import { afterEach, describe, expect, test } from "bun:test";
import * as nodeFs from "node:fs/promises";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import { CompanionController, type CompanionDeps } from "./companion";
import { CommandCliError, CompanionUnavailable, type ExecOutcome } from "./hunk-cli";
import { companionRecordPath, type CompanionRecord } from "./storage";
import {
	FakeTimers,
	HARNESS_AGENT_PANE,
	HARNESS_SOCKET,
	HARNESS_WORKSPACE,
	canon,
	createHerdrHarness,
	createTempRepo,
	harnessEnv,
	headSha,
	herdrAbsent,
	herdrTransient,
	killedOutcome,
	type GitFixture,
	type Harness,
} from "./test-helpers";

interface TestContext {
	harness: Harness;
	timers: FakeTimers;
	controller: CompanionController;
	deps: CompanionDeps;
	repo: GitFixture;
	artifactsDir: string;
	artifactsFile: string;
	stateDir: string;
	notifications: string[];
	recordPath: string;
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
	const stateDir = await nodeFs.mkdtemp(nodePath.join(nodeOs.tmpdir(), "hunk-ext-state-"));
	const artifactsDir = await nodeFs.mkdtemp(nodePath.join(nodeOs.tmpdir(), "hunk-ext-artifacts-"));
	const harness = createHerdrHarness();
	harness.repoRootForLaunch = repo.path;
	const env = harnessEnv(stateDir);
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
	};
	const controller = new CompanionController(deps);
	controller.updateSessionContext({ ompSessionId: "omp-1", artifactsDir });
	controller.setCwd(repo.path);
	const recordPath = companionRecordPath(env, HARNESS_SOCKET, HARNESS_WORKSPACE);
	return {
		harness,
		timers: harness.timers,
		controller,
		deps,
		repo,
		artifactsDir,
		artifactsFile: nodePath.join(artifactsDir, "hunk", "review-notes.json"),
		stateDir,
		notifications,
		recordPath,
		async cleanup() {
			await repo.cleanup();
			await nodeFs.rm(stateDir, { recursive: true, force: true });
			await nodeFs.rm(artifactsDir, { recursive: true, force: true });
		},
	};
}

async function seedRecord(context: TestContext, record: Partial<CompanionRecord>): Promise<void> {
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
	await nodeFs.mkdir(nodePath.dirname(context.recordPath), { recursive: true });
	await Bun.write(context.recordPath, `${JSON.stringify(full)}\n`);
}

