import { afterEach, describe, expect, test } from "bun:test";
import * as nodeFs from "node:fs/promises";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import {
	CompanionController,
	PENDING_OWNERSHIP_MESSAGE,
	SECONDARY_INACTIVE_MESSAGE,
	type CompanionDeps,
	type ParentSnapshot,
} from "./companion";
import type { ExecOutcome } from "../exec";
import { companionRecordPath, primaryRoleLockPath, type CompanionRecord } from "./storage";
import {
	FakeTimers,
	HARNESS_AGENT_PANE,
	HARNESS_AGENT_TAB,
	HARNESS_SOCKET,
	HARNESS_WORKSPACE,
	canon,
	createHerdrHarness,
	createHarnessLocks,
	createTempRepo,
	harnessEnv,
	harnessFail,
	herdrAbsent,
	herdrTransient,
	headSha,
	killedOutcome,
	type GitFixture,
	type Harness,
	type HarnessLocks,
	type HarnessSession,
} from "../test-helpers";

interface TestContext {
	harness: Harness;
	locks: HarnessLocks;
	timers: FakeTimers;
	controller: CompanionController;
	deps: CompanionDeps;
	repo: GitFixture;
	artifactsDir: string;
	artifactsFile: string;
	stateDir: string;
	notifications: string[];
	recordPath: string;
	sidecarPath: string;
	lockPath: string;
	desired: ParentSnapshot;
	cleanup(): Promise<void>;
}

const cleaners: Array<() => Promise<void>> = [];
afterEach(async () => {
	while (cleaners.length > 0) {
		const clean = cleaners.pop();
		if (clean) await clean();
	}
});

async function freshContext(): Promise<TestContext> {
	const repo = await createTempRepo(["line one", "line two", "line three"]);
	const stateDir = await nodeFs.mkdtemp(nodePath.join(nodeOs.tmpdir(), "herdr-ext-state-"));
	const artifactsDir = await nodeFs.mkdtemp(nodePath.join(nodeOs.tmpdir(), "herdr-ext-artifacts-"));
	const locks = createHarnessLocks();
	const harness = createHerdrHarness(locks);
	harness.repoRootForLaunch = repo.path;
	const env = { ...harnessEnv(stateDir), HERDR_TAB_ID: "w1:t0" };
	const notifications: string[] = [];
	const deps: CompanionDeps = {
		exec: (command, args, opts) => harness.exec.run(command, args, opts),
		env,
		timers: harness.timers,
		logger: { debug() {}, info() {}, warn() {}, error() {} },
		notify: message => {
			notifications.push(message);
		},
		hunkPath: "hunk",
		tryPrimaryLock: harness.tryPrimaryLock,
		controllerPid: process.pid,
		isProcessAlive: pid => harness.isProcessAlive(pid),
	};
	const controller = new CompanionController(deps);
	const recordPath = companionRecordPath(env, HARNESS_SOCKET, HARNESS_WORKSPACE);
	const desired = controller.observeParent({
		ompSessionId: "omp-1",
		artifactsDir,
		cwd: repo.path,
	});
	return {
		harness,
		locks,
		timers: harness.timers,
		controller,
		deps,
		repo,
		artifactsDir,
		artifactsFile: nodePath.join(artifactsDir, "hunk", "review-notes.json"),
		stateDir,
		notifications,
		recordPath,
		sidecarPath: `${recordPath}.launch.json`,
		lockPath: primaryRoleLockPath(env, HARNESS_SOCKET, HARNESS_WORKSPACE),
		desired,
		async cleanup() {
			await repo.cleanup();
			await nodeFs.rm(stateDir, { recursive: true, force: true });
			await nodeFs.rm(artifactsDir, { recursive: true, force: true });
		},
	};
}

/** Observe a new parent context (the controller-side entry every event uses). */
function observe(
	ctx: TestContext,
	ompSessionId: string,
	overrides?: { cwd?: string; artifactsDir?: string },
): ParentSnapshot {
	ctx.desired = ctx.controller.observeParent({
		ompSessionId,
		artifactsDir: overrides?.artifactsDir ?? ctx.artifactsDir,
		cwd: overrides?.cwd ?? ctx.repo.path,
	});
	return ctx.desired;
}

/** Admit (expecting primary) and run the first reconciliation to readiness. */
async function startPrimary(ctx: TestContext): Promise<void> {
	const role = await ctx.controller.admit();
	expect(role).toBe("primary");
	await ctx.controller.reconcile(ctx.desired);
}

function childPaneIds(ctx: TestContext): string[] {
	return [...ctx.harness.panes.keys()].filter(id => id !== HARNESS_AGENT_PANE);
}

function closeCalls(ctx: TestContext, paneId?: string): number {
	return ctx.harness.exec.callsTo("herdr", ["pane", "close", ...(paneId ? [paneId] : [])]).length;
}

async function fileExists(path: string): Promise<boolean> {
	return nodeFs
		.access(path)
		.then(() => true, () => false);
}

async function seedRecord(ctx: TestContext, record: Partial<CompanionRecord>): Promise<void> {
	const full: CompanionRecord = {
		version: 1,
		socketPath: HARNESS_SOCKET,
		workspaceId: HARNESS_WORKSPACE,
		ownerPaneId: HARNESS_AGENT_PANE,
		tabId: "w1:t1",
		paneId: "w1:p1",
		repoRoot: "/repo",
		...record,
	};
	await nodeFs.mkdir(nodePath.dirname(ctx.recordPath), { recursive: true });
	await Bun.write(ctx.recordPath, `${JSON.stringify(full)}\n`);
}

async function readRecord(ctx: TestContext): Promise<Record<string, unknown>> {
	return JSON.parse(await nodeFs.readFile(ctx.recordPath, "utf8")) as Record<string, unknown>;
}

async function sidecarExists(ctx: TestContext): Promise<boolean> {
	return fileExists(ctx.sidecarPath);
}

/** Commit every change in a fixture repo (fixtures disable signing/hooks). */
async function commitAll(repoPath: string): Promise<string> {
	const run = async (args: string[]): Promise<void> => {
		const proc = Bun.spawn(["git", ...args], { cwd: repoPath, stdout: "pipe", stderr: "pipe" });
		const code = await proc.exited;
		if (code !== 0) throw new Error(`git ${args.join(" ")} failed`);
	};
	await run(["add", "-A"]);
	await run(["commit", "-m", "advance"]);
	const proc = Bun.spawn(["git", "rev-parse", "HEAD"], { cwd: repoPath, stdout: "pipe" });
	return (await new Response(proc.stdout).text()).trim();
}

/**
 * Drive fake timers for the lifetime of one awaited operation. Controller poll
 * loops register sleeps asynchronously (and real-git spawns open real-time
 * gaps), so pump on a fixed step until the operation settles.
 */
async function withPump<T>(ctx: TestContext, operation: Promise<T>, stepMs = 1_000): Promise<T> {
	let stopped = false;
	void (async () => {
		while (!stopped) {
			await ctx.timers.advance(stepMs);
			await new Promise<void>(resolve => setImmediate(resolve));
		}
	})();
	try {
		return await operation;
	} finally {
		stopped = true;
	}
}

/** Spin microtasks until one notification contains the fragment (no real timers). */
async function waitForNotification(ctx: TestContext, fragment: string): Promise<void> {
	for (;;) {
		if (ctx.notifications.some(message => message.includes(fragment))) return;
		await new Promise<void>(resolve => setImmediate(resolve));
	}
}

/** Spin microtasks until the recorded exec log shows `count` matching calls. */
async function waitForExecCalls(
	ctx: TestContext,
	count: number,
	command: string,
	prefix: string[],
): Promise<void> {
	for (;;) {
		if (ctx.harness.exec.callsTo(command, prefix).length >= count) return;
		await new Promise<void>(resolve => setImmediate(resolve));
	}
}

interface CallGate {
	/** Resolves once the targeted call entered the gate. */
	entered: Promise<void>;
	/** Settles the gated call with `outcome()` evaluated at release time. */
	release(): void;
	dispose(): void;
}

/**
 * Hold the Nth matching exec call (1-indexed) until released, modeling an
 * await parked mid-flight while the test mutates harness state. Later calls
 * fall through to the normal handlers.
 */
function gateNthCall(ctx: TestContext, command: string, prefix: string[], nth: number, outcome: () => ExecOutcome): CallGate {
	let seen = 0;
	const { promise: entered, resolve: enteredResolve } = Promise.withResolvers<void>();
	const { promise: held, resolve: releaseHeld } = Promise.withResolvers<void>();
	const dispose = ctx.harness.exec.override(
		call => {
			if (call.command !== command || !prefix.every((part, index) => call.args[index] === part)) return false;
			seen += 1;
			return seen === nth;
		},
		() => {
			enteredResolve();
			return held.then(outcome);
		},
	);
	return {
		entered,
		release: () => releaseHeld(),
		dispose,
	};
}

/** Remove a live child Hunk from the registry and mark its PID dead. */
function killChildHunk(ctx: TestContext, paneId: string): HarnessSession {
	const pane = ctx.harness.panes.get(paneId);
	if (pane === undefined) throw new Error(`missing fixture pane ${paneId}`);
	const pid = pane.foreground.find(candidate =>
		ctx.harness.sessions.some(session => session.pid === candidate),
	);
	const session = ctx.harness.sessions.find(entry => entry.pid === pid);
	if (session === undefined) throw new Error("no live child session to kill");
	ctx.harness.sessions = ctx.harness.sessions.filter(entry => entry !== session);
	ctx.harness.killProcess(session.pid);
	pane.foreground = pane.foreground.filter(candidate => candidate !== session.pid);
	return session;
}

/** Drive herdr's pane close; the harness handler models pid death and session removal. */
async function closePaneLikeHerdr(ctx: TestContext, paneId: string): Promise<void> {
	await ctx.harness.exec.run("herdr", ["pane", "close", paneId]);
}

/** Seed a verified standalone child pane + registered Hunk session + record. */
async function seedLiveChild(
	ctx: TestContext,
): Promise<{ session: HarnessSession; paneId: string; tabId: string; shellPid: number }> {
	const shellPid = ++ctx.harness.nextPid;
	const paneId = "w1:p1";
	const tabId = "w1:t1";
	ctx.harness.panes.set(paneId, { tabId, shellPid, foreground: [] });
	ctx.harness.registered = true;
	const session = ctx.harness.addSession(await canon(ctx.repo.path), paneId);
	await seedRecord(ctx, {
		tabId,
		paneId,
		shellPid,
		repoRoot: await canon(ctx.repo.path),
		hunkSessionId: session.sessionId,
		hunkPid: session.pid,
	});
	return { session, paneId, tabId, shellPid };
}

describe("admission and role", () => {
	test("racing admissions decide exactly one primary and one secondary", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		const second = new CompanionController(ctx.deps);
		second.observeParent({ ompSessionId: "omp-2", artifactsDir: ctx.artifactsDir, cwd: ctx.repo.path });

		const [firstRole, secondRole] = await Promise.all([ctx.controller.admit(), second.admit()]);
		expect([firstRole, secondRole].sort()).toEqual(["primary", "secondary"]);
		expect(ctx.harness.locks.holds(ctx.lockPath)).toBe(true);
		expect(ctx.harness.tabCreateCount).toBe(0);

		// A decided role is never retried.
		expect(await ctx.controller.admit()).toBe(firstRole);
		expect(await second.admit()).toBe(secondRole);
	});

	test("a successor claims the lock only after the previous primary's process exit", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		expect(await ctx.controller.admit()).toBe("primary");

		// While the first process lives, a newcomer stays secondary.
		const newcomer = new CompanionController(ctx.deps);
		expect(await newcomer.admit()).toBe("secondary");

		ctx.harness.locks.simulateProcessExit(ctx.lockPath);
		const successor = new CompanionController(ctx.deps);
		expect(await successor.admit()).toBe("primary");
		expect(ctx.harness.locks.holds(ctx.lockPath)).toBe(true);

		// Demoted processes keep their decided role; they never re-contest.
		expect(await newcomer.admit()).toBe("secondary");
		expect(await ctx.controller.admit()).toBe("primary");
	});

	test("native or filesystem failures stay pending, notify once, and mutate nothing", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		ctx.harness.locks.failAcquires(new Error("FileLock unavailable"));

		expect(await ctx.controller.admit()).toBe("pending");
		expect(await ctx.controller.admit()).toBe("pending");
		expect(ctx.notifications.filter(message => message.includes("could not claim workspace ownership")).length).toBe(1);
		expect(ctx.harness.tabCreateCount).toBe(0);
		expect(ctx.harness.locks.holds(ctx.lockPath)).toBe(false);

		// Pending admission gates tools with the ownership message.
		const capture = await ctx.controller.captureStable();
		expect(capture.ok).toBe(false);
		expect(capture.reason).toBe(PENDING_OWNERSHIP_MESSAGE);

		ctx.harness.locks.failAcquires(null);
		expect(await ctx.controller.admit()).toBe("primary");
	});
});

