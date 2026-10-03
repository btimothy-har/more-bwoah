/**
 * Shared behavioral-test helpers: a recording command runner, a manual fake
 * timer wheel, and disposable git fixtures. No external dependencies.
 */

import * as nodeFs from "node:fs/promises";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import type { ExecOutcome, ExecRunner, ExecRunnerOptions } from "./hunk-cli";

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
	reviewNotes: unknown[];
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
	addSession(repoRoot: string, paneId: string): HarnessSession;
}

export interface HarnessEnv {
	HERDR_ENV: "1";
	HERDR_WORKSPACE_ID: string;
	HERDR_PANE_ID: string;
	HERDR_SOCKET_PATH: string;
	HERDR_BIN_PATH: string;
	XDG_STATE_HOME: string;
	[key: string]: string | undefined;
}

function okJson(value: unknown): { stdout: string; stderr: string; code: number; killed: boolean } {
	return { stdout: JSON.stringify(value), stderr: "", code: 0, killed: false };
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

export function harnessEnv(stateDir: string): HarnessEnv {
	return {
		HERDR_ENV: "1",
		HERDR_WORKSPACE_ID: HARNESS_WORKSPACE,
		HERDR_PANE_ID: HARNESS_AGENT_PANE,
		HERDR_SOCKET_PATH: HARNESS_SOCKET,
		HERDR_BIN_PATH: "herdr",
		XDG_STATE_HOME: stateDir,
	};
}

export function createHerdrHarness(): Harness {
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
		tabCreateCount: 0,
		adds: 0,
		lastAddArgs: null,
		reviewNotes: [],
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
		addSession: (repoRoot, paneId) => {
			const pid = ++harness.nextPid;
			const session: HarnessSession = {
				sessionId: `sess-${harness.nextSession++}`,
				pid,
				cwd: repoRoot,
				repoRoot,
				generation: "gen-1",
				stateRevision: 1,
			};
			harness.sessions.push(session);
			const pane = harness.panes.get(paneId);
			if (pane !== undefined) pane.foreground.push(pid);
			return session;
		},
		pendingSessionGetPayload: null,
	};

	harness.exec.install(
		call => call.command === "herdr" && call.args[0] === "tab" && call.args[1] === "create",
		() => {
			harness.tabCreateCount += 1;
			const tabId = `w1:t${harness.panes.size + 1}`;
			const paneId = `${tabId.replace("t", "p")}`;
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
			return okJson({ result: {} });
		},
	);

	harness.exec.install(
		call => call.command === "herdr" && call.args[0] === "pane" && call.args[1] === "process-info",
		call => {
			const pane = harness.panes.get(call.args[3]);
			if (pane === undefined) return herdrAbsent("pane_not_found");
			return okJson({
				result: {
					process_info: {
						shell_pid: pane.shellPid,
						foreground_processes: pane.foreground.map(pid => ({ pid, name: "hunk" })),
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
				result: { pane: { pane_id: call.args[2], tab_id: pane.tabId, workspace_id: HARNESS_WORKSPACE } },
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
							liveCommentCount: 0,
							liveComments: [],
							reviewNotes: [],
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
					reviewNotes: harness.reviewNotes,
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
			harness.adds += 1;
			harness.lastAddArgs = [...call.args];
			if (harness.hangCommentAdd) {
				return new Promise<ExecOutcome>(resolve => {
					harness.commentAddGate = resolve;
				});
			}
			if (harness.bumpGenerationOnAdd) {
				const session = harness.sessions.find(entry => entry.sessionId === call.args[3]);
				if (session !== undefined) session.generation = "gen-bumped";
			}
			return okJson({
				result: { commentId: "mcp:1", filePath: "seed.txt", hunkIndex: 0, side: "new", line: 2 },
			});
		},
	);

	harness.exec.install(
		call => call.command === "hunk" && call.args[0] === "session" && call.args[2] === "clear",
		() => {
			if (harness.failClears) return harnessFail("comment clear failed");
			harness.clears += 1;
			return okJson({ result: { removedCount: 3 } });
		},
	);

	return harness;
}
