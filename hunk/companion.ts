/**
 * Companion controller: binds exactly one herdr tab + Hunk session per
 * workspace and owns its lifecycle.
 *
 * Identity model (verified against hunk 0.22.0 + herdr 0.9.3):
 * - Hunk generates its own session UUID and registers {pid, cwd, repoRoot,
 *   terminal metadata}; it exposes no herdr pane ids. Label matching and
 *   repo-only matching are therefore NOT identity proofs. The proof is a PID
 *   intersection: the registered Hunk session PID must appear in the owned
 *   pane's foreground processes, the pane's shell PID must match the record,
 *   and a bind may only claim sessions that are new relative to the
 *   launch-time registry snapshot.
 * - The persistent ownership record (keyed by herdr socket + workspace) proves
 *   which tab/pane this extension created. It stores no notes and is never a
 *   replay journal.
 *
 * Failure policy: herdr calls distinguish proven absence (structured
 * tab_not_found/pane_not_found codes) from indeterminate failures (socket
 * hiccups, herdr restarts, timeouts, malformed output). Absence may close or
 * relaunch; indeterminate failures skip the tick or park the controller in
 * "unavailable" for retry — never a sticky close, never a duplicate tab.
 * Handshake ambiguity (several candidate sessions) fails closed everywhere;
 * the documented recovery is closing the stuck tab and completing a /diff
 * selection.
 */

import {
	CommandCliError,
	CompanionUnavailable,
	HunkCli,
	type CommentAddRequest,
	type CommentAddResult,
	type RegisteredSession,
	type ReviewPublication,
	type SessionSnapshot,
} from "./hunk-cli";
import { HerdrAbsentError, HerdrCli, type HerdrPane, type PaneProcessInfo } from "./herdr-cli";
import { canonicalPath } from "./boundary";
import {
	hunkReloadArgs,
	resolveCheckout,
	resolveCommitSha,
	mergeBase,
	type ReviewScope,
} from "./diff-targets";
import {
	atomicWriteJson,
	companionRecordPath,
	readCompanionRecord,
	writeCompanionRecord,
	type CompanionRecord,
} from "./storage";

export type EnvLike = Record<string, string | undefined>;

export interface CompanionTimers {
	setInterval(callback: () => void, ms: number): unknown;
	clearInterval(handle: unknown): void;
	setTimeout(callback: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
	/** Monotonic-enough wall clock; injectable so tests control deadlines. */
	now(): number;
}

export interface CompanionLogger {
	debug(message: string, detail?: unknown): void;
	info(message: string, detail?: unknown): void;
	warn(message: string, detail?: unknown): void;
	error(message: string, detail?: unknown): void;
}

export type NotifyLevel = "info" | "warning" | "error";

export interface CompanionDeps {
	exec: ExecRunner;
	env: EnvLike;
	timers: CompanionTimers;
	logger: CompanionLogger;
	notify(message: string, level?: NotifyLevel): void;
	/** Canonical Hunk binary path as resolved for shell launch lines. */
	hunkPath: string;
}

export interface SessionContext {
	ompSessionId: string;
	artifactsDir: string | null;
}

export type CompanionState = "unavailable" | "starting" | "ready" | "closed";

export type ClosedReason = "user" | "exited" | "blocked" | "left-git" | "unverified";

/**
 * What each closed reason permits. `sticky` blocks non-explicit reopen
 * (initialize without a completed /diff); `autoRecover` lets the lifecycle
 * tick retry startup on its own (left-git only: re-entering a repo is not a
 * user decision to close).
 */
const CLOSED_POLICY: Record<ClosedReason, { sticky: boolean; autoRecover: boolean }> = {
	user: { sticky: true, autoRecover: false },
	exited: { sticky: true, autoRecover: false },
	unverified: { sticky: true, autoRecover: false },
	blocked: { sticky: true, autoRecover: false },
	"left-git": { sticky: false, autoRecover: true },
};

type Presence = "present" | "absent" | "indeterminate";

type HandshakeOutcome =
	| { status: "bound"; hunkSessionId: string; hunkPid: number }
	| { status: "ambiguous"; reason: string }
	| { status: "timeout" };

type HealthOutcome =
	| "healthy"
	| "indeterminate"
	| { reason: ClosedReason; notifyKey: string; notice: string };

interface ViewTokenRecord {
	token: string;
	bindingGeneration: number;
	hunkSessionId: string;
	publicationGeneration: string;
}

export interface StableCapture {
	capturedAt: string;
	scope: ReviewScope;
	viewToken: string;
	review: Record<string, unknown>;
	publication: ReviewPublication;
	hunkSessionId: string;
}

export interface CaptureOutcome {
	ok: boolean;
	reason?: string;
	capture?: StableCapture;
}

export interface CommentWriteOutcome {
	ok: boolean;
	error?: string;
	reviewChanged?: boolean;
	result?: CommentAddResult;
}

export interface SnapshotPublication {
	generation: string;
	stateRevision?: number;
}

export interface SnapshotEnvelope {
	version: 1;
	capturedAt: string;
	ompSessionId: string;
	workspaceId: string;
	tabId: string;
	paneId: string;
	hunkSessionId: string;
	repoRoot: string;
	scope: ReviewScope;
	publication: SnapshotPublication;
	review: Record<string, unknown>;
}

export function eligibleEnv(env: EnvLike): boolean {
	return (
		env.HERDR_ENV === "1" &&
		(env.HERDR_WORKSPACE_ID ?? "").length > 0 &&
		(env.HERDR_PANE_ID ?? "").length > 0 &&
		(env.HERDR_SOCKET_PATH ?? "").length > 0
	);
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Idle means no foreground process — or only the pane's own shell, which herdr
 * may keep reporting after the foreground job exits. Every occupied/idle
 * decision in the controller goes through this predicate so an owned occupant
 * is never mistaken for a foreign one (and vice versa).
 */
function isIdleShell(info: PaneProcessInfo, shellPid: number | undefined): boolean {
	if (info.foregroundPids.length === 0) return true;
	if (shellPid === undefined) return false;
	return info.foregroundPids.every(pid => pid === shellPid);
}

export class CompanionController {
	readonly #deps: CompanionDeps;
	readonly #cli: HunkCli;
	readonly #herdr: HerdrCli;
	#state: CompanionState = "unavailable";
	#closedReason: ClosedReason | undefined;
	#binding: { hunkSessionId: string; hunkPid?: number } | undefined;
	#record: CompanionRecord | undefined;
	#recordPath: string | undefined;
	#repoRoot: string | undefined;
	#baselineHead: string | undefined;
	#scope: ReviewScope | undefined;
	#bindingGeneration = 0;
	#ompSessionId: string | undefined;
	#artifactsDir: string | null = null;
	#cwd = "";
	#viewToken: ViewTokenRecord | undefined;
	#queueTail: Promise<unknown> = Promise.resolve();
	#initPromise: Promise<void> | undefined;
	/** Hunk registry snapshot taken before the current launch submitted its command. */
	#launchBeforeSessions: Set<string> | undefined;
	#resetFailed = false;
	#shutdownStarted = false;
	/** In-flight lifecycle tick; concurrent callers await it instead of racing. */
	#lifecycleTickPromise: Promise<void> | undefined;
	#archiveRunning = false;
	#launchInFlight = false;
	#lastNotifyKey: string | undefined;
	readonly #eligible: boolean;

	constructor(deps: CompanionDeps) {
		this.#deps = deps;
		this.#cli = new HunkCli(deps.exec, deps.hunkPath);
		this.#herdr = new HerdrCli(deps.exec, deps.env.HERDR_BIN_PATH ?? "herdr");
		this.#eligible = eligibleEnv(deps.env);
	}

	get state(): CompanionState {
		return this.#state;
	}

	get closedReason(): ClosedReason | undefined {
		return this.#closedReason;
	}

	get eligible(): boolean {
		return this.#eligible;
	}

	get isReady(): boolean {
		return this.#state === "ready" && this.#binding !== undefined;
	}

	get scope(): ReviewScope | undefined {
		return this.#scope;
	}

	get repoRoot(): string | undefined {
		return this.#repoRoot;
	}

	get baselineHead(): string | undefined {
		return this.#baselineHead;
	}

	#workspaceId(): string {
		return this.#deps.env.HERDR_WORKSPACE_ID ?? "";
	}

	#agentPaneId(): string {
		return this.#deps.env.HERDR_PANE_ID ?? "";
	}