async function readRecord(context: TestContext): Promise<Record<string, unknown>> {
	return JSON.parse(await nodeFs.readFile(context.recordPath, "utf8")) as Record<string, unknown>;
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

describe("companion identity and lifecycle", () => {
	test("fresh launch binds by pid, clears notes once, records ownership, and snapshots", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		await ctx.controller.initialize();

		expect(ctx.controller.state).toBe("ready");
		expect(ctx.harness.tabCreateCount).toBe(1);
		expect(ctx.harness.clears).toBe(1);
		expect(ctx.controller.scope).toEqual({ kind: "session", baseSha: await headSha(ctx.repo.path) });

		const launch = ctx.harness.launchedCommands[0];
		expect(launch).toContain(`cd -- '${await canon(ctx.repo.path)}'`);
		expect(launch).toContain(`'hunk' diff`);
		expect(launch).toContain(`--watch --agent-notes`);

		const session = ctx.harness.sessions[0];
		const record = await readRecord(ctx);
		expect(record.hunkSessionId).toBe(session.sessionId);
		expect(record.hunkPid).toBe(session.pid);
		expect(record.repoRoot).toBe(await canon(ctx.repo.path));

		const snapshot = JSON.parse(await nodeFs.readFile(ctx.artifactsFile, "utf8")) as Record<string, unknown>;
		expect(snapshot.version).toBe(1);
		expect(snapshot.hunkSessionId).toBe(session.sessionId);
		expect(snapshot.scope).toEqual({ kind: "session", baseSha: await headSha(ctx.repo.path) });
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
		});

		await ctx.controller.initialize();

		expect(ctx.controller.isReady).toBe(true);
		const pane = ctx.harness.panes.get("w1:p1");
		expect(pane?.foreground.length).toBe(1);
		const ownedPid = pane?.foreground[0];
		expect(ownedPid).not.toBe(ctx.harness.sessions[0].pid);
		const bound = ctx.harness.sessions.find(entry => entry.pid === ownedPid);
		expect(bound?.sessionId.startsWith("sess-")).toBe(true);
		const record = await readRecord(ctx);
		expect(record.hunkSessionId).toBe(bound?.sessionId);
		expect(record.hunkPid).toBe(ownedPid);
		expect(record.repoRoot).toBe(root);
		expect(ctx.harness.clears).toBe(1);
	});

	test("duplicate new sessions fail closed instead of guessing", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		ctx.harness.duplicateLaunch = true;
		await expect(ctx.controller.initialize()).rejects.toBeInstanceOf(CompanionUnavailable);
		expect(ctx.controller.state).toBe("closed");
		expect(ctx.controller.closedReason).toBe("unverified");
		expect(ctx.controller.isReady).toBe(false);
		expect(ctx.harness.clears).toBe(0);
		expect(ctx.harness.tabCreateCount).toBe(1); // the owned tab stands; no second attempt
	});

	test("duplicate registration mid-handshake fails closed instead of newest-wins", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		ctx.harness.launchRegistrationDeferred = true;
		const root = await canon(ctx.repo.path);
		const gate = (async () => {
			// Two session-list calls: the launch snapshot, then the first handshake poll.
			await waitForExecCalls(ctx, 2, "hunk", ["session", "list"]);
			ctx.harness.registered = true;
			const paneId = ctx.harness.deferredPaneId;
			if (paneId !== undefined) {
				ctx.harness.addSession(root, paneId);
				ctx.harness.addSession(root, paneId);
			}
		})();
		await expect(withPump(ctx, ctx.controller.initialize())).rejects.toBeInstanceOf(CompanionUnavailable);
		await gate;

		expect(ctx.controller.state).toBe("closed");
		expect(ctx.controller.closedReason).toBe("unverified");
		const record = await readRecord(ctx);
		expect(record.hunkSessionId).toBeUndefined();
		expect(record.hunkPid).toBeUndefined();
		expect(ctx.harness.clears).toBe(0);
		expect(ctx.harness.tabCreateCount).toBe(1);
	});

	test("delayed readiness: no duplicate tab, and a later initialize binds the same pane", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		// The daemon registration lags past the handshake deadline: the gate
		// registers only after the launch-timeout notification fires.
		ctx.harness.launchRegistrationDeferred = true;
		const gate = (async () => {
			await waitForNotification(ctx, "timed out");
			ctx.harness.registered = true;
			if (ctx.harness.deferredPaneId !== undefined) {
				ctx.harness.addSession(ctx.harness.repoRootForLaunch, ctx.harness.deferredPaneId);
			}
		})();
		const initialized = withPump(ctx, ctx.controller.initialize());
		await gate;
		await initialized;
		expect(ctx.controller.state).toBe("starting");
		expect(ctx.harness.tabCreateCount).toBe(1);

		// A later initialize (e.g. /diff) re-handshakes the same provisional pane.
		const retry = ctx.controller.initialize({ explicit: true });
		await withPump(ctx, retry);
		expect(ctx.controller.state).toBe("ready");
		expect(ctx.harness.tabCreateCount).toBe(1);
	});

	test("late bind refuses a replaced shell and never binds or clears a foreign session", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		ctx.harness.launchRegistrationDeferred = true;
		const root = await canon(ctx.repo.path);
		const gate = (async () => {
			await waitForNotification(ctx, "timed out");
			const paneId = ctx.harness.deferredPaneId;
			const pane = paneId !== undefined ? ctx.harness.panes.get(paneId) : undefined;
			if (pane !== undefined) {
				// The original shell died and a new one owns the pane.
				pane.shellPid = ++ctx.harness.nextPid;
				pane.foreground = [];
			}
			ctx.harness.registered = true;
			if (paneId !== undefined) ctx.harness.addSession(root, paneId);
		})();
		const initialized = withPump(ctx, ctx.controller.initialize());
		await gate;
		await initialized;
		expect(ctx.controller.state).toBe("starting");
		expect(ctx.harness.clears).toBe(0);

		// Every tick keeps refusing: the pane is not the shell we launched.
		await ctx.controller.lifecycleTick();
		await ctx.controller.lifecycleTick();
		expect(ctx.controller.state).toBe("starting");
		expect(ctx.harness.clears).toBe(0);
		const record = await readRecord(ctx);
		expect(record.hunkSessionId).toBeUndefined();
		expect(record.hunkPid).toBeUndefined();
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
		});
		const preExistingPid = ctx.harness.sessions[0].pid;
		// Our own review registers late, so the handshake polls while the
		// user's pre-existing hunk sits in the companion pane's foreground.
		ctx.harness.launchRegistrationDeferred = true;
		const gate = (async () => {
			// Two session-list calls: the launch snapshot, then the first poll.
			await waitForExecCalls(ctx, 2, "hunk", ["session", "list"]);
			const paneId = ctx.harness.deferredPaneId;
			if (paneId !== undefined) {
				const pane = ctx.harness.panes.get(paneId);
				pane?.foreground.push(preExistingPid);
				ctx.harness.addSession(root, paneId);
			}
		})();
		await withPump(ctx, ctx.controller.initialize());
		await gate;

		expect(ctx.controller.isReady).toBe(true);
		const pane = ctx.harness.panes.get("w1:p1");
		expect(pane?.foreground).toContain(preExistingPid);
		const record = await readRecord(ctx);
		expect(record.hunkSessionId).not.toBe("pre-existing");
		expect(record.hunkPid).not.toBe(preExistingPid);
		expect(ctx.harness.clears).toBe(1);
	});

	test("adoption reuses the recorded tab and session without creating a new one", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		const shellPid = ++ctx.harness.nextPid;
		ctx.harness.panes.set("w1:p1", { tabId: "w1:t1", shellPid, foreground: [] });
		const session = ctx.harness.addSession(await canon(ctx.repo.path), "w1:p1");
		ctx.harness.registered = true;
		await seedRecord(ctx, {
			tabId: "w1:t1",
			paneId: "w1:p1",
			shellPid,
			hunkSessionId: session.sessionId,
			hunkPid: session.pid,
		});

		await ctx.controller.initialize();
		expect(ctx.controller.state).toBe("ready");
		expect(ctx.harness.tabCreateCount).toBe(0);
		expect(ctx.harness.launchedCommands.length).toBe(0);
		expect(ctx.harness.clears).toBe(1);
		expect(ctx.controller.isReady).toBe(true);
	});

	test("ownership conflict: another live agent pane is never stolen", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		ctx.harness.panes.set("w1:pOther", { tabId: "w1:tOther", shellPid: ++ctx.harness.nextPid, foreground: [] });
		await seedRecord(ctx, { ownerPaneId: "w1:pOther", tabId: "w1:tX", paneId: "w1:pX" });

		await expect(ctx.controller.initialize()).rejects.toBeInstanceOf(CompanionUnavailable);
		expect(ctx.harness.tabCreateCount).toBe(0);
		expect(ctx.notifications.some(message => message.includes("owned by another agent pane"))).toBe(true);
	});

	test("transient failure while verifying the owner parks instead of stealing", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		await seedRecord(ctx, { ownerPaneId: "w1:pOther", tabId: "w1:tX", paneId: "w1:pX" });
		const undo = ctx.harness.exec.override(
			call => call.command === "herdr" && call.args[1] === "get",
			() => herdrTransient(),
		);
		await expect(ctx.controller.initialize()).rejects.toBeInstanceOf(CompanionUnavailable);
		expect(ctx.controller.state).toBe("unavailable");
		expect(ctx.harness.tabCreateCount).toBe(0);
		undo();

		// Once herdr answers, the tick's retry proves the owner is gone and takes over.
		await ctx.controller.lifecycleTick();
		expect(ctx.controller.isReady).toBe(true);
		expect(ctx.harness.tabCreateCount).toBe(1);
	});

	test("health check skips transient herdr failures; proven absence still closes", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		await ctx.controller.initialize();
		const closedNotices = () => ctx.notifications.filter(message => message.includes("was closed")).length;
		expect(closedNotices()).toBe(0);

		const transientTabGet = ctx.harness.exec.override(
			call => call.command === "herdr" && call.args[1] === "get",
			() => herdrTransient(),
		);
		await ctx.controller.lifecycleTick();
		expect(ctx.controller.state).toBe("ready");
		expect(closedNotices()).toBe(0);
		transientTabGet();

		const killedTabGet = ctx.harness.exec.override(
			call => call.command === "herdr" && call.args[1] === "get",
			() => killedOutcome(),
		);
		await ctx.controller.lifecycleTick();
		expect(ctx.controller.state).toBe("ready");
		killedTabGet();

		const transientInfo = ctx.harness.exec.override(
			call => call.command === "herdr" && call.args[1] === "process-info",
			() => herdrTransient(),
		);
		await ctx.controller.lifecycleTick();
		expect(ctx.controller.state).toBe("ready");
		expect(closedNotices()).toBe(0);
		transientInfo();

		const malformedInfo = ctx.harness.exec.override(
			call => call.command === "herdr" && call.args[1] === "process-info",
			() => ({ stdout: JSON.stringify({ result: { process_info: {} } }), stderr: "", code: 0, killed: false }),
		);
		await ctx.controller.lifecycleTick();
		expect(ctx.controller.state).toBe("ready");
		malformedInfo();

		const absentTabGet = ctx.harness.exec.override(
			call => call.command === "herdr" && call.args[1] === "get",
			() => herdrAbsent("tab_not_found"),
		);
		await ctx.controller.lifecycleTick();
		absentTabGet();
		expect(ctx.controller.state).toBe("closed");
		expect(ctx.controller.closedReason).toBe("user");
		expect(closedNotices()).toBe(1);
	});

	test("adoption on transient herdr failure parks without duplicating the tab", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		const shellPid = ++ctx.harness.nextPid;
		ctx.harness.panes.set("w1:p1", { tabId: "w1:t1", shellPid, foreground: [] });
		const session = ctx.harness.addSession(await canon(ctx.repo.path), "w1:p1");
		ctx.harness.registered = true;
		await seedRecord(ctx, {
			tabId: "w1:t1",
			paneId: "w1:p1",
			shellPid,
			hunkSessionId: session.sessionId,
			hunkPid: session.pid,
		});

		const undo = ctx.harness.exec.override(
			call => call.command === "herdr" && call.args[1] === "get",
			() => herdrTransient(),
		);
		await expect(ctx.controller.initialize()).rejects.toBeInstanceOf(CompanionUnavailable);
		expect(ctx.controller.state).toBe("unavailable");
		expect(ctx.harness.tabCreateCount).toBe(0);
		undo();

		// The parked startup retries from the lifecycle tick and adopts in place.
		await ctx.controller.lifecycleTick();
		expect(ctx.controller.isReady).toBe(true);
		expect(ctx.harness.tabCreateCount).toBe(0);
		expect(ctx.controller.repoRoot).toBe(await canon(ctx.repo.path));
	});

	test("malformed pane identity is indeterminate, never permission to replace a companion", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		await ctx.controller.initialize();
		const adopter = new CompanionController(ctx.deps);
		adopter.updateSessionContext({ ompSessionId: "omp-2", artifactsDir: ctx.artifactsDir });
		adopter.setCwd(ctx.repo.path);
		const undo = ctx.harness.exec.override(
			call => call.command === "herdr" && call.args[0] === "pane" && call.args[1] === "get",
			() => ({ stdout: JSON.stringify({ result: { pane: {} } }), stderr: "", code: 0, killed: false }),
		);
		await expect(adopter.initialize()).rejects.toBeInstanceOf(CompanionUnavailable);
		expect(adopter.state).toBe("unavailable");
		expect(ctx.harness.tabCreateCount).toBe(1);
		expect(ctx.harness.clears).toBe(1);
		undo();
		await adopter.lifecycleTick();
		expect(adopter.isReady).toBe(true);
		expect(ctx.harness.tabCreateCount).toBe(1);
	});

	test("recorded session cannot be adopted after its shell is replaced", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		await ctx.controller.initialize();
		const record = await readRecord(ctx);
		const pane = ctx.harness.panes.get(record.paneId);
		if (!pane) throw new Error("missing fixture pane");
		pane.shellPid += 100;
		const foreground = [...pane.foreground];
		const adopter = new CompanionController(ctx.deps);
		adopter.updateSessionContext({ ompSessionId: "omp-2", artifactsDir: ctx.artifactsDir });
		adopter.setCwd(ctx.repo.path);
		await expect(adopter.initialize()).rejects.toBeInstanceOf(CompanionUnavailable);
		expect(ctx.harness.clears).toBe(1);
		expect(ctx.harness.ctrlcSent).toBe(0);
		await adopter.initialize({ explicit: true });
		expect(ctx.harness.tabCreateCount).toBe(2);
		expect(pane.foreground).toEqual(foreground);
		expect(ctx.harness.ctrlcSent).toBe(0);
	});

	test("launch setup failures park instead of wedging in starting; ticks recover", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		// Phase 1: hunk daemon unreachable before any tab exists.
		const failSessionList = ctx.harness.exec.override(
			call => call.command === "hunk" && call.args[1] === "list",
			() => harnessDaemonDown(),
		);
		await expect(ctx.controller.initialize()).rejects.toBeInstanceOf(CommandCliError);
		expect(ctx.controller.state).toBe("unavailable");
		expect(ctx.harness.tabCreateCount).toBe(0);
		failSessionList();

		// Phase 2: herdr tab create fails transiently.
		const failTabCreate = ctx.harness.exec.override(
			call => call.command === "herdr" && call.args[1] === "create",
			() => herdrTransient(),
		);
		await expect(ctx.controller.initialize()).rejects.toBeInstanceOf(CommandCliError);
		expect(ctx.controller.state).toBe("unavailable");
		expect(ctx.harness.tabCreateCount).toBe(0);
		failTabCreate();

		// Phase 3: the next lifecycle tick retries startup and succeeds.
		await ctx.controller.lifecycleTick();
		expect(ctx.controller.isReady).toBe(true);
		expect(ctx.harness.tabCreateCount).toBe(1);
	});

	test("user-closed tab stays closed on ticks; a completed /diff reopen recreates it", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		await ctx.controller.initialize();
		const closedNotices = () => ctx.notifications.filter(message => message.includes("was closed")).length;
		const originalPaneId = ctx.harness.panes.keys().next().value;
		expect(originalPaneId).toBeDefined();

		// User closes the companion tab.
		if (originalPaneId !== undefined) ctx.harness.panes.delete(originalPaneId);
		await ctx.controller.lifecycleTick();
		expect(ctx.controller.state).toBe("closed");
		expect(ctx.controller.closedReason).toBe("user");

		await ctx.controller.lifecycleTick();
		await ctx.controller.lifecycleTick();
		expect(ctx.harness.tabCreateCount).toBe(1); // no respawn

		await ctx.controller.initialize({ explicit: true });
		expect(ctx.controller.state).toBe("ready");
		expect(ctx.harness.tabCreateCount).toBe(2);

		// Recovery re-armed the close notice: a second close notifies again.
		const noticesBefore = closedNotices();
		const reopenedPaneId = ctx.harness.panes.keys().next().value;
		if (reopenedPaneId !== undefined) ctx.harness.panes.delete(reopenedPaneId);
		await ctx.controller.lifecycleTick();
		expect(ctx.controller.state).toBe("closed");
		expect(closedNotices()).toBe(noticesBefore + 1);
	});

	test("same-root cwd movement changes nothing; cross-root relaunches in the same pane", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		await ctx.controller.initialize();
		const launchesBefore = ctx.harness.launchedCommands.length;
		const paneId = ctx.harness.panes.keys().next().value;
		expect(paneId).toBeDefined();

		const subDir = nodePath.join(ctx.repo.path, "sub");
		await nodeFs.mkdir(subDir, { recursive: true });
		ctx.controller.setCwd(subDir);
		await ctx.controller.lifecycleTick();
		expect(ctx.harness.launchedCommands.length).toBe(launchesBefore);
		expect(ctx.harness.ctrlcSent).toBe(0);

		const other = await createTempRepo(["other one", "other two"]);
		cleaners.push(other.cleanup);
		ctx.harness.repoRootForLaunch = other.path;
		const otherHead = await headSha(other.path);
		ctx.controller.setCwd(other.path);
		await ctx.controller.lifecycleTick();

		expect(ctx.controller.isReady).toBe(true);
		expect(ctx.controller.repoRoot).toBe(await canon(other.path));
		expect(ctx.controller.baselineHead).toBe(otherHead);
		expect(ctx.harness.launchedCommands.length).toBe(launchesBefore + 1);
		expect(ctx.harness.launchedCommands.at(-1)).toContain(`cd -- '${await canon(other.path)}'`);
		expect(ctx.harness.launchedCommands.at(-1)).toContain(`'${otherHead}'`);
		if (paneId !== undefined) {
			expect(ctx.harness.panes.get(paneId)?.foreground.length).toBe(1);
		}
		expect(ctx.harness.tabCreateCount).toBe(1); // same pane reused
	});

	test("left-git then a different repo stops the owned hunk and reuses the pane", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		await ctx.controller.initialize();
		const paneId = ctx.harness.panes.keys().next().value;
		expect(paneId).toBeDefined();

		const plainDir = await nodeFs.mkdtemp(nodePath.join(nodeOs.tmpdir(), "hunk-ext-plain-"));
		cleaners.push(async () => nodeFs.rm(plainDir, { recursive: true, force: true }));
		ctx.controller.setCwd(plainDir);
		await ctx.controller.lifecycleTick();
		expect(ctx.controller.state).toBe("closed");
		expect(ctx.controller.closedReason).toBe("left-git");

		const other = await createTempRepo(["other repo seed"]);
		cleaners.push(other.cleanup);
		ctx.harness.repoRootForLaunch = other.path;
		const otherHead = await headSha(other.path);
		ctx.controller.setCwd(other.path);
		await ctx.controller.lifecycleTick();

		expect(ctx.controller.isReady).toBe(true);
		expect(ctx.controller.repoRoot).toBe(await canon(other.path));
		expect(ctx.controller.baselineHead).toBe(otherHead);
		expect(ctx.harness.ctrlcSent).toBe(1); // the old owned hunk was stopped, not orphaned
		expect(ctx.harness.tabCreateCount).toBe(1); // same pane reused
		expect(ctx.harness.clears).toBe(2);
		expect(ctx.harness.launchedCommands.at(-1)).toContain(`cd -- '${await canon(other.path)}'`);
	});

	test("idle shell reporting its own pid still counts as stopped (cross-root reuse)", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		ctx.harness.ctrlcLeavesShell = true;
		await ctx.controller.initialize();
		const paneId = ctx.harness.panes.keys().next().value;
		expect(paneId).toBeDefined();

		const plainDir = await nodeFs.mkdtemp(nodePath.join(nodeOs.tmpdir(), "hunk-ext-plain-"));
		cleaners.push(async () => nodeFs.rm(plainDir, { recursive: true, force: true }));
		ctx.controller.setCwd(plainDir);
		await ctx.controller.lifecycleTick();
		expect(ctx.controller.closedReason).toBe("left-git");

		const other = await createTempRepo(["shell-reporting repo"]);
		cleaners.push(other.cleanup);
		ctx.harness.repoRootForLaunch = other.path;
		ctx.controller.setCwd(other.path);
		await ctx.controller.lifecycleTick();

		expect(ctx.controller.isReady).toBe(true);
		expect(ctx.harness.ctrlcSent).toBe(1);
		expect(ctx.harness.tabCreateCount).toBe(1);
		const pane = paneId !== undefined ? ctx.harness.panes.get(paneId) : undefined;
		expect(pane?.foreground.length).toBe(2); // shell still reported + the new hunk
	});

	test("busy pane on root change: left untouched, no input beyond the verified ctrl+c", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		await ctx.controller.initialize();
		ctx.harness.ctrlcNoop = true; // shell never becomes idle

		const other = await createTempRepo(["busy one"]);
		cleaners.push(other.cleanup);
		ctx.harness.repoRootForLaunch = other.path;
		ctx.controller.setCwd(other.path);
		await withPump(ctx, ctx.controller.lifecycleTick());

		expect(ctx.controller.state).toBe("closed");
		expect(ctx.controller.closedReason).toBe("blocked");
		const launchesAfterBlock = ctx.harness.launchedCommands.length;
		expect(ctx.harness.tabCreateCount).toBe(1);

		const oldPaneId = ctx.harness.panes.keys().next().value;
		const oldForeground = oldPaneId ? [...(ctx.harness.panes.get(oldPaneId)?.foreground ?? [])] : [];
		const stops = ctx.harness.ctrlcSent;
		await ctx.controller.initialize({ explicit: true });
		expect(ctx.harness.ctrlcSent).toBe(stops);
		expect(oldPaneId ? ctx.harness.panes.get(oldPaneId)?.foreground : []).toEqual(oldForeground);
		expect(ctx.controller.isReady).toBe(true);
		expect(ctx.harness.tabCreateCount).toBe(2);
		expect(ctx.harness.launchedCommands.length).toBe(launchesAfterBlock + 1);
	});

	test("omp session boundary clears notes exactly once per changed id", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		await ctx.controller.initialize();
		expect(ctx.harness.clears).toBe(1);

		await ctx.controller.onSessionChanged("omp-2");
		expect(ctx.harness.clears).toBe(2);
		await ctx.controller.onSessionChanged("omp-2");
		expect(ctx.harness.clears).toBe(2);
	});

	test("leaving git parks the companion; returning reactivates it", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		await ctx.controller.initialize();

		const plainDir = await nodeFs.mkdtemp(nodePath.join(nodeOs.tmpdir(), "hunk-ext-plain-"));
		cleaners.push(async () => nodeFs.rm(plainDir, { recursive: true, force: true }));
		ctx.controller.setCwd(plainDir);
		await ctx.controller.lifecycleTick();
		expect(ctx.controller.state).toBe("closed");
		expect(ctx.controller.closedReason).toBe("left-git");

		ctx.controller.setCwd(ctx.repo.path);
		await ctx.controller.lifecycleTick();
		expect(ctx.controller.state).toBe("ready");
	});

	test("root transition archives the old review before stopping the owned process", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		await ctx.controller.initialize();
		ctx.harness.reviewNotes = [{ noteId: "n1", body: "human note" }];
		const oldSessionId = ctx.harness.sessions[0].sessionId;

		const other = await createTempRepo(["next repo"]);
		cleaners.push(other.cleanup);
		ctx.harness.repoRootForLaunch = other.path;
		ctx.controller.setCwd(other.path);
		await ctx.controller.lifecycleTick();

		const calls = ctx.harness.exec.calls;
		const oldReviewIndex = calls.findIndex(
			call => call.command === "hunk" && call.args[1] === "review" && call.args[2] === oldSessionId,
		);
		const ctrlcIndex = calls.findIndex(call => call.command === "herdr" && call.args[1] === "send-keys");
		expect(oldReviewIndex).toBeGreaterThanOrEqual(0);
		expect(ctrlcIndex).toBeGreaterThan(oldReviewIndex);

		const envelope = JSON.parse(await nodeFs.readFile(ctx.artifactsFile, "utf8")) as Record<string, unknown>;
		expect(envelope.hunkSessionId).not.toBe(oldSessionId); // rolling file tracks the new binding
		expect(ctx.controller.isReady).toBe(true);
		expect(ctx.harness.ctrlcSent).toBe(1);
		expect(ctx.harness.tabCreateCount).toBe(1);
	});

	test("reset failure blocks writes; a completed /diff selection retries it", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		await ctx.controller.initialize();
		ctx.harness.failClears = true;
		await ctx.controller.onSessionChanged("omp-2");
		expect(ctx.harness.clears).toBe(1);

		const refused = await ctx.controller.commentWrite("stale-token", { summary: "x" });
		expect(refused.ok).toBe(false);
		expect(refused.error).toContain("/diff");

		ctx.harness.failClears = false;
		const head = await headSha(ctx.repo.path);
		await ctx.controller.selectScope({ kind: "commit", commitSha: head });
		expect(ctx.harness.clears).toBe(2); // the completed selection retried the reset

		const capture = await ctx.controller.captureStable();
		expect(capture.ok).toBe(true);
		const write = await ctx.controller.commentWrite(capture.capture?.viewToken ?? "", { file: "seed.txt", side: "new", line: 2, summary: "note" });
		expect(write.ok).toBe(true);
		expect(ctx.harness.adds).toBe(1);

		// Suppression re-arms after recovery: a renewed failure notifies again.
		const resetFailures = () => ctx.notifications.filter(message => message.includes("could not clear")).length;
		const failuresBefore = resetFailures();
		ctx.harness.failClears = true;
		await ctx.controller.onSessionChanged("omp-3");
		expect(resetFailures()).toBe(failuresBefore + 1);
	});

	test("session changes during shutdown do not reset the companion", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		await ctx.controller.initialize();
		expect(ctx.harness.clears).toBe(1);

		const shutdown = ctx.controller.shutdown(1_000);
		await ctx.controller.onSessionChanged("omp-during-shutdown");
		await shutdown;

		expect(ctx.harness.clears).toBe(1);
		expect(ctx.controller.state).toBe("unavailable");
	});

	test("scope change retitles the tab to diff without affecting the reload", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		await ctx.controller.initialize();
		const head = await headSha(ctx.repo.path);
		await ctx.controller.selectScope({ kind: "commit", commitSha: head });

		expect(ctx.harness.renames).toEqual(["diff"]);
		const reload = ctx.harness.exec.calls.find(
			call => call.command === "hunk" && call.args[1] === "reload",
		);
		expect(reload?.args).toContain("show");
		expect(reload?.args).toContain(head);
		expect(ctx.controller.scope).toEqual({ kind: "commit", commitSha: head });
	});
});

