import { afterEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import * as nodeFs from "node:fs/promises";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import guidanceSource from "./guidance.md" with { type: "text" };
import {
	FakeTimers,
	createHerdrHarness,
	createTempRepo,
	harnessEnv,
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
	mode: "tui";
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
}

function createFakeContext(repoPath: string, artifactsDir: string, session: FakeSession): FakeContext {
	const scheduled: Array<() => void> = [];
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
		setInterval: () => ({}),
		setTimeout: callback => {
			scheduled.push(callback);
			return {};
		},
		clearTimer: () => {},
	};
	// Expose scheduled callbacks for the rig to run startup inline.
	(session as FakeSession & { scheduled: Array<() => void> }).scheduled = scheduled;
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

async function freshRig(): Promise<Rig> {
	const { default: hunkCompanionExtension } = await import("./index");
	const repo = await createTempRepo(["line one", "line two", "line three"]);
	const stateDir = await nodeFs.mkdtemp(nodePath.join(nodeOs.tmpdir(), "hunk-fb-state-"));
	const artifactsDir = await nodeFs.mkdtemp(nodePath.join(nodeOs.tmpdir(), "hunk-fb-art-"));
	const harness = createHerdrHarness();
	harness.repoRootForLaunch = repo.path;
	const env = harnessEnv(stateDir);
	// The factory reads eligibility from process.env at construction time.
	overrideEnv(env);
	const host = createFakeHost((command, args, options) => harness.exec.run(command, args, options));
	hunkCompanionExtension(host.pi);
	const session: FakeSession = {
		notifications: [],
		selectCalls: [],
		selections: [],
		savedArtifacts: [],
	};
	const ctx = createFakeContext(repo.path, artifactsDir, session);

	const startHandlers = host.handlers.session_start ?? [];
	expect(startHandlers.length).toBe(1);
	await startHandlers[0]({}, ctx);
	// The factory schedules initialization via ctx.setTimeout(0); run the
	// scheduled callbacks inline so startup proceeds without real timers.
	const scheduled = (session as FakeSession & { scheduled: Array<() => void> }).scheduled;
	for (const callback of scheduled.splice(0)) callback();
	const review = host.tools.hunk_review;
	expect(review).toBeDefined();
	// Drive startup to readiness by polling the review tool. The controller
	// spawns real git children here, and back-to-back setImmediate spins starve
	// Bun's I/O polling — sleep-yield so the child processes can complete.
	let ready = false;
	let lastProbe = "";
	for (let iteration = 0; iteration < 2_000 && !ready; iteration += 1) {
		const result = await review.execute("probe", {}, undefined, undefined, ctx);
		lastProbe = result.content[0]?.text ?? "";
		ready = lastProbe.includes("viewToken");
		if (!ready) await Bun.sleep(2);
	}
	if (!ready) {
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
	test("hunk_review returns the live review with a view token", async () => {
		const rig = await freshRig();
		cleaners.push(rig.cleanup);
		const payload = await reviewPayload(rig);
		expect(typeof payload.viewToken).toBe("string");
		expect(Array.isArray(payload.review.files)).toBe(true);
	});

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
		expect(rig.session.savedArtifacts[0]?.content).toContain("x".repeat(100));
		expect(rig.session.savedArtifacts[0]?.toolType).toBe("hunk-review");
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

	test("multiline quoted summaries pass through argv unchanged", async () => {
		const rig = await freshRig();
		cleaners.push(rig.cleanup);
		const { viewToken } = await reviewPayload(rig);
		const summary = "keep this line\nand this 'quoted' part";
		await rig.host.tools.hunk_comment.execute(
			"call",
			{ kind: "line", viewToken, filePath: "seed.txt", side: "new", line: 2, summary },
			undefined,
			undefined,
			rig.ctx,
		);
		expect(rig.harness.adds).toBe(1);
		expect(rig.harness.lastAddArgs).toContain(summary);
		expect(rig.harness.lastAddArgs).toContain("--author");
		expect(rig.harness.lastAddArgs).toContain("omp");
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

	test("reply forwards reply-to without file or line", async () => {
		const rig = await freshRig();
		cleaners.push(rig.cleanup);
		const { viewToken } = await reviewPayload(rig);
		await rig.host.tools.hunk_comment.execute(
			"call",
			{ kind: "reply", viewToken, replyTo: "user:9", summary: "addressed" },
			undefined,
			undefined,
			rig.ctx,
		);
		expect(rig.harness.adds).toBe(1);
		expect(rig.harness.lastAddArgs).toContain("--reply-to");
		expect(rig.harness.lastAddArgs).toContain("user:9");
		expect(rig.harness.lastAddArgs).not.toContain("--file");
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

		const reloads = rig.harness.exec.calls.filter(
			call => call.command === "hunk" && call.args[1] === "reload",
		);
		expect(reloads.length).toBeGreaterThanOrEqual(1);
		const reloadArgs = reloads.at(-1)?.args ?? [];
		expect(reloadArgs).toContain("--watch");
		expect(reloadArgs.join(" ")).toMatch(/-- diff [0-9a-f]{40} --watch/);
		expect(rig.harness.focusCount).toBe(1);
	});
});