describe("primary startup and child creation", () => {
	test("fresh launch binds by pid, clears notes once, records ownership, and snapshots", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		await startPrimary(ctx);

		expect(ctx.controller.childState).toBe("ready");
		expect(ctx.controller.isReady).toBe(true);
		expect(ctx.harness.tabCreateCount).toBe(1);
		expect(ctx.harness.clears).toBe(1);
		expect(ctx.controller.scope).toEqual({ kind: "session", baseSha: await headSha(ctx.repo.path) });

		// The child tab is created unfocused with the literal label; the
		// controller itself never renames tabs.
		const create = ctx.harness.exec.callsTo("herdr", ["tab", "create"])[0];
		expect(create?.args).toContain("diff");
		expect(create?.args).toContain("--no-focus");
		expect(ctx.harness.renames).toEqual([]);

		const launch = ctx.harness.launchedCommands[0];
		expect(launch).toContain(`cd -- '${await canon(ctx.repo.path)}'`);
		expect(launch).toContain(`'hunk' diff`);
		expect(launch).toContain(`--watch --agent-notes`);

		const session = ctx.harness.sessions[0];
		const record = await readRecord(ctx);
		expect(record.hunkSessionId).toBe(session.sessionId);
		expect(record.hunkPid).toBe(session.pid);
		expect(record.repoRoot).toBe(await canon(ctx.repo.path));
		expect(record.ownerPaneId).toBe(HARNESS_AGENT_PANE);
		expect(await sidecarExists(ctx)).toBe(false);

		const snapshot = JSON.parse(await nodeFs.readFile(ctx.artifactsFile, "utf8")) as Record<string, unknown>;
		expect(snapshot.version).toBe(1);
		expect(snapshot.hunkSessionId).toBe(session.sessionId);
		expect(snapshot.ompSessionId).toBe("omp-1");
		expect(snapshot.scope).toEqual({ kind: "session", baseSha: await headSha(ctx.repo.path) });
	});

	test("controller pane identity change pauses management without touching any tab", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		await startPrimary(ctx);
		const paneId = childPaneIds(ctx)[0];
		const createsBefore = ctx.harness.tabCreateCount;
		const closesBefore = closeCalls(ctx);

		const agentPane = ctx.harness.panes.get(HARNESS_AGENT_PANE);
		if (!agentPane) throw new Error("missing agent pane fixture");
		agentPane.foreground = agentPane.foreground.filter(pid => pid !== process.pid);
		observe(ctx, "omp-1");
		await ctx.controller.reconcile(ctx.desired);
		expect(ctx.notifications.some(message => message.includes("pane identity changed"))).toBe(true);

		// A tab-id mismatch in the env is the same reservation break.
		(ctx.deps.env as Record<string, string | undefined>).HERDR_TAB_ID = "w1:tX";
		observe(ctx, "omp-1");
		await ctx.controller.reconcile(ctx.desired);

		expect(ctx.harness.tabCreateCount).toBe(createsBefore);
		expect(closeCalls(ctx)).toBe(closesBefore);
		expect(ctx.harness.panes.has(paneId)).toBe(true);
	});

	test("same-repo foreign session never binds; the owned pane's session does", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		const root = await canon(ctx.repo.path);
		ctx.harness.registered = true;
		ctx.harness.sessions.push({
			sessionId: "foreign",
			pid: ++ctx.harness.nextPid,
			cwd: root,
			repoRoot: root,
			generation: "gen-1",
			stateRevision: 1,
			notes: [],
		});

		await startPrimary(ctx);

		expect(ctx.controller.isReady).toBe(true);
		const pane = ctx.harness.panes.get(childPaneIds(ctx)[0]);
		expect(pane?.foreground.length).toBe(1);
		const ownedPid = pane?.foreground[0];
		expect(ownedPid).not.toBe(ctx.harness.sessions[0].pid);
		const bound = ctx.harness.sessions.find(entry => entry.pid === ownedPid);
		expect(bound?.sessionId.startsWith("sess-")).toBe(true);
		const record = await readRecord(ctx);
		expect(record.hunkSessionId).toBe(bound?.sessionId);
		expect(record.hunkPid).toBe(ownedPid);
		expect(ctx.harness.clears).toBe(1);
	});
});

describe("replacement by a newly admitted primary", () => {
	test("successor replaces the retained child by recorded ids and never adopts its review", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		await startPrimary(ctx);
		const oldPaneId = childPaneIds(ctx)[0];
		const oldSession = ctx.harness.sessions[0];
		oldSession.notes = [{ noteId: "n1", body: "kept in A only" }];

		await ctx.controller.shutdown(1_500);
		ctx.harness.locks.simulateProcessExit(ctx.lockPath);

		const successor = new CompanionController(ctx.deps);
		successor.observeParent({ ompSessionId: "omp-1", artifactsDir: ctx.artifactsDir, cwd: ctx.repo.path });
		expect(await successor.admit()).toBe("primary");
		await successor.reconcile(ctx.desired);

		// The verified retained child was closed before the fresh launch.
		expect(closeCalls(ctx, oldPaneId)).toBe(1);
		expect(ctx.harness.panes.has(oldPaneId)).toBe(false);
		expect(ctx.harness.sessions.some(entry => entry.sessionId === oldSession.sessionId)).toBe(false);
		expect(ctx.harness.tabCreateCount).toBe(2);

		const record = await readRecord(ctx);
		expect(record.hunkSessionId).not.toBe(oldSession.sessionId);
		const boundSession = ctx.harness.sessions.find(entry => entry.sessionId === record.hunkSessionId);
		expect(boundSession?.notes).toEqual([]);
	});

	test("indeterminate child identity blocks destructive recovery and creation", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		// Retained child whose foreground was replaced by a foreign process.
		const shellPid = ++ctx.harness.nextPid;
		ctx.harness.panes.set("w1:p1", { tabId: "w1:t1", shellPid, foreground: [] });
		ctx.harness.registered = true;
		const session = ctx.harness.addSession(await canon(ctx.repo.path), "w1:p1");
		const occupied = ctx.harness.panes.get("w1:p1");
		// The foreign process replaced the review in the pane foreground.
		if (occupied !== undefined) occupied.foreground = [++ctx.harness.nextPid];
		await seedRecord(ctx, {
			tabId: "w1:t1",
			paneId: "w1:p1",
			shellPid,
			repoRoot: await canon(ctx.repo.path),
			hunkSessionId: session.sessionId,
			hunkPid: session.pid,
		});

		expect(await ctx.controller.admit()).toBe("primary");
		await ctx.controller.reconcile(ctx.desired);

		// Unproven ownership closes and creates nothing; every durable proof stays.
		expect(closeCalls(ctx, "w1:p1")).toBe(0);
		expect(ctx.harness.tabCreateCount).toBe(0);
		expect(ctx.harness.panes.has("w1:p1")).toBe(true);
		expect(ctx.harness.sessions.some(entry => entry.sessionId === session.sessionId)).toBe(true);
		expect(await fileExists(ctx.recordPath)).toBe(true);
	});

	test("an identity-only record reports the unknown creation outcome and creates nothing", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		ctx.harness.panes.set("w1:p1", { tabId: "w1:t1", shellPid: ++ctx.harness.nextPid, foreground: [] });
		await seedRecord(ctx, { tabId: "w1:t1", paneId: "w1:p1", repoRoot: "/repo" });
		await Bun.write(ctx.sidecarPath, `${JSON.stringify({ version: 1, nonce: "stale" })}\n`);

		expect(await ctx.controller.admit()).toBe("primary");
		await ctx.controller.reconcile(ctx.desired);

		expect(ctx.notifications.some(message => message.includes("creation outcome is unknown"))).toBe(true);
		expect(ctx.harness.tabCreateCount).toBe(0);
		expect(await sidecarExists(ctx)).toBe(true);
		expect(await fileExists(ctx.recordPath)).toBe(true);
	});

	test("a stale sidecar without a record blocks creation until inspected", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		await Bun.write(ctx.sidecarPath, `${JSON.stringify({ version: 1, nonce: "lost" })}\n`);

		expect(await ctx.controller.admit()).toBe("primary");
		await ctx.controller.reconcile(ctx.desired);

		expect(ctx.notifications.some(message => message.includes("creation outcome is unknown"))).toBe(true);
		expect(ctx.harness.tabCreateCount).toBe(0);
		expect(await sidecarExists(ctx)).toBe(true);
	});

	test("a malformed launch intent is retained unmodified and never duplicated", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		await nodeFs.mkdir(nodePath.dirname(ctx.sidecarPath), { recursive: true });
		await Bun.write(ctx.sidecarPath, "{not-json");
		expect(await ctx.controller.admit()).toBe("primary");
		await ctx.controller.reconcile(ctx.desired);

		expect(ctx.harness.tabCreateCount).toBe(0);
		expect(await nodeFs.readFile(ctx.sidecarPath, "utf8")).toBe("{not-json");
		expect(await fileExists(ctx.recordPath)).toBe(false);

		// Later drains keep refusing: an unreadable intent is never replaced.
		observe(ctx, "omp-1");
		await ctx.controller.reconcile(ctx.desired);
		expect(ctx.harness.tabCreateCount).toBe(0);
		expect(await nodeFs.readFile(ctx.sidecarPath, "utf8")).toBe("{not-json");
	});

	test("a malformed sidecar retains the retired child's record and blocks re-creation", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		const shellPid = ++ctx.harness.nextPid;
		ctx.harness.panes.set("w1:p1", { tabId: "w1:t1", shellPid, foreground: [] });
		await seedRecord(ctx, {
			tabId: "w1:t1",
			paneId: "w1:p1",
			shellPid,
			repoRoot: await canon(ctx.repo.path),
		});
		await nodeFs.mkdir(nodePath.dirname(ctx.sidecarPath), { recursive: true });
		await Bun.write(ctx.sidecarPath, "{not-json");

		expect(await ctx.controller.admit()).toBe("primary");
		await ctx.controller.reconcile(ctx.desired);

		// The verified idle-shell child was retired, but the undeletable intent
		// retains the record: no replacement is created until both are resolved.
		expect(closeCalls(ctx, "w1:p1")).toBe(1);
		expect(ctx.harness.tabCreateCount).toBe(0);
		expect(await fileExists(ctx.recordPath)).toBe(true);
		expect(await nodeFs.readFile(ctx.sidecarPath, "utf8")).toBe("{not-json");
	});

	test("a pane report with no shell proof never authorizes retirement", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		const shellPid = ++ctx.harness.nextPid;
		ctx.harness.panes.set("w1:p1", { tabId: "w1:t1", shellPid, foreground: [] });
		await seedRecord(ctx, {
			tabId: "w1:t1",
			paneId: "w1:p1",
			shellPid,
			repoRoot: await canon(ctx.repo.path),
		});
		// The pane's process report lost its shell identity entirely: an empty
		// foreground must not be read as this pane's idle shell.
		const undo = ctx.harness.exec.override(
			call =>
				call.command === "herdr" &&
				call.args[0] === "pane" &&
				call.args[1] === "process-info" &&
				call.args[3] === "w1:p1",
			call => ({
				stdout: JSON.stringify({
					result: { process_info: { pane_id: call.args[3] ?? "", foreground_processes: [] } },
				}),
				stderr: "",
				code: 0,
				killed: false,
			}),
		);
		expect(await ctx.controller.admit()).toBe("primary");
		await ctx.controller.reconcile(ctx.desired);
		undo();

		expect(closeCalls(ctx, "w1:p1")).toBe(0);
		expect(ctx.harness.tabCreateCount).toBe(0);
		expect(ctx.harness.panes.has("w1:p1")).toBe(true);
		expect(await fileExists(ctx.recordPath)).toBe(true);
	});

	test("a lost tab-create reply retains the launch intent and never duplicates", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		expect(await ctx.controller.admit()).toBe("primary");
		const undo = ctx.harness.exec.override(
			call => call.command === "herdr" && call.args[0] === "tab" && call.args[1] === "create",
			() => killedOutcome(),
		);
		await ctx.controller.reconcile(ctx.desired);
		undo();

		expect(ctx.harness.tabCreateCount).toBe(0);
		expect(await sidecarExists(ctx)).toBe(true);
		expect(await fileExists(ctx.recordPath)).toBe(false);

		// The next startup still refuses to create on top of the unknown outcome.
		observe(ctx, "omp-1");
		await ctx.controller.reconcile(ctx.desired);
		expect(ctx.harness.tabCreateCount).toBe(0);
		expect(await sidecarExists(ctx)).toBe(true);
	});

	test("shell-qualified provisional record is retired by a successor, sidecar before record", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		const shellPid = ++ctx.harness.nextPid;
		// A true original idle shell: the recorded shell is the pane's only
		// foreground process, and the launch intent sidecar is still intact.
		ctx.harness.panes.set("w1:p1", { tabId: "w1:t1", shellPid, foreground: [shellPid] });
		await seedRecord(ctx, {
			tabId: "w1:t1",
			paneId: "w1:p1",
			shellPid,
			repoRoot: await canon(ctx.repo.path),
		});
		await Bun.write(
			ctx.sidecarPath,
			`${JSON.stringify({
				version: 1,
				socketPath: HARNESS_SOCKET,
				workspaceId: HARNESS_WORKSPACE,
				ownerPaneId: HARNESS_AGENT_PANE,
				controllerPid: 1,
				nonce: "pending",
			})}\n`,
		);

		expect(await ctx.controller.admit()).toBe("primary");
		await ctx.controller.reconcile(ctx.desired);

		// The provisional pane was closed and the fresh child created under a new
		// identity; neither old durable file survives.
		expect(ctx.harness.panes.has("w1:p1")).toBe(false);
		expect(await sidecarExists(ctx)).toBe(false);
		const record = await readRecord(ctx);
		expect(record.paneId).not.toBe("w1:p1");
		expect(ctx.harness.tabCreateCount).toBe(1);
	});
});