describe("companion ticks and concurrency", () => {
	test("concurrent ticks await the in-flight tick instead of racing it", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		await ctx.controller.initialize();

		let releaseTabGet: (() => void) | undefined;
		const undo = ctx.harness.exec.override(
			call => call.command === "herdr" && call.args[1] === "get",
			() =>
				new Promise<ExecOutcome>(resolve => {
					releaseTabGet = () => resolve(herdrTransient());
				}),
		);
		const first = ctx.controller.lifecycleTick();
		const second = ctx.controller.lifecycleTick();
		expect(second).toBe(first);
		releaseTabGet?.();
		await Promise.all([first, second]);
		undo();
		expect(ctx.controller.state).toBe("ready"); // transient hiccup, no close
	});

	test("shutdown final snapshot respects its deadline against a hung capture", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		await ctx.controller.initialize();
		const reviewsBefore = ctx.harness.exec.callsTo("hunk", ["session", "review"]).length;

		ctx.harness.hangSessionGet = true;
		await withPump(ctx, ctx.controller.shutdown(1_000));
		expect(ctx.controller.state).toBe("unavailable");
		// No capture completed during shutdown: no new review read, no rewrite.
		expect(ctx.harness.exec.callsTo("hunk", ["session", "review"]).length).toBe(reviewsBefore);
		const before = await nodeFs.readFile(ctx.artifactsFile, "utf8");

		// Drain the hung capture; the rolling file keeps its last good bytes.
		ctx.harness.hangSessionGet = false;
		ctx.harness.releaseSessionGet();
		const after = await nodeFs.readFile(ctx.artifactsFile, "utf8");
		expect(after).toBe(before);
	});

	test("overlapping archive calls: the running snapshot wins, the second is skipped", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		await ctx.controller.initialize();
		const reviewsBefore = ctx.harness.exec.callsTo("hunk", ["session", "review"]).length;

		ctx.harness.hangSessionGet = true;
		const first = ctx.controller.snapshotNow({ deadlineMs: 30_000 });
		const second = await ctx.controller.snapshotNow({ deadlineMs: 30_000 });
		expect(second).toBe(false);

		ctx.harness.hangSessionGet = false;
		ctx.harness.releaseSessionGet();
		expect(await first).toBe(true);
		expect(ctx.harness.exec.callsTo("hunk", ["session", "review"]).length).toBe(reviewsBefore + 1);
		const envelope = JSON.parse(await nodeFs.readFile(ctx.artifactsFile, "utf8")) as Record<string, unknown>;
		expect(envelope.version).toBe(1);
	});
});

