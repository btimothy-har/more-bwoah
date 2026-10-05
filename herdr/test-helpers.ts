/**
 * Shared behavioral-test helpers: a recording command runner, a manual fake
 * timer wheel, and disposable git fixtures. No external dependencies.
 */

import * as nodeFs from "node:fs/promises";
import * as nodeFsSync from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import type { ExecOutcome, ExecRunner, ExecRunnerOptions } from "./hunk-cli";
import type { PrimaryLockFactory } from "./primary-lock";

export interface RecordedCall {
	command: string;
	args: string[];
	options?: ExecRunnerOptions;
	outcome?: ExecOutcome;
}

export class FakeExec implements ExecRunner {
	readonly calls: RecordedCall[] = [];
	#queue: Array<(call: RecordedCall) => ExecOutcome | Promise<ExecOutcome>> = [];
	#installed: Array<{ matcher: (call: RecordedCall) => boolean; reply: (call: RecordedCall) => ExecOutcome | Promise<ExecOutcome> }> = [];

	/** Persistent responder, checked before one-shot enqueue handlers. */
	install(
		matcher: (call: RecordedCall) => boolean,
		reply: ExecOutcome | ((call: RecordedCall) => ExecOutcome | Promise<ExecOutcome>),
	): void {
		this.#installed.push({
			matcher,
			reply: typeof reply === "function" ? reply : () => reply,
		});
	}

	/** Priority responder checked before install-ed ones; returns a disposer. */
	override(
		matcher: (call: RecordedCall) => boolean,
		reply: ExecOutcome | ((call: RecordedCall) => ExecOutcome | Promise<ExecOutcome>),
	): () => void {
		const entry = { matcher, reply: typeof reply === "function" ? reply : () => reply };
		this.#installed.unshift(entry);
		return () => {
			const index = this.#installed.indexOf(entry);
			if (index >= 0) this.#installed.splice(index, 1);
		};
	}

	/** Reply to the next command whose args start with these prefixes. */
	enqueue(matcher: (call: RecordedCall) => boolean, reply: ExecOutcome | ((call: RecordedCall) => ExecOutcome)): void {
		this.#queue.push(call => {
			if (!matcher(call)) return { stdout: "", stderr: "no handler", code: 1, killed: false };
			return typeof reply === "function" ? reply(call) : reply;
		});
	}

	async run(command: string, args: string[], options?: ExecRunnerOptions): Promise<ExecOutcome> {
		const call: RecordedCall = { command, args, options };
		this.calls.push(call);
		const installed = this.#installed.find(entry => entry.matcher(call));
		if (installed !== undefined) {
			const outcome = await installed.reply(call);
			call.outcome = outcome;
			return outcome;
		}
		if (command === "git") {
			const outcome = await this.#runRealGit(args, options?.cwd);
			call.outcome = outcome;
			return outcome;
		}
		const handler = this.#queue.shift();
		const outcome = handler
			? await handler(call)
			: { stdout: "", stderr: `unhandled command: ${command} ${args.join(" ")}`, code: 1, killed: false };
		call.outcome = outcome;
		return outcome;
	}

	async #runRealGit(args: string[], cwd?: string): Promise<ExecOutcome> {
		const proc = Bun.spawn(["git", ...args], {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { stdout, stderr, code, killed: false };
	}

	/** Adapter so helpers expecting an `ExecRunner` function can use this instance. */
	runner(): ExecRunner {
		return (command, args, options) => this.run(command, args, options);
	}

	callsTo(command: string, prefix: string[]): RecordedCall[] {
		return this.calls.filter(
			call => call.command === command && prefix.every((part, index) => call.args[index] === part),
		);
	}
}

export interface FakeTimerHandle {
	kind: "interval" | "timeout";
	fn: () => void;
	ms: number;
	id: number;
	cleared: boolean;
}

export class FakeTimers {
	readonly pending: FakeTimerHandle[] = [];
	#nextId = 0;
	#now = 0;

	now(): number {
		return this.#now;
	}