describe("parent transitions and scope retention", () => {
	test("new omp session id archives the old view, retires it, and yields a clean fresh child", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		await startPrimary(ctx);
		const oldPaneId = childPaneIds(ctx)[0];
		const oldSession = ctx.harness.sessions[0];
		oldSession.notes = [{ noteId: "n1", body: "human note" }];
		const stableBefore = await ctx.controller.captureStable();
		expect(stableBefore.ok).toBe(true);
		const staleToken = stableBefore.capture?.viewToken ?? "";

		const nextArtifacts = await nodeFs.mkdtemp(nodePath.join(nodeOs.tmpdir(), "herdr-ext-next-"));
		cleaners.push(async () => nodeFs.rm(nextArtifacts, { recursive: true, force: true }));
		observe(ctx, "omp-2", { artifactsDir: nextArtifacts });
		await ctx.controller.reconcile(ctx.desired);

		// The old bound view was archived to the old parent's destination before
		// retirement; the envelope still carries the old parent identity.
		const oldEnvelope = JSON.parse(await nodeFs.readFile(ctx.artifactsFile, "utf8")) as Record<string, unknown>;
		expect(oldEnvelope.ompSessionId).toBe("omp-1");
		expect(oldEnvelope.hunkSessionId).toBe(oldSession.sessionId);

		expect(ctx.harness.panes.has(oldPaneId)).toBe(false);
		expect(ctx.harness.sessions.some(entry => entry.sessionId === oldSession.sessionId)).toBe(false);
		expect(ctx.harness.tabCreateCount).toBe(2);

		const record = await readRecord(ctx);
		expect(record.hunkSessionId).not.toBe(oldSession.sessionId);
		const newArchive = JSON.parse(
			await nodeFs.readFile(nodePath.join(nextArtifacts, "hunk", "review-notes.json"), "utf8"),
		) as Record<string, unknown>;
		expect(newArchive.ompSessionId).toBe("omp-2");
		expect(JSON.stringify(newArchive.review)).not.toContain("human note");

		// A's view token never addresses the replacement child.
		const write = await ctx.controller.commentWrite(staleToken, { summary: "stale" });
		expect(write.ok).toBe(false);
		expect(write.error).toContain("hunk_review");
	});

	test("A -> B -> A discards a picker opened in the first A via the revision check", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		await startPrimary(ctx);
		const head = await headSha(ctx.repo.path);
		const snapshotA = observe(ctx, "omp-1"); // same id, fresh revision for the picker

		observe(ctx, "omp-2");
		await ctx.controller.reconcile(ctx.desired);
		observe(ctx, "omp-3");
		await ctx.controller.reconcile(ctx.desired);
		// Return to the ORIGINAL id: an identity-only guard would pass here and
		// apply the stale picker to the replacement child. Only the revision
		// check must protect this reincarnation.
		observe(ctx, "omp-1");
		await ctx.controller.reconcile(ctx.desired);

		const reloadsBefore = ctx.harness.exec.callsTo("hunk", ["session", "reload"]).length;
		const focusesBefore = ctx.harness.focusCount;
		await ctx.controller.selectScope({ kind: "commit", commitSha: head }, snapshotA);
		await ctx.controller.focusTab(snapshotA);
		// The original picker neither reloads nor focuses the replacement child.
		expect(ctx.harness.exec.callsTo("hunk", ["session", "reload"]).length).toBe(reloadsBefore);
		expect(ctx.harness.focusCount).toBe(focusesBefore);
		expect(ctx.controller.scope?.kind).toBe("session");
	});

	test("queue-time parent change cancels the queued selection and focus", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		await startPrimary(ctx);
		const head = await headSha(ctx.repo.path);
		const snapshotA = observe(ctx, "omp-1");

		const selection = ctx.controller.selectScope({ kind: "commit", commitSha: head }, snapshotA);
		observe(ctx, "omp-2");
		await ctx.controller.reconcile(ctx.desired);
		await selection;

		expect(ctx.controller.scope?.kind).toBe("session");
		const commitReloads = ctx.harness.exec.calls.filter(
			call => call.command === "hunk" && call.args[1] === "reload" && call.args.includes(head),
		);
		expect(commitReloads).toEqual([]);
	});

	test("child-only replacement keeps the pinned baseline and scope even as HEAD advances", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		await startPrimary(ctx);
		const head = await headSha(ctx.repo.path);
		const oldPaneId = childPaneIds(ctx)[0];
		const oldSession = ctx.harness.sessions[0];

		// Pin a commit scope, then advance the repository HEAD.
		await ctx.controller.selectScope({ kind: "commit", commitSha: head }, observe(ctx, "omp-1"));
		expect(ctx.controller.scope).toEqual({ kind: "commit", commitSha: head });
		await Bun.write(nodePath.join(ctx.repo.path, "extra.txt"), "advanced\n");
		const advancedHead = await commitAll(ctx.repo.path);
		expect(advancedHead).not.toBe(head);

		killChildHunk(ctx, oldPaneId);
		await closePaneLikeHerdr(ctx, oldPaneId);
		await ctx.controller.reconcile(ctx.desired);

		const newPaneId = childPaneIds(ctx).find(id => id !== oldPaneId);
		expect(newPaneId).toBeDefined();
		const record = await readRecord(ctx);
		expect(record.hunkSessionId).not.toBe(oldSession.sessionId);
		// The launch reused the pinned baseline, not the advanced HEAD.
		expect(ctx.harness.launchedCommands.at(-1)).toContain(`'${head}'`);
		const reload = ctx.harness.exec.calls
			.filter(call => call.command === "hunk" && call.args[1] === "reload")
			.at(-1);
		expect(reload?.args).toContain("show");
		expect(reload?.args).toContain(head);
	});

	test("a failed pinned-scope reload blocks export and annotation until the tick retries", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		await startPrimary(ctx);
		const head = await headSha(ctx.repo.path);
		await ctx.controller.selectScope({ kind: "commit", commitSha: head }, observe(ctx, "omp-1"));
		expect(ctx.controller.scope).toEqual({ kind: "commit", commitSha: head });

		// Replace the child while every pinned-scope reload fails.
		const oldPaneId = childPaneIds(ctx)[0];
		killChildHunk(ctx, oldPaneId);
		await closePaneLikeHerdr(ctx, oldPaneId);
		const undo = ctx.harness.exec.override(
			call => call.command === "hunk" && call.args[1] === "reload",
			() => harnessFail("reload down"),
		);
		observe(ctx, "omp-1");
		await ctx.controller.reconcile(ctx.desired);
		undo();
		expect(ctx.harness.tabCreateCount).toBe(2);
		expect(ctx.controller.childState).toBe("ready");

		// The new child still shows the wrong view: it must not be exportable or
		// annotatable while the pinned reload is unresolved.
		const blocked = await ctx.controller.captureStable();
		expect(blocked.ok).toBe(false);
		const denied = await ctx.controller.commentWrite("any-token", { summary: "x" });
		expect(denied.ok).toBe(false);
		expect(ctx.harness.adds).toBe(0);

		// The ordinary lifecycle tick retries the reload and unblocks the tools.
		const reloadsBeforeRetry = ctx.harness.exec.callsTo("hunk", ["session", "reload"]).length;
		observe(ctx, "omp-1");
		await ctx.controller.reconcile(ctx.desired);
		expect(ctx.harness.exec.callsTo("hunk", ["session", "reload"]).length).toBe(reloadsBeforeRetry + 1);
		const recovered = await ctx.controller.captureStable();
		expect(recovered.ok).toBe(true);
		expect(recovered.capture?.scope).toEqual({ kind: "commit", commitSha: head });
	});

	test("closing the child while the parent lives recreates it without /diff", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		await startPrimary(ctx);
		const oldPaneId = childPaneIds(ctx)[0];
		const oldSession = ctx.harness.sessions[0];

		await closePaneLikeHerdr(ctx, oldPaneId);
		observe(ctx, "omp-1");
		await ctx.controller.reconcile(ctx.desired);

		expect(ctx.harness.tabCreateCount).toBe(2);
		const record = await readRecord(ctx);
		expect(record.hunkSessionId).not.toBe(oldSession.sessionId);
		expect(ctx.controller.isReady).toBe(true);
	});

	test("a review that exited to its idle shell is retired with its pane and recreated", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		await startPrimary(ctx);
		const oldPaneId = childPaneIds(ctx)[0];
		const oldSession = killChildHunk(ctx, oldPaneId);

		observe(ctx, "omp-1");
		await ctx.controller.reconcile(ctx.desired);

		expect(closeCalls(ctx, oldPaneId)).toBe(1);
		expect(ctx.harness.panes.has(oldPaneId)).toBe(false);
		expect(ctx.harness.sessions.some(entry => entry.sessionId === oldSession.sessionId)).toBe(false);
		expect(ctx.harness.tabCreateCount).toBe(2);
		expect(ctx.controller.isReady).toBe(true);
	});

	test("cross-root movement archives, retires, and creates a fresh child for the new checkout", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		await startPrimary(ctx);
		const oldPaneId = childPaneIds(ctx)[0];
		const oldSession = ctx.harness.sessions[0];
		oldSession.notes = [{ noteId: "n1", body: "old root note" }];

		const other = await createTempRepo(["other one", "other two"]);
		cleaners.push(other.cleanup);
		ctx.harness.repoRootForLaunch = other.path;
		const otherHead = await headSha(other.path);
		observe(ctx, "omp-1", { cwd: other.path });

		// Hold the retirement close: the old root's review must already be
		// archived while the old pane is still being closed.
		ctx.harness.hangClose = true;
		const draining = ctx.controller.reconcile(ctx.desired);
		await waitForExecCalls(ctx, 1, "herdr", ["pane", "close"]);
		const oldEnvelope = JSON.parse(await nodeFs.readFile(ctx.artifactsFile, "utf8")) as Record<string, unknown>;
		expect(oldEnvelope.hunkSessionId).toBe(oldSession.sessionId);
		expect(JSON.stringify(oldEnvelope.review)).toContain("old root note");

		ctx.harness.hangClose = false;
		ctx.harness.releaseClose();
		await draining;

		// The fresh child publishes a clean archive for the new checkout; the old
		// parent's notes never leak into it.
		const envelope = JSON.parse(await nodeFs.readFile(ctx.artifactsFile, "utf8")) as Record<string, unknown>;
		expect(envelope.hunkSessionId).not.toBe(oldSession.sessionId);
		expect(JSON.stringify(envelope.review)).not.toContain("old root note");
		expect(closeCalls(ctx, oldPaneId)).toBe(1);
		expect(ctx.harness.tabCreateCount).toBe(2);
		expect(ctx.controller.repoRoot).toBe(await canon(other.path));
		expect(ctx.controller.baselineHead).toBe(otherHead);
		expect(ctx.harness.launchedCommands.at(-1)).toContain(`cd -- '${await canon(other.path)}'`);
		expect(ctx.harness.launchedCommands.at(-1)).toContain(`'${otherHead}'`);
	});

	test("same-checkout cwd movement is not a reset: child, notes, and scope survive", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		await startPrimary(ctx);
		const childSession = ctx.harness.sessions[0];
		childSession.notes = [{ noteId: "n1", body: "kept" }];
		const subDir = nodePath.join(ctx.repo.path, "sub");
		await nodeFs.mkdir(subDir, { recursive: true });

		observe(ctx, "omp-1", { cwd: subDir });
		await ctx.controller.reconcile(ctx.desired);

		expect(ctx.harness.tabCreateCount).toBe(1);
		expect(ctx.harness.sessions).toContain(childSession);
		expect(childSession.notes).toEqual([{ noteId: "n1", body: "kept" }]);
		expect(ctx.controller.isReady).toBe(true);
		// The revision still moved, so pre-move tokens are invalid.
		const stale = await ctx.controller.commentWrite("any-token", { summary: "x" });
		expect(stale.ok).toBe(false);
	});

	test("the replacement's pending scope blocks readiness until its reload lands", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		await startPrimary(ctx);
		const head = await headSha(ctx.repo.path);
		await ctx.controller.selectScope({ kind: "commit", commitSha: head }, observe(ctx, "omp-1"));
		expect(ctx.controller.scope).toEqual({ kind: "commit", commitSha: head });
		const archivedBefore = await nodeFs.readFile(ctx.artifactsFile, "utf8");

		// Externally replace the child; the recreation re-binds and must reload
		// the pinned commit scope onto the fresh, baseline-showing child.
		const oldPaneId = childPaneIds(ctx)[0];
		killChildHunk(ctx, oldPaneId);
		await closePaneLikeHerdr(ctx, oldPaneId);

		const gate = gateNthCall(ctx, "hunk", ["session", "reload"], 1, () => ({
			stdout: JSON.stringify({ result: { sessionId: ctx.harness.sessions.at(-1)?.sessionId } }),
			stderr: "",
			code: 0,
			killed: false,
		}));
		const draining = ctx.controller.reconcile(ctx.desired);
		await gate.entered;

		// Between the bind and the pinned reload the live review still shows the
		// baseline session view: readiness, capture, and archive must be blocked
		// instead of labeling the baseline view as the commit scope.
		expect(ctx.controller.isReady).toBe(false);
		const capture = await ctx.controller.captureStable();
		expect(capture.ok).toBe(false);
		expect(await ctx.controller.snapshotNow({ deadlineMs: 5_000 })).toBe(false);
		expect(await nodeFs.readFile(ctx.artifactsFile, "utf8")).toBe(archivedBefore);

		gate.release();
		await draining;
		gate.dispose();

		expect(ctx.controller.isReady).toBe(true);
		const recovered = await ctx.controller.captureStable();
		expect(recovered.ok).toBe(true);
		expect(recovered.capture?.scope).toEqual({ kind: "commit", commitSha: head });
	});

	test("a same-id cwd observation gates review until the applied context catches up", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		await startPrimary(ctx);
		const childSession = ctx.harness.sessions[0];
		childSession.notes = [{ noteId: "n1", body: "kept" }];

		// Same id, cwd moved within the same canonical checkout: review pauses
		// until a verified health reconciliation refreshes the applied context;
		// nothing resets and nothing is recreated.
		const subDir = nodePath.join(ctx.repo.path, "sub");
		await nodeFs.mkdir(subDir, { recursive: true });
		observe(ctx, "omp-1", { cwd: subDir });
		expect(ctx.controller.isReady).toBe(false);
		const gated = await ctx.controller.captureStable();
		expect(gated.ok).toBe(false);
		expect(gated.reason).toContain("parent session changed");

		await ctx.controller.reconcile(ctx.desired);
		expect(ctx.controller.isReady).toBe(true);
		const afterMove = await ctx.controller.captureStable();
		expect(afterMove.ok).toBe(true);
		expect(afterMove.capture?.hunkSessionId).toBe(childSession.sessionId);
		expect(ctx.harness.tabCreateCount).toBe(1);
		expect(childSession.notes).toEqual([{ noteId: "n1", body: "kept" }]);

		// Same id, cwd now a different committed checkout, and a controller
		// pane-get failure stops reconciliation before Git discovery: the stale
		// applied context must not serve review for the new destination.
		const other = await createTempRepo(["other one", "other two"]);
		cleaners.push(other.cleanup);
		ctx.harness.repoRootForLaunch = other.path;
		const undo = ctx.harness.exec.override(
			call => call.command === "herdr" && call.args[1] === "get" && call.args[2] === HARNESS_AGENT_PANE,
			() => herdrTransient(),
		);
		observe(ctx, "omp-1", { cwd: other.path });
		await ctx.controller.reconcile(ctx.desired);
		undo();

		expect(ctx.controller.isReady).toBe(false);
		const paused = await ctx.controller.captureStable();
		expect(paused.ok).toBe(false);
		expect(paused.reason).toContain("parent session changed");

		// Once discovery can proceed, the ordinary transition re-binds and
		// restores access; nothing wedged.
		await ctx.controller.reconcile(ctx.desired);
		expect(ctx.harness.tabCreateCount).toBe(2);
		expect(ctx.controller.isReady).toBe(true);
	});

	test("the post-clean pinned reload reproves the controller reservation", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		await startPrimary(ctx);
		const head = await headSha(ctx.repo.path);
		await ctx.controller.selectScope({ kind: "commit", commitSha: head }, observe(ctx, "omp-1"));

		const oldPaneId = childPaneIds(ctx)[0];
		killChildHunk(ctx, oldPaneId);
		await closePaneLikeHerdr(ctx, oldPaneId);

		// Hold the replacement's clean-gate clear; while it is parked the
		// controller's pane moves to a foreign tab.
		const gate = gateNthCall(ctx, "hunk", ["session", "comment", "clear"], 1, () => ({
			stdout: JSON.stringify({ result: { removedCount: 0 } }),
			stderr: "",
			code: 0,
			killed: false,
		}));
		const draining = ctx.controller.reconcile(ctx.desired);
		await gate.entered;
		const agentPane = ctx.harness.panes.get(HARNESS_AGENT_PANE);
		if (agentPane === undefined) throw new Error("missing agent pane fixture");
		const ownedTab = agentPane.tabId;
		agentPane.tabId = "w1:tforeign";
		gate.release();
		await draining;
		gate.dispose();

		// The clear completed, but the moved pane never receives the pinned
		// reload: the scope stays pending and readiness stays blocked.
		const reloadsAfterMove = ctx.harness.exec.callsTo("hunk", ["session", "reload"]).length;
		expect(reloadsAfterMove).toBe(1);
		expect(ctx.controller.isReady).toBe(false);
		const blocked = await ctx.controller.captureStable();
		expect(blocked.ok).toBe(false);

		// Restoring the reservation lets the ordinary tick apply the scope.
		agentPane.tabId = ownedTab;
		observe(ctx, "omp-1");
		await ctx.controller.reconcile(ctx.desired);
		expect(ctx.harness.exec.callsTo("hunk", ["session", "reload"]).length).toBe(reloadsAfterMove + 1);
		expect(ctx.controller.isReady).toBe(true);
		const recovered = await ctx.controller.captureStable();
		expect(recovered.ok).toBe(true);
		expect(recovered.capture?.scope).toEqual({ kind: "commit", commitSha: head });
	});

	test("a proven-dead child is replaced despite a lingering registration", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		await startPrimary(ctx);
		const oldPaneId = childPaneIds(ctx)[0];
		const oldSession = ctx.harness.sessions[0];

		// The pane is gone and the process proven dead, but the registry entry
		// lingers with the recorded UUID/PID/root: replacement must proceed.
		ctx.harness.panes.delete(oldPaneId);
		ctx.harness.killProcess(oldSession.pid);
		observe(ctx, "omp-1");
		await ctx.controller.reconcile(ctx.desired);

		expect(await fileExists(ctx.recordPath)).toBe(true);
		const record = await readRecord(ctx);
		expect(record.hunkSessionId).not.toBe(oldSession.sessionId);
		expect(ctx.harness.panes.has(oldPaneId)).toBe(false);
		expect(closeCalls(ctx, oldPaneId)).toBe(0);
		expect(childPaneIds(ctx).length).toBe(1);
		expect(ctx.controller.isReady).toBe(true);

		// The same rule on the health path: the replacement's review exits to
		// its idle shell while its registration lingers with a dead PID.
		const secondPane = childPaneIds(ctx)[0];
		const secondSession = ctx.harness.sessions.find(entry => entry.sessionId !== oldSession.sessionId);
		if (secondSession === undefined) throw new Error("missing replacement child session");
		const pane = ctx.harness.panes.get(secondPane);
		if (pane === undefined) throw new Error("missing replacement child pane");
		pane.foreground = [];
		ctx.harness.killProcess(secondSession.pid);
		observe(ctx, "omp-1");
		const closesBefore = closeCalls(ctx, secondPane);
		await ctx.controller.reconcile(ctx.desired);

		expect(closeCalls(ctx, secondPane)).toBe(closesBefore + 1);
		expect(ctx.harness.tabCreateCount).toBe(3);
		expect(childPaneIds(ctx).length).toBe(1);
		expect(ctx.controller.isReady).toBe(true);
	});
});