describe("stable capture and view tokens", () => {
	test("stable reads reuse the token; a generation change rotates and refuses it", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		await ctx.controller.initialize();

		const stable1 = await ctx.controller.captureStable();
		expect(stable1.ok).toBe(true);
		const stable2 = await ctx.controller.captureStable();
		expect(stable2.ok).toBe(true);
		expect(stable2.capture?.viewToken).toBe(stable1.capture?.viewToken);
		expect(stable2.capture?.publication.generation).toBe(stable1.capture?.publication.generation);

		// Generation drifts between the two reads of one capture: refused.
		ctx.harness.bumpGenerationOnNextGet = true;
		const drifted = await ctx.controller.captureStable();
		expect(drifted.ok).toBe(false);
		expect(drifted.reason).toContain("hunk_review");

		// The next stable read succeeds at the new generation with a fresh token.
		const afterDrift = await ctx.controller.captureStable();
		expect(afterDrift.ok).toBe(true);
		expect(afterDrift.capture?.publication.generation).not.toBe(stable1.capture?.publication.generation);
		expect(afterDrift.capture?.viewToken).not.toBe(stable1.capture?.viewToken);

		// The old token is refused for writes.
		const write = await ctx.controller.commentWrite(stable1.capture?.viewToken ?? "", { summary: "stale" });
		expect(write.ok).toBe(false);
		expect(write.error).toContain("hunk_review");
		expect(ctx.harness.adds).toBe(0);
	});

	test("missing publication generation is a retryable error, never a capture", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		await ctx.controller.initialize();

		ctx.harness.omitGeneration = true;
		const outcome = await ctx.controller.captureStable();
		ctx.harness.omitGeneration = false;
		expect(outcome.ok).toBe(false);
		expect(outcome.reason).toContain("generation");
		expect(outcome.capture).toBeUndefined();

		// A stable read still works afterwards.
		const retry = await ctx.controller.captureStable();
		expect(retry.ok).toBe(true);
	});

	test("stateRevision-only drift keeps the capture stable", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		await ctx.controller.initialize();

		ctx.harness.bumpStateRevisionOnNextGet = true;
		const outcome = await ctx.controller.captureStable();
		expect(outcome.ok).toBe(true);
		expect(outcome.capture?.publication.generation).toBe("gen-1");
		expect(outcome.capture?.publication.stateRevision).toBe(2);
	});

	test("comment write timeout reports unknown outcome, once, and kills the token", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		await ctx.controller.initialize();
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
		expect(ctx.harness.adds).toBe(1);

		// A blind retry is refused: the outcome was unknown, so the token is dead.
		const retry = await ctx.controller.commentWrite(token, { file: "seed.txt", side: "new", line: 2, summary: "again" });
		expect(retry.ok).toBe(false);
		expect(retry.error).toContain("hunk_review");
		expect(ctx.harness.adds).toBe(1);

		// A fresh capture re-arms writes.
		ctx.harness.hangCommentAdd = false;
		const fresh = await ctx.controller.captureStable();
		expect(fresh.ok).toBe(true);
		const write = await ctx.controller.commentWrite(fresh.capture?.viewToken ?? "", { file: "seed.txt", side: "new", line: 2, summary: "settled" });
		expect(write.ok).toBe(true);
		expect(ctx.harness.adds).toBe(2);
	});
});

/** hunk-side daemon failure: a plain (non-herdr) CLI error. */
function harnessDaemonDown(): ExecOutcome {
	return { stdout: "", stderr: "hunk: daemon unreachable", code: 1, killed: false };
}
