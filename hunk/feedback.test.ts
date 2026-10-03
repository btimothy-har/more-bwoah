import { afterEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import * as nodeFs from "node:fs/promises";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import guidanceSource from "./guidance.md" with { type: "text" };
import hunkCompanionExtension from "./index";
import {
	FakeTimers,
	createHerdrHarness,
	createTempRepo,
	harnessEnv,
	headSha,
	type Harness,
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

function createFakeHost(exec: Harness["exec"]["run"]): FakeHost {
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
	};
	return { tools, commands, handlers, pi: pi as unknown as ExtensionAPI };
}

interface FakeSession {
	notifications: string[];
	selectCalls: Array<{ title: string; labels: string[] }>;
	selections: Array<string | undefined>;
	savedArtifacts: Array<{ content: string; toolType: string }>;
	scheduled: Array<() => void>;
	intervals: Map<unknown, { callback: () => void; ms: number }>;
}

function createFakeContext(repoPath: string, artifactsDir: string, session: FakeSession): FakeContext {
	const scheduled = session.scheduled;
	const context: FakeContext = {
		agent: { kind: "main", id: "Main", name: "main", depth: 0 },
		mode: "tui",
		sessionManager: {
			getSessionId: () => "omp-1",
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
	timers: FakeTimers;
	session: FakeSession;
	ctx: FakeContext;
	repoPath: string;
	artifactsDir: string;
	artifactsFile: string;
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

async function freshRig(options: { mode?: FakeContext["mode"]; outsideHerdr?: boolean; kind?: "main" | "sub" } = {}): Promise<Rig> {
	const repo = await createTempRepo(["line one", "line two", "line three"]);
	const stateDir = await nodeFs.mkdtemp(nodePath.join(nodeOs.tmpdir(), "hunk-fb-state-"));
	const artifactsDir = await nodeFs.mkdtemp(nodePath.join(nodeOs.tmpdir(), "hunk-fb-art-"));
	const harness = createHerdrHarness();
	harness.repoRootForLaunch = repo.path;
	const env = harnessEnv(stateDir);
	// The factory reads eligibility from process.env at construction time.
	overrideEnv(options.outsideHerdr ? { ...env, HERDR_ENV: "0" } : env);
	const host = createFakeHost((command, args, options) => harness.exec.run(command, args, options));
	hunkCompanionExtension(host.pi);
	const session: FakeSession = {
		notifications: [],
		selectCalls: [],
		selections: [],
		savedArtifacts: [],
		scheduled: [],
		intervals: new Map(),
	};
	const ctx = createFakeContext(repo.path, artifactsDir, session);
	ctx.mode = options.mode ?? "tui";
	ctx.agent.kind = options.kind ?? "main";

	const startHandlers = host.handlers.session_start ?? [];
	expect(startHandlers.length).toBe(1);
	await startHandlers[0]({}, ctx);
	// The factory schedules initialization via ctx.setTimeout(0); run the
	// scheduled callbacks inline so startup proceeds without real timers.
	const scheduled = session.scheduled;
	for (const callback of scheduled.splice(0)) callback();
	const review = host.tools.hunk_review;
	expect(review).toBeDefined();
	// Drive startup to readiness by polling the review tool. The controller
	// spawns real git children here, and back-to-back setImmediate spins starve
	// Bun's I/O polling — sleep-yield so the child processes can complete.
	let ready = false;
	let lastProbe = "";
	for (let iteration = 0; iteration < 2_000 && !ready && ctx.mode === "tui" && ctx.agent.kind === "main" && !options.outsideHerdr; iteration += 1) {
		const result = await review.execute("probe", {}, undefined, undefined, ctx);
		lastProbe = result.content[0]?.text ?? "";
		ready = lastProbe.includes("viewToken");
		if (!ready) await Bun.sleep(2);
	}
	if (!ready && ctx.mode === "tui" && ctx.agent.kind === "main" && !options.outsideHerdr) {
		throw new Error(
			`companion never became ready; last probe: ${JSON.stringify(lastProbe)}; notifications: ${JSON.stringify(session.notifications)}`,
		);
	}

	const artifactsFile = nodePath.join(artifactsDir, "hunk", "review-notes.json");
	return {
		host,
		harness,
		timers: harness.timers,
		session,
		ctx,
		repoPath: repo.path,
		artifactsDir,
		artifactsFile,
		async cleanup() {
			await repo.cleanup();
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

describe("feedback surface", () => {
	test("hunk_review preserves human feedback bodies and thread identities", async () => {
		const rig = await freshRig();
		cleaners.push(rig.cleanup);
		const notes = [
			{ noteId: "user:1", source: "user", body: "Keep this edge case\nand its context", editable: true },
			{ noteId: "mcp:2", parentId: "user:1", source: "mcp", body: "Fixed the boundary", editable: false },
		];
		rig.harness.reviewNotes = notes;
		const payload = await reviewPayload(rig);
		expect(payload.review.reviewNotes).toEqual(notes);
	});

	for (const mode of ["print", "rpc", "json"] as const) {
		test(`${mode} sessions never start companion work or clear interactive notes`, async () => {
			const rig = await freshRig({ mode });
			cleaners.push(rig.cleanup);
			rig.harness.reviewNotes = [{ noteId: "user:kept", body: "Do not erase this review" }];
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
			expect(rig.harness.reviewNotes).toEqual([{ noteId: "user:kept", body: "Do not erase this review" }]);
		});
	}

	test("non-herdr TUI startup explains the skip without scheduling service work", async () => {
		const rig = await freshRig({ outsideHerdr: true });
		cleaners.push(rig.cleanup);
		expect(rig.session.notifications).toEqual([expect.stringContaining("skipping Hunk companion launch")]);
		expect(rig.session.intervals.size).toBe(0);
		expect(rig.harness.exec.calls).toEqual([]);
		const result = await rig.host.tools.hunk_comment.execute("write", {}, undefined, undefined, rig.ctx);
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

	test("failed artifact storage reports an error without truncating human feedback", async () => {
		const rig = await freshRig();
		cleaners.push(rig.cleanup);
		rig.harness.reviewNotes = [{ noteId: "user:large", source: "user", body: "z".repeat(20_000) }];
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

	test("tools follow a moved checkout before the scheduled lifecycle tick", async () => {
		const rig = await freshRig();
		cleaners.push(rig.cleanup);
		const next = await createTempRepo(["different", "checkout", "content"]);
		cleaners.push(next.cleanup);
		const prior = await reviewPayload(rig);
		rig.harness.repoRootForLaunch = next.path;
		rig.ctx.sessionManager.getCwd = () => next.path;
		const result = await rig.host.tools.hunk_review.execute("read", {}, undefined, undefined, rig.ctx);
		const payload = JSON.parse(result.content[0].text);
		expect(payload.scope).toEqual({ kind: "session", baseSha: await headSha(next.path) });
		expect(payload.review.sessionId).not.toBe(prior.review.sessionId);
		expect(payload.viewToken).not.toBe(prior.viewToken);
		expect(rig.harness.tabCreateCount).toBe(1);
	});

	for (const changed of ["session", "cwd"] as const) {
		test(`/diff abandons a selection when ${changed} changes while the picker is open`, async () => {
			const rig = await freshRig();
			cleaners.push(rig.cleanup);
			const before = rig.harness.exec.calls.length;
			const renames = [...rig.harness.renames];
			rig.ctx.ui.select = async () => {
				if (changed === "session") rig.ctx.sessionManager.getSessionId = () => "replacement";
				else rig.ctx.sessionManager.getCwd = () => nodeOs.tmpdir();
				return "Full session";
			};
			await rig.host.commands.diff.handler("", rig.ctx);
			expect(rig.harness.exec.calls.length).toBe(before);
			expect(rig.harness.focusCount).toBe(0);
			expect(rig.harness.renames).toEqual(renames);
			expect(rig.session.notifications.at(-1)).toContain("cancelled");
		});
	}

	for (const choices of [
		[undefined], ["Against a base branch", undefined], ["Specific commit", undefined],
	]) {
		test(`/diff cancellation at ${choices[0] ?? "root"} leaves even a closed companion alone`, async () => {
			const rig = await freshRig();
			cleaners.push(rig.cleanup);
			rig.harness.panes.clear();
			const lifecycle = [...rig.session.intervals.values()].find(timer => timer.ms === 3_000);
			lifecycle?.callback();
			// Await the same tick through the next read before opening the selector.
			await rig.host.tools.hunk_review.execute("read", {}, undefined, undefined, rig.ctx);
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

	test("large reviews spill losslessly to an artifact", async () => {
		const rig = await freshRig();
		cleaners.push(rig.cleanup);
		rig.harness.reviewNotes = [
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
		expect(saved.review.reviewNotes).toEqual(rig.harness.reviewNotes);
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
		expect(beforeHandlers.length).toBe(1);

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