	#requireEligible(): void {
		if (!this.#eligible) {
			throw new CompanionUnavailable("Hunk companion requires omp running inside a herdr workspace.");
		}
	}

	/**
	 * Consecutive-duplicate suppression: fires only when `key` differs from the
	 * previous notification. Recovery paths clear the matching key so a
	 * recurrence of the same failure notifies again instead of staying silent.
	 */
	#notifyOnChange(key: string, message: string, level: NotifyLevel): void {
		if (this.#lastNotifyKey === key) return;
		this.#lastNotifyKey = key;
		this.#deps.notify(message, level);
	}

	#clearNotifyKey(key: string): void {
		if (this.#lastNotifyKey === key) this.#lastNotifyKey = undefined;
	}

	enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const wrapped = async (): Promise<T> => {
			if (this.#shutdownStarted) {
				throw new CompanionUnavailable("Hunk companion is shutting down.");
			}
			return operation();
		};
		const run = this.#queueTail.then(wrapped, wrapped);
		this.#queueTail = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	updateSessionContext(context: SessionContext): void {
		this.#ompSessionId = context.ompSessionId;
		this.#artifactsDir = context.artifactsDir;
	}

	setCwd(cwd: string): void {
		this.#cwd = cwd;
	}

	#recordFile(): string {
		if (!this.#recordPath) {
			const socket = this.#deps.env.HERDR_SOCKET_PATH ?? "";
			this.#recordPath = companionRecordPath(this.#deps.env, socket, this.#workspaceId());
		}
		return this.#recordPath;
	}

	async #persistRecord(): Promise<void> {
		if (!this.#record) return;
		this.#record.ownerPaneId = this.#agentPaneId();
		await writeCompanionRecord(this.#recordFile(), this.#record);
	}

	// ---------------------------------------------------------------- herdr --

	async #tabPresence(tabId: string): Promise<Presence> {
		try {
			return await this.#herdr.tabPresence(tabId);
		} catch (error) {
			this.#deps.logger.debug("herdr tab get failed", { tabId, error });
			return "indeterminate";
		}
	}

	async #paneState(paneId: string): Promise<HerdrPane | "absent" | "indeterminate"> {
		try {
			return (await this.#herdr.paneState(paneId)) ?? "absent";
		} catch (error) {
			this.#deps.logger.debug("herdr pane get failed", { paneId, error });
			return "indeterminate";
		}
	}

	async #paneInfo(paneId: string): Promise<PaneProcessInfo | "absent" | "indeterminate"> {
		try {
			return await this.#herdr.paneProcessInfo(paneId);
		} catch (error) {
			if (error instanceof HerdrAbsentError) return "absent";
			this.#deps.logger.debug("herdr pane process-info failed", { paneId, error });
			return "indeterminate";
		}
	}

	/**
	 * Broker host/port must be pinned at tab creation; omp-side environment
	 * changes do not propagate into already-created herdr tabs.
	 */
	#tabCreateEnvArgs(): string[] {
		const envArgs: string[] = [];
		const host = this.#deps.env.HUNK_MCP_HOST;
		const port = this.#deps.env.HUNK_MCP_PORT;
		if (host !== undefined && host.length > 0) envArgs.push("--env", `HUNK_MCP_HOST=${host}`);
		if (port !== undefined && port.length > 0) envArgs.push("--env", `HUNK_MCP_PORT=${port}`);
		return envArgs;
	}

	async focusTab(): Promise<void> {
		if (!this.#record) throw new CompanionUnavailable("No companion tab to focus.");
		await this.#herdr.run(["tab", "focus", this.#record.tabId], "tab focus");
	}

	/**
	 * Retitle the owned tab. Creation labels it "hunk"; a completed /diff
	 * scope change retitles it "diff" so the tab name reflects the active view.
	 */
	async renameTab(label: string): Promise<void> {
		if (!this.#record) throw new CompanionUnavailable("No companion tab to rename.");
		await this.#herdr.run(["tab", "rename", this.#record.tabId, label], "tab rename");
	}

	// ------------------------------------------------------------- lifecycle --

	/**
	 * Establish the companion for the current omp session. Idempotent while a
	 * startup is already in flight; `/diff` awaits the same operation rather
	 * than launching a second one. `explicit` (a completed /diff selection) may
	 * reopen a companion the user closed.
	 */
	initialize(options?: { explicit?: boolean }): Promise<void> {
		if (this.#state === "ready") return Promise.resolve();
		if (this.#initPromise) return this.#initPromise;
		this.#initPromise = this.enqueue(() => this.#initializeInner(options)).finally(() => {
			this.#initPromise = undefined;
		});
		return this.#initPromise;
	}

	async #initializeInner(options?: { explicit?: boolean }): Promise<void> {
		this.#requireEligible();
		if (this.#shutdownStarted) throw new CompanionUnavailable("Hunk companion is shutting down.");
		const checkout = await resolveCheckout(this.#deps.exec, this.#cwd);
		if (!checkout.ok) {
			throw new CompanionUnavailable(
				checkout.reason === "unborn"
					? "Hunk companion needs a git repository with at least one commit."
					: "Hunk companion needs a git repository.",
			);
		}
		if (
			this.#state === "closed" &&
			CLOSED_POLICY[this.#closedReason ?? "user"].sticky &&
			options?.explicit !== true
		) {
			throw new CompanionUnavailable("Open /diff to reopen the Hunk companion.");
		}

		let record: CompanionRecord | null = null;
		try {
			record = await readCompanionRecord(this.#recordFile());
		} catch (error) {
			this.#notifyOnChange(
				"record-malformed",
				"Hunk: companion ownership record is malformed; leaving it untouched.",
				"error",
			);
			this.#deps.logger.error("companion record malformed", { path: this.#recordFile(), error });
			throw new CompanionUnavailable("Hunk companion ownership record is malformed.");
		}

		this.#repoRoot = checkout.repoRoot;
		this.#baselineHead = checkout.headSha;
		this.#state = "starting";
		this.#closedReason = undefined;

		try {
			if (record !== null && record.socketPath === (this.#deps.env.HERDR_SOCKET_PATH ?? "")) {
				if (record.ownerPaneId !== this.#agentPaneId()) {
					const ownerPane = await this.#paneState(record.ownerPaneId);
					if (ownerPane === "indeterminate") {
						throw new CompanionUnavailable(
							"Hunk: could not reach herdr to verify the companion owner; will retry.",
						);
					}
					if (ownerPane !== "absent") {
						this.#state = "unavailable";
						this.#notifyOnChange(
							"ownership-conflict",
							`Hunk companion is owned by another agent pane (${record.ownerPaneId}).`,
							"warning",
						);
						throw new CompanionUnavailable(
							`Hunk companion is owned by another agent pane (${record.ownerPaneId}).`,
						);
					}
					// Owner pane is verifiably gone: take over after the identity checks below.
				}
				if (await this.#adoptOrLaunchFromRecord(record, checkout.repoRoot, checkout.headSha, options?.explicit === true)) return;
			}
			await this.#launchNewTab(checkout.repoRoot, checkout.headSha);
		} catch (error) {
			// A startup that failed before producing a bound companion must not
			// wedge in "starting" (tools would claim "still starting" forever and
			// ticks would no-op). Park it: lifecycle ticks retry, tools report
			// honestly. Deliberate closes (blocked/unverified) stay untouched.
			if (this.#state === "starting") this.#markRetryable();
			throw error;
		}
	}

	/** Startup failed without a closed decision: retryable by ticks and /diff. */
	#markRetryable(): void {
		this.#state = "unavailable";
		this.#closedReason = undefined;
	}

	/** Returns true when the existing record produced a bound companion. */
	async #adoptOrLaunchFromRecord(
		record: CompanionRecord,
		repoRoot: string,
		headSha: string,
		explicit = false,
	): Promise<boolean> {
		// Bind paths below seed scope and persistence from these fields; the
		// root-change fallback calls this method outside #initializeInner, so
		// they must track the caller's target checkout, not the previous root.
		this.#repoRoot = repoRoot;
		this.#baselineHead = headSha;

		const tab = await this.#tabPresence(record.tabId);
		if (tab === "indeterminate") {
			throw new CompanionUnavailable("Hunk: could not reach herdr to verify the companion tab; will retry.");
		}
		if (tab === "absent") {
			// A previous session's closed tab does not bind a fresh session: relaunch.
			this.#deps.logger.debug("recorded companion tab is gone; creating a new one", { tabId: record.tabId });
			return false;
		}
		const pane = await this.#paneState(record.paneId);
		if (pane === "indeterminate") {
			throw new CompanionUnavailable("Hunk: could not reach herdr to verify the companion pane; will retry.");
		}
		if (pane === "absent" || (pane.tabId !== undefined && pane.tabId !== record.tabId)) {
			this.#deps.logger.debug("recorded companion pane is gone; creating a new one", { paneId: record.paneId });
			return false;
		}
		const info = await this.#paneInfo(record.paneId);
		if (info === "indeterminate") {
			throw new CompanionUnavailable("Hunk: could not reach herdr to inspect the companion pane; will retry.");
		}
		if (info === "absent") {
			// Pane vanished between the two herdr calls; treat like a gone pane.
			this.#deps.logger.debug("recorded companion pane vanished during adoption", { paneId: record.paneId });
			return false;
		}
		if (
			(record.hunkSessionId !== undefined || record.shellPid !== undefined) &&
			(record.shellPid === undefined || info.shellPid !== record.shellPid)
		) {
			if (explicit) return false;
			this.#closeWithReason("unverified");
			throw new CompanionUnavailable("Hunk companion shell was replaced; use /diff to open a new tab.");
		}

		if (record.hunkSessionId !== undefined && record.hunkPid !== undefined) {
			return this.#bindRecordedSession(
				record,
				{ hunkSessionId: record.hunkSessionId, hunkPid: record.hunkPid },
				repoRoot,
				headSha,
				info,
				explicit,
			);
		}
		return this.#recoverIncompleteLaunch(record, repoRoot, headSha, info, explicit);
	}

	/** Recorded session binding: re-verify, re-resolve by pid, or fail closed. */
	async #bindRecordedSession(
		record: CompanionRecord,
		binding: { hunkSessionId: string; hunkPid: number },
		repoRoot: string,
		headSha: string,
		info: PaneProcessInfo,
		explicit: boolean,
	): Promise<boolean> {
		const sessions = await this.#cli.sessionList();
		const registered = sessions.find(entry => entry.sessionId === binding.hunkSessionId);
		const registeredRoot =
			registered !== undefined ? await canonicalPath(registered.repoRoot ?? registered.cwd) : undefined;
		if (
			registered !== undefined &&
			registered.pid === binding.hunkPid &&
			info.foregroundPids.includes(binding.hunkPid) &&
			registeredRoot === repoRoot
		) {
			this.#record = { ...record, repoRoot, ownerPaneId: this.#agentPaneId() };
			await this.#finishBind(binding, { reloadToSessionScope: true });
			return true;
		}
		// PID survives but the daemon lost the recorded id: re-resolve by pid.
		const inPane = [];
		for (const entry of sessions) {
			if (entry.pid !== binding.hunkPid) continue;
			if (!info.foregroundPids.includes(entry.pid)) continue;
			const entryRoot = await canonicalPath(entry.repoRoot ?? entry.cwd);
			if (entryRoot === repoRoot) inPane.push(entry);
		}
		if (inPane.length === 1) {
			const session = inPane[0];
			this.#record = {
				...record,
				repoRoot,
				hunkSessionId: session.sessionId,
				ownerPaneId: this.#agentPaneId(),
			};
			await this.#persistRecord();
			await this.#finishBind(
				{ hunkSessionId: session.sessionId, hunkPid: binding.hunkPid },
				{ reloadToSessionScope: true },
			);
			return true;
		}
		if (inPane.length > 1) {
			this.#failClosedAmbiguity(
				"unverified",
				"multiple sessions match the recorded pid in the owned pane",
				"Hunk: could not identify the companion session uniquely. Close the companion tab, then use /diff to relaunch.",
			);
		}
		if (explicit && !isIdleShell(info, record.shellPid)) return false;
		// The recorded hunk may still occupy the pane at another root (left-git
		// re-entry, cross-worktree restart): stop it and relaunch in place
		// instead of orphaning it in favor of a second tab.
		if (await this.#stopRecordedOccupant(record, binding, info, sessions)) {
			await this.#launchInPane(record.tabId, record.paneId, repoRoot, headSha, info);
			return true;
		}
		// Occupied by something the record cannot prove is ours: leave it alone.
		if (!isIdleShell(info, record.shellPid)) {
			if (explicit) return false;
			this.#closeWithReason("blocked");
			this.#notifyOnChange(
				"occupied-pane",
				"Hunk: the companion pane is busy with an unrecognized process; it was left untouched. Use /diff to open a new tab.",
				"warning",
			);
			throw new CompanionUnavailable("Hunk companion pane is occupied by an unrecognized process. Use /diff to open a new tab.");
		}
		const shellMatches = record.shellPid === undefined || info.shellPid === record.shellPid;
		if (!shellMatches) {
			this.#deps.logger.debug("recorded pane shell was replaced; creating a new tab", {
				paneId: record.paneId,
			});
			return false;
		}
		await this.#launchInPane(record.tabId, record.paneId, repoRoot, headSha, info);
		return true;
	}

	/**
	 * Single ambiguity policy for the identity handshake: never guess, never
	 * relaunch into the pane. The tab stands closed; the documented recovery is
	 * closing the stuck tab and completing a /diff selection.
	 */
	#failClosedAmbiguity(notifyKey: string, detail: string, message: string): never {
		this.#deps.logger.debug("handshake ambiguous; failing closed", { detail });
		this.#closeWithReason("unverified");
		this.#notifyOnChange(notifyKey, message, "error");
		throw new CompanionUnavailable(message);
	}

	/**
	 * True when the recorded hunk still occupies the pane (possibly registered
	 * at another root) and was stopped for an in-place relaunch. Requires the
	 * registry to still know the pid — foreground presence alone could be pid
	 * reuse by an unrelated process.
	 */
	async #stopRecordedOccupant(
		record: CompanionRecord,
		binding: { hunkSessionId: string; hunkPid: number },
		info: PaneProcessInfo,
		sessions: RegisteredSession[],
	): Promise<boolean> {
		if (!info.foregroundPids.includes(binding.hunkPid)) return false;
		if (!sessions.some(entry => entry.pid === binding.hunkPid)) return false;
		if (record.shellPid === undefined || info.shellPid !== record.shellPid) {
			return false;
		}
		return this.#stopOwnedHunk(record.paneId, record.shellPid);
	}

	/**
	 * Record exists but never captured a hunk identity (launch interrupted).
	 * Try a short late bind — the review may have registered late — then decide
	 * between an in-place relaunch and fail-closed reporting.
	 */
	async #recoverIncompleteLaunch(
		record: CompanionRecord,
		repoRoot: string,
		headSha: string,
		info: PaneProcessInfo,
		explicit: boolean,
	): Promise<boolean> {
		const lateBind = await this.#handshake(
			record.paneId,
			repoRoot,
			this.#launchBeforeSessions ?? new Set<string>(),
			record.shellPid,
			2_000,
		);
		if (lateBind.status === "bound") {
			this.#record = {
				...record,
				repoRoot,
				hunkSessionId: lateBind.hunkSessionId,
				hunkPid: lateBind.hunkPid,
				ownerPaneId: this.#agentPaneId(),
			};
			await this.#persistRecord();
			await this.#finishBind(lateBind, { reloadToSessionScope: true });
			return true;
		}
		if (lateBind.status === "ambiguous") {
			this.#failClosedAmbiguity(
				"incomplete-launch",
				lateBind.reason,
				"Hunk: could not identify the review session in the companion pane. Close the tab, then use /diff to relaunch.",
			);
		}
		if (!isIdleShell(info, record.shellPid)) {
			if (explicit) return false;
			this.#closeWithReason("blocked");
			this.#notifyOnChange(
				"incomplete-launch",
				"Hunk: the previous launch never completed and the companion pane is busy; it was left untouched. Use /diff to open a new tab.",
				"warning",
			);
			throw new CompanionUnavailable("Hunk companion launch was incomplete and the pane is occupied.");
		}
		const shellMatches = record.shellPid === undefined || info.shellPid === record.shellPid;
		if (!shellMatches) {
			this.#deps.logger.debug("recorded pane shell was replaced; creating a new tab", {
				paneId: record.paneId,
			});
			return false;
		}
		await this.#launchInPane(record.tabId, record.paneId, repoRoot, headSha, info);
		return true;
	}

	async #launchNewTab(repoRoot: string, headSha: string): Promise<void> {
		const before = new Set((await this.#cli.sessionList()).map(entry => entry.sessionId));
		this.#launchBeforeSessions = before;
		const { tabId, paneId } = await this.#herdr.tabCreate(
			this.#workspaceId(),
			repoRoot,
			this.#tabCreateEnvArgs(),
		);
		this.#record = {
			version: 1,
			socketPath: this.#deps.env.HERDR_SOCKET_PATH ?? "",
			workspaceId: this.#workspaceId(),
			ownerPaneId: this.#agentPaneId(),
			tabId,
			paneId,
			repoRoot,
		};
		await this.#persistRecord();
		const info = await this.#waitForShell(paneId);
		if (info === null) {
			// Provisional record stands; late lifecycle ticks may still bind.
			this.#notifyOnChange(
				"shell-timeout",
				"Hunk: companion tab shell did not become ready in time.",
				"warning",
			);
			return;
		}
		await this.#launchInPane(tabId, paneId, repoRoot, headSha, info, before);
	}

	async #waitForShell(paneId: string, deadlineMs = 10_000): Promise<PaneProcessInfo | null> {
		const startedAt = this.#deps.timers.now();
		for (;;) {
			if (this.#shutdownStarted) return null;
			const info = await this.#paneInfo(paneId);
			if (info === "absent") return null; // tab closed mid-launch; the next tick reports it
			if (info !== "indeterminate" && info.shellPid !== undefined) return info;
			if (this.#deps.timers.now() - startedAt >= deadlineMs) return null;
			await this.#sleep(250);
		}
	}

	async #launchInPane(
		tabId: string,
		paneId: string,
		repoRoot: string,
		headSha: string,
		info: PaneProcessInfo,
		beforeSessions?: Set<string>,
	): Promise<void> {
		if (this.#launchInFlight) {
			throw new CompanionUnavailable("Hunk companion launch already in flight.");
		}
		this.#launchInFlight = true;
		try {
			this.#repoRoot = repoRoot;
			this.#baselineHead = headSha;
			await this.#launchInPaneInner(tabId, paneId, repoRoot, headSha, info, beforeSessions);
		} finally {
			this.#launchInFlight = false;
		}
	}

	async #launchInPaneInner(
		tabId: string,
		paneId: string,
		repoRoot: string,
		headSha: string,
		info: PaneProcessInfo,
		beforeSessions?: Set<string>,
	): Promise<void> {
		if (this.#record) {
			this.#record.shellPid = info.shellPid;
			this.#record.repoRoot = repoRoot;
			delete this.#record.hunkSessionId;
			delete this.#record.hunkPid;
			await this.#persistRecord();
		}
		const before =
			beforeSessions ?? new Set((await this.#cli.sessionList()).map(entry => entry.sessionId));
		this.#launchBeforeSessions = before;
		const command = `cd -- ${shellQuote(repoRoot)} && ${shellQuote(this.#deps.hunkPath)} diff ${shellQuote(headSha)} --watch --agent-notes`;
		await this.#herdr.run(["pane", "run", paneId, command], "pane run");
		this.#state = "starting";
		const handshake = await this.#handshake(paneId, repoRoot, before, info.shellPid, 20_000);
		if (handshake.status === "ambiguous") {
			this.#failClosedAmbiguity(
				"handshake-ambiguous",
				handshake.reason,
				"Hunk: multiple review sessions appeared in the companion pane. Close the tab, then use /diff to relaunch.",
			);
		}
		if (handshake.status === "timeout") {
			this.#notifyOnChange(
				"launch-timeout",
				"Hunk: review not ready yet (timed out); it may still be loading.",
				"warning",
			);
			return;
		}
		this.#record = {
			...(this.#record ?? {
				version: 1,
				socketPath: this.#deps.env.HERDR_SOCKET_PATH ?? "",
				workspaceId: this.#workspaceId(),
				ownerPaneId: this.#agentPaneId(),
				tabId,
				paneId,
				repoRoot,
			}),
			tabId,
			paneId,
			shellPid: info.shellPid,
			repoRoot,
			hunkSessionId: handshake.hunkSessionId,
			hunkPid: handshake.hunkPid,
		};
		await this.#persistRecord();
		await this.#finishBind(
			{ hunkSessionId: handshake.hunkSessionId, hunkPid: handshake.hunkPid },
			{ reloadToSessionScope: false },
		);
	}

	/**
	 * Poll the owned pane until exactly one newly-registered hunk session (not
	 * in `before`, in the pane's foreground, at the expected canonical root)
	 * proves itself. `expectedShellPid` must still own the pane: a replaced
	 * shell means whatever runs there was not started by our command. Timeout
	 * means "nothing proven yet" and stays retryable by design; ambiguity is
	 * final and fails closed at every call site.
	 */
	async #handshake(
		paneId: string,
		expectedRoot: string,
		before: Set<string>,
		expectedShellPid: number | undefined,
		deadlineMs: number,
	): Promise<HandshakeOutcome> {
		const startedAt = this.#deps.timers.now();
		for (;;) {
			if (this.#shutdownStarted) return { status: "timeout" };
			const info = await this.#paneInfo(paneId);
			if (info !== "indeterminate") {
				if (info === "absent") return { status: "timeout" };
				if (expectedShellPid !== undefined && info.shellPid !== expectedShellPid) {
					return { status: "timeout" };
				}
				try {
					const sessions = await this.#cli.sessionList();
					const candidates = [];
					for (const entry of sessions) {
						if (before.has(entry.sessionId)) continue;
						if (!info.foregroundPids.includes(entry.pid)) continue;
						const entryRoot = await canonicalPath(entry.repoRoot ?? entry.cwd);
						if (entryRoot === expectedRoot) candidates.push(entry);
					}
					if (candidates.length === 1) {
						const session = candidates[0];
						return { status: "bound", hunkSessionId: session.sessionId, hunkPid: session.pid };
					}
					if (candidates.length > 1) {
						return {
							status: "ambiguous",
							reason: "multiple new review sessions appeared in the owned pane",
						};
					}
				} catch (error) {
					this.#deps.logger.debug("handshake poll failed", { paneId, error });
				}
			}
			if (this.#deps.timers.now() - startedAt >= deadlineMs) return { status: "timeout" };
			await this.#sleep(500);
		}
	}

	async #finishBind(
		binding: { hunkSessionId: string; hunkPid?: number },
		options: { reloadToSessionScope: boolean },
	): Promise<void> {
		this.#binding = binding;
		this.#bindingGeneration += 1;
		this.#viewToken = undefined;
		this.#launchBeforeSessions = undefined;
		this.#state = "ready";
		this.#closedReason = undefined;
		// Recovery: re-arm every launch/close notice so a recurrence notifies again.
		for (const key of [
			"closed-user",
			"closed-exited",
			"blocked",
			"unverified",
			"handshake-ambiguous",
			"late-bind-ambiguous",
			"launch-timeout",
			"shell-timeout",
			"incomplete-launch",
			"occupied-pane",
			"late-bind-shell-changed",
		]) {
			this.#clearNotifyKey(key);
		}
		this.#scope = { kind: "session", baseSha: this.#baselineHead ?? "" };
		await this.#resetAnnotations();
		if (options.reloadToSessionScope) {
			try {
				await this.#cli.reload(binding.hunkSessionId, hunkReloadArgs(this.#scope), { timeoutMs: 5_000 });
			} catch (error) {
				this.#deps.logger.warn("post-adoption scope reload failed", { error });
			}
		}
		await this.snapshotNow({ deadlineMs: 3_000 });
	}

	/**
	 * Fresh-annotation boundary for a new omp session: clear every note in the
	 * owned companion only. Returns false when the clear failed; annotations
	 * stay blocked until a completed /diff selection retries it or the next
	 * session boundary succeeds.
	 */
	async #resetAnnotations(): Promise<boolean> {
		if (!this.#binding) return false;
		try {
			await this.#cli.commentClearAll(this.#binding.hunkSessionId, { timeoutMs: 5_000 });
			this.#resetFailed = false;
			this.#clearNotifyKey("reset-failed");
			return true;
		} catch (error) {
			this.#resetFailed = true;
			this.#deps.logger.warn("clean-slate clear failed", { error });
			this.#notifyOnChange(
				"reset-failed",
				"Hunk: could not clear the previous session's notes; annotations are disabled. Complete a /diff selection to retry, or wait for the next session boundary.",
				"warning",
			);
			return false;
		}
	}

	/** Re-run the clean boundary when the omp session id changes (/new, branch, resume). */
	async onSessionChanged(newSessionId: string): Promise<void> {
		if (this.#shutdownStarted) return; // shutdown owns the companion from here on
		if (this.#ompSessionId === newSessionId) return;
		this.#ompSessionId = newSessionId;
		this.#viewToken = undefined;
		if (!this.isReady || !this.#binding) return;
		await this.enqueue(async () => {
			if (!this.isReady || !this.#binding) return;
			const checkout = await resolveCheckout(this.#deps.exec, this.#cwd);
			if (!checkout.ok) return;
			this.#baselineHead = checkout.headSha;
			this.#scope = { kind: "session", baseSha: checkout.headSha };
			await this.#resetAnnotations();
			try {
				await this.#cli.reload(this.#binding.hunkSessionId, hunkReloadArgs(this.#scope), {
					timeoutMs: 5_000,
				});
			} catch (error) {
				this.#deps.logger.warn("session-boundary scope reload failed", { error });
			}
			await this.snapshotNow({ deadlineMs: 3_000 });
		});
	}

	#closeWithReason(reason: ClosedReason): void {
		this.#state = "closed";
		this.#closedReason = reason;
		this.#binding = undefined;
		this.#viewToken = undefined;
		this.#launchBeforeSessions = undefined;
	}

	#notReadyMessage(): string {
		if (this.#state === "starting") return "Hunk companion is still starting; try again shortly.";
		if (this.#state === "closed") return "Open /diff to reopen the Hunk companion.";
		return "Hunk companion is unavailable; use /diff to retry.";
	}

	// ------------------------------------------------------------------ ticks --

	/**
	 * Health check + cwd follow. Serialized: concurrent callers (interval,
	 * tools) await the in-flight tick instead of racing it, so no caller
	 * outruns a transition.
	 */
	lifecycleTick(): Promise<void> {
		if (this.#lifecycleTickPromise) return this.#lifecycleTickPromise;
		const tick = this.#lifecycleTickInner().finally(() => {
			this.#lifecycleTickPromise = undefined;
		});
		this.#lifecycleTickPromise = tick;
		return tick;
	}

	async #lifecycleTickInner(): Promise<void> {
		if (this.#shutdownStarted) return;
		if (!this.#eligible) return;
		try {
			if (this.#state === "unavailable") {
				// A parked startup (transient failure, unresolved conflict, malformed
				// record): retry instead of leaving tools stuck on "still starting".
				await this.initialize().catch(error => {
					this.#deps.logger.debug("startup retry failed", { error });
				});
				return;
			}
			if (this.#state === "closed") {
				if (CLOSED_POLICY[this.#closedReason ?? "user"].autoRecover) {
					await this.initialize().catch(error => {
						this.#deps.logger.debug("closed-state recovery failed", { error });
					});
				}
				return;
			}
			if (this.#state === "starting") {
				await this.#lateBindTick();
				return;
			}
			if (this.isReady && this.#record && this.#binding) {
				const health = await this.#healthCheck();
				if (health === "indeterminate") return; // transient herdr failure: decide on a later tick
				if (health !== "healthy") {
					this.#closeWithReason(health.reason);
					this.#notifyOnChange(health.notifyKey, health.notice, "info");
					return;
				}
			}
			const checkout = await resolveCheckout(this.#deps.exec, this.#cwd);
			if (!checkout.ok) {
				if (this.#state === "ready") {
					this.#closeWithReason("left-git");
					this.#notifyOnChange(
						"left-git",
						"Hunk: left the git checkout; the review tab stays as-is until you return.",
						"info",
					);
				}
				return;
			}
			if (checkout.repoRoot === this.#repoRoot) return;
			await this.enqueue(() => this.#rootChange(checkout.repoRoot, checkout.headSha));
		} catch (error) {
			this.#deps.logger.debug("lifecycle tick failed", { error });
		}
	}

	/**
	 * Bind a launch whose hunk process registered after the inline handshake
	 * gave up. Requires the recorded shell to still own the pane and the
	 * session to be new relative to the launch-time registry snapshot — a
	 * replaced shell or a session that predates the launch is never bound (and
	 * never cleared).
	 */
	async #lateBindTick(): Promise<void> {
		if (this.#launchInFlight) return; // an inline handshake already owns this bind
		const record = this.#record;
		if (!record || record.shellPid === undefined) return; // no shell proof: nothing provable to bind
		const info = await this.#paneInfo(record.paneId);
		if (info === "indeterminate") return;
		if (info === "absent") {
			this.#closeWithReason("user");
			this.#notifyOnChange("closed-user", "Hunk: companion tab was closed. Use /diff to reopen it.", "info");
			return;
		}
		if (info.shellPid !== record.shellPid) {
			this.#notifyOnChange(
				"late-bind-shell-changed",
				"Hunk: the companion pane's shell changed during startup; refusing to bind. Use /diff to open a fresh companion.",
				"warning",
			);
			return;
		}
		if (isIdleShell(info, record.shellPid)) return; // the launch command has no foreground job yet
		const handshake = await this.#handshake(
			record.paneId,
			record.repoRoot,
			this.#launchBeforeSessions ?? new Set<string>(),
			record.shellPid,
			2_000,
		);
		if (handshake.status === "ambiguous") {
			this.#closeWithReason("unverified");
			this.#notifyOnChange(
				"late-bind-ambiguous",
				"Hunk: multiple new review sessions appeared in the companion pane; refusing to bind. Close the tab, then use /diff to relaunch.",
				"error",
			);
			return;
		}
		if (handshake.status !== "bound") return; // registration may still lag; stay starting
		record.hunkSessionId = handshake.hunkSessionId;
		record.hunkPid = handshake.hunkPid;
		await this.#persistRecord();
		await this.#finishBind(handshake, { reloadToSessionScope: false });
	}

	/**
	 * "healthy" keeps the tick going; "indeterminate" skips it (a transient
	 * herdr failure must neither sticky-close nor relaunch); otherwise the
	 * close decision with its notice.
	 */
	async #healthCheck(): Promise<HealthOutcome> {
		const closedNotice = "Hunk: companion tab was closed. Use /diff to reopen it.";
		const exitedNotice = "Hunk: the review process exited. Use /diff to relaunch it.";
		if (!this.#record || !this.#binding) {
			return { reason: "exited", notifyKey: "closed-exited", notice: exitedNotice };
		}
		const tab = await this.#tabPresence(this.#record.tabId);
		if (tab === "indeterminate") return "indeterminate";
		if (tab === "absent") {
			return { reason: "user", notifyKey: "closed-user", notice: closedNotice };
		}
		const info = await this.#paneInfo(this.#record.paneId);
		if (info === "indeterminate") return "indeterminate";
		if (info === "absent") {
			return { reason: "user", notifyKey: "closed-user", notice: closedNotice };
		}
		if (!info.foregroundPids.includes(this.#binding.hunkPid ?? -1)) {
			return { reason: "exited", notifyKey: "closed-exited", notice: exitedNotice };
		}
		try {
			const sessions = await this.#cli.sessionList();
			const registered = sessions.find(entry => entry.sessionId === this.#binding?.hunkSessionId);
			if (registered === undefined || registered.pid !== this.#binding.hunkPid) {
				return {
					reason: "exited",
					notifyKey: "closed-exited",
					notice: "Hunk: the review session is no longer registered. Use /diff to relaunch it.",
				};
			}
		} catch (error) {
			// Hunk-daemon hiccups are not herdr absence: keep the binding and retry later.
			this.#deps.logger.debug("health check session list failed", { error });
		}
		return "healthy";
	}

	async #rootChange(newRoot: string, newHead: string): Promise<void> {
		// Archive the old root's review before any pane input is sent.
		await this.snapshotNow({ deadlineMs: 1_000 });
		if (this.isReady && this.#record && this.#binding && (await this.#verifyOwnedHunkAlive())) {
			const stopped = await this.#stopOwnedHunk(this.#record.paneId, this.#record.shellPid);
			if (!stopped) {
				this.#closeWithReason("blocked");
				this.#notifyOnChange(
					"blocked",
					"Hunk: companion pane did not return to its shell; it was left untouched. Use /diff to open a new tab.",
					"warning",
				);
				return;
			}
			await this.#launchInPane(this.#record.tabId, this.#record.paneId, newRoot, newHead, {
				shellPid: this.#record.shellPid,
				foregroundPids: [],
			});
			return;
		}
		// No verifiable binding: adopt-or-launch for the new root from the record.
		let record: CompanionRecord | null = null;
		try {
			record = await readCompanionRecord(this.#recordFile());
		} catch {
			record = null;
		}
		if (record !== null && (await this.#adoptOrLaunchFromRecord(record, newRoot, newHead))) return;
		await this.#launchNewTab(newRoot, newHead);
	}

	async #verifyOwnedHunkAlive(): Promise<boolean> {
		if (!this.#record || !this.#binding) return false;
		try {
			const info = await this.#herdr.paneProcessInfo(this.#record.paneId);
			if (!info.foregroundPids.includes(this.#binding.hunkPid ?? -1)) return false;
			const sessions = await this.#cli.sessionList();
			return sessions.some(
				entry => entry.sessionId === this.#binding?.hunkSessionId && entry.pid === this.#binding?.hunkPid,
			);
		} catch {
			return false;
		}
	}

	/** ctrl+c the pane's foreground job and wait for its shell to be idle again. */
	async #stopOwnedHunk(paneId: string, shellPid: number | undefined, deadlineMs = 5_000): Promise<boolean> {
		await this.#herdr.run(["pane", "send-keys", paneId, "ctrl+c"], "pane send-keys");
		const startedAt = this.#deps.timers.now();
		for (;;) {
			if (this.#shutdownStarted) return false;
			const info = await this.#paneInfo(paneId);
			if (typeof info === "string") return false; // pane gone or herdr unreachable: not proven idle
			if (isIdleShell(info, shellPid)) return true;
			if (this.#deps.timers.now() - startedAt >= deadlineMs) return false;
			await this.#sleep(250);
		}
	}

	// ------------------------------------------------------------- /diff API --

	/** Completed /diff selection: retry a failed clean-slate reset, then reload. */
	async selectScope(scope: ReviewScope): Promise<void> {
		await this.enqueue(async () => {
			if (!this.isReady || !this.#binding) {
				throw new CompanionUnavailable(this.#notReadyMessage());
			}
			// A previously failed reset is retried by the completed selection;
			// success clears the flag and re-arms the failure notice.
			if (this.#resetFailed) await this.#resetAnnotations();
			await this.#cli.reload(this.#binding.hunkSessionId, hunkReloadArgs(scope), { timeoutMs: 5_000 });
			this.#scope = scope;
			this.#viewToken = undefined;
			try {
				await this.renameTab("diff");
			} catch (error) {
				this.#deps.logger.warn("tab rename after scope change failed", { error });
			}
			await this.snapshotNow({ deadlineMs: 3_000 });
		});
	}

	// ---------------------------------------------------------------- capture --

	async captureStable(signal?: AbortSignal): Promise<CaptureOutcome> {
		if (!this.isReady || !this.#binding) {
			return { ok: false, reason: this.#notReadyMessage() };
		}
		const generation0 = this.#bindingGeneration;
		const sessionId = this.#binding.hunkSessionId;
		let before: SessionSnapshot;
		try {
			before = await this.#cli.sessionGet(sessionId, { signal });
		} catch (error) {
			return { ok: false, reason: this.#captureErrorReason(error) };
		}
		const generation = before.publication?.generation;
		if (generation === undefined) {
			return { ok: false, reason: "Hunk did not report a review generation; try again shortly." };
		}
		let review;
		try {
			review = await this.#cli.sessionReview(sessionId, { signal });
		} catch (error) {
			return { ok: false, reason: this.#captureErrorReason(error) };
		}
		let after: SessionSnapshot;
		try {
			after = await this.#cli.sessionGet(sessionId, { signal });
		} catch (error) {
			return { ok: false, reason: this.#captureErrorReason(error) };
		}
		if (after.publication?.generation !== generation) {
			return { ok: false, reason: "Review changed while reading; call hunk_review again." };
		}
		if (this.#bindingGeneration !== generation0 || this.#binding?.hunkSessionId !== sessionId) {
			return { ok: false, reason: "Companion rebound during capture; call hunk_review again." };
		}
		const token = this.#issueViewToken(generation);
		return {
			ok: true,
			capture: {
				capturedAt: new Date().toISOString(),
				scope: this.#scope ?? { kind: "session", baseSha: this.#baselineHead ?? "" },
				viewToken: token,
				review: review.review,
				publication: after.publication ?? { generation },
				hunkSessionId: sessionId,
			},
		};
	}

	#captureErrorReason(error: unknown): string {
		// CommandCliError messages are already context-prefixed by the CLI layer.
		if (error instanceof CommandCliError) return error.message;
		if (error instanceof CompanionUnavailable) return error.message;
		return "Hunk companion call failed; try again shortly.";
	}

	#issueViewToken(publicationGeneration: string): string {
		const existing = this.#viewToken;
		if (
			existing !== undefined &&
			existing.bindingGeneration === this.#bindingGeneration &&
			existing.hunkSessionId === this.#binding?.hunkSessionId &&
			existing.publicationGeneration === publicationGeneration
		) {
			return existing.token;
		}
		const token = crypto.randomUUID();
		this.#viewToken = {
			token,
			bindingGeneration: this.#bindingGeneration,
			hunkSessionId: this.#binding?.hunkSessionId ?? "",
			publicationGeneration,
		};
		return token;
	}

	async commentWrite(
		token: string,
		request: CommentAddRequest,
		signal?: AbortSignal,
	): Promise<CommentWriteOutcome> {
		return this.enqueue(async () => {
			if (!this.isReady || !this.#binding) {
				return { ok: false, error: this.#notReadyMessage() };
			}
			if (this.#resetFailed) {
				return {
					ok: false,
					error:
						"Annotations are unavailable: the clean-slate reset failed earlier. Complete a /diff selection to retry it.",
				};
			}
			const record = this.#viewToken;
			if (
				record === undefined ||
				record.token !== token ||
				record.bindingGeneration !== this.#bindingGeneration ||
				record.hunkSessionId !== this.#binding.hunkSessionId
			) {
				return { ok: false, error: "Unknown or stale view token; call hunk_review again before annotating." };
			}
			let current: SessionSnapshot;
			try {
				current = await this.#cli.sessionGet(this.#binding.hunkSessionId, { signal });
			} catch (error) {
				return { ok: false, error: this.#captureErrorReason(error) };
			}
			if (current.publication?.generation !== record.publicationGeneration) {
				return { ok: false, error: "Review changed; call hunk_review again before annotating." };
			}
			let result: CommentAddResult;
			try {
				result = await this.#cli.commentAdd(this.#binding.hunkSessionId, request, { signal });
			} catch (error) {
				if (error instanceof CommandCliError && error.message.includes("timed out")) {
					// The write may or may not have landed; a blind retry could
					// duplicate it. Kill the token so the next attempt needs a fresh
					// hunk_review.
					this.#viewToken = undefined;
					return {
						ok: false,
						error: "Comment write timed out; the outcome is unknown. Call hunk_review before retrying.",
					};
				}
				if (error instanceof CommandCliError) {
					return { ok: false, error: `Hunk rejected the comment: ${error.message}` };
				}
				return { ok: false, error: this.#captureErrorReason(error) };
			}
			let reviewChanged = false;
			try {
				const after = await this.#cli.sessionGet(this.#binding.hunkSessionId, { signal });
				reviewChanged = after.publication?.generation !== record.publicationGeneration;
			} catch {
				reviewChanged = true;
			}
			return { ok: true, result, reviewChanged };
		});
	}

	// --------------------------------------------------------------- archives --

	async snapshotNow(options?: { deadlineMs?: number }): Promise<boolean> {
		if (this.#archiveRunning) return false; // a 30s tick can outlive its interval
		this.#archiveRunning = true;
		try {
			if (!this.isReady || !this.#binding || !this.#scope) return false;
			const artifactsDir = this.#artifactsDir;
			if (artifactsDir === null) {
				this.#deps.logger.debug("skipping archive: session has no artifact directory");
				return false;
			}
			// Capture identity/destination before awaiting; discard outdated work
			// instead of writing into a replacement session's archive.
			const boundSessionId = this.#binding.hunkSessionId;
			const boundGeneration = this.#bindingGeneration;
			const ompSessionId = this.#ompSessionId ?? "";
			const workspaceId = this.#workspaceId();
			const tabId = this.#record?.tabId ?? "";
			const paneId = this.#record?.paneId ?? "";
			const repoRoot = this.#repoRoot ?? "";
			const deadline = options?.deadlineMs;
			const capture = await this.#withDeadline(this.captureStable(), deadline);
			if (capture === undefined) {
				this.#deps.logger.debug("archive capture exceeded its deadline");
				return false;
			}
			if (!capture.ok || !capture.capture) {
				this.#deps.logger.debug("archive capture skipped", { reason: capture.reason });
				return false;
			}
			if (this.#bindingGeneration !== boundGeneration || this.#binding?.hunkSessionId !== boundSessionId) {
				this.#deps.logger.debug("archive discarded: companion rebound during capture");
				return false;
			}
			const envelope: SnapshotEnvelope = {
				version: 1,
				capturedAt: capture.capture.capturedAt,
				ompSessionId,
				workspaceId,
				tabId,
				paneId,
				hunkSessionId: capture.capture.hunkSessionId,
				repoRoot,
				scope: capture.capture.scope,
				publication: {
					generation: capture.capture.publication.generation,
					stateRevision: capture.capture.publication.stateRevision,
				},
				review: capture.capture.review,
			};
			await this.#withDeadline(
				atomicWriteJson(`${artifactsDir}/hunk/review-notes.json`, envelope, 0o600),
				deadline,
			);
			return true;
		} catch (error) {
			this.#deps.logger.warn("archive write failed", { error });
			return false;
		} finally {
			this.#archiveRunning = false;
		}
	}

	async #withDeadline<T>(promise: Promise<T>, deadlineMs?: number): Promise<T | undefined> {
		if (deadlineMs === undefined) return promise;
		const { promise: raced, resolve } = Promise.withResolvers<T | undefined>();
		const handle = this.#deps.timers.setTimeout(() => resolve(undefined), deadlineMs);
		const settled = await Promise.race([promise, raced]);
		this.#deps.timers.clearTimeout(handle);
		return settled;
	}

	// --------------------------------------------------------------- shutdown --

	async shutdown(deadlineMs: number): Promise<void> {
		this.#shutdownStarted = true;
		try {
			await this.snapshotNow({ deadlineMs });
		} catch (error) {
			this.#deps.logger.debug("final snapshot failed", { error });
		}
		this.#state = "unavailable";
		this.#closedReason = undefined;
		this.#binding = undefined;
		this.#viewToken = undefined;
		this.#launchBeforeSessions = undefined;
	}

	/** Resolves immediately once shutdown started so poll loops never hang. */
	#sleep(ms: number): Promise<void> {
		if (this.#shutdownStarted) return Promise.resolve();
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#deps.timers.setTimeout(resolve, ms);
		return promise;
	}

	// ------------------------------------------------------- /diff resolution --

	/** Resolve the user's selector choice into a pinned ReviewScope. */
	async resolveScope(
		kind: "session" | "branch" | "commit",
		selection?: { branchFullRef?: string; commitSha?: string },
	): Promise<ReviewScope> {
		const checkout = await resolveCheckout(this.#deps.exec, this.#cwd);
		if (!checkout.ok) {
			throw new CompanionUnavailable(
				checkout.reason === "unborn"
					? "This repository has no commits yet."
					: "This directory is not a git repository.",
			);
		}
		if (kind === "session") {
			return { kind: "session", baseSha: this.#baselineHead ?? checkout.headSha };
		}
		if (kind === "commit" && selection?.commitSha !== undefined) {
			return { kind: "commit", commitSha: selection.commitSha };
		}
		if (kind === "branch" && selection?.branchFullRef !== undefined) {
			const baseSha = await resolveCommitSha(this.#deps.exec, this.#cwd, selection.branchFullRef);
			const base = await mergeBase(this.#deps.exec, this.#cwd, baseSha, checkout.headSha);
			return { kind: "branch", baseBranch: selection.branchFullRef, baseSha: base };
		}
		throw new CompanionUnavailable("Incomplete diff selection.");
	}
}
