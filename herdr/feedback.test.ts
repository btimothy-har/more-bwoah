import { afterEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import * as nodeFs from "node:fs/promises";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import guidanceSource from "./hunk/guidance.md" with { type: "text" };
import { createHerdrExtension } from "./index";
import { primaryRoleLockPath } from "./hunk/storage";
import {
	FakeTimers,
	HARNESS_AGENT_PANE,
	HARNESS_SOCKET,
	HARNESS_WORKSPACE,
	canon,
	createHerdrHarness,
	createHarnessLocks,
	createTempRepo,
	herdrTransient,
	harnessEnv,
	headSha,
	type Harness,
	type HarnessLocks,
	type RecordedCall,
} from "./test-helpers";

// The factory runs against the real host types; tests feed it a structurally
// complete fake host via this one unchecked cast.
type ToolExecute = (
	toolCallId: string,
	params: unknown,
	signal: AbortSignal | undefined,
	onUpdate: unknown,
	ctx: FakeContext,
) => Promise<{ content: Array<{ type: string; text: string }>; details?: unknown }>;

interface FakeContext {
	agent: { kind: "main" | "sub"; id: string; name: string; depth: number };
	mode: "tui" | "print" | "rpc" | "json";
	sessionManager: {
		getSessionId(): string;
		getArtifactsDir(): string | null;
		getCwd(): string;
		saveArtifact(content: string, toolType: string): Promise<string | undefined>;
	};
	ui: {
		notify(message: string, level?: string): void;
		select(
			title: string,
			options: Array<{ label: string; description?: string }>,
			dialogOptions?: { initialIndex?: number },
		): Promise<string | undefined>;
	};
	setInterval(callback: () => void, ms: number): unknown;
	setTimeout(callback: () => void, ms: number): unknown;
	clearTimer(handle: unknown): void;
}

interface FakeHost {
	tools: Record<string, { execute: ToolExecute }>;
	commands: Record<string, { handler: (args: string, ctx: FakeContext) => Promise<void> }>;
	handlers: Record<string, Array<(event: unknown, ctx: FakeContext) => unknown>>;
	pi: ExtensionAPI;
}

function createFakeSession(): FakeSession {
	return {
		notifications: [],
		selectCalls: [],
		selections: [],
		savedArtifacts: [],
		scheduled: [],
		intervals: new Map(),
		sessionName: "omp agent",
	};
}

function createFakeHost(exec: Harness["exec"]["run"], session: FakeSession): FakeHost {
	const tools: FakeHost["tools"] = {};
	const commands: FakeHost["commands"] = {};
	const handlers: FakeHost["handlers"] = {};
	const zodChain = {
		min: () => zodChain,
		optional: () => zodChain,
	};
	const zodStub = {
		object: () => zodChain,
		literal: () => zodChain,
		string: () => zodChain,
		number: () => zodChain,
		enum: () => zodChain,
		union: () => zodChain,
	};
	const pi = {
		on: (event: string, handler: (event: unknown, ctx: FakeContext) => unknown) => {
			(handlers[event] ??= []).push(handler);
		},
		registerTool: (tool: { name: string; execute: ToolExecute }) => {
			tools[tool.name] = tool;
		},
		registerCommand: (name: string, command: { handler: (args: string, ctx: FakeContext) => Promise<void> }) => {
			commands[name] = command;
		},
		exec,
		logger: { debug() {}, info() {}, warn() {}, error() {} },
		zod: zodStub,
		getSessionName: () => session.sessionName,
	};
	return { tools, commands, handlers, pi: pi as unknown as ExtensionAPI };
}

function createFakeContext(repoPath: string, artifactsDir: string, session: FakeSession, sessionId = "omp-1"): FakeContext {
	const scheduled = session.scheduled;
	const context: FakeContext = {
		agent: { kind: "main", id: "Main", name: "main", depth: 0 },
		mode: "tui",
		sessionManager: {
			getSessionId: () => sessionId,
			getArtifactsDir: () => artifactsDir,
			getCwd: () => repoPath,
			saveArtifact: async (content, toolType) => {
				session.savedArtifacts.push({ content, toolType });
				return `art-${session.savedArtifacts.length}`;
			},
		},
		ui: {
			notify: message => {
				session.notifications.push(message);
			},
			select: async (title, options) => {
				session.selectCalls.push({ title, labels: options.map(option => option.label) });
				return session.selections.shift();
			},
		},
		setInterval: (callback, ms) => {
			const handle = {};
			session.intervals.set(handle, { callback, ms });
			return handle;
		},
		setTimeout: callback => {
			scheduled.push(callback);
			return {};
		},
		clearTimer: handle => {
			session.intervals.delete(handle);
		},
	};
	return context;
}

interface Rig {
	host: FakeHost;
	harness: Harness;
	locks: HarnessLocks;
	timers: FakeTimers;
	session: FakeSession;
	ctx: FakeContext;
	repoPath: string;
	artifactsDir: string;
	artifactsFile: string;
	agentPaneId: string;
	sessionId: string;
	cleanup(): Promise<void>;
}

const cleaners: Array<() => Promise<void>> = [];
const savedEnv: Array<[string, string | undefined]> = [];
afterEach(async () => {
	while (savedEnv.length > 0) {
		const [key, value] = savedEnv.pop() ?? [];
		if (value === undefined) delete process.env[key ?? ""];
		else process.env[key ?? ""] = value;
	}
	while (cleaners.length > 0) {
		const clean = cleaners.pop();
		if (clean) await clean();
	}
});

function overrideEnv(env: Record<string, string>): void {
	for (const [key, value] of Object.entries(env)) {
		savedEnv.push([key, process.env[key]]);
		process.env[key] = value;
	}
}

/** herdr/hunk commands that must never fire outside ordinary review reads. */
function mutationCalls(harness: Harness): RecordedCall[] {
	return harness.exec.calls.filter(call => {
		if (call.command === "herdr") {
			const [verb, sub] = call.args;
			return (
				(verb === "tab" && (sub === "create" || sub === "focus")) ||
				(verb === "pane" && (sub === "close" || sub === "run" || sub === "send-keys"))
			);
		}
		if (call.command === "hunk" && call.args[0] === "session") {
			// `session reload <id>` carries its verb at args[1]; comment verbs
			// sit under `session comment <add|clear> ...` at args[2].
			return call.args[1] === "reload" || call.args[2] === "add" || call.args[2] === "clear";
		}
		return false;
	});
}

/** Pane id whose foreground currently hosts the given harness session, if provable. */
function paneHostingSession(harness: Harness, sessionId: string): string | undefined {
	const session = harness.sessions.find(entry => entry.sessionId === sessionId);
	if (session === undefined) return undefined;
	for (const [paneId, pane] of harness.panes) {
		if (pane.foreground.includes(session.pid)) return paneId;
	}
	return undefined;
}

interface FreshRigOptions {
	mode?: FakeContext["mode"];
	outsideHerdr?: boolean;
	nestedOmp?: boolean;
	kind?: "main" | "sub";
	role?: "primary" | "secondary" | "pending";
	locks?: HarnessLocks;
	stateDir?: string;
	harness?: Harness;
	repoPath?: string;
	agentPaneId?: string;
	sessionId?: string;
	namingFails?: boolean;
}

const ROLE_PROBES = {
	primary: "viewToken",
	secondary: "inactive in this secondary omp session",
	pending: "waiting for workspace ownership",
} as const;

async function freshRig(options: FreshRigOptions = {}): Promise<Rig> {
	const role = options.role ?? "primary";
	const sharedHarness = options.harness !== undefined;
	const repo = sharedHarness ? undefined : await createTempRepo(["line one", "line two", "line three"]);
	const repoPath = options.repoPath ?? repo?.path ?? "/repo";
	const stateDir = options.stateDir ?? (await nodeFs.mkdtemp(nodePath.join(nodeOs.tmpdir(), "hunk-fb-state-")));
	const artifactsDir = await nodeFs.mkdtemp(nodePath.join(nodeOs.tmpdir(), "hunk-fb-art-"));
	const harness = options.harness ?? createHerdrHarness(options.locks);
	const locks = harness.locks;
	if (!sharedHarness) harness.repoRootForLaunch = repoPath;
	const agentPaneId = options.agentPaneId ?? HARNESS_AGENT_PANE;
	const session = createFakeSession();
	const env: Record<string, string> = { ...harnessEnv(stateDir), HERDR_PANE_ID: agentPaneId };
	// The controller verifies its own tab against this env value; a rig in a
	// non-default pane must present that pane's real tab id.
	const ownTabId = harness.panes.get(agentPaneId)?.tabId;
	if (ownTabId !== undefined) env.HERDR_TAB_ID = ownTabId;
	if (options.outsideHerdr) env.HERDR_ENV = "0";
	if (options.nestedOmp) env.OMPCODE = "1";
	overrideEnv(env);
	const host = createFakeHost((command, args, execOptions) => harness.exec.run(command, args, execOptions), session);
	let disposeNamingFailure: (() => void) | undefined;
	if (options.namingFails) {
		let failedOnce = false;
		disposeNamingFailure = harness.exec.override(
			call =>
				call.command === "herdr" &&
				call.args[0] === "pane" &&
				call.args[1] === "get" &&
				call.args[2] === agentPaneId &&
				!failedOnce,
			() => {
				failedOnce = true;
				return herdrTransient();
			},
		);
	}
	createHerdrExtension(harness.tryPrimaryLock)(host.pi);
	const ctx = createFakeContext(repoPath, artifactsDir, session, options.sessionId ?? "omp-1");
	ctx.mode = options.mode ?? "tui";
	ctx.agent.kind = options.kind ?? "main";

	const startHandlers = host.handlers.session_start ?? [];
	expect(startHandlers.length).toBe(1);
	await startHandlers[0]({}, ctx);
	// The factory schedules naming + admission via ctx.setTimeout(0); run the
	// scheduled callbacks inline, then drain the microtask chains (the fake
	// lock's state-directory setup is synchronous) before probing or asserting.
	for (const callback of session.scheduled.splice(0)) callback();
	await flushTurns();
	disposeNamingFailure?.();

	const review = host.tools.hunk_review;
	expect(review).toBeDefined();
	// Drive startup until the role's consumer-visible signal appears. The
	// controller spawns real git children here; sleep-yield so they complete.
	const eligible = ctx.mode === "tui" && ctx.agent.kind === "main" && !options.outsideHerdr && !options.nestedOmp;
	let ready = !eligible;
	let lastProbe = "";
	for (let iteration = 0; iteration < 2_000 && !ready && eligible; iteration += 1) {
		const result = await review.execute("probe", {}, undefined, undefined, ctx);
		lastProbe = result.content[0]?.text ?? "";
		ready = lastProbe.includes(ROLE_PROBES[role]);
		if (!ready) await Bun.sleep(2);
	}
	if (!ready && eligible) {
		throw new Error(
			`companion never reached role ${role}; last probe: ${JSON.stringify(lastProbe)}; notifications: ${JSON.stringify(session.notifications)}`,
		);
	}

	const artifactsFile = nodePath.join(artifactsDir, "hunk", "review-notes.json");
	return {
		host,
		harness,
		locks,
		timers: harness.timers,
		session,
		ctx,
		repoPath,
		artifactsDir,
		artifactsFile,
		agentPaneId,
		sessionId: options.sessionId ?? "omp-1",
		async cleanup() {
			disposeNamingFailure?.();
			if (repo) await repo.cleanup();
			await nodeFs.rm(stateDir, { recursive: true, force: true });
			await nodeFs.rm(artifactsDir, { recursive: true, force: true });
		},
	};
}

async function reviewPayload(rig: Rig): Promise<{ viewToken: string; review: Record<string, unknown> }> {
	const result = await rig.host.tools.hunk_review.execute("call", {}, undefined, undefined, rig.ctx);
	const text = result.content[0]?.text ?? "";
	expect(text).toContain("viewToken");
	return JSON.parse(text) as { viewToken: string; review: Record<string, unknown> };
}

async function pollForViewToken(rig: Rig): Promise<{ viewToken: string; review: Record<string, unknown> }> {
	// The reconcile path spawns real git children; a real yield lets them run.
	for (let iteration = 0; iteration < 2_000; iteration += 1) {
		const result = await rig.host.tools.hunk_review.execute("poll", {}, undefined, undefined, rig.ctx);
		const text = result.content[0]?.text ?? "";
		if (text.includes("viewToken")) return JSON.parse(text) as { viewToken: string; review: Record<string, unknown> };
		await Bun.sleep(2);
	}
	throw new Error("companion never produced a review token after admission recovery");
}

/** Fire every registered handler for one event and await them in order. */
async function fireLifecycleEvent(rig: Rig, eventName: string): Promise<void> {
	for (const handler of rig.host.handlers[eventName] ?? []) await handler({}, rig.ctx);
}

/**
 * Yield several event-loop turns so a fired timer callback and its promise
 * chains settle without binding the wait to wall-clock time.
 */
async function flushTurns(turns = 8): Promise<void> {
	for (let turn = 0; turn < turns; turn += 1) await new Promise<void>(resolve => setImmediate(resolve));
}

describe("feedback surface", () => {
	test("hunk_review preserves human feedback bodies and thread identities", async () => {
		const rig = await freshRig();
		cleaners.push(rig.cleanup);
		const notes = [
			{ noteId: "user:1", source: "user", body: "Keep this edge case\nand its context", editable: true },
			{ noteId: "mcp:2", parentId: "user:1", source: "mcp", body: "Fixed the boundary", editable: false },
		];
		rig.harness.sessions[0].notes = notes;
		const payload = await reviewPayload(rig);
		expect(payload.review.reviewNotes).toEqual(notes);
	});

	for (const mode of ["print", "rpc", "json"] as const) {
		test(`${mode} sessions never start companion work or clear interactive notes`, async () => {
			const rig = await freshRig({ mode });
			cleaners.push(rig.cleanup);
			// An unrelated live Hunk session owns these notes; headless omp must
			// never touch them.
			const bystander = rig.harness.addSession("/unrelated-repo", "w2:p0");
			bystander.notes = [{ noteId: "user:kept", body: "Do not erase this review" }];
			for (const event of ["session_before_switch", "session_switch", "session_branch"]) {
				for (const handler of rig.host.handlers[event] ?? []) await handler({}, rig.ctx);
			}
			await rig.host.commands.diff.handler("", rig.ctx);
			const review = await rig.host.tools.hunk_review.execute("read", {}, undefined, undefined, rig.ctx);
			const comment = await rig.host.tools.hunk_comment.execute(
				"write", { kind: "reply", viewToken: "unused", replyTo: "user:kept", summary: "no write" },
				undefined, undefined, rig.ctx,
			);
			const guidance = await rig.host.handlers.before_agent_start[0]({ systemPrompt: ["base"] }, rig.ctx);
			await rig.host.handlers.session_shutdown[0]({}, rig.ctx);
			expect(review.content[0].text).toContain("headless");
			expect(comment.content[0].text).toContain("headless");
			expect(guidance).toBeUndefined();
			expect(rig.session.intervals.size).toBe(0);
			expect(rig.harness.exec.calls).toEqual([]);
			expect(bystander.notes).toEqual([{ noteId: "user:kept", body: "Do not erase this review" }]);
		});
	}

	test("non-herdr TUI startup explains the skip without scheduling service work", async () => {
		const rig = await freshRig({ outsideHerdr: true });
		cleaners.push(rig.cleanup);
		expect(rig.session.notifications).toEqual([expect.stringContaining("skipping Herdr integration")]);
		expect(rig.session.intervals.size).toBe(0);
		expect(rig.harness.exec.calls).toEqual([]);
		const result = await rig.host.tools.hunk_comment.execute("write", {}, undefined, undefined, rig.ctx);
		expect(result.content[0].text).toContain("herdr");
		expect(rig.harness.exec.calls).toEqual([]);
	});

	test("nested omp launches stay completely inert", async () => {
		const rig = await freshRig({ nestedOmp: true });
		cleaners.push(rig.cleanup);
		expect(rig.session.notifications).toEqual([expect.stringContaining("skipping Herdr integration")]);
		expect(rig.session.intervals.size).toBe(0);
		expect(rig.harness.exec.calls).toEqual([]);
		expect(rig.harness.renameCalls).toEqual([]);
		const result = await rig.host.tools.hunk_review.execute("read", {}, undefined, undefined, rig.ctx);
		expect(result.content[0].text).toContain("herdr");
		expect(rig.harness.exec.calls).toEqual([]);
	});

	test("subagent startup never schedules service work or emits guidance", async () => {
		const rig = await freshRig({ kind: "sub" });
		cleaners.push(rig.cleanup);
		await rig.host.handlers.session_switch[0]({}, rig.ctx);
		const result = await rig.host.handlers.before_agent_start[0]({ systemPrompt: ["base"] }, rig.ctx);
		expect(result).toBeUndefined();
		expect(rig.session.intervals.size).toBe(0);
		expect(rig.harness.exec.calls).toEqual([]);
	});

	test("primary startup names its own tab once, syncs its title, and creates one unfocused diff child", async () => {
		const rig = await freshRig();
		cleaners.push(rig.cleanup);
		const tabRenames = rig.harness.renameCalls.filter(call => call.scope === "tab");
		expect(tabRenames).toEqual([{ scope: "tab", id: "w1:t0", label: "omp" }]);
		const create = rig.harness.exec.calls.find(
			call => call.command === "herdr" && call.args[0] === "tab" && call.args[1] === "create",
		);
		expect(create).toBeDefined();
		expect(create?.args).toContain("--no-focus");
		const labelIndex = create?.args.indexOf("--label") ?? -1;
		expect(create?.args[labelIndex + 1]).toBe("diff");
		// The pane title comes from the session name and dedupes across ticks.
		const titleRenames = () => rig.harness.renameCalls.filter(call => call.scope === "pane");
		expect(titleRenames()).toEqual([{ scope: "pane", id: "w1:p0", label: "omp agent" }]);
		const lifecycle = [...rig.session.intervals.values()].find(timer => timer.ms === 3_000);
		for (let round = 0; round < 2; round += 1) {
			lifecycle?.callback();
			await flushTurns();
		}
		expect(titleRenames()).toEqual([{ scope: "pane", id: "w1:p0", label: "omp agent" }]);
		// Manual tab renames are never overwritten: no further tab renames fire.
		await fireLifecycleEvent(rig, "session_switch");
		await flushTurns();
		expect(rig.harness.renameCalls.filter(call => call.scope === "tab")).toEqual([
			{ scope: "tab", id: "w1:t0", label: "omp" },
		]);
	});

	test("own-tab naming failure does not block admission or child work", async () => {
		const rig = await freshRig({ namingFails: true });
		cleaners.push(rig.cleanup);
		const payload = await reviewPayload(rig);
		expect(payload.viewToken).toBeTruthy();
		expect(rig.harness.renameCalls.filter(call => call.scope === "tab" && call.label === "omp")).toEqual([]);
	});

	test("secondary startup names only its own tab and never schedules child work", async () => {
		const locks = createHarnessLocks();
		const stateDir = await nodeFs.mkdtemp(nodePath.join(nodeOs.tmpdir(), "hunk-fb-state-"));
		cleaners.push(async () => nodeFs.rm(stateDir, { recursive: true, force: true }));
		const holder = await locks.tryPrimaryLock(
			primaryRoleLockPath(harnessEnv(stateDir), HARNESS_SOCKET, HARNESS_WORKSPACE),
			{ debug() {}, info() {}, warn() {}, error() {} },
		);
		expect(holder.acquired).toBe(true);
		const rig = await freshRig({ role: "secondary", locks, stateDir });
		cleaners.push(rig.cleanup);
		expect(rig.harness.renameCalls).toEqual([{ scope: "tab", id: "w1:t0", label: "omp" }]);
		expect(rig.harness.tabCreateCount).toBe(0);
		expect(rig.session.intervals.size).toBe(0);
		expect(rig.harness.exec.calls.filter(call => call.command === "hunk")).toEqual([]);

		// Secondary /diff reports the exact inactive message and shows no picker.
		await rig.host.commands.diff.handler("", rig.ctx);
		expect(rig.session.selectCalls).toEqual([]);
		expect(rig.session.notifications.at(-1)).toContain("inactive in this secondary omp session");

		// /new, resume-style switches, and branch events never promote it.
		rig.ctx.sessionManager.getSessionId = () => "omp-secondary-new";
		for (const event of ["session_before_switch", "session_switch", "session_before_branch", "session_branch"]) {
			await fireLifecycleEvent(rig, event);
		}
		const review = await rig.host.tools.hunk_review.execute("read", {}, undefined, undefined, rig.ctx);
		expect(review.content[0].text).toContain("inactive in this secondary omp session");
		expect(rig.harness.tabCreateCount).toBe(0);
		expect(rig.harness.renameCalls).toEqual([{ scope: "tab", id: "w1:t0", label: "omp" }]);

		// Guidance stays off for secondaries, and shutdown does no shared work.
		const guidance = await rig.host.handlers.before_agent_start[0]({ systemPrompt: ["base"] }, rig.ctx);
		expect(guidance).toBeUndefined();
		const mutationsBefore = mutationCalls(rig.harness).length;
		await rig.host.handlers.session_shutdown[0]({}, rig.ctx);
		expect(mutationCalls(rig.harness).length).toBe(mutationsBefore);
		expect(rig.session.intervals.size).toBe(0);

		// The rig's losing admission never disturbed the winner's ownership.
		const lockPath = primaryRoleLockPath(harnessEnv(stateDir), HARNESS_SOCKET, HARNESS_WORKSPACE);
		expect(locks.holds(lockPath)).toBe(true);
		// Releasing the winner's handle frees the path for the next process.
		holder.release();
		expect(locks.holds(lockPath)).toBe(false);
	});

	test("pending admission reports the waiting message and recovers on the admission tick", async () => {
		const locks = createHarnessLocks();
		locks.failAcquires(new Error("host FileLock API missing"));
		const rig = await freshRig({ role: "pending", locks });
		cleaners.push(rig.cleanup);
		const waiting = await rig.host.tools.hunk_review.execute("read", {}, undefined, undefined, rig.ctx);
		expect(waiting.content[0].text).toContain("waiting for workspace ownership");
		expect([...rig.session.intervals.values()].map(timer => timer.ms)).toEqual([3_000]);
		const admission = [...rig.session.intervals.values()][0];
		expect(admission).toBeDefined();

		locks.failAcquires(null);
		admission?.callback();
		const payload = await pollForViewToken(rig);
		expect(payload.viewToken).toBeTruthy();
		expect([...rig.session.intervals.values()].map(timer => timer.ms).sort((a, b) => a - b)).toEqual([3_000, 30_000]);
	});

	test("conversation changes retain one timer pair and shutdown removes it", async () => {
		const rig = await freshRig();
		cleaners.push(rig.cleanup);
		const handles = [...rig.session.intervals.keys()];
		let sessionId = "omp-1";
		rig.ctx.sessionManager.getSessionId = () => sessionId;
		for (const id of ["omp-2", "omp-3"]) {
			sessionId = id;
			await rig.host.handlers.session_switch[0]({}, rig.ctx);
			await rig.host.handlers.session_branch[0]({}, rig.ctx);
		}
		await rig.host.handlers.session_start[0]({}, rig.ctx);
		expect([...rig.session.intervals.keys()]).toEqual(handles);
		expect([...rig.session.intervals.values()].map(timer => timer.ms).sort((a, b) => a - b)).toEqual([3_000, 30_000]);
		await rig.host.handlers.session_shutdown[0]({}, rig.ctx);
		expect(rig.session.intervals.size).toBe(0);
	});

	test("session transition replaces the old diff without leaking notes", async () => {
		const rig = await freshRig();
		cleaners.push(rig.cleanup);
		const childA = rig.harness.sessions[0];
		childA.notes = [{ noteId: "user:a1", source: "user", body: "A's human note" }];
		const childAPaneId = paneHostingSession(rig.harness, childA.sessionId);
		expect(childAPaneId).toBeDefined();
		const { viewToken: tokenA } = await reviewPayload(rig);

		// An unrelated live session in a second workspace owns notes that no
		// transition in this workspace may touch.
		const other = await createTempRepo(["unrelated", "workspace"]);
		cleaners.push(other.cleanup);
		rig.harness.panes.set("w2:p0", { tabId: "w2:t0", shellPid: ++rig.harness.nextPid, foreground: [] });
		const bystander = rig.harness.addSession(await canon(other.path), "w2:p0");
		bystander.notes = [{ noteId: "user:b1", source: "user", body: "B keeps its note" }];

		// /new: the omp session id changes; the old diff must be retired and a
		// fresh child created for the new session.
		rig.ctx.sessionManager.getSessionId = () => "omp-2";
		for (const eventName of ["session_before_switch", "session_switch"] as const) {
			for (const handler of rig.host.handlers[eventName] ?? []) await handler({}, rig.ctx);
		}

		const fresh = await reviewPayload(rig);
		expect(rig.harness.tabCreateCount).toBe(2);
		expect(childAPaneId !== undefined && rig.harness.panes.has(childAPaneId)).toBe(false);
		expect(rig.harness.sessions.some(session => session.sessionId === childA.sessionId)).toBe(false);
		expect(fresh.review.sessionId).not.toBe(childA.sessionId);
		expect(fresh.review.reviewNotes).toEqual([]);
		expect(rig.harness.panes.has("w2:p0")).toBe(true);
		expect(bystander.notes).toEqual([{ noteId: "user:b1", source: "user", body: "B keeps its note" }]);

		const envelope = JSON.parse(await nodeFs.readFile(rig.artifactsFile, "utf8")) as {
			ompSessionId: string;
			hunkSessionId: string;
		};
		expect(envelope.ompSessionId).toBe("omp-2");
		expect(envelope.hunkSessionId).not.toBe(childA.sessionId);

		// A's view token must never address the replacement child.
		const stale = await rig.host.tools.hunk_comment.execute(
			"write",
			{ kind: "line", viewToken: tokenA, filePath: "seed.txt", side: "new", line: 2, summary: "stale" },
			undefined,
			undefined,
			rig.ctx,
		);
		expect(stale.content[0].text).toContain("hunk_review");
	});

	test("primary soft shutdown leaves the child, notes, and evidence intact", async () => {
		const rig = await freshRig();
		cleaners.push(rig.cleanup);
		const child = rig.harness.sessions[0];
		child.notes = [{ noteId: "user:keep", source: "user", body: "Survives shutdown" }];
		const childPaneId = paneHostingSession(rig.harness, child.sessionId);
		expect(childPaneId).toBeDefined();
		const { viewToken } = await reviewPayload(rig);

		const mutationsBefore = mutationCalls(rig.harness).length;
		await rig.host.handlers.session_shutdown[0]({}, rig.ctx);
		expect(rig.session.intervals.size).toBe(0);
		expect(mutationCalls(rig.harness).length).toBe(mutationsBefore);
		expect(childPaneId !== undefined && rig.harness.panes.has(childPaneId)).toBe(true);
		expect(rig.harness.sessions.some(session => session.sessionId === child.sessionId)).toBe(true);
		expect(child.notes).toEqual([{ noteId: "user:keep", source: "user", body: "Survives shutdown" }]);

		// Tool writes stay invalidated after shutdown; no revival via queued calls.
		const review = await rig.host.tools.hunk_review.execute("read", {}, undefined, undefined, rig.ctx);
		expect(review.content[0].text).not.toContain("viewToken");
		// The serialized queue rejects outright once shutdown started, so the
		// annotation never reaches Hunk.
		await expect(
			rig.host.tools.hunk_comment.execute(
				"write",
				{ kind: "line", viewToken, filePath: "seed.txt", side: "new", line: 2, summary: "post-shutdown" },
				undefined,
				undefined,
				rig.ctx,
			),
		).rejects.toThrow("shutting down");
		expect(rig.harness.adds).toBe(0);
	});

	test("tools follow a moved checkout by replacing the old child", async () => {
		const rig = await freshRig();
		cleaners.push(rig.cleanup);
		const next = await createTempRepo(["different", "checkout", "content"]);
		cleaners.push(next.cleanup);
		const prior = await reviewPayload(rig);
		const oldPaneId = paneHostingSession(rig.harness, rig.harness.sessions[0].sessionId);
		expect(oldPaneId).toBeDefined();
		rig.harness.repoRootForLaunch = next.path;
		rig.ctx.sessionManager.getCwd = () => next.path;
		const result = await rig.host.tools.hunk_review.execute("read", {}, undefined, undefined, rig.ctx);
		const payload = JSON.parse(result.content[0]?.text ?? "{}") as {
			scope?: Record<string, unknown>;
			review?: { sessionId?: string };
			viewToken?: string;
		};
		expect(payload.scope).toEqual({ kind: "session", baseSha: await headSha(next.path) });
		expect(payload.review?.sessionId).not.toBe(prior.review.sessionId);
		expect(payload.viewToken).not.toBe(prior.viewToken);
		expect(rig.harness.tabCreateCount).toBe(2);
		expect(oldPaneId !== undefined && rig.harness.panes.has(oldPaneId)).toBe(false);
	});

	test("a closed child is recreated automatically on the next tick", async () => {
		const rig = await freshRig();
		cleaners.push(rig.cleanup);
		const prior = await reviewPayload(rig);
		const childSessionId = rig.harness.sessions[0].sessionId;
		const childPaneId = paneHostingSession(rig.harness, childSessionId);
		expect(childPaneId).toBeDefined();
		// The user closed the child pane; herdr removed the pane and its
		// foregrounded Hunk registration with it.
		rig.harness.panes.delete(childPaneId as string);
		rig.harness.sessions = rig.harness.sessions.filter(session => session.sessionId !== childSessionId);

		const lifecycle = [...rig.session.intervals.values()].find(timer => timer.ms === 3_000);
		lifecycle?.callback();
		const fresh = await pollForViewToken(rig);
		expect(rig.harness.tabCreateCount).toBe(2);
		expect(fresh.review.sessionId).not.toBe(prior.review.sessionId);
		expect(fresh.review.reviewNotes).toEqual([]);
	});

	for (const changed of ["session", "cwd"] as const) {
		test(`/diff abandons a selection when ${changed} changes while the picker is open`, async () => {
			const rig = await freshRig();
			cleaners.push(rig.cleanup);
			const prior = await reviewPayload(rig);
			const mutationsBefore = mutationCalls(rig.harness).length;
			const renames = [...rig.harness.renameCalls];
			let pick = 0;
			rig.ctx.ui.select = async (_title, options) => {
				pick += 1;
				if (pick === 1) {
					if (changed === "session") rig.ctx.sessionManager.getSessionId = () => "replacement";
					else rig.ctx.sessionManager.getCwd = () => nodeOs.tmpdir();
					// A concrete non-default selection, so an applied scope would be
					// observable in the bound child.
					return "Against a base branch";
				}
				return options[0]?.label;
			};
			await rig.host.commands.diff.handler("", rig.ctx);
			// The queued selection and focus are discarded by the revision check:
			// the picker never renames a tab and never focuses the child.
			expect(rig.harness.focusCount).toBe(0);
			expect(rig.harness.renameCalls).toEqual(renames);
			if (changed === "session") {
				// A committed parent transition still proceeds on the ordinary
				// reconciliation path; the fresh child reviews the new parent's
				// full-session baseline, not the picked branch scope.
				const fresh = await reviewPayload(rig);
				expect(fresh.review.sessionId).not.toBe(prior.review.sessionId);
				expect(fresh.scope).toEqual({ kind: "session", baseSha: await headSha(rig.repoPath) });
			} else {
				// Indeterminate git resolution creates nothing and blocks review.
				expect(mutationCalls(rig.harness).length).toBe(mutationsBefore);
				const review = await rig.host.tools.hunk_review.execute("read", {}, undefined, undefined, rig.ctx);
				expect(review.content[0].text).toContain("cannot be resolved");
			}
		});
	}

	for (const choices of [
		[undefined], ["Against a base branch", undefined], ["Specific commit", undefined],
	]) {
		test(`/diff cancellation at ${choices[0] ?? "root"} performs no lifecycle action`, async () => {
			const rig = await freshRig();
			cleaners.push(rig.cleanup);
			const creates = rig.harness.tabCreateCount;
			const clears = rig.harness.clears;
			const renames = [...rig.harness.renames];
			const reloads = rig.harness.exec.calls.filter(call => call.command === "hunk" && call.args[1] === "reload").length;
			rig.session.selections.push(...choices);
			await rig.host.commands.diff.handler("", rig.ctx);
			expect(rig.harness.tabCreateCount).toBe(creates);
			expect(rig.harness.clears).toBe(clears);
			expect(rig.harness.renames).toEqual(renames);
			expect(rig.harness.focusCount).toBe(0);
			expect(rig.harness.exec.calls.filter(call => call.command === "hunk" && call.args[1] === "reload").length).toBe(reloads);
		});
	}

	test("subagent contexts are refused without any companion calls", async () => {
		const rig = await freshRig();
		cleaners.push(rig.cleanup);
		const subCtx = { ...rig.ctx, agent: { ...rig.ctx.agent, kind: "sub" as const } };
		const callsBefore = rig.harness.exec.calls.length;
		const result = await rig.host.tools.hunk_review.execute("call", {}, undefined, undefined, subCtx as FakeContext);
		expect(result.content[0].text).toContain("main session");
		expect(rig.harness.exec.calls.length).toBe(callsBefore);
	});

	test("secondary stays fixed while a successor primary replaces the retired child", async () => {
		const locks = createHarnessLocks();
		const stateDir = await nodeFs.mkdtemp(nodePath.join(nodeOs.tmpdir(), "hunk-fb-state-"));
		cleaners.push(async () => nodeFs.rm(stateDir, { recursive: true, force: true }));
		const shared = { locks, stateDir };
		const rigA = await freshRig({ ...shared, role: "primary", sessionId: "omp-A", agentPaneId: HARNESS_AGENT_PANE });
		cleaners.push(rigA.cleanup);
		const childA = rigA.harness.sessions[0];
		childA.notes = [{ noteId: "user:a1", source: "user", body: "A's retained note" }];
		const childAPaneId = paneHostingSession(rigA.harness, childA.sessionId);
		expect(childAPaneId).toBeDefined();

		// Secondary B joins the same workspace in its own pane.
		rigA.harness.panes.set("w1:pB", { tabId: "w1:tB", shellPid: ++rigA.harness.nextPid, foreground: [process.pid] });
		const rigB = await freshRig({
			...shared,
			role: "secondary",
			sessionId: "omp-B",
			agentPaneId: "w1:pB",
			harness: rigA.harness,
			repoPath: rigA.repoPath,
		});
		cleaners.push(rigB.cleanup);
		expect(rigB.harness.tabCreateCount).toBe(1);
		expect(rigB.session.intervals.size).toBe(0);

		// B's /new changes its session id but never touches A's child.
		rigB.ctx.sessionManager.getSessionId = () => "omp-B-new";
		for (const event of ["session_before_switch", "session_switch"] as const) {
			await fireLifecycleEvent(rigB, event);
		}
		expect(rigA.harness.tabCreateCount).toBe(1);
		expect(rigA.harness.sessions.some(session => session.sessionId === childA.sessionId)).toBe(true);
		const bDuringA = await rigB.host.tools.hunk_review.execute("read", {}, undefined, undefined, rigB.ctx);
		expect(bDuringA.content[0].text).toContain("inactive in this secondary omp session");

		// A soft-exits: the retained child, its notes, and metadata stay put.
		const mutationsBefore = mutationCalls(rigA.harness).length;
		await rigA.host.handlers.session_shutdown[0]({}, rigA.ctx);
		expect(mutationCalls(rigA.harness).length).toBe(mutationsBefore);
		expect(childAPaneId !== undefined && rigA.harness.panes.has(childAPaneId)).toBe(true);
		expect(childA.notes).toEqual([{ noteId: "user:a1", source: "user", body: "A's retained note" }]);

		// A's actual process exit frees the primary lock; B must stay secondary.
		const lockPath = primaryRoleLockPath(harnessEnv(stateDir), HARNESS_SOCKET, HARNESS_WORKSPACE);
		expect(locks.holds(lockPath)).toBe(true);
		locks.simulateProcessExit(lockPath);
		const bAfterExit = await rigB.host.tools.hunk_review.execute("read", {}, undefined, undefined, rigB.ctx);
		expect(bAfterExit.content[0].text).toContain("inactive in this secondary omp session");

		// C starts in the original agent pane, becomes primary, and replaces the
		// retained child by recorded IDs — while B remains untouched.
		const rigC = await freshRig({
			...shared,
			role: "primary",
			sessionId: "omp-C",
			agentPaneId: HARNESS_AGENT_PANE,
			harness: rigA.harness,
			repoPath: rigA.repoPath,
		});
		cleaners.push(rigC.cleanup);
		expect(rigA.harness.tabCreateCount).toBe(2);
		expect(childAPaneId !== undefined && rigA.harness.panes.has(childAPaneId)).toBe(false);
		expect(rigA.harness.sessions.some(session => session.sessionId === childA.sessionId)).toBe(false);
		const freshC = await reviewPayload(rigC);
		expect(freshC.review.reviewNotes).toEqual([]);
		const bAfterC = await rigB.host.tools.hunk_review.execute("read", {}, undefined, undefined, rigB.ctx);
		expect(bAfterC.content[0].text).toContain("inactive in this secondary omp session");
		// The create counter is harness-global: exactly A's and C's launches —
		// B contributed none, proven by its empty interval set above and its
		// inactive gates here.
		expect(rigB.harness.tabCreateCount).toBe(2);
		// Each process named only its own tab exactly once.
		const ompTabRenames = rigA.harness.renameCalls.filter(call => call.scope === "tab" && call.label === "omp");
		expect(ompTabRenames.map(call => call.id)).toEqual(["w1:t0", "w1:tB", "w1:t0"]);
	});

	test("failed artifact storage reports an error without truncating human feedback", async () => {
		const rig = await freshRig();
		cleaners.push(rig.cleanup);
		rig.harness.sessions[0].notes = [{ noteId: "user:large", source: "user", body: "z".repeat(20_000) }];
		for (const fail of [
			async (): Promise<string | undefined> => undefined,
			async (): Promise<string | undefined> => { throw new Error("disk full"); },
		]) {
			rig.ctx.sessionManager.saveArtifact = fail;
			const result = await rig.host.tools.hunk_review.execute("read", {}, undefined, undefined, rig.ctx);
			expect(result.content[0].text).toContain("artifact spill failed");
			expect(result.details).toBeUndefined();
			expect(result.content[0].text).not.toContain("artifact://");
		}
	});

	test("large reviews spill losslessly to an artifact", async () => {
		const rig = await freshRig();
		cleaners.push(rig.cleanup);
		rig.harness.sessions[0].notes = [
			{
				noteId: "user:1",
				source: "user",
				filePath: "seed.txt",
				body: "x".repeat(20_000),
				editable: true,
			},
		];
		const result = await rig.host.tools.hunk_review.execute("call", {}, undefined, undefined, rig.ctx);
		const text = result.content[0]?.text ?? "";
		expect(text).toContain("artifact://art-1");
		expect(rig.session.savedArtifacts.length).toBe(1);
		const saved = JSON.parse(rig.session.savedArtifacts[0].content);
		expect(saved.review.reviewNotes).toEqual(rig.harness.sessions[0].notes);
		expect(saved.viewToken).toBeTruthy();
	});

	test("stale view tokens never reach a comment write", async () => {
		const rig = await freshRig();
		cleaners.push(rig.cleanup);
		const stale = await reviewPayload(rig);
		rig.harness.sessions[0].generation = "gen-changed";
		const addsBefore = rig.harness.adds;
		const result = await rig.host.tools.hunk_comment.execute(
			"call",
			{
				kind: "line",
				viewToken: stale.viewToken,
				filePath: "seed.txt",
				side: "new",
				line: 2,
				summary: "should not land",
			},
			undefined,
			undefined,
			rig.ctx,
		);
		expect(result.content[0].text).toContain("Review changed; call hunk_review again");
		expect(rig.harness.adds).toBe(addsBefore);
	});

	test("flag-like multiline annotation values remain bound to their options", async () => {
		const rig = await freshRig();
		cleaners.push(rig.cleanup);
		const { viewToken } = await reviewPayload(rig);
		const summary = "--focus\nkeep this 'quoted' text literal";
		const rationale = "--repo=/unrelated\n$(do-not-execute)";
		const result = await rig.host.tools.hunk_comment.execute(
			"write",
			{ kind: "line", viewToken, filePath: "seed.txt", side: "new", line: 2, summary, rationale },
			undefined, undefined, rig.ctx,
		);
		expect(result.content[0].text).toContain("Comment created");
		const args = rig.harness.lastAddArgs ?? [];
		expect(args.filter(arg => arg.startsWith("--summary="))).toEqual([`--summary=${summary}`]);
		expect(args.filter(arg => arg.startsWith("--rationale="))).toEqual([`--rationale=${rationale}`]);
		expect(args).toContain("--file=seed.txt");
		expect(args).toContain("--new-line=2");
		expect(args).not.toContain("--focus");
		expect(args).not.toContain("--repo=/unrelated");
	});

	test("flag-like reply IDs cannot become file anchors or target selectors", async () => {
		const rig = await freshRig();
		cleaners.push(rig.cleanup);
		const { viewToken } = await reviewPayload(rig);
		const replyTo = "--repo=/unrelated";
		await rig.host.tools.hunk_comment.execute(
			"reply", { kind: "reply", viewToken, replyTo, summary: "Keep the thread anchor" },
			undefined, undefined, rig.ctx,
		);
		const args = rig.harness.lastAddArgs ?? [];
		expect(args.filter(arg => arg.startsWith("--reply-to="))).toEqual([`--reply-to=${replyTo}`]);
		expect(args.some(arg => arg === "--file" || arg.startsWith("--file="))).toBe(false);
		expect(args.some(arg => /^--(?:old|new)-line(?:=|$)/.test(arg))).toBe(false);
		expect(args).not.toContain("--repo=/unrelated");
	});

	test("generation change during a successful write is reported honestly", async () => {
		const rig = await freshRig();
		cleaners.push(rig.cleanup);
		rig.harness.bumpGenerationOnAdd = true;
		const { viewToken } = await reviewPayload(rig);
		const result = await rig.host.tools.hunk_comment.execute(
			"call",
			{ kind: "line", viewToken, filePath: "seed.txt", side: "old", line: 1, summary: "racy" },
			undefined,
			undefined,
			rig.ctx,
		);
		expect(result.content[0].text).toContain("mcp:1");
		expect(result.content[0].text).toContain("anchor may be stale");
	});

	test("guidance is appended once while ready and never when not ready", async () => {
		const rig = await freshRig();
		cleaners.push(rig.cleanup);
		const beforeHandlers = rig.host.handlers.before_agent_start ?? [];

		const event = { systemPrompt: ["base prompt"] };
		const first = await beforeHandlers[0](event, rig.ctx);
		expect(first).toEqual({ systemPrompt: ["base prompt", guidanceSource] });

		const second = await beforeHandlers[0]({ systemPrompt: ["base", guidanceSource] }, rig.ctx);
		expect(second).toBeUndefined();
	});

	test("/diff rejects arguments and cancellation changes nothing", async () => {
		const rig = await freshRig();
		cleaners.push(rig.cleanup);
		const diffHandler = rig.host.commands.diff?.handler;
		expect(diffHandler).toBeDefined();

		await diffHandler?.("main", rig.ctx);
		expect(rig.session.notifications).toContain("Use /diff without arguments.");
		expect(rig.session.selectCalls.length).toBe(0);

		rig.session.selections.push(undefined);
		await diffHandler?.("", rig.ctx);
		expect(rig.session.selectCalls.length).toBe(1);
		expect(rig.session.selectCalls[0]?.title).toBe("Diff view");
		expect(rig.session.selectCalls[0]?.labels).toEqual([
			"Full session",
			"Against a base branch",
			"Specific commit",
		]);
		const tabCreates = rig.harness.exec.calls.filter(
			call => call.command === "herdr" && call.args[1] === "create",
		).length;
		expect(tabCreates).toBe(1);
	});

	test("/diff branch selection reloads the bound session to the merge-base and focuses", async () => {
		const rig = await freshRig();
		cleaners.push(rig.cleanup);
		rig.session.selections.push("Against a base branch", "main");
		await rig.host.commands.diff.handler("", rig.ctx);

		const result = await rig.host.tools.hunk_review.execute("read", {}, undefined, undefined, rig.ctx);
		const payload = JSON.parse(result.content[0].text);
		expect(payload.scope).toEqual({ kind: "branch", baseBranch: "refs/heads/main", baseSha: await headSha(rig.repoPath) });
		expect(rig.harness.focusCount).toBe(1);
	});
});