describe("git discovery is never proof of a root change", () => {
	test("a transient git failure keeps the same child untouched but pauses review access", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		await startPrimary(ctx);
		const childSession = ctx.harness.sessions[0];
		childSession.notes = [{ noteId: "n1", body: "kept" }];
		const closesBefore = closeCalls(ctx);

		const undo = ctx.harness.exec.override(
			call => call.command === "git" && call.args[0] === "rev-parse",
			() => harnessFail("git timeout"),
		);
		observe(ctx, "omp-1");
		await ctx.controller.reconcile(ctx.desired);
		expect(ctx.controller.isReady).toBe(false);
		const paused = await ctx.controller.captureStable();
		expect(paused.ok).toBe(false);

		undo();
		observe(ctx, "omp-1");
		await ctx.controller.reconcile(ctx.desired);

		expect(ctx.harness.tabCreateCount).toBe(1);
		expect(ctx.harness.panes.has(childPaneIds(ctx)[0])).toBe(true);
		expect(childSession.notes).toEqual([{ noteId: "n1", body: "kept" }]);
		expect(ctx.controller.isReady).toBe(true);
		const recovered = await ctx.controller.captureStable();
		expect(recovered.ok).toBe(true);
		expect(closeCalls(ctx)).toBe(closesBefore);
	});

	test("a committed parent transition retires the old child while git is unresolvable", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		await startPrimary(ctx);
		const oldPaneId = childPaneIds(ctx)[0];
		const oldSession = ctx.harness.sessions[0];

		const undo = ctx.harness.exec.override(
			call => call.command === "git" && call.args[0] === "rev-parse",
			() => harnessFail("git down"),
		);
		observe(ctx, "omp-2");
		await ctx.controller.reconcile(ctx.desired);
		undo();

		expect(ctx.harness.panes.has(oldPaneId)).toBe(false);
		expect(ctx.harness.sessions.some(entry => entry.sessionId === oldSession.sessionId)).toBe(false);
		// Nothing is created until git discovery resolves again.
		expect(ctx.harness.tabCreateCount).toBe(1);
		expect(ctx.controller.isReady).toBe(false);

		observe(ctx, "omp-2");
		await ctx.controller.reconcile(ctx.desired);
		expect(ctx.harness.tabCreateCount).toBe(2);
		expect(ctx.controller.isReady).toBe(true);
	});

	test("a fresh primary retires a retained child even while git discovery is indeterminate", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		const seeded = await seedLiveChild(ctx);

		const undo = ctx.harness.exec.override(
			call => call.command === "git" && call.args[0] === "rev-parse",
			() => harnessFail("git down"),
		);
		expect(await ctx.controller.admit()).toBe("primary");
		await ctx.controller.reconcile(ctx.desired);
		undo();

		// A newly admitted primary never adopts the retained child, whatever its
		// recorded parent: it is verified and replaced even while git is down.
		expect(ctx.harness.panes.has(seeded.paneId)).toBe(false);
		expect(ctx.harness.sessions.some(entry => entry.sessionId === seeded.session.sessionId)).toBe(false);
		// Creation itself stays deferred until git discovery resolves.
		expect(ctx.harness.tabCreateCount).toBe(0);
		expect(await fileExists(ctx.recordPath)).toBe(false);

		observe(ctx, "omp-1");
		await ctx.controller.reconcile(ctx.desired);
		expect(ctx.harness.tabCreateCount).toBe(1);
		expect(ctx.controller.isReady).toBe(true);
	});

	test("an indeterminate first reconciliation still retires a different-parent child", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		const seeded = await seedLiveChild(ctx);

		const undo = ctx.harness.exec.override(
			call => call.command === "git" && call.args[0] === "rev-parse",
			() => harnessFail("git down"),
		);
		expect(await ctx.controller.admit()).toBe("primary");
		await ctx.controller.reconcile(ctx.desired);
		undo();

		expect(ctx.harness.panes.has(seeded.paneId)).toBe(false);
		expect(ctx.harness.sessions.some(entry => entry.sessionId === seeded.session.sessionId)).toBe(false);
		expect(ctx.harness.tabCreateCount).toBe(0);
		expect(await fileExists(ctx.recordPath)).toBe(false);
	});
});

describe("clean-note gate", () => {
	test("failed initial clear blocks export and annotation; the lifecycle tick recovers", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		ctx.harness.failClears = true;
		await startPrimary(ctx);

		expect(ctx.notifications.some(message => message.includes("could not clear"))).toBe(true);
		expect(ctx.controller.childState).toBe("ready");
		const capture = await ctx.controller.captureStable();
		expect(capture.ok).toBe(false);
		expect(capture.reason).toContain("cleared");
		const write = await ctx.controller.commentWrite("token", { summary: "x" });
		expect(write.ok).toBe(false);
		expect(await fileExists(ctx.artifactsFile)).toBe(false);

		ctx.harness.failClears = false;
		observe(ctx, "omp-1");
		await ctx.controller.reconcile(ctx.desired);

		expect(ctx.harness.clears).toBe(1);
		const recovered = await ctx.controller.captureStable();
		expect(recovered.ok).toBe(true);
		const note = await ctx.controller.commentWrite(recovered.capture?.viewToken ?? "", {
			file: "seed.txt",
			side: "new",
			line: 2,
			summary: "fresh",
		});
		expect(note.ok).toBe(true);

		// Repeated successful ticks retain the new notes instead of re-clearing.
		const clearsAfterRecovery = ctx.harness.clears;
		observe(ctx, "omp-1");
		await ctx.controller.reconcile(ctx.desired);
		observe(ctx, "omp-1");
		await ctx.controller.reconcile(ctx.desired);
		expect(ctx.harness.clears).toBe(clearsAfterRecovery);
		expect(ctx.harness.sessions[0].notes.length).toBe(1);

		// Suppression re-arms: a renewed failure notifies again.
		const failuresBefore = ctx.notifications.filter(message => message.includes("could not clear")).length;
		ctx.harness.failClears = true;
		observe(ctx, "omp-9");
		await ctx.controller.reconcile(ctx.desired);
		expect(ctx.notifications.filter(message => message.includes("could not clear")).length).toBe(failuresBefore + 1);
	});
});

describe("start-state verification", () => {
	test("ambiguous registration keeps the provisional child unavailable without duplicating", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		ctx.harness.duplicateLaunch = true;
		expect(await ctx.controller.admit()).toBe("primary");
		await ctx.controller.reconcile(ctx.desired);

		expect(ctx.harness.tabCreateCount).toBe(1);
		expect(ctx.controller.childState).toBe("starting");
		expect(ctx.controller.isReady).toBe(false);
		expect(ctx.harness.clears).toBe(0);
		const record = await readRecord(ctx);
		expect(record.hunkSessionId).toBeUndefined();
		expect(await sidecarExists(ctx)).toBe(false);

		// Repeated drains keep verifying the same provisional child.
		observe(ctx, "omp-1");
		await ctx.controller.reconcile(ctx.desired);
		expect(ctx.harness.tabCreateCount).toBe(1);
		expect(ctx.notifications.some(message => message.includes("multiple review sessions"))).toBe(true);
	});

	test("a launch whose registration lags stays starting; a later drain binds the same pane", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		ctx.harness.launchRegistrationDeferred = true;
		expect(await ctx.controller.admit()).toBe("primary");
		const gate = (async () => {
			await waitForNotification(ctx, "timed out");
			ctx.harness.registered = true;
			if (ctx.harness.deferredPaneId !== undefined) {
				ctx.harness.addSession(ctx.harness.repoRootForLaunch, ctx.harness.deferredPaneId);
			}
		})();
		await withPump(ctx, ctx.controller.reconcile(ctx.desired));
		await gate;
		expect(ctx.controller.childState).toBe("starting");
		expect(ctx.harness.tabCreateCount).toBe(1);

		observe(ctx, "omp-1");
		await ctx.controller.reconcile(ctx.desired);
		expect(ctx.controller.childState).toBe("ready");
		expect(ctx.harness.tabCreateCount).toBe(1);
		expect(ctx.harness.clears).toBe(1);
	});

	test("late bind refuses a replaced shell and never binds or clears a foreign session", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		ctx.harness.launchRegistrationDeferred = true;
		expect(await ctx.controller.admit()).toBe("primary");
		const root = await canon(ctx.repo.path);
		const gate = (async () => {
			await waitForNotification(ctx, "timed out");
			const paneId = ctx.harness.deferredPaneId;
			const pane = paneId !== undefined ? ctx.harness.panes.get(paneId) : undefined;
			if (pane !== undefined) {
				pane.shellPid = ++ctx.harness.nextPid;
				pane.foreground = [];
			}
			ctx.harness.registered = true;
			if (paneId !== undefined) ctx.harness.addSession(root, paneId);
		})();
		await withPump(ctx, ctx.controller.reconcile(ctx.desired));
		await gate;
		expect(ctx.controller.childState).toBe("starting");
		expect(ctx.harness.clears).toBe(0);

		observe(ctx, "omp-1");
		await ctx.controller.reconcile(ctx.desired);
		observe(ctx, "omp-1");
		await ctx.controller.reconcile(ctx.desired);
		expect(ctx.controller.childState).toBe("starting");
		expect(ctx.harness.clears).toBe(0);
		const record = await readRecord(ctx);
		expect(record.hunkSessionId).toBeUndefined();
		expect(ctx.notifications.some(message => message.includes("refusing to bind"))).toBe(true);
	});

	test("late bind honors the launch-time session snapshot over pre-existing sessions", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		const root = await canon(ctx.repo.path);
		ctx.harness.registered = true;
		ctx.harness.sessions.push({
			sessionId: "pre-existing",
			pid: ++ctx.harness.nextPid,
			cwd: root,
			repoRoot: root,
			generation: "gen-1",
			stateRevision: 1,
			notes: [],
		});
		const preExistingPid = ctx.harness.sessions[0].pid;
		ctx.harness.launchRegistrationDeferred = true;
		expect(await ctx.controller.admit()).toBe("primary");
		const gate = (async () => {
			await waitForExecCalls(ctx, 2, "hunk", ["session", "list"]);
			const paneId = ctx.harness.deferredPaneId;
			if (paneId !== undefined) {
				ctx.harness.panes.get(paneId)?.foreground.push(preExistingPid);
				ctx.harness.addSession(root, paneId);
			}
		})();
		await withPump(ctx, ctx.controller.reconcile(ctx.desired));
		await gate;

		expect(ctx.controller.childState).toBe("ready");
		const record = await readRecord(ctx);
		expect(record.hunkSessionId).not.toBe("pre-existing");
		expect(record.hunkPid).not.toBe(preExistingPid);
		expect(ctx.harness.clears).toBe(1);
	});

	test("unrecognized foreground on a bound child is reported, never terminated", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		await startPrimary(ctx);
		const paneId = childPaneIds(ctx)[0];
		ctx.harness.panes.get(paneId)!.foreground = [++ctx.harness.nextPid];

		observe(ctx, "omp-1");
		await ctx.controller.reconcile(ctx.desired);

		expect(ctx.notifications.some(message => message.includes("foreground changed"))).toBe(true);
		expect(ctx.harness.panes.has(paneId)).toBe(true);
		expect(closeCalls(ctx)).toBe(0);
		expect(ctx.harness.tabCreateCount).toBe(1);
	});

	test("malformed ownership record is preserved and reported, and recovery follows", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		await nodeFs.mkdir(nodePath.dirname(ctx.recordPath), { recursive: true });
		await Bun.write(ctx.recordPath, "{not json");

		expect(await ctx.controller.admit()).toBe("primary");
		await ctx.controller.reconcile(ctx.desired);
		expect(ctx.notifications.some(message => message.includes("malformed"))).toBe(true);
		expect(ctx.harness.tabCreateCount).toBe(0);
		await ctx.controller.reconcile(ctx.desired);
		expect(ctx.notifications.filter(message => message.includes("malformed")).length).toBe(1);

		await nodeFs.rm(ctx.recordPath);
		observe(ctx, "omp-1");
		await ctx.controller.reconcile(ctx.desired);
		expect(ctx.harness.tabCreateCount).toBe(1);
	});

	test("malformed controller pane identity is indeterminate, never permission to mutate", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		await startPrimary(ctx);
		const undo = ctx.harness.exec.override(
			call => call.command === "herdr" && call.args[0] === "pane" && call.args[1] === "get",
			() => ({ stdout: JSON.stringify({ result: { pane: {} } }), stderr: "", code: 0, killed: false }),
		);
		observe(ctx, "omp-1");
		await ctx.controller.reconcile(ctx.desired);
		undo();
		expect(ctx.harness.tabCreateCount).toBe(1);
		expect(ctx.controller.childState).toBe("ready");
	});

	test("a failed close preserves the record and retries from the same evidence", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		await startPrimary(ctx);
		const oldPaneId = childPaneIds(ctx)[0];
		killChildHunk(ctx, oldPaneId);

		ctx.harness.hangClose = true;
		const draining = ctx.controller.reconcile(ctx.desired);
		await waitForExecCalls(ctx, 1, "herdr", ["pane", "close"]);
		ctx.harness.closeGate?.(killedOutcome());
		await draining;

		expect(ctx.notifications.some(message => message.includes("closing the recorded child failed"))).toBe(true);
		expect(await fileExists(ctx.recordPath)).toBe(true);
		expect(ctx.harness.tabCreateCount).toBe(1);

		ctx.harness.hangClose = false;
		observe(ctx, "omp-1");
		await ctx.controller.reconcile(ctx.desired);
		expect(ctx.harness.tabCreateCount).toBe(2);
		expect(ctx.controller.isReady).toBe(true);
	});
});