	setInterval(fn: () => void, ms: number): FakeTimerHandle {
		const handle: FakeTimerHandle = { kind: "interval", fn, ms, id: this.#nextId++, cleared: false };
		this.pending.push(handle);
		return handle;
	}

	clearInterval(handle: unknown): void {
		this.#clear(handle);
	}

	setTimeout(fn: () => void, ms: number): FakeTimerHandle {
		const handle: FakeTimerHandle = { kind: "timeout", fn, ms, id: this.#nextId++, cleared: false };
		this.pending.push(handle);
		return handle;
	}

	clearTimeout(handle: unknown): void {
		this.#clear(handle);
	}

	#clear(handle: unknown): void {
		for (const pending of this.pending) {
			if (pending === handle) pending.cleared = true;
		}
	}

	/** Advance virtual time, firing due timeouts once and intervals repeatedly. */
	async advance(ms: number): Promise<void> {
		const target = this.#now + ms;
		for (;;) {
			const due = this.#earliestDue(target);
			if (due === undefined) {
				// Let in-flight async work register more timers before giving up.
				await new Promise<void>(resolve => setImmediate(resolve));
				if (this.#earliestDue(target) === undefined) {
					this.#now = target;
					return;
				}
				continue;
			}
			this.#now += due.ms;
			if (due.kind === "timeout") due.cleared = true;
			due.fn();
			await new Promise<void>(resolve => setImmediate(resolve));
		}
	}

	#earliestDue(target: number): FakeTimerHandle | undefined {
		const dueTimers = this.pending.filter(handle => !handle.cleared && this.#now + handle.ms <= target);
		return dueTimers.sort((a, b) => a.ms - b.ms || a.id - b.id)[0];
	}
}

export interface GitFixture {
	path: string;
	cleanup(): Promise<void>;
}

/** init -b main repo with one committed file; returns the repo path. */
export async function createTempRepo(seedLines: string[]): Promise<GitFixture> {
	const root = await nodeFs.mkdtemp(nodePath.join(nodeOs.tmpdir(), "hunk-ext-test-"));
	const repoPath = nodePath.join(root, "repo");
	await nodeFs.mkdir(repoPath, { recursive: true });
	const run = async (args: string[]): Promise<void> => {
		const proc = Bun.spawn(["git", ...args], { cwd: repoPath, stdout: "pipe", stderr: "pipe" });
		const code = await proc.exited;
		if (code !== 0) {
			const stderr = await new Response(proc.stderr).text();
			throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
		}
	};
	await run(["init", "-b", "main"]);
	await run(["config", "user.email", "test@example.com"]);
	await run(["config", "user.name", "Test"]);
	// The developer's global config may enable commit signing and hooks; both
	// hang or fail in tests. Local settings override the global ones.
	await run(["config", "commit.gpgsign", "false"]);
	await run(["config", "core.hooksPath", "/dev/null"]);
	await Bun.write(nodePath.join(repoPath, "seed.txt"), `${seedLines.join("\n")}\n`);
	await run(["add", "."]);
	await run(["commit", "-m", "seed commit"]);
	return {
		path: repoPath,
		async cleanup() {
			await nodeFs.rm(root, { recursive: true, force: true });
		},
	};
}

/** SHA-1 of the current HEAD in a fixture repo. */
export async function headSha(repoPath: string): Promise<string> {
	const proc = Bun.spawn(["git", "rev-parse", "HEAD"], { cwd: repoPath, stdout: "pipe" });
	return (await new Response(proc.stdout).text()).trim();
}

/** Realpath of a fixture path; the controller canonicalizes checkout roots. */
export async function canon(path: string): Promise<string> {
	return nodeFs.realpath(path);
}

// ---------------------------------------------------------------------------
// herdr + hunk CLI harness (companion/feedback suites)
// ---------------------------------------------------------------------------

export interface HarnessSession {
	sessionId: string;
	pid: number;
	cwd: string;
	repoRoot: string;
	generation: string;
	stateRevision: number;
	/** Live review notes owned by this Hunk session; clear removes exactly these. */
	notes: unknown[];
}

export interface HarnessPane {
	tabId: string;
	shellPid: number;
	foreground: number[];
}

export interface Harness {
	exec: FakeExec;
	timers: FakeTimers;
	sessions: HarnessSession[];
	panes: Map<string, HarnessPane>;
	nextPid: number;
	nextSession: number;
	registered: boolean;
	launchedCommands: string[];
	ctrlcSent: number;
	clears: number;
	focusCount: number;
	renames: string[];
	tabCreateCount: number;
	/** comment add invocations recorded for assertions. */
	adds: number;
	lastAddArgs: string[] | null;
	/** When true, comment add bumps the session's publication generation. */
	bumpGenerationOnAdd: boolean;
	/** Repo root assigned to sessions created by a pane-run launch. */
	repoRootForLaunch: string;
	/** When true, a pane run registers two sessions (ambiguity fixture). */
	duplicateLaunch: boolean;
	/** When true, pane run sets the foreground pid but defers daemon registration. */
	launchRegistrationDeferred: boolean;
	deferredPaneId?: string;
	/** When true, ctrl+c does not clear the pane foreground (busy fixture). */
	ctrlcNoop: boolean;
	/** When true, ctrl+c leaves only the shell pid in the pane foreground. */
	ctrlcLeavesShell: boolean;
	/** When true, comment clear fails (clean-slate reset fixture). */
	failClears: boolean;
	/** When true, session get omits the review publication (missing generation). */
	omitGeneration: boolean;
	/** When true, the next session get bumps that session's generation after replying. */
	bumpGenerationOnNextGet: boolean;
	/** When true, the next session get bumps stateRevision after replying. */
	bumpStateRevisionOnNextGet: boolean;
	/** When true, session get replies only once releaseSessionGet is called. */
	hangSessionGet: boolean;
	sessionGetGate: { resolve(outcome: ExecOutcome): void } | null;
	/** Payload captured at hang time; releaseSessionGet resolves with it. */
	pendingSessionGetPayload: unknown;
	releaseSessionGet(): void;
	/** When true, comment add replies only once commentAddGate is resolved. */
	hangCommentAdd: boolean;
	commentAddGate: ((outcome: ExecOutcome) => void) | null;
	/** When true, comment clear replies only once commentClearGate is resolved. */
	hangCommentClear: boolean;
	/** Resuming the pending clear: success applies the removal, failure leaves notes. */
	commentClearGate: ((outcome: ExecOutcome) => void) | null;
	releaseCommentClear(): void;
	/** When true, herdr pane close replies only once closeGate is resolved. */
	hangClose: boolean;
	/** Resuming the pending close: success removes the targeted pane and its foregrounded Hunk sessions. */
	closeGate: ((outcome: ExecOutcome) => void) | null;
	releaseClose(): void;
	/** Shared admission-lock table; pass one instance to several rigs to model one workspace. */
	locks: HarnessLocks;
	/** The table's PrimaryLockFactory; production wiring receives exactly this under tests. */
	tryPrimaryLock: PrimaryLockFactory;
	/** Mark a simulated process dead: harness.isProcessAlive then reports false for it. */
	killProcess(pid: number): void;
	/** Liveness for injected CompanionDeps: minted+alive → true, killed → false, never-minted → "unknown". */
	isProcessAlive(pid: number): boolean | "unknown";
	/** Structured tab/pane rename record: which id was retargeted to which label. */
	renameCalls: Array<{ scope: "tab" | "pane"; id: string; label: string }>;
	addSession(repoRoot: string, paneId: string): HarnessSession;
}

export interface HarnessEnv {
	HERDR_ENV: "1";
	HERDR_WORKSPACE_ID: string;
	HERDR_PANE_ID: string;
	/** Own-tab identity proof the controller verifies before child mutation. */
	HERDR_TAB_ID: string;
	HERDR_SOCKET_PATH: string;
	HERDR_BIN_PATH: string;
	XDG_STATE_HOME: string;
	/** Pinned to "not nested": an inherited host OMPCODE=1 would make every rig inert. */
	OMPCODE: "";
	[key: string]: string | undefined;
}

function okJson(value: unknown): { stdout: string; stderr: string; code: number; killed: boolean } {
	return { stdout: JSON.stringify(value), stderr: "", code: 0, killed: false };
}

/** Numeric suffix of a harness pane id (`w1:p12` → 12); non-numeric ids never raise the floor. */
function paneNumber(paneId: string): number {
	const match = /(\d+)$/.exec(paneId);
	return match === null ? Number.NaN : Number.parseInt(match[1] ?? "", 10);
}

/** Value of a joined `--option=value` argument, mirroring the hunk CLI's flag parsing. */
function joinedArg(args: string[], option: string): string | undefined {
	const prefix = `${option}=`;
	return args.find(arg => arg.startsWith(prefix))?.slice(prefix.length);
}

export function harnessFail(stderr: string): { stdout: string; stderr: string; code: number; killed: boolean } {
	return { stdout: "", stderr, code: 1, killed: false };
}

/** herdr proved absence via its structured stderr envelope. */
export function herdrAbsent(code: "tab_not_found" | "pane_not_found"): ExecOutcome {
	return {
		stdout: "",
		stderr: `${JSON.stringify({ error: { code, message: code } })}\n`,
		code: 1,
		killed: false,
	};
}

/** herdr-side server failure: indeterminate, never absence. */
export function herdrTransient(): ExecOutcome {
	return {
		stdout: "",
		stderr: `${JSON.stringify({ error: { code: "internal_error", message: "socket hiccup" } })}\n`,
		code: 1,
		killed: false,
	};
}

/** Process killed by its exec timeout: unknown outcome for writes, indeterminate for reads. */
export function killedOutcome(): ExecOutcome {
	return { stdout: "", stderr: "", code: 0, killed: true };
}

export const HARNESS_SOCKET = "/tmp/herdr-test.sock";
export const HARNESS_WORKSPACE = "w1";
export const HARNESS_AGENT_PANE = "w1:p0";
export const HARNESS_AGENT_TAB = "w1:t0";

export interface HarnessLocks {
	/** PrimaryLockFactory over the shared in-memory table. */
	tryPrimaryLock: PrimaryLockFactory;
	/**
	 * Simulate the owning controller process actually exiting: the path frees
	 * the way a native flock does at process death — without any release()
	 * call. session_shutdown must never produce this event.
	 */
	simulateProcessExit(lockPath: string): void;
	/** Make acquire attempts reject (native/import/filesystem failure) until cleared with null. */
	failAcquires(error: Error | null): void;
	/** Whether some live handle currently holds the path. */
	holds(lockPath: string): boolean;
}

export function createHarnessLocks(): HarnessLocks {
	type Owner = { token: symbol };
	const owners = new Map<string, Owner>();
	let acquireError: Error | null = null;
	const tryPrimaryLock: PrimaryLockFactory = async path => {
		// The host adapter creates the state directory (mode 0700) before
		// acquiring; downstream record/sidecar persistence depends on it. The
		// fake performs the same effect synchronously so admission settles in
		// microtasks and tests can drain it with turn flushing alone.
		nodeFsSync.mkdirSync(nodePath.dirname(path), { recursive: true, mode: 0o700 });
		if (acquireError !== null) throw acquireError;
		const holder = owners.get(path);
		if (holder !== undefined) {
			// Losing handle: release is an idempotent no-op that can never free a
			// winner's or successor's reservation.
			return { acquired: false, release() {} };
		}
		const token = Symbol(path);
		owners.set(path, { token });
		return {
			acquired: true,
			release() {
				const current = owners.get(path);
				if (current !== undefined && current.token === token) owners.delete(path);
			},
		};
	};
	return {
		tryPrimaryLock,
		simulateProcessExit(path) {
			owners.delete(path);
		},
		failAcquires(error) {
			acquireError = error;
		},
		holds(path) {
			return owners.has(path);
		},
	};
}

export function harnessEnv(stateDir: string): HarnessEnv {
	return {
		HERDR_ENV: "1",
		HERDR_WORKSPACE_ID: HARNESS_WORKSPACE,
		HERDR_PANE_ID: HARNESS_AGENT_PANE,
		HERDR_TAB_ID: HARNESS_AGENT_TAB,
		HERDR_SOCKET_PATH: HARNESS_SOCKET,
		HERDR_BIN_PATH: "herdr",
		XDG_STATE_HOME: stateDir,
		OMPCODE: "",
	};
}

export function createHerdrHarness(locks: HarnessLocks = createHarnessLocks()): Harness {
	const deadPids = new Set<number>();
	let nextPaneNumber = 0;
	const harness: Harness = {
		exec: new FakeExec(),
		timers: new FakeTimers(),
		sessions: [],
		panes: new Map(),
		nextPid: 500,
		nextSession: 1,
		registered: false,
		launchedCommands: [],
		ctrlcSent: 0,
		clears: 0,
		focusCount: 0,
		renames: [],
		renameCalls: [],
		tabCreateCount: 0,
		adds: 0,
		lastAddArgs: null,
		bumpGenerationOnAdd: false,
		repoRootForLaunch: "/repo",
		duplicateLaunch: false,
		launchRegistrationDeferred: false,
		deferredPaneId: undefined,
		ctrlcNoop: false,
		ctrlcLeavesShell: false,
		failClears: false,
		omitGeneration: false,
		bumpGenerationOnNextGet: false,
		bumpStateRevisionOnNextGet: false,
		hangSessionGet: false,
		sessionGetGate: null,
		releaseSessionGet: () => {
			const gate = harness.sessionGetGate;
			if (!gate) return;
			harness.sessionGetGate = null;
			gate.resolve(okJson(harness.pendingSessionGetPayload));
		},
		hangCommentAdd: false,
		commentAddGate: null,
		hangCommentClear: false,
		commentClearGate: null,
		releaseCommentClear: () => {
			harness.commentClearGate?.(okJson({ result: {} }));
		},
		hangClose: false,
		closeGate: null,
		releaseClose: () => {
			harness.closeGate?.(okJson({ result: { type: "ok" } }));
		},
		locks,
		tryPrimaryLock: locks.tryPrimaryLock,
		killProcess: pid => {
			deadPids.add(pid);
		},
		isProcessAlive: pid => {
			if (deadPids.has(pid)) return false;
			if (Number.isInteger(pid) && pid > 0 && pid <= harness.nextPid) return true;
			return "unknown";
		},
		addSession: (repoRoot, paneId) => {
			const pid = ++harness.nextPid;
			const session: HarnessSession = {
				sessionId: `sess-${harness.nextSession++}`,
				pid,
				cwd: repoRoot,
				repoRoot,
				generation: "gen-1",
				stateRevision: 1,
				notes: [],
			};
			harness.sessions.push(session);
			const pane = harness.panes.get(paneId);
			if (pane !== undefined) pane.foreground.push(pid);
			return session;
		},
		pendingSessionGetPayload: null,
	};

	// The omp controller's own pane always exists: its foreground pid is this
	// very test process, matching the factory's real controllerPid proof.
	harness.panes.set(HARNESS_AGENT_PANE, { tabId: HARNESS_AGENT_TAB, shellPid: ++harness.nextPid, foreground: [process.pid] });

	harness.exec.install(
		call => call.command === "herdr" && call.args[0] === "tab" && call.args[1] === "create",
		call => {
			harness.tabCreateCount += 1;
			const workspaceFlag = call.args.indexOf("--workspace");
			const workspaceId = workspaceFlag >= 0 ? (call.args[workspaceFlag + 1] ?? HARNESS_WORKSPACE) : HARNESS_WORKSPACE;
			// herdr never reuses pane ids: allocate past every id ever minted and
			// past hand-seeded panes, so a closed pane's id cannot collide with a
			// freshly created one.
			const seededMax = [...harness.panes.keys()].reduce((max, paneId) => {
				const suffix = paneNumber(paneId);
				return Number.isNaN(suffix) ? max : Math.max(max, suffix);
			}, nextPaneNumber);
			const nth = seededMax + 1;
			nextPaneNumber = nth;
			const tabId = `${workspaceId}:t${nth}`;
			const paneId = `${workspaceId}:p${nth}`;
			const shellPid = ++harness.nextPid;
			harness.panes.set(paneId, { tabId, shellPid, foreground: [] });
			return okJson({
				id: "cli:tab:create",
				result: { tab: { tab_id: tabId }, root_pane: { pane_id: paneId } },
			});
		},
	);

	harness.exec.install(
		call => call.command === "herdr" && call.args[0] === "tab" && call.args[1] === "get",
		call => {
			const tabId = call.args[2];
			for (const pane of harness.panes.values()) {
				if (pane.tabId === tabId) return okJson({ result: { tab: { tab_id: tabId } } });
			}
			return herdrAbsent("tab_not_found");
		},
	);

	harness.exec.install(
		call => call.command === "herdr" && call.args[0] === "tab" && call.args[1] === "focus",
		() => {
			harness.focusCount += 1;
			return okJson({ result: {} });
		},
	);

	harness.exec.install(
		call => call.command === "herdr" && call.args[0] === "tab" && call.args[1] === "rename",
		call => {
			harness.renames.push(call.args[3] ?? "");
			harness.renameCalls.push({ scope: "tab", id: call.args[2] ?? "", label: call.args[3] ?? "" });
			return okJson({ result: {} });
		},
	);

	harness.exec.install(
		call => call.command === "herdr" && call.args[0] === "pane" && call.args[1] === "rename",
		call => {
			harness.renames.push(call.args[3] ?? "");
			harness.renameCalls.push({ scope: "pane", id: call.args[2] ?? "", label: call.args[3] ?? "" });
			return okJson({ result: {} });
		},
	);

	harness.exec.install(
		call => call.command === "herdr" && call.args[0] === "pane" && call.args[1] === "list",
		call => {
			const workspaceFlag = call.args.indexOf("--workspace");
			const workspaceId = workspaceFlag >= 0 ? call.args[workspaceFlag + 1] : undefined;
			const panes = [...harness.panes.entries()]
				.filter(([paneId]) => workspaceId === undefined || paneId.startsWith(`${workspaceId}:`))
				.map(([paneId, pane]) => ({
					pane_id: paneId,
					tab_id: pane.tabId,
					workspace_id: paneId.split(":")[0] ?? HARNESS_WORKSPACE,
				}));
			return okJson({ result: { panes } });
		},
	);

	harness.exec.install(
		call => call.command === "herdr" && call.args[0] === "pane" && call.args[1] === "process-info",
		call => {
			const pane = harness.panes.get(call.args[3]);
			if (pane === undefined) return herdrAbsent("pane_not_found");
			// herdr 0.9.3 echoes the requested pane id and omits
			// foreground_processes entirely when nothing is foregrounded.
			return okJson({
				result: {
					process_info: {
						pane_id: call.args[3],
						shell_pid: pane.shellPid,
						...(pane.foreground.length === 0
							? {}
							: {
									foreground_processes: pane.foreground.map(pid => ({
										pid,
										name: pid === pane.shellPid ? "zsh" : "hunk",
									})),
								}),
					},
				},
			});
		},
	);

	harness.exec.install(
		call => call.command === "herdr" && call.args[0] === "pane" && call.args[1] === "get",
		call => {
			const pane = harness.panes.get(call.args[2]);
			if (pane === undefined) return herdrAbsent("pane_not_found");
			return okJson({
				result: {
					pane: {
						pane_id: call.args[2],
						tab_id: pane.tabId,
						workspace_id: call.args[2].split(":")[0] ?? HARNESS_WORKSPACE,
					},
				},
			});
		},
	);

	harness.exec.install(
		call => call.command === "herdr" && call.args[0] === "pane" && call.args[1] === "run",
		call => {
			const pane = harness.panes.get(call.args[2]);
			if (pane === undefined) return harnessFail("pane not found");
			harness.launchedCommands.push(call.args[3] ?? "");
			if (harness.launchRegistrationDeferred) {
				// Foreground pid exists; the daemon registration lags behind.
				harness.deferredPaneId = call.args[2];
				return okJson({ result: {} });
			}
			if (harness.duplicateLaunch) {
				harness.addSession(harness.repoRootForLaunch, call.args[2]);
				harness.addSession(harness.repoRootForLaunch, call.args[2]);
			} else {
				harness.addSession(harness.repoRootForLaunch, call.args[2]);
			}
			harness.registered = true;
			return okJson({ result: {} });
		},
	);

	harness.exec.install(
		call => call.command === "herdr" && call.args[0] === "pane" && call.args[1] === "send-keys",
		call => {
			if (call.args[3] === "ctrl+c") {
				harness.ctrlcSent += 1;
				if (!harness.ctrlcNoop) {
					const pane = harness.panes.get(call.args[2]);
					if (pane !== undefined) {
						// herdr may keep reporting the shell as the foreground process.
						pane.foreground = harness.ctrlcLeavesShell ? [pane.shellPid] : [];
					}
				}
			}
			return okJson({ result: {} });
		},
	);

	harness.exec.install(
		call => call.command === "herdr" && call.args[0] === "pane" && call.args[1] === "close",
		call => {
			const pane = harness.panes.get(call.args[2]);
			if (pane === undefined) return herdrAbsent("pane_not_found");
			// A completed pane close destroys the targeted pane and the Hunk
			// sessions that were foregrounded in it — and only those; other
			// panes, tabs, and sessions are untouched. Killed/failed outcomes
			// are unknown and change nothing.
			const complete = (outcome: ExecOutcome): ExecOutcome => {
				if (outcome.killed || outcome.code !== 0) return outcome;
				const foreground = pane.foreground;
				// A completed close destroys everything foregrounded in the pane:
				// liveness must flip before the pane disappears, or post-close
				// retirement proofs observe a live PID herdr already killed.
				for (const pid of foreground) harness.killProcess(pid);
				harness.sessions = harness.sessions.filter(session => !foreground.includes(session.pid));
				// herdr never reuses pane ids: raise the allocation floor from the
				// pane being deleted so a closed hand-seeded pane cannot be re-minted.
				nextPaneNumber = Math.max(nextPaneNumber, paneNumber(call.args[2] ?? "") || 0);
				harness.panes.delete(call.args[2]);
				return okJson({ result: { type: "ok" } });
			};
			if (harness.hangClose) {
				return new Promise<ExecOutcome>(resolve => {
					harness.closeGate = outcome => resolve(complete(outcome));
				});
			}
			return complete(okJson({ result: { type: "ok" } }));
		},
	);

	harness.exec.install(
		call => call.command === "hunk" && call.args[0] === "session" && call.args[1] === "list",
		() => {
			const sessions = harness.registered
				? harness.sessions.map(session => ({
						sessionId: session.sessionId,
						pid: session.pid,
						cwd: session.cwd,
						repoRoot: session.repoRoot,
						inputKind: "vcs",
					}))
				: [];
			return okJson({ sessions });
		},
	);

	harness.exec.install(
		call => call.command === "hunk" && call.args[0] === "session" && call.args[1] === "get",
		call => {
			const session = harness.sessions.find(entry => entry.sessionId === call.args[2]);
			if (session === undefined) return harnessFail("No active session matches");
			const publication = harness.omitGeneration
				? undefined
				: { generation: session.generation, stateRevision: session.stateRevision };
			const payload = {
				session: {
					sessionId: session.sessionId,
					pid: session.pid,
					cwd: session.cwd,
					repoRoot: session.repoRoot,
					inputKind: "vcs",
					snapshot: {
						state: {
							liveCommentCount: session.notes.length,
							liveComments: [],
							reviewNotes: session.notes,
							...(publication === undefined ? {} : { reviewPublication: publication }),
						},
					},
				},
			};
			if (harness.hangSessionGet) {
				harness.pendingSessionGetPayload = payload;
				return new Promise<ExecOutcome>(resolve => {
					harness.sessionGetGate = { resolve };
				});
			}
			// Post-reply bumps model a review that changes between the two gets
			// of a stable capture (generation drift vs stateRevision-only drift).
			if (harness.bumpGenerationOnNextGet) {
				harness.bumpGenerationOnNextGet = false;
				session.generation = "gen-next";
			}
			if (harness.bumpStateRevisionOnNextGet) {
				harness.bumpStateRevisionOnNextGet = false;
				session.stateRevision += 1;
			}
			return okJson(payload);
		},
	);

	harness.exec.install(
		call => call.command === "hunk" && call.args[0] === "session" && call.args[1] === "review",
		call => {
			const session = harness.sessions.find(entry => entry.sessionId === call.args[2]);
			if (session === undefined) return harnessFail("No active session matches");
			return okJson({
				review: {
					sessionId: session.sessionId,
					title: "review",
					inputKind: "vcs",
					files: [{ id: "f1", path: "seed.txt", additions: 1, deletions: 0, hunkCount: 1, hunks: [] }],
					reviewNotes: session.notes,
					selectedFile: null,
					selectedHunk: null,
				},
			});
		},
	);

	harness.exec.install(
		call => call.command === "hunk" && call.args[0] === "session" && call.args[1] === "reload",
		call => {
			const session = harness.sessions.find(entry => entry.sessionId === call.args[2]);
			if (session === undefined) return harnessFail("No active session matches");
			return okJson({ result: { sessionId: session.sessionId, inputKind: "vcs" } });
		},
	);

	harness.exec.install(
		call => call.command === "hunk" && call.args[0] === "session" && call.args[2] === "add",
		call => {
			const session = harness.sessions.find(entry => entry.sessionId === call.args[3]);
			if (session === undefined) return harnessFail("No active session matches");
			harness.adds += 1;
			harness.lastAddArgs = [...call.args];
			const settle = (): ExecOutcome => {
				if (harness.bumpGenerationOnAdd) session.generation = "gen-bumped";
				const commentId = `mcp:${harness.adds}`;
				const replyTo = joinedArg(call.args, "--reply-to");
				session.notes.push({
					noteId: commentId,
					...(replyTo !== undefined ? { parentId: replyTo } : {}),
					source: "agent",
					body: joinedArg(call.args, "--summary") ?? "",
				});
				return okJson({
					result: {
						commentId,
						filePath: joinedArg(call.args, "--file") ?? "seed.txt",
						hunkIndex: 0,
						side: "new",
						line: 2,
					},
				});
			};
			if (harness.hangCommentAdd) {
				return new Promise<ExecOutcome>(resolve => {
					harness.commentAddGate = outcome =>
						resolve(outcome.killed || outcome.code !== 0 ? outcome : settle());
				});
			}
			return settle();
		},
	);

	harness.exec.install(
		call => call.command === "hunk" && call.args[0] === "session" && call.args[2] === "clear",
		call => {
			if (!call.args.includes("--all") || !call.args.includes("--yes")) {
				return harnessFail("comment clear requires --all and --yes");
			}
			const session = harness.sessions.find(entry => entry.sessionId === call.args[3]);
			if (session === undefined) return harnessFail("No active session matches");
			if (harness.failClears) return harnessFail("comment clear failed");
			// A completed clear removes exactly the requested session's notes and
			// reports the real removed count; killed/failed outcomes change nothing.
			const complete = (outcome: ExecOutcome): ExecOutcome => {
				if (outcome.killed || outcome.code !== 0) return outcome;
				const removedCount = session.notes.length;
				session.notes = [];
				harness.clears += 1;
				return okJson({ result: { removedCount } });
			};
			if (harness.hangCommentClear) {
				return new Promise<ExecOutcome>(resolve => {
					harness.commentClearGate = outcome => resolve(complete(outcome));
				});
			}
			return complete(okJson({ result: {} }));
		},
	);

	return harness;
}
