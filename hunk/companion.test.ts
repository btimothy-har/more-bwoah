import { afterEach, describe, expect, test } from "bun:test";
import * as nodeFs from "node:fs/promises";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import { CompanionController, type CompanionDeps } from "./companion";
import { CompanionUnavailable } from "./hunk-cli";
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
		const record = JSON.parse(await nodeFs.readFile(ctx.recordPath, "utf8")) as Record<string, unknown>;
		expect(record.hunkSessionId).toBe(session.sessionId);
		expect(record.hunkPid).toBe(session.pid);
		expect(record.repoRoot).toBe(await canon(ctx.repo.path));

		const snapshot = JSON.parse(await nodeFs.readFile(ctx.artifactsFile, "utf8")) as Record<string, unknown>;
		expect(snapshot.version).toBe(1);
		expect(snapshot.hunkSessionId).toBe(session.sessionId);
		expect(snapshot.scope).toEqual({ kind: "session", baseSha: await headSha(ctx.repo.path) });
	});

	test("two sessions on one repo: only the owned pane's pid binds", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		ctx.harness.sessions.push({
			sessionId: "foreign",
			pid: ++ctx.harness.nextPid,
			cwd: "/repo",
			repoRoot: "/repo",
			generation: "gen-1",
		});
		await ctx.controller.initialize();

		expect(ctx.controller.isReady).toBe(true);
		const bound = ctx.harness.sessions.find(entry => entry.sessionId.startsWith("sess-"));
		expect(bound).toBeDefined();
	});

	test("duplicate new sessions fail closed instead of guessing", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		ctx.harness.duplicateLaunch = true;
		await ctx.controller.initialize();
		expect(ctx.controller.state).toBe("closed");
		expect(ctx.controller.closedReason).toBe("unverified");
		expect(ctx.controller.isReady).toBe(false);
		expect(ctx.harness.tabCreateCount).toBe(1); // the owned tab stands; no second attempt
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

	test("user-closed tab stays closed on ticks; a completed /diff reopen recreates it", async () => {
		const ctx = await freshContext();
		cleaners.push(ctx.cleanup);
		await ctx.controller.initialize();
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

	test("busy pane on root change: left untouched, no input sent, /diff opens a new tab", async () => {
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

		await ctx.controller.initialize({ explicit: true });
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