describe("stable capture and view tokens", () => {
	test("stable reads reuse the token; a generation change rotates and refuses it", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		await startPrimary(ctx);

		const stable1 = await ctx.controller.captureStable();
		expect(stable1.ok).toBe(true);
		const stable2 = await ctx.controller.captureStable();
		expect(stable2.ok).toBe(true);
		expect(stable2.capture?.viewToken).toBe(stable1.capture?.viewToken);

		ctx.harness.bumpGenerationOnNextGet = true;
		const drifted = await ctx.controller.captureStable();
		expect(drifted.ok).toBe(false);
		expect(drifted.reason).toContain("hunk_review");

		const afterDrift = await ctx.controller.captureStable();
		expect(afterDrift.ok).toBe(true);
		expect(afterDrift.capture?.viewToken).not.toBe(stable1.capture?.viewToken);

		const write = await ctx.controller.commentWrite(stable1.capture?.viewToken ?? "", { summary: "stale" });
		expect(write.ok).toBe(false);
		expect(write.error).toContain("hunk_review");
		expect(ctx.harness.adds).toBe(0);
	});

	test("missing publication generation is a retryable error, never a capture", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		await startPrimary(ctx);

		ctx.harness.omitGeneration = true;
		const outcome = await ctx.controller.captureStable();
		ctx.harness.omitGeneration = false;
		expect(outcome.ok).toBe(false);
		expect(outcome.reason).toContain("generation");

		const retry = await ctx.controller.captureStable();
		expect(retry.ok).toBe(true);
	});

	test("stateRevision-only drift keeps the capture stable", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		await startPrimary(ctx);

		ctx.harness.bumpStateRevisionOnNextGet = true;
		const outcome = await ctx.controller.captureStable();
		expect(outcome.ok).toBe(true);
		expect(outcome.capture?.publication.generation).toBe("gen-1");
		expect(outcome.capture?.publication.stateRevision).toBe(2);
	});

	test("comment write timeout reports unknown outcome, once, and kills the token", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		await startPrimary(ctx);
		const capture = await ctx.controller.captureStable();
		expect(capture.ok).toBe(true);
		const token = capture.capture?.viewToken ?? "";

		ctx.harness.hangCommentAdd = true;
		const pending = ctx.controller.commentWrite(token, { file: "seed.txt", side: "new", line: 2, summary: "maybe" });
		await waitForExecCalls(ctx, 1, "hunk", ["session", "comment", "add"]);
		ctx.harness.commentAddGate?.(killedOutcome());
		const outcome = await pending;
		expect(outcome.ok).toBe(false);
		expect(outcome.error).toContain("timed out");

		const retry = await ctx.controller.commentWrite(token, { file: "seed.txt", side: "new", line: 2, summary: "again" });
		expect(retry.ok).toBe(false);
		expect(retry.error).toContain("hunk_review");
		expect(ctx.harness.adds).toBe(1);

		ctx.harness.hangCommentAdd = false;
		const fresh = await ctx.controller.captureStable();
		expect(fresh.ok).toBe(true);
		const write = await ctx.controller.commentWrite(fresh.capture?.viewToken ?? "", {
			file: "seed.txt",
			side: "new",
			line: 2,
			summary: "settled",
		});
		expect(write.ok).toBe(true);
		expect(ctx.harness.adds).toBe(2);
	});
});

describe("/diff selection contract", () => {
	test("selection reloads the pinned scope and focuses only the owned tab", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		await startPrimary(ctx);
		const head = await headSha(ctx.repo.path);
		const snapshot = observe(ctx, "omp-1");

		await ctx.controller.selectScope({ kind: "commit", commitSha: head }, snapshot);
		expect(ctx.controller.scope).toEqual({ kind: "commit", commitSha: head });
		const reload = ctx.harness.exec.calls.find(call => call.command === "hunk" && call.args[1] === "reload");
		expect(reload?.args).toContain("show");
		expect(reload?.args).toContain(head);
		expect(ctx.harness.renames).toEqual([]);

		await ctx.controller.focusTab(snapshot);
		expect(ctx.harness.focusCount).toBe(1);
	});

	test("pending and secondary roles gate every review entrypoint with the contract messages", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		const head = await headSha(ctx.repo.path);
		const snapshot = ctx.desired;

		await expect(ctx.controller.selectScope({ kind: "commit", commitSha: head }, snapshot)).rejects.toThrow(
			PENDING_OWNERSHIP_MESSAGE,
		);
		const capture = await ctx.controller.captureStable();
		expect(capture.reason).toBe(PENDING_OWNERSHIP_MESSAGE);

		expect(await ctx.controller.admit()).toBe("primary");
		const secondary = new CompanionController(ctx.deps);
		secondary.observeParent({ ompSessionId: "omp-2", artifactsDir: ctx.artifactsDir, cwd: ctx.repo.path });
		expect(await secondary.admit()).toBe("secondary");
		await expect(secondary.selectScope({ kind: "commit", commitSha: head }, snapshot)).rejects.toThrow(
			SECONDARY_INACTIVE_MESSAGE,
		);
		await expect(secondary.focusTab(snapshot)).rejects.toThrow(SECONDARY_INACTIVE_MESSAGE);
		expect((await secondary.captureStable()).reason).toBe(SECONDARY_INACTIVE_MESSAGE);
		expect((await secondary.commentWrite("t", { summary: "x" })).error).toBe(SECONDARY_INACTIVE_MESSAGE);
	});
});

describe("archives and publication fencing", () => {
	test("overlapping archive calls: the running writer wins until the write settles", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		await startPrimary(ctx);

		ctx.harness.hangSessionGet = true;
		const first = ctx.controller.snapshotNow({ deadlineMs: 30_000 });
		await waitForExecCalls(ctx, 1, "hunk", ["session", "get"]);
		const second = await ctx.controller.snapshotNow({ deadlineMs: 30_000 });
		expect(second).toBe(false);

		ctx.harness.hangSessionGet = false;
		ctx.harness.releaseSessionGet();
		expect(await first).toBe(true);
		const envelope = JSON.parse(await nodeFs.readFile(ctx.artifactsFile, "utf8")) as Record<string, unknown>;
		expect(envelope.version).toBe(1);
	});

	test("an archive in flight across a parent change never publishes into the new identity", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		await startPrimary(ctx);
		const oldSession = ctx.harness.sessions[0];
		oldSession.notes = [{ noteId: "n1", body: "old parent note" }];
		// The bind-time archive is the latest published state for parent A.
		const boundEnvelope = JSON.parse(await nodeFs.readFile(ctx.artifactsFile, "utf8")) as Record<string, unknown>;
		expect(boundEnvelope.hunkSessionId).toBe(oldSession.sessionId);

		const nextArtifacts = await nodeFs.mkdtemp(nodePath.join(nodeOs.tmpdir(), "herdr-ext-next-"));
		cleaners.push(async () => nodeFs.rm(nextArtifacts, { recursive: true, force: true }));

		ctx.harness.hangSessionGet = true;
		const pending = ctx.controller.snapshotNow({ deadlineMs: 30_000 });
		await waitForExecCalls(ctx, 1, "hunk", ["session", "get"]);

		// The parent changes while the old capture is hung: the transition's own
		// archive is skipped (writer busy) and retirement proceeds.
		observe(ctx, "omp-2", { artifactsDir: nextArtifacts });
		await ctx.controller.reconcile(ctx.desired);
		expect(ctx.harness.tabCreateCount).toBe(2);

		ctx.harness.hangSessionGet = false;
		ctx.harness.releaseSessionGet();
		expect(await pending).toBe(false);

		// The abandoned capture landed nowhere: parent A's file still holds the
		// bind-time envelope, and parent B's archive carries only the new child.
		await ctx.controller.snapshotNow({ deadlineMs: 10_000 });
		const unchanged = JSON.parse(await nodeFs.readFile(ctx.artifactsFile, "utf8")) as Record<string, unknown>;
		expect(unchanged.hunkSessionId).toBe(oldSession.sessionId);
		const newEnvelope = JSON.parse(
			await nodeFs.readFile(nodePath.join(nextArtifacts, "hunk", "review-notes.json"), "utf8"),
		) as Record<string, unknown>;
		expect(newEnvelope.ompSessionId).toBe("omp-2");
		expect(newEnvelope.hunkSessionId).not.toBe(oldSession.sessionId);
		expect(JSON.stringify(newEnvelope.review)).not.toContain("old parent note");
	});

	test("shutdown's deadline abandons a hung capture without publishing", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		await startPrimary(ctx);
		// The bind-time archive is the last good publication.
		expect(await fileExists(ctx.artifactsFile)).toBe(true);
		const before = await nodeFs.readFile(ctx.artifactsFile, "utf8");

		ctx.harness.hangSessionGet = true;
		await withPump(ctx, ctx.controller.shutdown(1_000));
		expect((await nodeFs.readFile(ctx.artifactsFile, "utf8")) === before).toBe(true);

		// The abandoned capture is discarded: releasing it writes nothing.
		ctx.harness.hangSessionGet = false;
		ctx.harness.releaseSessionGet();
		await new Promise<void>(resolve => setImmediate(resolve));
		expect((await nodeFs.readFile(ctx.artifactsFile, "utf8")) === before).toBe(true);

		// Post-shutdown archives are refused outright.
		expect(await ctx.controller.snapshotNow({ deadlineMs: 1_000 })).toBe(false);
	});

	test("an archive staged across a parent observation is discarded; a transition archive still publishes", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		await startPrimary(ctx);
		const boundEnvelope = await nodeFs.readFile(ctx.artifactsFile, "utf8");

		const nextArtifacts = await nodeFs.mkdtemp(nodePath.join(nodeOs.tmpdir(), "herdr-ext-next-"));
		cleaners.push(async () => nodeFs.rm(nextArtifacts, { recursive: true, force: true }));

		// Hold the archive's filesystem staging: the capture has completed, the
		// write sits between the staged bytes and the publish fence.
		const realWrite = Bun.write as unknown as (
			destination: unknown,
			data: unknown,
			options?: unknown,
		) => Promise<number>;
		const writableBun = Bun as unknown as {
			write: (destination: unknown, data: unknown, options?: unknown) => Promise<number>;
		};
		const { promise: stagingEntered, resolve: enteredResolve } = Promise.withResolvers<void>();
		const { promise: stagingHeld, resolve: releaseStaging } = Promise.withResolvers<void>();
		const archiveTmpPrefix = `${ctx.artifactsFile}.tmp-`;
		writableBun.write = (destination, data, options) => {
			if (typeof destination === "string" && destination.startsWith(archiveTmpPrefix)) {
				enteredResolve();
				return stagingHeld.then(() => realWrite(destination, data, options));
			}
			return realWrite(destination, data, options);
		};

		let published: boolean;
		try {
			const pending = ctx.controller.snapshotNow();
			await stagingEntered;
			// The desired parent is re-observed while the old capture's bytes are
			// already staged; no rebinding happened in between, so only the
			// revision fence can keep this out of the destination.
			observe(ctx, "omp-2", { artifactsDir: nextArtifacts });
			releaseStaging();
			published = await pending;
		} finally {
			writableBun.write = realWrite;
		}

		expect(published).toBe(false);
		expect(await nodeFs.readFile(ctx.artifactsFile, "utf8")).toBe(boundEnvelope);

		// A transition archive started under the current desired revision — old
		// applied parent, new desired — still publishes its captured view.
		expect(await ctx.controller.snapshotNow()).toBe(true);
		const envelope = JSON.parse(await nodeFs.readFile(ctx.artifactsFile, "utf8")) as Record<string, unknown>;
		expect(envelope.ompSessionId).toBe("omp-1");
		expect(envelope.hunkSessionId).toBe(ctx.harness.sessions[0].sessionId);
	});
});

describe("soft shutdown", () => {
	test("shutdown leaves the child, labels, notes, and metadata intact and sends no child commands", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		await startPrimary(ctx);
		const paneId = childPaneIds(ctx)[0];
		const session = ctx.harness.sessions[0];
		session.notes = [{ noteId: "n1", body: "survives" }];
		const closesBefore = closeCalls(ctx);
		const runsBefore = ctx.harness.launchedCommands.length;
		const clearsBefore = ctx.harness.clears;
		const reloadsBefore = ctx.harness.exec.callsTo("hunk", ["session", "reload"]).length;

		await ctx.controller.shutdown(1_500);

		expect(closeCalls(ctx)).toBe(closesBefore);
		expect(ctx.harness.launchedCommands.length).toBe(runsBefore);
		expect(ctx.harness.clears).toBe(clearsBefore);
		expect(ctx.harness.exec.callsTo("hunk", ["session", "reload"]).length).toBe(reloadsBefore);
		expect(ctx.harness.panes.get(paneId)?.foreground).toContain(session.pid);
		expect(ctx.harness.sessions).toContain(session);
		const record = await readRecord(ctx);
		expect(record.hunkSessionId).toBe(session.sessionId);
		expect(ctx.harness.locks.holds(ctx.lockPath)).toBe(true);
		expect(ctx.controller.isReady).toBe(false);
		expect((await ctx.controller.captureStable()).reason).toContain("shutting down");

		// Queued callbacks and reconciles cannot revive management.
		await expect(ctx.controller.selectScope({ kind: "commit", commitSha: "x" }, ctx.desired)).rejects.toThrow();
		observe(ctx, "omp-1");
		await expect(ctx.controller.reconcile(ctx.desired)).rejects.toThrow();
		expect(ctx.harness.tabCreateCount).toBe(1);
	});

	test("a clean-gate clear parked across shutdown dispatches nothing further", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		expect(await ctx.controller.admit()).toBe("primary");
		ctx.harness.hangCommentClear = true;
		const draining = ctx.controller.reconcile(ctx.desired);
		await waitForExecCalls(ctx, 1, "hunk", ["session", "comment", "clear"]);

		// Shutdown while the clean gate is parked: no archive, no further commands.
		const getsBefore = ctx.harness.exec.callsTo("hunk", ["session", "get"]).length;
		const runsBefore = ctx.harness.launchedCommands.length;
		await ctx.controller.shutdown(1_500);
		ctx.harness.hangCommentClear = false;
		ctx.harness.releaseCommentClear();
		await draining;

		// The pre-shutdown clear completed; shutdown dispatched nothing after it.
		expect(ctx.harness.clears).toBe(1);
		expect(ctx.harness.launchedCommands.length).toBe(runsBefore);
		expect(ctx.harness.exec.callsTo("hunk", ["session", "get"]).length).toBe(getsBefore);
		expect(await fileExists(ctx.artifactsFile)).toBe(false);
		expect(ctx.controller.isReady).toBe(false);
		expect((await ctx.controller.captureStable()).reason).toContain("shutting down");
	});

	test("a retirement close parked across shutdown completes without relaunching", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		await startPrimary(ctx);
		const paneId = childPaneIds(ctx)[0];
		killChildHunk(ctx, paneId);

		ctx.harness.hangClose = true;
		const draining = ctx.controller.reconcile(ctx.desired);
		await waitForExecCalls(ctx, 1, "herdr", ["pane", "close"]);

		const createsBefore = ctx.harness.tabCreateCount;
		const runsBefore = ctx.harness.launchedCommands.length;
		await ctx.controller.shutdown(1_500);
		ctx.harness.hangClose = false;
		ctx.harness.releaseClose();
		await draining;

		// The pre-shutdown close landed, but shutdown's verification veto keeps
		// the ownership metadata for the successor and dispatches no replacement.
		expect(closeCalls(ctx, paneId)).toBe(1);
		expect(ctx.harness.tabCreateCount).toBe(createsBefore);
		expect(ctx.harness.launchedCommands.length).toBe(runsBefore);
		expect(await fileExists(ctx.recordPath)).toBe(true);
		expect(await sidecarExists(ctx)).toBe(false);
	});

	test("a retirement verified across shutdown keeps the ownership record and launch sidecar", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		const seeded = await seedLiveChild(ctx);
		// A crash between shell proof and intent removal leaves both the record
		// and its launch sidecar; the successor's retirement cleans both only
		// while it still owns the workspace.
		await Bun.write(
			ctx.sidecarPath,
			`${JSON.stringify({
				version: 1,
				socketPath: HARNESS_SOCKET,
				workspaceId: HARNESS_WORKSPACE,
				ownerPaneId: HARNESS_AGENT_PANE,
				controllerPid: process.pid,
				nonce: "seeded-nonce",
			})}\n`,
		);

		expect(await ctx.controller.admit()).toBe("primary");
		// Park the post-close registry read so the retirement's verification is
		// still awaiting when the process shuts down; the parked release then
		// reports the emptied registry. (The early proof and the pre-close
		// re-proof each consume one earlier registry read.)
		const gate = gateNthCall(ctx, "hunk", ["session", "list"], 3, () => ({
			stdout: JSON.stringify({ sessions: [] }),
			stderr: "",
			code: 0,
			killed: false,
		}));
		const draining = ctx.controller.reconcile(ctx.desired);
		await gate.entered;
		expect(closeCalls(ctx, seeded.paneId)).toBe(1);

		await ctx.controller.shutdown(1_500);
		gate.release();
		await draining;
		gate.dispose();

		// The close landed pre-shutdown, but none of the metadata deletions
		// ran afterwards: the retained record and sidecar are the successor's
		// still-valid absence evidence, and no replacement was launched.
		expect(await fileExists(ctx.recordPath)).toBe(true);
		expect(await sidecarExists(ctx)).toBe(true);
		expect((await readRecord(ctx)).hunkSessionId).toBe(seeded.session.sessionId);
		expect(ctx.harness.tabCreateCount).toBe(0);
		expect(ctx.harness.launchedCommands.length).toBe(0);
	});
});

describe("primary and secondary coexistence", () => {
	test("a secondary never manages, reads, or writes the primary's child", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		await startPrimary(ctx);
		const childSession = ctx.harness.sessions[0];
		childSession.notes = [{ noteId: "n1", body: "primary note" }];
		const createsBefore = ctx.harness.tabCreateCount;
		const closesBefore = closeCalls(ctx);

		const secondary = new CompanionController(ctx.deps);
		const secondaryDesired = secondary.observeParent({
			ompSessionId: "omp-2",
			artifactsDir: ctx.artifactsDir,
			cwd: ctx.repo.path,
		});
		expect(await secondary.admit()).toBe("secondary");
		await secondary.reconcile(secondaryDesired);
		expect((await secondary.captureStable()).ok).toBe(false);

		expect(ctx.harness.tabCreateCount).toBe(createsBefore);
		expect(closeCalls(ctx)).toBe(closesBefore);
		expect(ctx.harness.sessions).toContain(childSession);
		expect(childSession.notes).toEqual([{ noteId: "n1", body: "primary note" }]);
	});

	test("the secondary stays fixed while a successor primary replaces the retained child", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		await startPrimary(ctx);
		const oldPaneId = childPaneIds(ctx)[0];
		const oldSession = ctx.harness.sessions[0];

		const secondary = new CompanionController(ctx.deps);
		const secondaryDesired = secondary.observeParent({
			ompSessionId: "omp-2",
			artifactsDir: ctx.artifactsDir,
			cwd: ctx.repo.path,
		});
		expect(await secondary.admit()).toBe("secondary");

		await ctx.controller.shutdown(1_500);
		ctx.harness.locks.simulateProcessExit(ctx.lockPath);

		// The still-running secondary neither promotes itself nor blocks takeover.
		expect(await secondary.admit()).toBe("secondary");
		await secondary.reconcile(secondaryDesired);
		expect(ctx.harness.tabCreateCount).toBe(1);

		const successor = new CompanionController(ctx.deps);
		successor.observeParent({ ompSessionId: "omp-3", artifactsDir: ctx.artifactsDir, cwd: ctx.repo.path });
		expect(await successor.admit()).toBe("primary");
		await successor.reconcile(ctx.desired);

		expect(ctx.harness.panes.has(oldPaneId)).toBe(false);
		expect(ctx.harness.sessions.some(entry => entry.sessionId === oldSession.sessionId)).toBe(false);
		expect(ctx.harness.tabCreateCount).toBe(2);
		expect(await secondary.captureStable()).toEqual({ ok: false, reason: SECONDARY_INACTIVE_MESSAGE });
	});
});

describe("concurrent reconciliation", () => {
	test("overlapping startup, tick, and picker produce one child and apply the selection", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		expect(await ctx.controller.admit()).toBe("primary");
		const snapshot = observe(ctx, "omp-1");
		const head = await headSha(ctx.repo.path);

		await Promise.all([
			ctx.controller.reconcile(ctx.desired),
			ctx.controller.reconcile(ctx.desired),
			ctx.controller.selectScope({ kind: "commit", commitSha: head }, snapshot),
		]);

		expect(ctx.harness.tabCreateCount).toBe(1);
		expect(ctx.controller.childState).toBe("ready");
		expect(ctx.controller.scope).toEqual({ kind: "commit", commitSha: head });
	});

	test("concurrent reconciles serialize instead of racing the same child", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		expect(await ctx.controller.admit()).toBe("primary");

		let releasePaneGet: (() => void) | undefined;
		const undo = ctx.harness.exec.override(
			call => call.command === "herdr" && call.args[0] === "pane" && call.args[1] === "get",
			() =>
				new Promise<ExecOutcome>(resolve => {
					releasePaneGet = () =>
						resolve({
							stdout: JSON.stringify({
								result: {
									pane: { pane_id: HARNESS_AGENT_PANE, tab_id: "w1:t0", workspace_id: HARNESS_WORKSPACE },
								},
							}),
							stderr: "",
							code: 0,
							killed: false,
						});
				}),
		);
		const first = ctx.controller.reconcile(ctx.desired);
		const second = ctx.controller.reconcile(ctx.desired);
		expect(second).not.toBe(first);
		// Release the parked identity proof, then remove the override so the
		// serialized second drain verifies through the normal handler.
		await waitForExecCalls(ctx, 1, "herdr", ["pane", "get"]);
		releasePaneGet?.();
		undo();
		await Promise.all([first, second]);
		expect(ctx.controller.childState).toBe("ready");
		expect(ctx.harness.tabCreateCount).toBe(1);
	});
});

describe("awaited-mutation guards", () => {
	test("a parent change while the launch waits for its shell stops before pane run", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		expect(await ctx.controller.admit()).toBe("primary");

		// Park the new pane's process-info until the test releases it.
		let releaseShell: (() => void) | undefined;
		const shellLookupStarted = Promise.withResolvers<void>();
		const undoShell = ctx.harness.exec.override(
			call =>
				call.command === "herdr" &&
				call.args[0] === "pane" &&
				call.args[1] === "process-info" &&
				call.args[3] !== HARNESS_AGENT_PANE,
			call => {
				const { promise, resolve } = Promise.withResolvers<ExecOutcome>();
				shellLookupStarted.resolve();
				releaseShell = () => {
					undoShell();
					const pane = ctx.harness.panes.get(call.args[3] ?? "");
					resolve({
						stdout: JSON.stringify({
							result: {
								process_info: {
									pane_id: call.args[3] ?? "",
									shell_pid: pane?.shellPid ?? 0,
									...(pane === undefined || pane.foreground.length === 0
										? {}
										: { foreground_processes: pane.foreground.map(pid => ({ pid, name: "hunk" })) }),
								},
							},
						}),
						stderr: "",
						code: 0,
						killed: false,
					});
				};
				return promise;
			},
		);

		const first = ctx.controller.reconcile(ctx.desired);
		await waitForExecCalls(ctx, 1, "herdr", ["tab", "create"]);
		await shellLookupStarted.promise;
		const supersededPaneId = childPaneIds(ctx)[0];
		const desired2 = observe(ctx, "omp-2");
		releaseShell?.();
		await first;

		// The superseded parent never received the launch command: whatever the
		// drain decided about the child tab it created, omp-1's pane never runs.
		expect(ctx.harness.exec.callsTo("herdr", ["pane", "run", supersededPaneId]).length).toBe(0);

		// The latest parent owns the approved drain: it retires the orphaned
		// starting child and launches the fresh child for omp-2.
		await ctx.controller.reconcile(desired2);
		expect(ctx.harness.tabCreateCount).toBe(2);
		expect(ctx.harness.launchedCommands.length).toBe(1);
		expect(ctx.controller.childState).toBe("ready");
	});

	test("selection and focus refuse while the controller pane identity is moved", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		await startPrimary(ctx);
		const head = await headSha(ctx.repo.path);
		const agentPane = ctx.harness.panes.get(HARNESS_AGENT_PANE);
		if (!agentPane) throw new Error("missing agent pane fixture");
		const realForeground = agentPane.foreground;
		agentPane.foreground = [++ctx.harness.nextPid]; // foreign occupant
		const snapshot = observe(ctx, "omp-1");
		const reloadsBefore = ctx.harness.exec.callsTo("hunk", ["session", "reload"]).length;

		await expect(ctx.controller.selectScope({ kind: "commit", commitSha: head }, snapshot)).rejects.toThrow(
			"pane identity changed",
		);
		await expect(ctx.controller.focusTab(snapshot)).rejects.toThrow("pane identity changed");
		expect(ctx.harness.exec.callsTo("hunk", ["session", "reload"]).length).toBe(reloadsBefore);
		expect(ctx.harness.focusCount).toBe(0);
		expect(ctx.controller.scope?.kind).toBe("session");

		// A verified reservation admits the queued selection again.
		agentPane.foreground = realForeground;
		await ctx.controller.selectScope({ kind: "commit", commitSha: head }, snapshot);
		expect(ctx.controller.scope).toEqual({ kind: "commit", commitSha: head });
		await ctx.controller.focusTab(snapshot);
		expect(ctx.harness.focusCount).toBe(1);
	});

	test("soft shutdown publishes the final read-only archive of the applied view", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		await startPrimary(ctx);
		ctx.harness.sessions[0].notes = [{ noteId: "n1", body: "final view note" }];
		await ctx.controller.snapshotNow({ deadlineMs: 10_000 });
		// Only the shutdown path may recreate the archive from here.
		await nodeFs.rm(ctx.artifactsFile);

		await ctx.controller.shutdown(1_500);

		const envelope = JSON.parse(await nodeFs.readFile(ctx.artifactsFile, "utf8")) as Record<string, unknown>;
		expect(envelope.ompSessionId).toBe("omp-1");
		expect(JSON.stringify(envelope.review)).toContain("final view note");
		const blocked = await ctx.controller.captureStable();
		expect(blocked.ok).toBe(false);
		expect(blocked.reason).toContain("shutting down");
	});

	test("a deadline-detached archive publishes nothing and releases the writer only on settlement", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		await startPrimary(ctx);
		const before = await nodeFs.readFile(ctx.artifactsFile, "utf8");

		ctx.harness.hangSessionGet = true;
		const first = ctx.controller.snapshotNow({ deadlineMs: 1_000 });
		await waitForExecCalls(ctx, 1, "hunk", ["session", "get"]);
		// The in-flight write path refuses concurrent archives.
		expect(await ctx.controller.snapshotNow({ deadlineMs: 30_000 })).toBe(false);
		await withPump(ctx, first);
		expect(await first).toBe(false);

		// The detached capture is discarded: releasing it publishes nothing.
		ctx.harness.hangSessionGet = false;
		ctx.harness.releaseSessionGet();
		await new Promise<void>(resolve => setImmediate(resolve));
		expect((await nodeFs.readFile(ctx.artifactsFile, "utf8")) === before).toBe(true);

		// The settled writer admits ordinary archives again.
		expect(await ctx.controller.snapshotNow({ deadlineMs: 30_000 })).toBe(true);
	});

	test("creation survives a state directory that disappears after admission", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		expect(await ctx.controller.admit()).toBe("primary");
		await nodeFs.rm(nodePath.dirname(ctx.recordPath), { recursive: true, force: true });

		await ctx.controller.reconcile(ctx.desired);

		expect(ctx.controller.childState).toBe("ready");
		expect(ctx.harness.tabCreateCount).toBe(1);
		expect(await fileExists(ctx.recordPath)).toBe(true);
		expect(await sidecarExists(ctx)).toBe(false);
	});
});

describe("revision fencing and identity awaits", () => {
	test("a parent revision bump fences readiness and captures before any reconcile", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		await startPrimary(ctx);
		const capture = await ctx.controller.captureStable();
		expect(capture.ok).toBe(true);

		// A committed parent change is observed but not yet reconciled: review
		// access must fence immediately, not only after the next drain.
		observe(ctx, "omp-2");
		expect(ctx.harness.tabCreateCount).toBe(1);
		expect(ctx.controller.isReady).toBe(false);
		const staleCapture = await ctx.controller.captureStable();
		expect(staleCapture.ok).toBe(false);
		const staleWrite = await ctx.controller.commentWrite(capture.capture?.viewToken ?? "", {
			summary: "stale",
		});
		expect(staleWrite.ok).toBe(false);
		expect(ctx.harness.adds).toBe(0);

		// Re-reconciling the new parent restores access on the fresh child.
		await ctx.controller.reconcile(ctx.desired);
		expect(ctx.controller.isReady).toBe(true);
		const fresh = await ctx.controller.captureStable();
		expect(fresh.ok).toBe(true);
		expect(fresh.capture?.hunkSessionId).not.toBe(capture.capture?.hunkSessionId);

		// An unchanged re-observation must not fence anything.
		observe(ctx, "omp-2");
		expect((await ctx.controller.captureStable()).ok).toBe(true);
	});

	test("commentWrite reproves the native reservation after its preflight read", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		await startPrimary(ctx);
		const stable = await ctx.controller.captureStable();
		expect(stable.ok).toBe(true);
		const token = stable.capture?.viewToken ?? "";

		// Hold the annotation preflight read; while it is parked the controller's
		// pane moves to a foreign tab, then the preflight resolves with the
		// still-valid generation.
		ctx.harness.hangSessionGet = true;
		const write = ctx.controller.commentWrite(token, {
			file: "seed.txt",
			side: "new",
			line: 2,
			summary: "moved during preflight",
		});
		await waitForExecCalls(ctx, 3, "hunk", ["session", "get"]);
		const agentPane = ctx.harness.panes.get(HARNESS_AGENT_PANE);
		if (agentPane === undefined) throw new Error("missing agent pane fixture");
		agentPane.tabId = "w1:tforeign";
		ctx.harness.hangSessionGet = false;
		ctx.harness.releaseSessionGet();

		const outcome = await write;
		expect(outcome.ok).toBe(false);
		expect(outcome.error).toContain("pane identity changed");
		expect(ctx.harness.adds).toBe(0);
		expect(ctx.harness.sessions[0].notes).toEqual([]);
	});

	test("comment, selection, and focus queued behind an identity await refuse on a moved pane", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		await startPrimary(ctx);
		const head = await headSha(ctx.repo.path);
		const snapshot = observe(ctx, "omp-1");
		const capture = await ctx.controller.captureStable();
		expect(capture.ok).toBe(true);
		const reloadsBefore = ctx.harness.exec.callsTo("hunk", ["session", "reload"]).length;

		// The pane is already occupied by a foreign process while pane get is
		// parked: the queued operations must await the proof and then refuse.
		const agentPane = ctx.harness.panes.get(HARNESS_AGENT_PANE);
		if (!agentPane) throw new Error("missing agent pane fixture");
		const realForeground = agentPane.foreground;
		agentPane.foreground = [++ctx.harness.nextPid];
		let releasePaneGet: (() => void) | undefined;
		const undo = ctx.harness.exec.override(
			call => call.command === "herdr" && call.args[0] === "pane" && call.args[1] === "get",
			() =>
				new Promise<ExecOutcome>(resolve => {
					releasePaneGet = () =>
						resolve({
							stdout: JSON.stringify({
								result: {
									pane: {
										pane_id: HARNESS_AGENT_PANE,
										tab_id: HARNESS_AGENT_TAB,
										workspace_id: HARNESS_WORKSPACE,
									},
								},
							}),
							stderr: "",
							code: 0,
							killed: false,
						});
				}),
		);

		const write = ctx.controller.commentWrite(capture.capture?.viewToken ?? "", {
			file: "seed.txt",
			side: "new",
			line: 2,
			summary: "stale",
		});
		const selection = ctx.controller.selectScope({ kind: "commit", commitSha: head }, snapshot);
		const focus = ctx.controller.focusTab(snapshot);
		const settled = Promise.allSettled([write, selection, focus]);
		await waitForExecCalls(ctx, 1, "herdr", ["pane", "get"]);
		releasePaneGet?.();
		undo();

		const [writeResult, selectionResult, focusResult] = await settled;
		expect(selectionResult.status).toBe("rejected");
		expect(focusResult.status).toBe("rejected");
		expect(writeResult.status).toBe("fulfilled");
		if (writeResult.status === "fulfilled") expect(writeResult.value.ok).toBe(false);
		expect(ctx.harness.adds).toBe(0);
		expect(ctx.harness.exec.callsTo("hunk", ["session", "reload"]).length).toBe(reloadsBefore);
		expect(ctx.harness.focusCount).toBe(0);

		// A verified reservation admits a fresh capture and annotation again.
		agentPane.foreground = realForeground;
		const fresh = await ctx.controller.captureStable();
		expect(fresh.ok).toBe(true);
		const written = await ctx.controller.commentWrite(fresh.capture?.viewToken ?? "", {
			file: "seed.txt",
			side: "new",
			line: 2,
			summary: "fresh",
		});
		expect(written.ok).toBe(true);
	});

	test("a single drain reconciles the newest observed parent without an extra call", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		const artifactsA = ctx.artifactsDir;
		const artifactsB = await nodeFs.mkdtemp(nodePath.join(nodeOs.tmpdir(), "herdr-ext-artifacts-"));
		cleaners.push(async () => {
			await nodeFs.rm(artifactsB, { recursive: true, force: true });
		});
		expect(await ctx.controller.admit()).toBe("primary");

		let releasePaneGet: (() => void) | undefined;
		const undo = ctx.harness.exec.override(
			call => call.command === "herdr" && call.args[0] === "pane" && call.args[1] === "get",
			() =>
				new Promise<ExecOutcome>(resolve => {
					releasePaneGet = () =>
						resolve({
							stdout: JSON.stringify({
								result: {
									pane: {
										pane_id: HARNESS_AGENT_PANE,
										tab_id: HARNESS_AGENT_TAB,
										workspace_id: HARNESS_WORKSPACE,
									},
								},
							}),
							stderr: "",
							code: 0,
							killed: false,
						});
				}),
		);
		const draining = ctx.controller.reconcile({
			ompSessionId: "omp-1",
			artifactsDir: artifactsA,
			cwd: ctx.repo.path,
		});
		await waitForExecCalls(ctx, 1, "herdr", ["pane", "get"]);
		// The newer parent is observed while the drain is parked on identity proof.
		ctx.controller.observeParent({ ompSessionId: "omp-2", artifactsDir: artifactsB, cwd: ctx.repo.path });
		releasePaneGet?.();
		undo();
		await draining;

		// The one drain applied the newest observed context: the child bound and
		// archived for omp-2's destination, not the stale snapshot's.
		expect(ctx.controller.childState).toBe("ready");
		expect(await fileExists(nodePath.join(artifactsB, "hunk", "review-notes.json"))).toBe(true);
		expect(await fileExists(nodePath.join(artifactsA, "hunk", "review-notes.json"))).toBe(false);
	});
});

describe("durable bound identity", () => {
	test("readiness waits until the bound identity is durably recorded; the tick completes it", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		// Fail exactly the bound-identity record write: provisional record
		// writes carry no Hunk identity and still succeed.
		const realWrite = Bun.write as unknown as (
			destination: unknown,
			data: unknown,
			options?: unknown,
		) => Promise<number>;
		const writableBun = Bun as unknown as {
			write: (destination: unknown, data: unknown, options?: unknown) => Promise<number>;
		};
		const recordTmpPrefix = `${ctx.recordPath}.tmp-`;
		writableBun.write = (destination, data, options) => {
			if (
				typeof destination === "string" &&
				destination.startsWith(recordTmpPrefix) &&
				typeof data === "string" &&
				data.includes("hunkSessionId")
			) {
				return Promise.reject(new Error("disk full"));
			}
			return realWrite(destination, data, options);
		};

		try {
			expect(await ctx.controller.admit()).toBe("primary");
			await ctx.controller.reconcile(ctx.desired);
		} finally {
			writableBun.write = realWrite;
		}

		// The launch bound in memory but its identity never became durable:
		// readiness, review, and archives stay blocked instead of running on a
		// record the disk cannot prove.
		expect(ctx.controller.childState).toBe("starting");
		expect(ctx.controller.isReady).toBe(false);
		const blocked = await ctx.controller.captureStable();
		expect(blocked.ok).toBe(false);
		const provisional = await readRecord(ctx);
		expect(provisional.hunkSessionId).toBeUndefined();
		expect(await sidecarExists(ctx)).toBe(false);
		expect(await fileExists(ctx.artifactsFile)).toBe(false);

		// The ordinary tick persists the bound identity and completes the bind.
		observe(ctx, "omp-1");
		await ctx.controller.reconcile(ctx.desired);

		expect(ctx.controller.isReady).toBe(true);
		const record = await readRecord(ctx);
		const stable = await ctx.controller.captureStable();
		expect(stable.ok).toBe(true);
		expect(record.hunkSessionId).toBe(stable.capture?.hunkSessionId);
	});
});

describe("runtime defect regressions", () => {
	test("retirement re-proves the child before closing; a changed occupant is never closed", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		await startPrimary(ctx);
		const paneId = childPaneIds(ctx)[0];
		const oldSession = killChildHunk(ctx, paneId); // proven exit: idle-shell retirement path

		// Park the pre-close re-proof's registry read (after the health read and
		// the early proof); while it is parked, another program takes the
		// original shell. The re-proof's pane observation runs only after that
		// registry read settles, so it must see the substituted occupant and
		// refuse the close the earlier proofs authorized.
		const gate = gateNthCall(
			ctx,
			"hunk",
			["session", "list"],
			3,
			() => ({
				stdout: JSON.stringify({
					sessions: ctx.harness.sessions.map(session => ({
						sessionId: session.sessionId,
						pid: session.pid,
						cwd: session.cwd,
						repoRoot: session.repoRoot,
						inputKind: "vcs",
					})),
				}),
				stderr: "",
				code: 0,
				killed: false,
			}),
		);
		const draining = ctx.controller.reconcile(ctx.desired);
		await gate.entered;
		const pane = ctx.harness.panes.get(paneId);
		if (pane === undefined) throw new Error("missing child pane fixture");
		const foreignPid = ++ctx.harness.nextPid;
		pane.foreground = [foreignPid];
		gate.release();
		await draining;
		gate.dispose();

		// The stale early proof was rejected: the unrelated occupant's pane was
		// never closed and no metadata moved.
		expect(closeCalls(ctx, paneId)).toBe(0);
		expect(ctx.harness.panes.has(paneId)).toBe(true);
		expect(await fileExists(ctx.recordPath)).toBe(true);
		expect(ctx.harness.tabCreateCount).toBe(1);

		// Once the occupant question is resolved, the same reconciliation path
		// retires and recreates without any /diff override.
		pane.foreground = [];
		observe(ctx, "omp-1");
		await ctx.controller.reconcile(ctx.desired);
		expect(closeCalls(ctx, paneId)).toBe(1);
		expect(ctx.harness.panes.has(paneId)).toBe(false);
		expect(ctx.harness.sessions.some(entry => entry.sessionId === oldSession.sessionId)).toBe(false);
		expect(ctx.harness.tabCreateCount).toBe(2);
		expect(ctx.controller.isReady).toBe(true);
	});

	test("retirement re-proves a live retained Hunk before closing; a substituted foreground is never closed", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		const seeded = await seedLiveChild(ctx);

		// Park the pre-close re-proof's registry read (the early proof consumes
		// the first); while it is parked, a foreign program takes the verified
		// child's foreground. The re-proof's pane observation runs only after
		// that registry read settles, so it must see the substitution and
		// refuse the close the earlier proof authorized.
		const gate = gateNthCall(
			ctx,
			"hunk",
			["session", "list"],
			2,
			() => ({
				stdout: JSON.stringify({
					sessions: ctx.harness.sessions.map(session => ({
						sessionId: session.sessionId,
						pid: session.pid,
						cwd: session.cwd,
						repoRoot: session.repoRoot,
						inputKind: "vcs",
					})),
				}),
				stderr: "",
				code: 0,
				killed: false,
			}),
		);
		expect(await ctx.controller.admit()).toBe("primary");
		const draining = ctx.controller.reconcile(ctx.desired);
		await gate.entered;
		const pane = ctx.harness.panes.get(seeded.paneId);
		if (pane === undefined) throw new Error("missing child pane fixture");
		pane.foreground = [++ctx.harness.nextPid];
		gate.release();
		await draining;
		gate.dispose();

		// The verified live child is never closed on a stale foreground proof
		// and no metadata moved.
		expect(closeCalls(ctx, seeded.paneId)).toBe(0);
		expect(ctx.harness.panes.has(seeded.paneId)).toBe(true);
		expect(ctx.harness.sessions).toContain(seeded.session);
		expect((await readRecord(ctx)).hunkSessionId).toBe(seeded.session.sessionId);
		expect(ctx.harness.tabCreateCount).toBe(0);

		// Once the occupant question is resolved, the same reconciliation path
		// retires the verified child and launches the replacement.
		pane.foreground = [seeded.session.pid];
		await ctx.controller.reconcile(ctx.desired);
		expect(closeCalls(ctx, seeded.paneId)).toBe(1);
		expect(ctx.harness.panes.has(seeded.paneId)).toBe(false);
		expect(ctx.harness.sessions.some(entry => entry.sessionId === seeded.session.sessionId)).toBe(false);
		expect(ctx.harness.tabCreateCount).toBe(1);
		expect(ctx.controller.isReady).toBe(true);
	});

	test("a conflicting live registration blocks idle-shell retirement", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		const seeded = await seedLiveChild(ctx);
		// The recorded UUID/PID is still live and registered, but its canonical
		// root no longer matches the record, and the pane shows only the
		// original shell. A conflicting LIVE registration is not a Hunk exit.
		seeded.session.repoRoot = "/elsewhere";
		seeded.session.cwd = "/elsewhere";
		const occupied = ctx.harness.panes.get(seeded.paneId);
		if (occupied !== undefined) occupied.foreground = [seeded.shellPid];

		expect(await ctx.controller.admit()).toBe("primary");
		await ctx.controller.reconcile(ctx.desired);

		expect(closeCalls(ctx, seeded.paneId)).toBe(0);
		expect(ctx.harness.panes.has(seeded.paneId)).toBe(true);
		expect(ctx.harness.sessions).toContain(seeded.session);
		expect(await fileExists(ctx.recordPath)).toBe(true);
		expect(ctx.harness.tabCreateCount).toBe(0);
		expect(ctx.notifications.some(message => message.includes("still registered"))).toBe(true);
	});

	test("an unverified recorded process blocks idle-shell retirement", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		const shellPid = ++ctx.harness.nextPid;
		ctx.harness.panes.set("w1:p1", { tabId: "w1:t1", shellPid, foreground: [shellPid] });
		// Nothing is registered for this UUID and the recorded PID was never
		// minted: its liveness is unknown, so its exit is unestablished.
		await seedRecord(ctx, {
			tabId: "w1:t1",
			paneId: "w1:p1",
			shellPid,
			repoRoot: await canon(ctx.repo.path),
			hunkSessionId: "ghost",
			hunkPid: 4_000_000,
		});

		expect(await ctx.controller.admit()).toBe("primary");
		await ctx.controller.reconcile(ctx.desired);

		expect(closeCalls(ctx, "w1:p1")).toBe(0);
		expect(ctx.harness.panes.has("w1:p1")).toBe(true);
		expect(await fileExists(ctx.recordPath)).toBe(true);
		expect(ctx.harness.tabCreateCount).toBe(0);
		expect(ctx.notifications.some(message => message.includes("unverified"))).toBe(true);
	});

	test("a proven rejected pane run is verified, retired, and recreated by the ordinary drain", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		expect(await ctx.controller.admit()).toBe("primary");

		// Reject exactly one dispatch with herdr's structured pre-submission
		// code; later dispatches fall through to the normal daemon handler.
		let rejected = false;
		const undo = ctx.harness.exec.override(
			call => call.command === "herdr" && call.args[0] === "pane" && call.args[1] === "run" && !rejected,
			call => {
				rejected = true;
				ctx.harness.launchedCommands.push(call.args[3] ?? "");
				queueMicrotask(undo);
				return {
					stdout: "",
					stderr: `${JSON.stringify({ error: { code: "server_not_running" } })}\n`,
					code: 1,
					killed: false,
				};
			},
		);
		await ctx.controller.reconcile(ctx.desired);

		// The rejected dispatch left a shell-qualified provisional: starting,
		// idle pane, no Hunk session, and no duplicate creation.
		expect(ctx.controller.childState).toBe("starting");
		expect(ctx.harness.tabCreateCount).toBe(1);
		const paneId = childPaneIds(ctx)[0];
		expect(paneId).toBeDefined();
		expect(ctx.harness.panes.get(paneId)?.foreground).toEqual([]);
		expect(ctx.harness.launchedCommands.length).toBe(1);
		expect(ctx.harness.sessions.length).toBe(0);

		// The ordinary drain verifies the failed idle provisional, retires it,
		// and recreates the child: one new tab and one new run.
		observe(ctx, "omp-1");
		await ctx.controller.reconcile(ctx.desired);

		expect(closeCalls(ctx, paneId)).toBe(1);
		expect(ctx.harness.panes.has(paneId)).toBe(false);
		expect(ctx.harness.tabCreateCount).toBe(2);
		expect(ctx.harness.launchedCommands.length).toBe(2);
		expect(ctx.controller.childState).toBe("ready");
		expect(ctx.controller.isReady).toBe(true);
		expect(ctx.harness.sessions.length).toBe(1);

		// Healthy ticks create and run nothing further.
		const createsAfter = ctx.harness.tabCreateCount;
		const runsAfter = ctx.harness.launchedCommands.length;
		observe(ctx, "omp-1");
		await ctx.controller.reconcile(ctx.desired);
		expect(ctx.harness.tabCreateCount).toBe(createsAfter);
		expect(ctx.harness.launchedCommands.length).toBe(runsAfter);
	});

	test("an unknown pane-run outcome binds through verification when the run landed", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		expect(await ctx.controller.admit()).toBe("primary");
		const root = await canon(ctx.repo.path);

		// Real herdr 0.9.3 answers a successful pane run with an empty code-0
		// envelope: classification stays "unknown", so the bind must happen by
		// verification and the command must never be submitted twice.
		const undo = ctx.harness.exec.override(
			call => call.command === "herdr" && call.args[0] === "pane" && call.args[1] === "run",
			call => {
				const pane = ctx.harness.panes.get(call.args[2] ?? "");
				if (pane === undefined) return herdrAbsent("pane_not_found");
				ctx.harness.launchedCommands.push(call.args[3] ?? "");
				ctx.harness.addSession(root, call.args[2] ?? "");
				ctx.harness.registered = true;
				return { stdout: "", stderr: "", code: 0, killed: false };
			},
		);
		await withPump(ctx, ctx.controller.reconcile(ctx.desired));
		undo();

		expect(ctx.harness.launchedCommands.length).toBe(1);
		expect(ctx.harness.tabCreateCount).toBe(1);
		expect(ctx.controller.childState).toBe("ready");
		expect(ctx.controller.isReady).toBe(true);
	});

	test("an unknown pane-run outcome never resubmits while it cannot be verified", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		expect(await ctx.controller.admit()).toBe("primary");

		const undo = ctx.harness.exec.override(
			call => call.command === "herdr" && call.args[0] === "pane" && call.args[1] === "run",
			call => {
				ctx.harness.launchedCommands.push(call.args[3] ?? "");
				return harnessFail("connection lost");
			},
		);
		await withPump(ctx, ctx.controller.reconcile(ctx.desired));
		undo();

		// The dispatch may have been submitted: no blind resubmission, no
		// speculative retirement, and no duplicate child.
		expect(ctx.harness.launchedCommands.length).toBe(1);
		expect(ctx.harness.tabCreateCount).toBe(1);
		expect(ctx.controller.childState).toBe("starting");
		const paneId = childPaneIds(ctx)[0];
		expect(ctx.harness.panes.has(paneId)).toBe(true);
		expect(closeCalls(ctx, paneId)).toBe(0);

		// Later drains keep verifying the same provisional child instead of
		// resubmitting the unknown command.
		observe(ctx, "omp-1");
		await ctx.controller.reconcile(ctx.desired);
		expect(ctx.harness.launchedCommands.length).toBe(1);
		expect(ctx.harness.tabCreateCount).toBe(1);
		expect(ctx.controller.childState).toBe("starting");
	});

	test("a transition archive publishes retained notes despite indeterminate git discovery", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		await startPrimary(ctx);
		const oldPaneId = childPaneIds(ctx)[0];
		const oldSession = ctx.harness.sessions[0];
		oldSession.notes = [{ noteId: "n1", body: "retained human note" }];

		const undo = ctx.harness.exec.override(
			call => call.command === "git" && call.args[0] === "rev-parse",
			() => harnessFail("git timeout"),
		);
		observe(ctx, "omp-2");
		await ctx.controller.reconcile(ctx.desired);
		undo();

		// The applied child's clean view was archived to the old parent's
		// destination before retirement, even though desired-checkout discovery
		// was indeterminate.
		const archived = JSON.parse(await nodeFs.readFile(ctx.artifactsFile, "utf8")) as Record<string, unknown>;
		expect(archived.ompSessionId).toBe("omp-1");
		expect(archived.hunkSessionId).toBe(oldSession.sessionId);
		expect(JSON.stringify(archived.review)).toContain("retained human note");
		expect(ctx.harness.panes.has(oldPaneId)).toBe(false);
		expect(closeCalls(ctx, oldPaneId)).toBe(1);

		// Tool-facing review access stays Git-gated for the current parent.
		const gated = await ctx.controller.captureStable();
		expect(gated.ok).toBe(false);
		expect(gated.reason).toContain("checkout cannot be resolved");

		// Once discovery resolves, the ordinary path binds a fresh child and
		// publishes its clean view without the old notes.
		observe(ctx, "omp-2");
		await ctx.controller.reconcile(ctx.desired);
		expect(ctx.harness.tabCreateCount).toBe(2);
		expect(ctx.controller.isReady).toBe(true);
		const fresh = JSON.parse(await nodeFs.readFile(ctx.artifactsFile, "utf8")) as Record<string, unknown>;
		expect(fresh.ompSessionId).toBe("omp-2");
		expect(JSON.stringify(fresh.review)).not.toContain("retained human note");
	});

	test("shutdown during a pre-submission launch leaves no recordless launch intent", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		expect(await ctx.controller.admit()).toBe("primary");

		// Park the creation's final controller lookup before `tab create`: the
		// sidecar exists, the intent is pre-submission, nothing was submitted.
		const gate = gateNthCall(
			ctx,
			"herdr",
			["pane", "get", HARNESS_AGENT_PANE],
			2,
			() => ({
				stdout: JSON.stringify({
					result: { pane: { pane_id: HARNESS_AGENT_PANE, tab_id: HARNESS_AGENT_TAB, workspace_id: HARNESS_WORKSPACE } },
				}),
				stderr: "",
				code: 0,
				killed: false,
			}),
		);
		const draining = ctx.controller.reconcile(ctx.desired);
		await gate.entered;
		expect(await sidecarExists(ctx)).toBe(true);

		await ctx.controller.shutdown(1_500);
		gate.release();
		await draining;
		gate.dispose();

		// Zero submitted creates: the operation's own cancellation removed its
		// matching-nonce intent even across shutdown — no recordless sidecar
		// can strand a successor as an unknown creation.
		expect(ctx.harness.tabCreateCount).toBe(0);
		expect(await sidecarExists(ctx)).toBe(false);
		expect(await fileExists(ctx.recordPath)).toBe(false);
		expect(ctx.harness.launchedCommands.length).toBe(0);
	});

	test("shutdown retains submitted creation evidence for the successor", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		expect(await ctx.controller.admit()).toBe("primary");

		// Park the launch's shell wait after `tab create` was submitted.
		let releaseShell: (() => void) | undefined;
		const shellStarted = Promise.withResolvers<void>();
		const undo = ctx.harness.exec.override(
			call =>
				call.command === "herdr" &&
				call.args[0] === "pane" &&
				call.args[1] === "process-info" &&
				call.args[3] !== HARNESS_AGENT_PANE,
			call => {
				const { promise, resolve } = Promise.withResolvers<ExecOutcome>();
				shellStarted.resolve();
				releaseShell = () => {
					undo();
					const pane = ctx.harness.panes.get(call.args[3] ?? "");
					resolve({
						stdout: JSON.stringify({
							result: {
								process_info: {
									pane_id: call.args[3] ?? "",
									shell_pid: pane?.shellPid ?? 0,
									...(pane !== undefined && pane.foreground.length > 0
										? { foreground_processes: pane.foreground.map(pid => ({ pid })) }
										: {}),
								},
							},
						}),
						stderr: "",
						code: 0,
						killed: false,
					});
				};
				return promise;
			},
		);

		const draining = ctx.controller.reconcile(ctx.desired);
		await shellStarted.promise;
		await ctx.controller.shutdown(1_500);
		releaseShell?.();
		await draining;
		undo();

		// A submitted creation keeps its durable evidence across shutdown: the
		// shell-qualified provisional record and sidecar survive and nothing
		// else was dispatched.
		expect(ctx.harness.tabCreateCount).toBe(1);
		expect(await fileExists(ctx.recordPath)).toBe(true);
		expect(await sidecarExists(ctx)).toBe(true);
		expect((await readRecord(ctx)).hunkSessionId).toBeUndefined();
		expect(ctx.harness.launchedCommands.length).toBe(0);

		// The successor resolves the retained provisional through the ordinary
		// path: it verifies the idle-shell child, replaces it, and binds a
		// fresh review — no unknown-creation block, no duplicate launch.
		ctx.harness.locks.simulateProcessExit(ctx.lockPath);
		const successor = new CompanionController(ctx.deps);
		successor.observeParent(ctx.desired);
		expect(await successor.admit()).toBe("primary");
		await successor.reconcile(ctx.desired);
		expect(ctx.harness.tabCreateCount).toBe(2);
		expect(successor.childState).toBe("ready");
		expect(await sidecarExists(ctx)).toBe(false);
	});
});
