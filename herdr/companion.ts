/**
 * Companion controller: admits exactly one primary omp process per Herdr
 * workspace and reconciles one managed Hunk diff child for it.
 *
 * Role model: the host's native `FileLock` decides primary vs secondary once
 * per process (`admit()`); the role never changes for the process lifetime.
 * Only the primary derives and reconciles a child from its session and
 * checkout; secondaries never create, close, clear, rename, focus, archive, or
 * expose any child. Child availability (`unavailable`/`starting`/`ready`) is
 * tracked separately from role.
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
 *   which tab/pane the extension created and which omp session bound it. It
 *   stores no notes and is never a replay journal.
 * - Retirement is ID-proven: before `pane close` the record's tab/pane/shell/
 *   Hunk identities and canonical recorded checkout must verify, a fresh pane
 *   list must prove another pane remains (herdr cascades workspace closure
 *   from the last pane), and structured `pane_not_found` plus disappearance of
 *   the bound registration (or proven Hunk PID death) must follow. Indeterminate
 *   evidence leaves the pane and all metadata untouched.
 * - Creation is guarded by a durable launch-intent sidecar
 *   (`<record>.launch.json`, `wx`-created before `tab create`, removed only
 *   after a shell-qualified record is durable), so a lost create reply or a
 *   crash can never produce a duplicate child on the next startup.
 *
 * Failure policy: herdr calls distinguish proven absence (structured
 * tab_not_found/pane_not_found codes) from indeterminate failures (socket
 * hiccups, herdr restarts, timeouts, malformed output). Proven absence may
 * replace a child; indeterminate failures skip the tick and retry later —
 * never a speculative close, never a duplicate tab.
 *
 * Lifecycle: one desired `ParentSnapshot` (revision-monotonic) is drained by a
 * single serialized reconciliation path. Parent-ID or verified canonical-root
 * changes archive, retire, and relaunch; same-parent/same-checkout runs keep
 * the pinned baseline, scope, and notes. Shutdown soft-retires: it stops new
 * work, invalidates tool tokens, attempts one final fenced archive, and never
 * touches the child, the records, or the process-owned primary lock.
 */

import * as nodeFs from "node:fs/promises";
import * as nodePath from "node:path";
import {
	CommandCliError,
	CompanionUnavailable,
	HunkCli,
	type CommentAddRequest,
	type CommentAddResult,
	type ExecRunner,
	type RegisteredSession,
	type ReviewPublication,
	type SessionSnapshot,
} from "./hunk-cli";
import { HerdrAbsentError, HerdrCli, HerdrRejectedError, type HerdrPane, type PaneProcessInfo } from "./herdr-cli";
import { asRecord, canonicalPath } from "./boundary";
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
	primaryRoleLockPath,
	readCompanionRecord,
	readJsonFile,
	writeCompanionRecord,
	type CompanionRecord,
} from "./storage";
import type { ControllerRole, PrimaryLock, PrimaryLockFactory } from "./primary-lock";

export type { ControllerRole } from "./primary-lock";
export type EnvLike = Record<string, string | undefined>;

export const SECONDARY_INACTIVE_MESSAGE = "Herdr integration is inactive in this secondary omp session.";
export const PENDING_OWNERSHIP_MESSAGE = "Herdr integration is waiting for workspace ownership.";
const SHUTDOWN_MESSAGE = "Herdr integration is shutting down.";
const PANE_IDENTITY_BLOCKED_MESSAGE =
	"Herdr: this controller's pane identity changed; review controls are paused.";

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
	/** Host primary-role lock factory; decides admission once per process. */
	tryPrimaryLock: PrimaryLockFactory;
	/** This omp process's own PID, proving its pane's foreground identity. */
	controllerPid: number;
	/** Zero-signal liveness probe: false = proven dead, otherwise true/"unknown". */
	isProcessAlive(pid: number): boolean | "unknown";
}

export interface SessionContext {
	ompSessionId: string;
	artifactsDir: string | null;
	cwd: string;
}

export interface ParentSnapshot extends SessionContext {
	revision: number;
}

/** Child availability, tracked independently from the process role. */
export type ChildState = "unavailable" | "starting" | "ready";

type HandshakeOutcome =
	| { status: "bound"; hunkSessionId: string; hunkPid: number }
	| { status: "ambiguous"; reason: string }
	| { status: "timeout" };

interface ViewTokenRecord {
	token: string;
	bindingEpoch: number;
	hunkSessionId: string;
	publicationGeneration: string;
}

interface LaunchIntent {
	sidecarPath: string;
	nonce: string;
	paneId: string;
}

/**
 * A proven child identity plus the pane-side fact it rests on:
 * `foregroundPid` names the Hunk process that must still hold the pane
 * foreground at close time; its absence means the proof rested on the
 * original idle shell, which the close-time comparison requires again.
 */
type QualifiedChildProof = {
	proven: true;
	recovered?: { hunkSessionId: string; hunkPid: number };
	foregroundPid?: number;
};

type ChildProof = QualifiedChildProof | { proven: false };

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

const LAUNCH_TIMEOUT_MS = 20_000;
const SHELL_WAIT_TIMEOUT_MS = 10_000;
const RETIRE_CLOSE_TIMEOUT_MS = 5_000;

/** Notify keys a recovered child re-arms so a recurrence notifies again. */
const RECOVERY_NOTIFY_KEYS = [
	"shell-timeout",
	"launch-timeout",
	"handshake-ambiguous",
	"late-bind-ambiguous",
	"late-bind-shell-changed",
	"foreground-unregistered",
	"registered-background",
	"clean-gate",
	"launch-registry",
	"tab-create",
] as const;

export function eligibleEnv(env: EnvLike): boolean {
	return (
		env.HERDR_ENV === "1" &&
		env.OMPCODE !== "1" &&
		(env.HERDR_WORKSPACE_ID ?? "").length > 0 &&
		(env.HERDR_PANE_ID ?? "").length > 0 &&
		(env.HERDR_SOCKET_PATH ?? "").length > 0
	);
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

function isEnoent(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
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
	readonly #eligible: boolean;

	// role admission
	#role: ControllerRole = "pending";
	#lock: PrimaryLock | undefined;
	#admitPromise: Promise<ControllerRole> | undefined;

	// desired parent context (single source of revision truth)
	#desired: ParentSnapshot | undefined;
	#revision = 0;

	// applied child state
	#child: ChildState = "unavailable";
	#binding: { hunkSessionId: string; hunkPid?: number } | undefined;
	/** Bumps on every binding transition (bind or clear); fences capture/publish. */
	#bindingEpoch = 0;
	#record: CompanionRecord | undefined;
	#recordPath: string | undefined;
	/** The in-memory record carries identity the disk does not confirm yet. */
	#recordDirty = false;
	/** The parent context and canonical root of the currently applied child. */
	#applied: { parent: ParentSnapshot; root: string } | undefined;
	/** The parent id the in-flight starting launch was derived for. Only this
	 * process's own launch state carries it: the durable record stays v1, and a
	 * successor never adopts a retained child regardless of its parent. */
	#launchParent: { ompSessionId: string } | undefined;
	/** The parent id + root the pinned baseline/scope was captured for. */
	#pinnedFor: { ompSessionId: string; root: string } | undefined;
	#repoRoot: string | undefined;
	#baselineHead: string | undefined;
	#scope: ReviewScope | undefined;
	/** Hunk session whose notes were verifiably cleared (clean-annotation gate). */
	#cleanForSessionId: string | undefined;
	#pendingScopeReload: ReviewScope | undefined;
	#gitReady = false;

	// launch bookkeeping
	#viewToken: ViewTokenRecord | undefined;
	#queueTail: Promise<unknown> = Promise.resolve();
	/** Hunk registry snapshot taken before the current launch submitted its command. */
	#launchBeforeSessions: Set<string> | undefined;
	#launchIntent: LaunchIntent | undefined;
	#launchInFlight = false;
	/** Proven pre-submission `pane run` rejection for the in-flight launch. */
	#launchRunRejected = false;

	// lifecycle
	#shutdownStarted = false;
	#archiveWriteInFlight = false;
	#lastNotifyKey: string | undefined;

	constructor(deps: CompanionDeps) {
		this.#deps = deps;
		this.#cli = new HunkCli(deps.exec, deps.hunkPath);
		this.#herdr = new HerdrCli(deps.exec, deps.env.HERDR_BIN_PATH ?? "herdr");
		this.#eligible = eligibleEnv(deps.env);
	}

	get role(): ControllerRole {
		return this.#role;
	}

	get childState(): ChildState {
		return this.#child;
	}

	get eligible(): boolean {
		return this.#eligible;
	}

	get isReady(): boolean {
		return (
			this.#role === "primary" &&
			!this.#shutdownStarted &&
			this.#gitReady &&
			this.#child === "ready" &&
			this.#binding !== undefined &&
			this.#cleanForSessionId === this.#binding.hunkSessionId &&
			// A pending pinned scope or a moved-on parent means the live review
			// does not yet match what this controller would report as ready.
			this.#pendingScopeReload === undefined &&
			this.#applied !== undefined &&
			this.#desired !== undefined &&
			// Revision correspondence, not just the session id: a same-id cwd
			// observation must gate readiness until the applied context catches up.
			this.#applied.parent.revision === this.#desired.revision
		);
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
			throw new CompanionUnavailable("Herdr integration requires omp running inside a herdr workspace.");
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
				throw new CompanionUnavailable(SHUTDOWN_MESSAGE);
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


	/**
	 * Decide this process's role from the host primary lock. The first
	 * successful lock attempt fixes the role for the process lifetime; a losing
	 * handle is released immediately, a winning handle is strongly referenced
	 * until actual process exit. Import/filesystem/native failures keep the
	 * role pending (dedup'd diagnostics) so the admission tick can retry; they
	 * never decide secondary or primary.
	 */
	admit(): Promise<ControllerRole> {
		if (this.#role !== "pending") return Promise.resolve(this.#role);
		if (this.#admitPromise) return this.#admitPromise;
		this.#admitPromise = this.#admitInner().finally(() => {
			this.#admitPromise = undefined;
		});
		return this.#admitPromise;
	}

	async #admitInner(): Promise<ControllerRole> {
		this.#requireEligible();
		if (this.#shutdownStarted) return "pending";
		const path = primaryRoleLockPath(
			this.#deps.env,
			this.#deps.env.HERDR_SOCKET_PATH ?? "",
			this.#workspaceId(),
		);
		let lock: PrimaryLock;
		try {
			lock = await this.#deps.tryPrimaryLock(path, this.#deps.logger);
		} catch (error) {
			this.#notifyOnChange(
				"admission-failed",
				`Herdr integration could not claim workspace ownership: ${error instanceof Error ? error.message : String(error)}`,
				"warning",
			);
			return "pending";
		}
		if (lock.acquired) {
			this.#lock = lock;
			this.#role = "primary";
			this.#clearNotifyKey("admission-failed");
			return "primary";
		}
		lock.release();
		this.#role = "secondary";
		return "secondary";
	}


	/**
	 * Record the complete desired parent context synchronously. A changed
	 * session id or cwd bumps the monotonic revision and immediately invalidates
	 * view tokens; no I/O or lifecycle action happens here.
	 */
	observeParent(parent: SessionContext): ParentSnapshot {
		const previous = this.#desired;
		const changed =
			previous === undefined ||
			previous.ompSessionId !== parent.ompSessionId ||
			previous.cwd !== parent.cwd;
		if (changed) {
			this.#revision += 1;
			this.#viewToken = undefined;
		}
		this.#desired = {
			ompSessionId: parent.ompSessionId,
			artifactsDir: parent.artifactsDir,
			cwd: parent.cwd,
			revision: this.#revision,
		};
		return this.#desired;
	}

	/**
	 * Observe the parent and drain the desired state through the single
	 * serialized reconciliation queue. Overlapping requests update the desired
	 * snapshot rather than dropping later input; one drain turn repeats while
	 * the desired revision moves during its awaited passes, so the newest
	 * observed parent is applied without an extra queued call.
	 */
	reconcile(parent: SessionContext): Promise<void> {
		this.observeParent(parent);
		return this.enqueue(() => this.#drain());
	}

	/**
	 * One serialized drain turn. Each pass reconciles the desired snapshot it
	 * captured; when a pass ends and the desired revision has moved on, the
	 * turn repeats with the newest snapshot so an observation made mid-drain is
	 * applied now instead of waiting for the next queued call. The turn ends
	 * when a pass sees the revision it drained (the controller caught up), when
	 * shutdown starts, or when a pass throws — a failure never re-runs the same
	 * desired revision in a spin; the ordinary tick or next reconcile retries.
	 */
	async #drain(): Promise<void> {
		while (!this.#shutdownStarted && this.#role === "primary" && this.#lock?.acquired === true) {
			const desired = this.#desired;
			if (!desired) return;
			try {
				await this.#reconcileDesired(desired);
			} catch (error) {
				this.#deps.logger.debug("reconciliation failed", { error });
				return;
			}
			if (this.#shutdownStarted || this.#desired?.revision === desired.revision) return;
		}
	}

	/**
	 * True when the desired parent moved on (or shutdown began) after `desired`
	 * was captured. Every awaited launch mutation rechecks this so an
	 * in-flight creation never runs, binds, or publishes for a superseded
	 * parent; evidence already on disk is kept for the successor.
	 */
	#launchSuperseded(desired: ParentSnapshot): boolean {
		return this.#shutdownStarted || this.#desired?.revision !== desired.revision;
	}

	/**
	 * Synchronous fail-closed fence re-checked immediately before every managed
	 * mutation (create, run, close, clear, reload, focus, comment, publish).
	 * Awaited observations can invalidate an earlier guard check; only a fence
	 * with zero awaits before the dispatch closes that window.
	 */
	#mutationBlocked(desired?: ParentSnapshot): boolean {
		return (
			this.#shutdownStarted ||
			this.#role !== "primary" ||
			this.#lock?.acquired !== true ||
			(desired !== undefined && this.#desired?.revision !== desired.revision)
		);
	}


	async #reconcileDesired(desired: ParentSnapshot): Promise<void> {
		// Before any child mutation, prove this controller still owns its native
		// pane: workspace/tab/pane identity plus its own foreground PID.
		const identity = await this.#verifyControllerIdentity();
		if (identity === "indeterminate") {
			this.#deps.logger.debug("controller identity unverifiable; skipping reconciliation");
			return;
		}
		if (identity === "changed") {
			this.#notifyOnChange(
				"controller-moved",
				"Herdr: this controller's pane identity changed; child management is paused.",
				"warning",
			);
			return;
		}
		this.#clearNotifyKey("controller-moved");

		let record: CompanionRecord | null;
		try {
			record = await readCompanionRecord(this.#recordFile());
			this.#clearNotifyKey("record-malformed");
		} catch (error) {
			// Malformed metadata is preserved and reported, never repaired or deleted.
			this.#notifyOnChange(
				"record-malformed",
				"Herdr: the companion ownership record is malformed; it was left untouched.",
				"error",
			);
			this.#deps.logger.error("companion record malformed", { path: this.#recordFile(), error });
			return;
		}

		const checkout = await resolveCheckout(this.#deps.exec, desired.cwd);
		if (!checkout.ok) {
			// Git discovery is not proof of a root change: keep an existing
			// same-parent child untouched, create nothing, retry on the tick.
			this.#gitReady = false;
			await this.#reconcileIndeterminateGit(desired, record);
			return;
		}
		this.#gitReady = true;
		this.#repoRoot = checkout.repoRoot;

		if (!this.#everApplied()) {
			if (record) {
				// First reconciliation after winning primary ownership: replace the
				// previous recorded child (soft shutdown or crash). Never adopt its
				// live review into this parent.
				const outcome = await this.#retireRecordedChild(record, desired);
				if (outcome !== "retired") return;
			}
			await this.#launchForContext(desired, checkout);
			return;
		}

		if (this.#applied !== undefined && this.#applied.parent.ompSessionId !== desired.ompSessionId) {
			// Committed parent transition (/new, resume of another session, branch):
			// archive the old bound view, retire it, launch at the new session's HEAD.
			await this.snapshotNow({ deadlineMs: 1_000 });
			if (this.#child !== "unavailable" && this.#record) {
				const outcome = await this.#retireRecordedChild(this.#record, desired);
				if (outcome !== "retired") return;
			}
			await this.#launchForContext(desired, checkout);
			return;
		}

		if (this.#applied !== undefined && this.#applied.root !== checkout.repoRoot) {
			// Verified canonical checkout change: archive, retire, fresh diff.
			await this.snapshotNow({ deadlineMs: 1_000 });
			if (this.#child !== "unavailable" && this.#record) {
				const outcome = await this.#retireRecordedChild(this.#record, desired);
				if (outcome !== "retired") return;
			}
			await this.#launchForContext(desired, checkout);
			return;
		}

		// Same parent id and canonical checkout.
		if (this.#child === "unavailable") {
			if (record) {
				// A still-recorded child that replacement could not prove earlier:
				// retry the same reconciliation path until its fate is decided.
				const outcome = await this.#retireRecordedChild(record, desired);
				if (outcome !== "retired") return;
			}
			// Child-only replacement: keep the pinned baseline and selected scope.
			await this.#launchForContext(desired, checkout);
			return;
		}
		if (this.#child === "starting") {
			// A launch captured for another parent id or checkout must not be
			// bound to the desired one: retire the provisional child and derive
			// fresh from the current desired state.
			if (
				record !== null &&
				(this.#launchParent?.ompSessionId !== desired.ompSessionId || record.repoRoot !== checkout.repoRoot)
			) {
				const outcome = await this.#retireRecordedChild(record, desired);
				if (outcome !== "retired") return;
				await this.#launchForContext(desired, checkout);
				return;
			}
			await this.#advanceStartingChild(desired, checkout, record);
			return;
		}
		await this.#healthDrain(desired, checkout);
	}

	#everApplied(): boolean {
		return this.#pinnedFor !== undefined || this.#applied !== undefined || this.#child !== "unavailable";
	}

	/**
	 * Git discovery could not resolve a committed checkout. A committed
	 * parent-ID transition still retires the old parent's child independently
	 * of Git discovery; an applied same-parent child stays untouched for the
	 * ordinary tick. A fresh primary always replaces a retained record —
	 * parent identity never authorizes adoption — while creation itself stays
	 * deferred until Git resolves. Nothing is ever created here.
	 */
	async #reconcileIndeterminateGit(desired: ParentSnapshot, record: CompanionRecord | null): Promise<void> {
		if (this.#applied !== undefined) {
			if (this.#applied.parent.ompSessionId !== desired.ompSessionId && this.#child !== "unavailable" && this.#record) {
				await this.snapshotNow({ deadlineMs: 1_000 });
				await this.#retireRecordedChild(this.#record, desired);
			}
			return;
		}
		if (record && this.#isOwnStartingChild(record, desired)) {
			// This process's own same-parent provisional child: indeterminate Git
			// discovery is not proof of a root change, so the child stays for the
			// ordinary tick instead of being retired by a transient failure.
			return;
		}
		if (record) {
			await this.#retireRecordedChild(record, desired);
		}
	}

	/** Whether `record` is this process's in-flight child for the desired parent. */
	#isOwnStartingChild(record: CompanionRecord, desired: ParentSnapshot): boolean {
		return (
			this.#child === "starting" &&
			this.#record !== undefined &&
			this.#record.paneId === record.paneId &&
			this.#launchParent?.ompSessionId === desired.ompSessionId
		);
	}

	/**
	 * Fresh child for the desired parent/checkout. Baseline and scope are
	 * captured once per new parent id or verified root and pinned across
	 * child-only replacements, even if HEAD advanced meanwhile.
	 */
	async #launchForContext(desired: ParentSnapshot, checkout: { ok: true; repoRoot: string; headSha: string }): Promise<void> {
		const sameContext =
			this.#pinnedFor !== undefined &&
			this.#pinnedFor.ompSessionId === desired.ompSessionId &&
			this.#pinnedFor.root === checkout.repoRoot;
		if (!sameContext) {
			this.#baselineHead = checkout.headSha;
			this.#scope = { kind: "session", baseSha: checkout.headSha };
			// Stage the pinned-context key together with the values it describes:
			// a launch superseded before binding must never leave a newer baseline
			// paired with the previous parent's key.
			this.#pinnedFor = { ompSessionId: desired.ompSessionId, root: checkout.repoRoot };
		}
		await this.#createChild(desired, checkout.repoRoot);
	}

	/**
	 * The controller's own native reservation: env pane must exist in the env
	 * workspace (and env tab, when known), with this controller PID in its
	 * foreground. A mismatch stops all mutation rather than moving or deleting
	 * other tabs; only a verified identity may proceed.
	 */
	async #verifyControllerIdentity(): Promise<"ok" | "indeterminate" | "changed"> {
		const paneId = this.#agentPaneId();
		const workspaceId = this.#workspaceId();
		if (paneId.length === 0 || workspaceId.length === 0) return "changed";
		let pane: HerdrPane | null;
		try {
			pane = await this.#herdr.paneState(paneId);
		} catch {
			return "indeterminate";
		}
		if (pane === null) return "changed";
		if (pane.workspaceId !== workspaceId) return "changed";
		const expectedTab = this.#deps.env.HERDR_TAB_ID;
		if (expectedTab !== undefined && expectedTab.length > 0 && pane.tabId !== expectedTab) {
			return "changed";
		}
		let info: PaneProcessInfo;
		try {
			info = await this.#herdr.paneProcessInfo(paneId);
		} catch {
			return "indeterminate";
		}
		if (!info.foregroundPids.includes(this.#deps.controllerPid)) return "changed";
		return "ok";
	}


	/**
	 * Create the child tab behind a durable launch intent. The sidecar is
	 * `wx`-acquired, written, and synced before `tab create`; the identity-only
	 * record is persisted immediately after the create reply; the shell-qualified
	 * provisional record is persisted before the intent is removed and `pane run`
	 * is dispatched. A lost reply or crash therefore leaves evidence a successor
	 * can prove or report — never a silent duplicate.
	 */
	async #createChild(desired: ParentSnapshot, root: string): Promise<void> {
		this.#launchRunRejected = false;
		const recordPath = this.#recordFile();
		const sidecarPath = `${recordPath}.launch.json`;
		let before: Set<string>;
		try {
			before = new Set((await this.#cli.sessionList()).map(entry => entry.sessionId));
		} catch (error) {
			this.#deps.logger.debug("pre-launch registry snapshot failed", { error });
			this.#notifyOnChange(
				"launch-registry",
				"Herdr: could not read the Hunk registry before launch; creation is deferred.",
				"warning",
			);
			return;
		}
		this.#clearNotifyKey("launch-registry");
		this.#launchBeforeSessions = before;

		const nonce = crypto.randomUUID();
		let handle: nodeFs.FileHandle;
		try {
			// The `wx` intent must never fail for a missing directory: launch
			// evidence is durable even if earlier writes never ran in this state
			// root. Exclusive creation: never replace an existing intent blindly.
			await nodeFs.mkdir(nodePath.dirname(sidecarPath), { recursive: true, mode: 0o700 });
			handle = await nodeFs.open(sidecarPath, "wx", 0o600);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") {
				this.#notifyOnChange(
					"stale-launch-intent",
					`Hunk creation outcome is unknown; inspect the workspace before clearing ${sidecarPath}.`,
					"error",
				);
				return;
			}
			this.#deps.logger.warn("launch sidecar creation failed", { error });
			this.#notifyOnChange(
				"launch-intent",
				"Herdr: could not record the launch intent; no child was created.",
				"warning",
			);
			return;
		}
		try {
			const intent = {
				version: 1,
				socketPath: this.#deps.env.HERDR_SOCKET_PATH ?? "",
				workspaceId: this.#workspaceId(),
				ownerPaneId: this.#agentPaneId(),
				controllerPid: this.#deps.controllerPid,
				nonce,
			};
			await handle.writeFile(`${JSON.stringify(intent, null, "\t")}\n`);
			await handle.sync();
		} catch (error) {
			await nodeFs.rm(sidecarPath, { force: true }).catch(() => {});
			this.#deps.logger.warn("launch sidecar write failed", { error });
			this.#notifyOnChange(
				"launch-intent",
				"Herdr: could not record the launch intent; no child was created.",
				"warning",
			);
			return;
		} finally {
			await handle.close();
		}
		this.#launchIntent = { sidecarPath, nonce, paneId: "" };

		// Recheck admission and the desired parent after acquiring the intent; a
		// superseded operation cancels its own intent because no tab exists yet.
		if (this.#mutationBlocked(desired)) {
			await this.#removeOwnIntent();
			return;
		}
		let competing: CompanionRecord | null;
		try {
			competing = await readCompanionRecord(recordPath);
		} catch (error) {
			// An unreadable binding is treated as competing: never create on top of it.
			this.#deps.logger.debug("binding reread after intent failed", { error });
			competing = {} as CompanionRecord;
		}
		if (competing !== null) {
			await this.#removeOwnIntent();
			return;
		}

		// Reprove the controller's native reservation after the registry/record
		// awaits: creation on a moved pane or stale parent is forbidden. No tab
		// exists yet, so this operation's own intent stays removable.
		if (this.#mutationBlocked(desired)) {
			await this.#removeOwnIntent();
			return;
		}
		if ((await this.#verifyControllerIdentity()) !== "ok") {
			await this.#removeOwnIntent();
			this.#notifyOnChange(
				"controller-moved",
				"Herdr: this controller's pane identity changed; child management is paused.",
				"warning",
			);
			return;
		}
		if (this.#mutationBlocked(desired)) {
			await this.#removeOwnIntent();
			return;
		}

		let created: { tabId: string; paneId: string };
		try {
			created = await this.#herdr.tabCreate(this.#workspaceId(), root, this.#tabCreateEnvArgs());
		} catch (error) {
			if (error instanceof HerdrAbsentError || error instanceof HerdrRejectedError) {
				// The daemon answered with a structured rejection proving no tab
				// was created: this operation's own intent is removable.
				this.#deps.logger.warn("tab create rejected", { error });
				await this.#removeOwnIntent();
				this.#notifyOnChange("tab-create", "Herdr: companion tab creation failed; creation is deferred.", "warning");
				return;
			}
			// The create was submitted, so a timeout, malformed JSON, or missing
			// returned IDs all leave the outcome unprovable — a child may exist.
			// The intent is retained for successor recovery; only the
			// pre-submission fences above may cancel it.
			this.#deps.logger.warn("tab create failed", { error });
			this.#notifyOnChange(
				"tab-create",
				`Hunk creation outcome is unknown; inspect the workspace before clearing ${sidecarPath}.`,
				"error",
			);
			return;
		}
		this.#launchIntent = { sidecarPath, nonce, paneId: created.paneId };

		// Identity-only record stands immediately; it is insufficient for
		// automatic teardown until shell proof lands. The record stays at the
		// approved v1 shape; the launching parent lives only in process memory.
		this.#record = {
			version: 1,
			socketPath: this.#deps.env.HERDR_SOCKET_PATH ?? "",
			workspaceId: this.#workspaceId(),
			ownerPaneId: this.#agentPaneId(),
			tabId: created.tabId,
			paneId: created.paneId,
			repoRoot: root,
		};
		this.#launchParent = { ompSessionId: desired.ompSessionId };
		try {
			await this.#persistRecord();
		} catch (error) {
			// A tab may exist with no durable identity: stop here and report the
			// unknown outcome instead of risking a duplicate on the next tick.
			this.#deps.logger.error("identity record persist failed after tab create", { error });
			this.#notifyOnChange(
				"stale-launch-intent",
				`Hunk creation outcome is unknown; inspect the workspace before clearing ${sidecarPath}.`,
				"error",
			);
			return;
		}
		this.#child = "starting";
		await this.#continueLaunch(desired, created.paneId, root, before);
	}

	/**
	 * Complete a started launch: capture the original idle shell, persist the
	 * shell-qualified provisional record, remove this operation's matching-nonce
	 * intent, then dispatch `pane run` exactly once and bind by handshake. A
	 * structured pre-submission rejection is tracked so the ordinary drain can
	 * verify-retire and recreate the failed provisional; a run timeout or any
	 * unknown outcome keeps verifying the known provisional child — it never
	 * re-submits.
	 */
	async #continueLaunch(
		desired: ParentSnapshot,
		paneId: string,
		root: string,
		before: Set<string>,
	): Promise<void> {
		if (this.#launchInFlight) return;
		this.#launchInFlight = true;
		try {
			const info = await this.#waitForShell(paneId, SHELL_WAIT_TIMEOUT_MS, desired);
			if (info === null || info.shellPid === undefined) {
				if (this.#launchSuperseded(desired)) return; // evidence retained for the successor
				// Preserve the record and the sidecar: shell proof is missing.
				this.#notifyOnChange(
					"shell-timeout",
					"Herdr: companion tab shell did not become ready in time.",
					"warning",
				);
				return;
			}
			if (this.#record && this.#record.paneId === paneId) {
				this.#record = { ...this.#record, shellPid: info.shellPid };
				this.#recordDirty = true;
				try {
					await this.#persistRecord();
					this.#recordDirty = false;
				} catch (error) {
					// Shell proof was captured but not durably recorded: retain the
					// intent and report the unknown outcome; never dispatch pane run.
					this.#deps.logger.error("shell-qualified record persist failed", { error });
					this.#notifyOnChange(
						"stale-launch-intent",
						`Hunk creation outcome is unknown; inspect the workspace before clearing ${this.#recordFile()}.launch.json.`,
						"error",
					);
					return;
				}
			}
			await this.#removeOwnIntent();
			// The creation identity is durable; a parent that changed while the
			// shell proof was captured must not receive this pane's launch.
			if (this.#mutationBlocked(desired)) return;

			const baseline = this.#baselineHead;
			if (baseline === undefined) {
				this.#deps.logger.error("launch aborted: no pinned baseline");
				return;
			}
			const command = `cd -- ${shellQuote(root)} && ${shellQuote(this.#deps.hunkPath)} diff ${shellQuote(baseline)} --watch --agent-notes`;
			// Reprove the controller's native reservation after the shell-wait and
			// record awaits; the dispatch follows with no intervening await.
			if ((await this.#verifyControllerIdentity()) !== "ok") {
				this.#notifyOnChange(
					"controller-moved",
					"Herdr: this controller's pane identity changed; child management is paused.",
					"warning",
				);
				return;
			}
			if (this.#mutationBlocked(desired)) return;
			try {
				await this.#herdr.run(["pane", "run", paneId, command], "pane run");
			} catch (error) {
				if (error instanceof HerdrAbsentError || error instanceof HerdrRejectedError) {
					// Structured proof the daemon rejected the command before
					// submitting it (pane gone, or the CLI never reached the
					// socket): no foreground job can follow. The shell-qualified
					// provisional stays recorded; the ordinary drain verifies it
					// and recreates the child instead of resubmitting blindly.
					this.#launchRunRejected = true;
					this.#deps.logger.warn("pane run dispatch rejected", { error });
					return;
				}
				// Timeout, dropped connection, malformed envelope: the command
				// may or may not have been submitted. Never resubmit — verify
				// the known provisional child through the handshake below.
				this.#deps.logger.warn("pane run outcome unknown; verifying the provisional child", { error });
			}
			this.#launchBeforeSessions = before;
			const handshake = await this.#handshake(paneId, root, before, info.shellPid, LAUNCH_TIMEOUT_MS, desired);
			if (this.#launchSuperseded(desired)) return;
			if (handshake.status === "ambiguous") {
				this.#notifyOnChange(
					"handshake-ambiguous",
					"Herdr: multiple review sessions appeared in the companion pane; it was left untouched and stays unavailable.",
					"error",
				);
				return;
			}
			if (handshake.status === "timeout") {
				this.#notifyOnChange(
					"launch-timeout",
					"Herdr: review not ready yet (timed out); it may still be loading.",
					"warning",
				);
				return;
			}
			if (this.#record && this.#record.paneId === paneId) {
				this.#record = {
					...this.#record,
					hunkSessionId: handshake.hunkSessionId,
					hunkPid: handshake.hunkPid,
				};
				this.#recordDirty = true;
				try {
					await this.#persistRecord();
					this.#recordDirty = false;
				} catch (error) {
					// The bound identity never became durable: readiness waits for the
					// ordinary tick to persist it, so neither this process nor a
					// successor ever closes against disk evidence weaker than the
					// identity this binding proved.
					this.#deps.logger.warn("bound-identity record persist failed", { error });
					return;
				}
			}
			// The proven identity is durable; a superseded parent never runs the
			// clean gate, scope reload, or archive for this binding.
			if (this.#launchSuperseded(desired)) return;
			await this.#finishBind(handshake, desired, root);
		} finally {
			this.#launchInFlight = false;
		}
	}

	/** A starting child on later drains: finish shell proof, or verify a late registration. */
	async #advanceStartingChild(
		desired: ParentSnapshot,
		checkout: { ok: true; repoRoot: string; headSha: string },
		record: CompanionRecord | null,
	): Promise<void> {
		if (!record || !this.#record || this.#record.paneId !== record.paneId) {
			// The record vanished under a starting child: decide its fate next drain.
			this.#child = "unavailable";
			return;
		}
		if (record.shellPid === undefined) {
			// Shell proof is still missing. Only this process's retained intent may
			// finish the launch; nothing is submitted again blindly.
			const intent = this.#launchIntent;
			if (!intent || intent.paneId !== record.paneId) {
				this.#notifyOnChange(
					"stale-launch-intent",
					`Hunk creation outcome is unknown; inspect the workspace before clearing ${intent?.sidecarPath ?? `${this.#recordFile()}.launch.json`}.`,
					"error",
				);
				return;
			}
			await this.#continueLaunch(desired, record.paneId, record.repoRoot, this.#launchBeforeSessions ?? new Set<string>());
			return;
		}
		const pane = await this.#paneState(record.paneId);
		if (pane === "indeterminate") return;
		const info = pane === "absent" ? "absent" : await this.#paneInfo(record.paneId);
		if (info === "indeterminate") return;
		if (pane === "absent" || info === "absent" || (pane.tabId !== undefined && pane.tabId !== record.tabId)) {
			// The provisional child's pane is proven gone: replace it.
			const outcome = await this.#retireRecordedChild(record, desired);
			if (outcome !== "retired") return;
			await this.#launchForContext(desired, checkout);
			return;
		}
		if (info.shellPid !== record.shellPid) {
			this.#notifyOnChange(
				"late-bind-shell-changed",
				"Herdr: the companion pane's shell changed during startup; refusing to bind.",
				"warning",
			);
			return;
		}
		if (isIdleShell(info, record.shellPid)) {
			if (this.#launchRunRejected !== true) return; // a dispatched run may still surface; stay starting
			// The dispatch was structurally rejected before submission, so the
			// idle shell can never gain a foreground job from that command.
			// Verify the occupant before any destructive recovery; if a live
			// Hunk appeared anyway, the late-bind path below decides it.
			const proof = await this.#proveChildIdentity(record, info);
			if (!proof.proven) return; // changed or unverified occupant: decide on a later tick
			if (proof.recovered === undefined) {
				const outcome = await this.#retireRecordedChild(record, desired);
				if (outcome !== "retired") return;
				await this.#launchForContext(desired, checkout);
				return;
			}
			// Nothing was submitted, so a live Hunk here is not this launch's
			// child and the launch snapshot was never taken: it can never be
			// proven. Stay starting and report instead of binding or touching it.
			this.#notifyOnChange(
				"rejected-run-foreign",
				"Herdr: a review session appeared in the companion pane after a rejected launch; it was left untouched.",
				"warning",
			);
		}
		if (!this.#launchBeforeSessions) return; // no launch snapshot: nothing provable to bind
		const handshake = await this.#handshake(
			record.paneId,
			record.repoRoot,
			this.#launchBeforeSessions,
			record.shellPid,
			2_000,
			desired,
		);
		if (handshake.status === "ambiguous") {
			this.#notifyOnChange(
				"late-bind-ambiguous",
				"Herdr: multiple new review sessions appeared in the companion pane; refusing to bind.",
				"error",
			);
			return;
		}
		if (handshake.status !== "bound") return; // registration may still lag; stay starting
		if (this.#launchSuperseded(desired)) return; // identity proof stays on disk for the successor
		const updated: CompanionRecord = {
			...record,
			hunkSessionId: handshake.hunkSessionId,
			hunkPid: handshake.hunkPid,
		};
		this.#record = updated;
		this.#recordDirty = true;
		try {
			await this.#persistRecord();
			this.#recordDirty = false;
		} catch (error) {
			// Stay starting: readiness and retirement require the durable identity,
			// and the ordinary tick retries this persist.
			this.#deps.logger.warn("late-bind record persist failed", { error });
			return;
		}
		await this.#finishBind(handshake, desired, checkout.repoRoot);
	}

	/**
	 * A ready child on the same parent/root: verify pane and Hunk liveness,
	 * replace proven-gone children automatically, retry the clean-note gate and
	 * any pending pinned-scope reload — always through this same path.
	 */
	async #healthDrain(
		desired: ParentSnapshot,
		checkout: { ok: true; repoRoot: string; headSha: string },
	): Promise<void> {
		const record = this.#record;
		const binding = this.#binding;
		if (!record || !binding) {
			this.#child = "unavailable";
			return;
		}
		const pane = await this.#paneState(record.paneId);
		if (pane === "indeterminate") return; // transient herdr failure: decide on a later tick
		const info = pane === "absent" ? "absent" : await this.#paneInfo(record.paneId);
		if (info === "indeterminate") return;
		if (
			pane === "absent" ||
			info === "absent" ||
			(pane.tabId !== undefined && pane.tabId !== record.tabId) ||
			(pane.workspaceId !== undefined && pane.workspaceId !== this.#workspaceId())
		) {
			// Proven pane loss (or identity break): recreate through retirement.
			const outcome = await this.#retireRecordedChild(record, desired);
			if (outcome !== "retired") return;
			await this.#launchForContext(desired, checkout);
			return;
		}
		let sessions: RegisteredSession[];
		try {
			sessions = await this.#cli.sessionList();
		} catch {
			return; // Hunk-daemon hiccups are not herdr absence: keep the binding and retry later
		}
		const registered = sessions.find(entry => entry.sessionId === binding.hunkSessionId);
		const registryKnows = registered !== undefined && registered.pid === binding.hunkPid;
		if (info.foregroundPids.includes(binding.hunkPid ?? -1)) {
			if (!registryKnows) {
				// Foreground PID present but the daemon lost the registration: PID
				// reuse or registry lag — never act on an unproven occupant.
				this.#notifyOnChange(
					"foreground-unregistered",
					"Herdr: the companion pane holds an unrecognized foreground process; it was left untouched.",
					"warning",
				);
				return;
			}
		} else if (registryKnows) {
			// A registration can linger after the process died: proven PID death
			// routes to the ordinary replacement instead of the background report.
			if (this.#deps.isProcessAlive(binding.hunkPid ?? -1) === false) {
				const outcome = await this.#retireRecordedChild(record, desired);
				if (outcome !== "retired") return;
				await this.#launchForContext(desired, checkout);
				return;
			}
			// Alive by registry but not foreground: never terminate; report once.
			this.#notifyOnChange(
				"registered-background",
				"Herdr: the review is registered but the companion pane's foreground changed; it was left untouched.",
				"warning",
			);
			return;
		} else {
			// Foreground and registry both lack the bound PID: corroborate death
			// before replacing; a live probe vetoes destructive recovery.
			if (this.#deps.isProcessAlive(binding.hunkPid ?? -1) === true) return;
			const outcome = await this.#retireRecordedChild(record, desired);
			if (outcome !== "retired") return;
			await this.#launchForContext(desired, checkout);
			return;
		}

		// Same parent id and canonical checkout, now verified live: refresh the
		// applied snapshot so a benign cwd move within the checkout updates the
		// applied revision and unblocks review without touching child or scope.
		const applied = this.#applied;
		if (applied !== undefined && applied.parent.revision !== desired.revision) {
			this.#applied = { parent: desired, root: checkout.repoRoot };
		}

		if (this.#cleanForSessionId !== binding.hunkSessionId) {
			await this.#attemptCleanGate(desired);
		}
		if (record.hunkSessionId !== binding.hunkSessionId || record.hunkPid !== binding.hunkPid) {
			// The bound identity never became durable: persist it from the applied
			// binding before anything else relies on the recorded proof.
			this.#record = { ...record, hunkSessionId: binding.hunkSessionId, hunkPid: binding.hunkPid };
			try {
				await this.#persistRecord();
			} catch (error) {
				this.#deps.logger.warn("bound-identity record persist retry failed", { error });
			}
		}
		if (this.#pendingScopeReload && this.#binding === binding) {
			// Reload is a child mutation: reprove the controller's native
			// reservation after the preceding awaits, then re-fence with no await
			// before the dispatch. A pending scope stays pending and the tick
			// retries when the proof fails.
			if (this.#mutationBlocked(desired)) return;
			if ((await this.#verifyControllerIdentity()) !== "ok") {
				this.#notifyOnChange(
					"controller-moved",
					"Herdr: this controller's pane identity changed; child management is paused.",
					"warning",
				);
				return;
			}
			if (this.#mutationBlocked(desired) || this.#binding !== binding) return;
			try {
				await this.#cli.reload(this.#binding.hunkSessionId, hunkReloadArgs(this.#pendingScopeReload), {
					timeoutMs: 5_000,
				});
				this.#pendingScopeReload = undefined;
			} catch (error) {
				this.#deps.logger.warn("pinned scope reload retry failed", { error });
			}
		}
	}


	/**
	 * ID-proven retirement of a recorded child. Every identity on the record —
	 * socket, workspace, tab, pane, shell PID, Hunk UUID/PID, canonical recorded
	 * checkout — must verify before `pane close`; a fresh pane list must prove
	 * another pane remains (herdr cascades the workspace from its last pane);
	 * structured `pane_not_found` plus disappearance of the bound registration
	 * (or proven Hunk PID death) must follow. Only then is the matching launch
	 * sidecar removed while the record is retained, and the record deleted last.
	 * A dirty bound identity is persisted before any effect, and every awaited
	 * step is re-fenced: shutdown, a superseded parent, or lost ownership keeps
	 * the metadata as the successor's absence evidence.
	 */
	async #retireRecordedChild(record: CompanionRecord, desired: ParentSnapshot): Promise<"retired" | "blocked"> {
		const workspaceId = this.#workspaceId();
		if (record.socketPath !== (this.#deps.env.HERDR_SOCKET_PATH ?? "") || record.workspaceId !== workspaceId) {
			this.#deps.logger.debug("record belongs to another socket/workspace; leaving it untouched", {
				socketPath: record.socketPath,
				workspaceId: record.workspaceId,
			});
			return "blocked";
		}

		const pane = await this.#paneState(record.paneId);
		if (pane === "indeterminate") {
			this.#notifyOnChange(
				"retire-indeterminate",
				"Herdr: could not reach herdr to verify the recorded child; it was left untouched.",
				"warning",
			);
			return "blocked";
		}
		let info: PaneProcessInfo | "absent";
		if (pane === "absent") {
			info = "absent";
		} else {
			if (pane.tabId !== undefined && pane.tabId !== record.tabId) {
				this.#notifyOnChange(
					"retire-identity",
					"Herdr: the recorded child pane moved to another tab; it was left untouched.",
					"warning",
				);
				return "blocked";
			}
			if (pane.workspaceId !== undefined && pane.workspaceId !== workspaceId) {
				this.#notifyOnChange(
					"retire-identity",
					"Herdr: the recorded child pane moved to another workspace; it was left untouched.",
					"warning",
				);
				return "blocked";
			}
			const inspected = await this.#paneInfo(record.paneId);
			if (inspected === "indeterminate") {
				this.#notifyOnChange(
					"retire-indeterminate",
					"Herdr: could not inspect the recorded child pane; it was left untouched.",
					"warning",
				);
				return "blocked";
			}
			info = inspected;
		}

		const proof = await this.#proveChildIdentity(record, info);
		if (!proof.proven) return "blocked";

		// A recovered identity is persisted before any effect so a crash between
		// close and verification leaves qualified evidence instead of an
		// unprovable provisional record; post-close checks use it in place of the
		// record's absent Hunk fields.
		let hunkIdentity: { hunkSessionId?: string; hunkPid?: number } = record;
		if (proof.recovered) {
			const qualified: CompanionRecord = { ...record, ...proof.recovered };
			hunkIdentity = qualified;
			if (this.#record?.paneId === record.paneId) this.#record = qualified;
			try {
				await writeCompanionRecord(this.#recordFile(), qualified);
				this.#recordDirty = false;
			} catch (error) {
				// Closing on a persist failure would leave the crash window with a
				// record that no longer proves what was destroyed: block so the next
				// drain retries the persist from the still-live evidence.
				this.#deps.logger.warn("qualified record persist before close failed", { error });
				this.#notifyOnChange(
					"qualified-persist",
					"Herdr: the recovered child identity could not be recorded; the pane was left untouched.",
					"warning",
				);
				return "blocked";
			}
		}

		// A bound identity still dirty in memory is made durable before any
		// effect: the crash window must never leave disk evidence weaker than
		// the identity this retirement proves against.
		if (this.#recordDirty && this.#record?.paneId === record.paneId) {
			try {
				await this.#persistRecord();
				this.#recordDirty = false;
			} catch (error) {
				this.#deps.logger.warn("bound identity persist before retirement failed", { error });
				this.#notifyOnChange(
					"qualified-persist",
					"Herdr: the bound child identity could not be recorded; the pane was left untouched.",
					"warning",
				);
				return "blocked";
			}
		}

		if (pane !== "absent") {
			let panes: HerdrPane[];
			try {
				panes = await this.#herdr.paneList(workspaceId);
			} catch {
				this.#notifyOnChange(
					"retire-indeterminate",
					"Herdr: could not list workspace panes before closing the recorded child; it was left untouched.",
					"warning",
				);
				return "blocked";
			}
			if (!panes.some(entry => entry.paneId !== record.paneId)) {
				// Closing the last pane would cascade the whole workspace: defer.
				this.#notifyOnChange(
					"last-pane",
					"Herdr: the recorded child appears to be the workspace's last pane; removal is deferred.",
					"warning",
				);
				return "blocked";
			}
			// Fence the awaited proof and pane list: shutdown, a superseded parent,
			// or lost primary ownership must still stop the close. The controller's
			// native reservation is reproved, then re-fenced with no await before
			// the dispatch.
			if (this.#mutationBlocked(desired)) return "blocked";
			if ((await this.#verifyControllerIdentity()) !== "ok") {
				this.#notifyOnChange(
					"controller-moved",
					"Herdr: this controller's pane identity changed; child management is paused.",
					"warning",
				);
				return "blocked";
			}
			if (this.#mutationBlocked(desired)) return "blocked";
			// The early proof predates the awaited persists, pane list, and
			// controller reproof. Immediately before the close dispatch,
			// re-prove the Hunk registry (or the established idle-shell exit)
			// and then re-observe the pane's tab/workspace/shell/foreground
			// strictly after that proof: a changed or unverified occupant must
			// never be closed.
			if (!(await this.#reconfirmChildProof(record, info, proof))) return "blocked";
			// Sync shutdown/supersession fence: nothing awaits between the final
			// pane observation above and this close dispatch.
			if (this.#mutationBlocked(desired)) return "blocked";
			try {
				await this.#herdr.closePane(record.paneId, RETIRE_CLOSE_TIMEOUT_MS);
			} catch (error) {
				if (!(error instanceof HerdrAbsentError)) {
					this.#notifyOnChange(
						"close-failed",
						`Herdr: closing the recorded child failed (${error instanceof Error ? error.message : String(error)}); nothing was deleted.`,
						"warning",
					);
					return "blocked";
				}
				// pane_not_found: the pane vanished while proving; absence is checked below.
			}
		}

		if (!(await this.#verifyRetirement(record, hunkIdentity))) {
			// Indeterminate checks preserve metadata; the next tick retries from the
			// still-valid absence evidence.
			this.#notifyOnChange(
				"retire-indeterminate",
				"Herdr: the recorded child's removal could not be verified; ownership metadata was kept.",
				"warning",
			);
			return "blocked";
		}

		// The verification awaited: shutdown, a superseded parent, or lost
		// ownership stops before any evidence deletion. The retained record and
		// sidecar are the still-valid absence evidence the next drain or a
		// successor primary retries from.
		if (this.#mutationBlocked(desired)) {
			this.#deps.logger.debug("retirement verified after shutdown or supersession; ownership metadata retained");
			return "blocked";
		}

		const sidecar = await this.#removeMatchingSidecar(record, desired);
		if (sidecar !== "removed") {
			if (sidecar === "retained") {
				this.#notifyOnChange(
					"sidecar-retain",
					"Herdr: the launch sidecar could not be removed; the ownership record was kept with it.",
					"warning",
				);
			}
			return "blocked";
		}

		// The sidecar cleanup awaited: re-fence so shutdown or a superseded
		// parent never deletes the ownership record itself.
		if (this.#mutationBlocked(desired)) {
			this.#deps.logger.debug("shutdown or supersession after sidecar cleanup; ownership record retained");
			return "blocked";
		}
		try {
			await nodeFs.rm(this.#recordFile());
		} catch (error) {
			if (!isEnoent(error)) {
				this.#notifyOnChange(
					"record-retain",
					"Herdr: the ownership record could not be deleted; replacement is deferred and will retry.",
					"warning",
				);
				return "blocked";
			}
		}

		this.#record = undefined;
		this.#recordDirty = false;
		this.#binding = undefined;
		this.#bindingEpoch += 1;
		this.#viewToken = undefined;
		this.#child = "unavailable";
		this.#applied = undefined;
		this.#launchBeforeSessions = undefined;
		this.#launchParent = undefined;
		return "retired";
	}

	/**
	 * Fresh re-proof of the recorded child immediately before its close
	 * dispatch. The early proof can go stale across the awaited record
	 * persists, pane list, and controller reproof; if Hunk exits during those
	 * awaits and another program takes the original shell, closing on the
	 * early proof would destroy the unrelated occupant.
	 *
	 * The awaited Hunk registry/canonical-root proof runs first, against the
	 * early pane observation; the pane's tab/workspace/shell/foreground are
	 * then observed once more, strictly after that proof settles, and
	 * compared synchronously against what the qualified proof rests on. A
	 * substitution parked inside any earlier await — including the registry
	 * read itself — is therefore still visible to the final comparison, and
	 * no awaited proof runs after the last native observation that could go
	 * stale behind it. Anything changed or unverifiable keeps the pane.
	 */
	async #reconfirmChildProof(
		record: CompanionRecord,
		earlyInfo: PaneProcessInfo | "absent",
		early: QualifiedChildProof,
	): Promise<boolean> {
		const qualified = await this.#proveChildIdentity(record, earlyInfo);
		if (!qualified.proven) return false;
		// A registry-side occupant swap between the early and pre-close proofs
		// (different recovered identities) is a changed occupant, even though
		// each proof holds on its own.
		const occupantChanged =
			early.recovered !== undefined
				? qualified.recovered !== undefined &&
					(qualified.recovered.hunkSessionId !== early.recovered.hunkSessionId ||
						qualified.recovered.hunkPid !== early.recovered.hunkPid)
				: qualified.recovered !== undefined;
		if (occupantChanged) {
			this.#notifyOnChange(
				"retire-identity",
				"Herdr: the recorded child pane's occupant changed while it was being verified; it was left untouched.",
				"warning",
			);
			return false;
		}

		// Last native observation: every await below precedes the synchronous
		// close-time comparison, and nothing is awaited again before the
		// caller's shutdown fence and close dispatch.
		const pane = await this.#paneState(record.paneId);
		if (pane === "indeterminate") {
			this.#notifyOnChange(
				"retire-indeterminate",
				"Herdr: could not reach herdr to re-verify the recorded child; it was left untouched.",
				"warning",
			);
			return false;
		}
		if (pane === "absent") return true; // nothing left to protect; absence handling continues below
		const info = await this.#paneInfo(record.paneId);
		if (info === "indeterminate") {
			this.#notifyOnChange(
				"retire-indeterminate",
				"Herdr: could not inspect the recorded child pane before closing; it was left untouched.",
				"warning",
			);
			return false;
		}
		if (info === "absent") return true; // herdr no longer reports the pane's process; absence handling continues below
		if (pane.tabId !== undefined && pane.tabId !== record.tabId) {
			this.#notifyOnChange(
				"retire-identity",
				"Herdr: the recorded child pane moved to another tab before closing; it was left untouched.",
				"warning",
			);
			return false;
		}
		if (pane.workspaceId !== undefined && pane.workspaceId !== this.#workspaceId()) {
			this.#notifyOnChange(
				"retire-identity",
				"Herdr: the recorded child pane moved to another workspace before closing; it was left untouched.",
				"warning",
			);
			return false;
		}
		// The qualified proof required the recorded original shell; a replaced
		// shell means this pane is no longer the one the proof qualified.
		if (info.shellPid !== record.shellPid) {
			this.#notifyOnChange(
				"retire-identity",
				"Herdr: the recorded child pane's original shell was replaced before closing; it was left untouched.",
				"warning",
			);
			return false;
		}
		if (qualified.foregroundPid !== undefined) {
			if (!info.foregroundPids.includes(qualified.foregroundPid)) {
				this.#notifyOnChange(
					"retire-identity",
					"Herdr: the recorded child pane's verified review no longer holds the foreground; it was left untouched.",
					"warning",
				);
				return false;
			}
		} else if (!isIdleShell(info, record.shellPid)) {
			// The proof rested on the established idle-shell exit; a new
			// foreground occupant appeared since, so the pane stays.
			this.#notifyOnChange(
				"retire-identity",
				"Herdr: the recorded child pane's foreground changed before closing; it was left untouched.",
				"warning",
			);
			return false;
		}
		return true;
	}

	/**
	 * Decide whether the recorded child is provably ours to retire: a live
	 * verified Hunk (registry UUID/PID in the pane foreground at the canonical
	 * recorded checkout), a recovered unique identity for a shell-qualified
	 * provisional record, or the original idle shell after a proven Hunk exit.
	 * Ambiguity and foreign occupiers stay unavailable.
	 */
	async #proveChildIdentity(
		record: CompanionRecord,
		info: PaneProcessInfo | "absent",
	): Promise<ChildProof> {
		if (record.hunkSessionId !== undefined && record.hunkPid !== undefined) {
			let sessions: RegisteredSession[];
			try {
				sessions = await this.#cli.sessionList();
			} catch {
				this.#notifyOnChange(
					"retire-indeterminate",
					"Herdr: could not read the Hunk registry to verify the recorded child; it was left untouched.",
					"warning",
				);
				return { proven: false };
			}
			const registered = sessions.find(entry => entry.sessionId === record.hunkSessionId);
			const pidMatches = registered !== undefined && registered.pid === record.hunkPid;
			const known =
				registered !== undefined &&
				registered.pid === record.hunkPid &&
				(await canonicalPath(registered.repoRoot ?? registered.cwd)) === record.repoRoot;
			if (info === "absent") {
				// Pane proven gone. A registration can linger while the kernel reaps
				// the process: proven PID death outranks the stale entry (the
				// post-close verifier applies the same rule); a live or unknown PID
				// with a matching registration stays fail-closed.
				if (this.#deps.isProcessAlive(record.hunkPid) === false) {
					return { proven: true };
				}
				if (registered !== undefined) {
					// A registration still names this UUID — live at a foreign root,
					// under a reused PID, or unverifiable. Conflicting or unknown
					// registration evidence is not an established exit.
					this.#notifyOnChange(
						"retire-unproven",
						"Herdr: the recorded child pane is gone but its review session is still registered; nothing was removed.",
						"warning",
					);
					return { proven: false };
				}
				if (this.#deps.isProcessAlive(record.hunkPid) === true) {
					this.#notifyOnChange(
						"retire-unproven",
						"Herdr: the recorded child pane is gone but its review process may still run; nothing was removed.",
						"warning",
					);
					return { proven: false };
				}
				return { proven: true };
			}
			// Both live-pane proofs require the pane's current shell to be the
			// recorded original: a replaced or unknown shell means this pane is
			// not the one this record was qualified against.
			if (record.shellPid === undefined || info.shellPid !== record.shellPid) {
				this.#notifyOnChange(
					"retire-identity",
					"Herdr: the recorded child pane's original shell was replaced; it was left untouched.",
					"warning",
				);
				return { proven: false };
			}
			if (!known) {
				const idle = isIdleShell(info, record.shellPid);
				const alive = this.#deps.isProcessAlive(record.hunkPid);
				if (idle && alive === false && (registered === undefined || pidMatches)) {
					// Established exit: the recorded PID is proven dead and no
					// registration contradicts it (registry lag under the same PID
					// is tolerated). Only then may the original idle shell be retired.
					return { proven: true };
				}
				if (idle && registered !== undefined) {
					// A live or unverified registration still names this UUID —
					// e.g. it moved to a foreign canonical root. That is a
					// conflicting live registration, not proof that the recorded
					// Hunk exited: fail closed.
					this.#notifyOnChange(
						"retire-unproven",
						"Herdr: a review session is still registered for the recorded child; it was left untouched.",
						"warning",
					);
					return { proven: false };
				}
				if (idle) {
					// No registration, but the recorded PID is live or unverifiable:
					// its exit is unestablished, so the idle shell may not be retired.
					this.#notifyOnChange(
						"retire-unproven",
						"Herdr: the recorded review session is no longer registered but its process state is unverified; it was left untouched.",
						"warning",
					);
					return { proven: false };
				}
				this.#notifyOnChange(
					"retire-unproven",
					"Herdr: the recorded review session is no longer registered and the pane is not an idle shell; it was left untouched.",
					"warning",
				);
				return { proven: false };
			}
			if (!info.foregroundPids.includes(record.hunkPid)) {
				// The registration may merely lag a proven-dead process; then only
				// the original idle shell may remain in the pane. A live or unknown
				// PID outside the foreground stays fail-closed.
				if (this.#deps.isProcessAlive(record.hunkPid) === false) {
					if (isIdleShell(info, record.shellPid)) return { proven: true };
					this.#notifyOnChange(
						"retire-unproven",
						"Herdr: the recorded review process is gone but the pane is busy with another process; it was left untouched.",
						"warning",
					);
					return { proven: false };
				}
				this.#notifyOnChange(
					"retire-unproven",
					"Herdr: the recorded review is registered but not in the pane foreground; it was left untouched.",
					"warning",
				);
				return { proven: false };
			}
			return { proven: true, foregroundPid: record.hunkPid };
		}
		if (record.shellPid !== undefined) {
			// Shell-qualified provisional record: recover a unique live identity
			// through the shell/PID/registry handshake, or require the idle shell.
			if (info === "absent") return { proven: true };
			if (info.shellPid !== record.shellPid) {
				this.#notifyOnChange(
					"retire-identity",
					"Herdr: the recorded child pane's shell was replaced; it was left untouched.",
					"warning",
				);
				return { proven: false };
			}
			let sessions: RegisteredSession[];
			try {
				sessions = await this.#cli.sessionList();
			} catch {
				this.#notifyOnChange(
					"retire-indeterminate",
					"Herdr: could not read the Hunk registry to verify the recorded child; it was left untouched.",
					"warning",
				);
				return { proven: false };
			}
			const candidates: RegisteredSession[] = [];
			for (const entry of sessions) {
				if (!info.foregroundPids.includes(entry.pid)) continue;
				if ((await canonicalPath(entry.repoRoot ?? entry.cwd)) !== record.repoRoot) continue;
				candidates.push(entry);
			}
			if (candidates.length > 1) {
				this.#notifyOnChange(
					"retire-unproven",
					"Herdr: multiple review sessions match the recorded child pane; it was left untouched.",
					"error",
				);
				return { proven: false };
			}
			if (candidates.length === 1) {
				// Carry the recovered UUID/PID so post-close verification proves this
				// process's disappearance, not just the pane's; the close-time
				// comparison requires this PID to still hold the foreground.
				return {
					proven: true,
					recovered: { hunkSessionId: candidates[0].sessionId, hunkPid: candidates[0].pid },
					foregroundPid: candidates[0].pid,
				};
			}
			if (isIdleShell(info, record.shellPid)) return { proven: true };
			this.#notifyOnChange(
				"retire-unproven",
				"Herdr: the recorded child pane is busy with an unrecognized process; it was left untouched.",
				"warning",
			);
			return { proven: false };
		}
		// Identity-only record: shell proof is missing, so the creation outcome is
		// unknowable without the workspace owner inspecting it.
		this.#notifyOnChange(
			"stale-launch-intent",
			`Hunk creation outcome is unknown; inspect the workspace before clearing ${this.#recordFile()}.launch.json.`,
			"error",
		);
		return { proven: false };
	}

	/**
	 * Bounded post-close verification: structured pane absence plus
	 * disappearance of the bound registration (or proven Hunk PID death).
	 * Indeterminate results preserve metadata for the next tick.
	 */
	async #verifyRetirement(
		record: CompanionRecord,
		hunk: { hunkSessionId?: string; hunkPid?: number } = record,
	): Promise<boolean> {
		for (let attempt = 0; attempt < 4; attempt += 1) {
			if (this.#shutdownStarted) return false;
			const pane = await this.#paneState(record.paneId);
			if (pane === "indeterminate") {
				await this.#sleep(300);
				continue;
			}
			if (pane !== "absent") return false;
			if (hunk.hunkSessionId !== undefined || hunk.hunkPid !== undefined) {
				try {
					const sessions = await this.#cli.sessionList();
					const still = sessions.some(
						entry =>
							entry.sessionId === hunk.hunkSessionId ||
							(hunk.hunkPid !== undefined && entry.pid === hunk.hunkPid),
					);
					if (still) {
						// The registration lingers; only a proven-dead process (registry
						// lag) counts as gone, and a live probe vetoes the removal.
						if (hunk.hunkPid !== undefined && this.#deps.isProcessAlive(hunk.hunkPid) === false) {
							return true;
						}
						return false;
					}
				} catch {
					await this.#sleep(300);
					continue;
				}
			}
			return true;
		}
		return false;
	}

	/**
	 * Remove the launch sidecar only when it matches the record being retired
	 * (socket/workspace/owner). Malformed or mismatched sidecars are retained
	 * with the record; absence is success. The metadata read is awaited, so a
	 * fence is rechecked before the removal: `"stopped"` means shutdown, a
	 * superseded parent, or lost ownership kept the evidence on disk.
	 */
	async #removeMatchingSidecar(
		record: CompanionRecord,
		desired: ParentSnapshot,
	): Promise<"removed" | "retained" | "stopped"> {
		const sidecarPath = `${this.#recordFile()}.launch.json`;
		let raw: unknown;
		try {
			raw = await readJsonFile(sidecarPath);
		} catch {
			return "retained"; // malformed intent: retain both
		}
		if (raw === null) return "removed";
		const intent = asRecord(raw);
		if (
			!intent ||
			intent["version"] !== 1 ||
			intent["socketPath"] !== record.socketPath ||
			intent["workspaceId"] !== record.workspaceId ||
			intent["ownerPaneId"] !== record.ownerPaneId
		) {
			return "retained";
		}
		if (this.#mutationBlocked(desired)) {
			this.#deps.logger.debug("shutdown or supersession before sidecar removal; launch intent retained");
			return "stopped";
		}
		try {
			await nodeFs.rm(sidecarPath);
			return "removed";
		} catch (error) {
			if (isEnoent(error)) return "removed";
			this.#deps.logger.warn("launch sidecar removal failed", { error });
			return "retained";
		}
	}

	/**
	 * Remove this operation's own matching-nonce intent; never another
	 * operation's. A pre-submission cancellation must clean up even while
	 * shutting down — a recordless intent would strand the successor as an
	 * unknown creation — but once the tab create was submitted the intent is
	 * launch evidence, so a shutdown race retains it for successor recovery.
	 */
	async #removeOwnIntent(): Promise<void> {
		const intent = this.#launchIntent;
		if (!intent) return;
		this.#launchIntent = undefined;
		if (this.#shutdownStarted && intent.paneId !== "") {
			this.#deps.logger.debug("shutdown raced the post-create intent cleanup; launch intent retained");
			return;
		}
		try {
			const raw = await readJsonFile(intent.sidecarPath);
			const parsed = asRecord(raw);
			if (parsed && parsed["nonce"] === intent.nonce) {
				await nodeFs.rm(intent.sidecarPath);
			}
		} catch (error) {
			if (!isEnoent(error)) this.#deps.logger.debug("launch intent removal failed", { error });
		}
	}


	async #finishBind(
		binding: { hunkSessionId: string; hunkPid?: number },
		desired: ParentSnapshot,
		root: string,
	): Promise<void> {
		this.#launchRunRejected = false;
		this.#binding = binding;
		this.#bindingEpoch += 1;
		this.#viewToken = undefined;
		this.#launchBeforeSessions = undefined;
		this.#launchParent = undefined;
		// A fresh child launched at the pinned baseline already shows the session
		// scope; a pinned commit/branch scope is only reloaded below. Mark that
		// reload pending BEFORE the binding publishes readiness or passes the
		// clean gate: capture, archive, and annotation stay blocked until the
		// scope verifiably landed on this child.
		const scope = this.#scope;
		this.#pendingScopeReload = scope !== undefined && scope.kind !== "session" ? scope : undefined;
		this.#child = "ready";
		this.#applied = { parent: desired, root };
		this.#pinnedFor = { ompSessionId: desired.ompSessionId, root };
		for (const key of RECOVERY_NOTIFY_KEYS) this.#clearNotifyKey(key);

		// Clean-note gate: clear exactly once per fresh binding; failure blocks
		// export and annotation until the ordinary reconciler retries.
		await this.#attemptCleanGate(desired);

		if (scope !== undefined && scope.kind !== "session") {
			// The clean gate awaited: shutdown or a superseded parent stops the
			// reload, and a replaced binding must never receive this scope.
			if (this.#mutationBlocked(desired) || this.#binding !== binding) return;
			// The clean gate's awaits can invalidate the controller's native
			// reservation: reprove it, then re-fence with no await before the
			// reload dispatch. A moved pane never receives the scope.
			if (this.#lock?.acquired !== true || (await this.#verifyControllerIdentity()) !== "ok") {
				this.#notifyOnChange(
					"controller-moved",
					"Herdr: this controller's pane identity changed; child management is paused.",
					"warning",
				);
				return;
			}
			if (this.#mutationBlocked(desired) || this.#binding !== binding) return;
			try {
				await this.#cli.reload(binding.hunkSessionId, hunkReloadArgs(scope), { timeoutMs: 5_000 });
				this.#pendingScopeReload = undefined;
			} catch (error) {
				// The pending scope stays; the ordinary reconciler retries it.
				this.#deps.logger.warn("pinned scope reload failed", { error });
			}
		}
		await this.snapshotNow({ deadlineMs: 3_000 });
	}

	/**
	 * Clean-annotation boundary for a freshly bound child: clear every note in
	 * the owned companion only. Returns false when the clear failed; export and
	 * annotation stay blocked until a lifecycle tick retries it.
	 */
	async #attemptCleanGate(desired?: ParentSnapshot): Promise<boolean> {
		const binding = this.#binding;
		if (!binding) return false;
		if (this.#mutationBlocked(desired)) return false;
		if ((await this.#verifyControllerIdentity()) !== "ok") {
			this.#notifyOnChange(
				"controller-moved",
				"Herdr: this controller's pane identity changed; child management is paused.",
				"warning",
			);
			return false;
		}
		// The identity proof awaited: re-fence with no await before the clear.
		if (this.#mutationBlocked(desired) || this.#binding !== binding) return false;
		try {
			await this.#cli.commentClearAll(binding.hunkSessionId, { timeoutMs: 5_000 });
			this.#cleanForSessionId = binding.hunkSessionId;
			this.#clearNotifyKey("clean-gate");
			return true;
		} catch (error) {
			this.#deps.logger.warn("clean-slate clear failed", { error });
			this.#notifyOnChange(
				"clean-gate",
				"Herdr: could not clear the previous session's notes; export and annotation stay disabled until the lifecycle retry succeeds.",
				"warning",
			);
			return false;
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

	async #waitForShell(paneId: string, deadlineMs: number, desired: ParentSnapshot): Promise<PaneProcessInfo | null> {
		const startedAt = this.#deps.timers.now();
		for (;;) {
			if (this.#launchSuperseded(desired)) return null;
			const info = await this.#paneInfo(paneId);
			if (info === "absent") return null; // tab closed mid-launch; the next drain reports it
			if (info !== "indeterminate" && info.shellPid !== undefined) return info;
			if (this.#deps.timers.now() - startedAt >= deadlineMs) return null;
			await this.#sleep(250);
		}
	}

	/**
	 * Poll the owned pane until exactly one newly-registered hunk session (not
	 * in `before`, in the pane's foreground, at the expected canonical root)
	 * proves itself. `expectedShellPid` must still own the pane: a replaced
	 * shell means whatever runs there was not started by our command. Timeout
	 * means "nothing proven yet" and stays retryable by design; ambiguity is
	 * final and never guessed at.
	 */
	async #handshake(
		paneId: string,
		expectedRoot: string,
		before: Set<string>,
		expectedShellPid: number | undefined,
		deadlineMs: number,
		desired: ParentSnapshot,
	): Promise<HandshakeOutcome> {
		const startedAt = this.#deps.timers.now();
		for (;;) {
			if (this.#launchSuperseded(desired)) return { status: "timeout" };
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


	#roleGate(): void {
		if (this.#role === "secondary") throw new CompanionUnavailable(SECONDARY_INACTIVE_MESSAGE);
		if (this.#role === "pending") throw new CompanionUnavailable(PENDING_OWNERSHIP_MESSAGE);
		if (this.#shutdownStarted) throw new CompanionUnavailable(SHUTDOWN_MESSAGE);
	}

	#reviewBlockReason(options?: {
		allowPendingScope?: boolean;
		allowParentMoved?: boolean;
		archive?: boolean;
	}): string | undefined {
		if (this.#role === "secondary") return SECONDARY_INACTIVE_MESSAGE;
		if (this.#role === "pending") return PENDING_OWNERSHIP_MESSAGE;
		if (this.#shutdownStarted) return SHUTDOWN_MESSAGE;
		// Archive captures serve the applied binding, so indeterminate
		// desired-checkout discovery must never block them; tool-facing review
		// access stays gated on the current parent's Git readiness.
		if (!options?.archive && !this.#gitReady) {
			return "Herdr: the checkout cannot be resolved right now; review access is paused.";
		}
		if (this.#child !== "ready" || !this.#binding) {
			return "Hunk review is not ready yet; try again shortly.";
		}
		if (this.#cleanForSessionId !== this.#binding.hunkSessionId) {
			return "Hunk: previous notes are not cleared yet; export and annotation stay disabled until the clean-slate clear succeeds.";
		}
		// Until the pinned scope is verifiably loaded, the live review does not
		// match what captures would report. Only an explicit new selection may
		// bypass this gate; it applies its own scope atomically.
		if (!options?.allowPendingScope && this.#pendingScopeReload !== undefined) {
			return "Hunk: the selected diff scope is not applied to the companion yet; review access stays paused until it is.";
		}
		// Archive captures serve the applied parent (a transition publishes the
		// old view while the desired parent has already moved on); tool-facing
		// review access is for the current parent only. Revision correspondence,
		// not just the session id: a same-id cwd observation must pause review
		// until the applied context catches up.
		if (
			!options?.allowParentMoved &&
			(this.#applied === undefined ||
				this.#desired === undefined ||
				this.#applied.parent.revision !== this.#desired.revision)
		) {
			return "Hunk: the parent session changed; review is paused until the companion is re-bound.";
		}
		return undefined;
	}

	/** Resolve the user's selector choice into a pinned ReviewScope for `expected`. */
	async resolveScope(
		expected: ParentSnapshot,
		kind: "session" | "branch" | "commit",
		selection?: { branchFullRef?: string; commitSha?: string },
	): Promise<ReviewScope> {
		this.#roleGate();
		const checkout = await resolveCheckout(this.#deps.exec, expected.cwd);
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
			const baseSha = await resolveCommitSha(this.#deps.exec, expected.cwd, selection.branchFullRef);
			const base = await mergeBase(this.#deps.exec, expected.cwd, baseSha, checkout.headSha);
			return { kind: "branch", baseBranch: selection.branchFullRef, baseSha: base };
		}
		throw new CompanionUnavailable("Incomplete diff selection.");
	}

	/**
	 * Apply a completed /diff selection. The queue-time revision check discards
	 * selections whose picker was opened under a parent that has since changed
	 * (including A → B → A); the controller's own native reservation is
	 * re-proved before the child is reloaded. The reconciler owns every
	 * clean-gate retry.
	 */
	async selectScope(scope: ReviewScope, expected: ParentSnapshot): Promise<void> {
		await this.enqueue(async () => {
			this.#roleGate();
			if (this.#revision !== expected.revision) {
				this.#deps.logger.debug("scope selection discarded: parent changed during the picker");
				return;
			}
			const blocked = this.#reviewBlockReason({ allowPendingScope: true });
			if (blocked) throw new CompanionUnavailable(blocked);
			const binding = this.#binding;
			if (this.#lock?.acquired !== true || binding === undefined || (await this.#verifyControllerIdentity()) !== "ok") {
				throw new CompanionUnavailable(PANE_IDENTITY_BLOCKED_MESSAGE);
			}
			// The identity proof awaited: the picker's parent, readiness, and the
			// bound child must all still hold before the reload dispatches.
			if (this.#revision !== expected.revision) {
				this.#deps.logger.debug("scope selection discarded: parent changed during identity verification");
				return;
			}
			this.#roleGate();
			const stillBlocked = this.#reviewBlockReason({ allowPendingScope: true });
			if (stillBlocked) throw new CompanionUnavailable(stillBlocked);
			if (this.#binding !== binding || this.#lock?.acquired !== true) {
				throw new CompanionUnavailable(PANE_IDENTITY_BLOCKED_MESSAGE);
			}
			await this.#cli.reload(binding.hunkSessionId, hunkReloadArgs(scope), { timeoutMs: 5_000 });
			this.#scope = scope;
			this.#viewToken = undefined;
			this.#pendingScopeReload = undefined;
			await this.snapshotNow({ deadlineMs: 3_000 });
		});
	}

	/** Focus the owned child tab; discarded when the parent changed while queued. */
	async focusTab(expected: ParentSnapshot): Promise<void> {
		await this.enqueue(async () => {
			this.#roleGate();
			if (this.#revision !== expected.revision) return;
			const tabId = this.#record?.tabId;
			if (tabId === undefined) throw new CompanionUnavailable("No companion tab to focus.");
			if (this.#lock?.acquired !== true || (await this.#verifyControllerIdentity()) !== "ok") {
				throw new CompanionUnavailable(PANE_IDENTITY_BLOCKED_MESSAGE);
			}
			// The identity proof awaited: recheck the parent, shutdown, ownership,
			// and the targeted tab with no await before the focus dispatch.
			this.#roleGate();
			if (this.#revision !== expected.revision || this.#record?.tabId !== tabId) return;
			await this.#herdr.run(["tab", "focus", tabId], "tab focus");
		});
	}


	async captureStable(signal?: AbortSignal): Promise<CaptureOutcome> {
		return this.#captureInner(signal, false);
	}

	/**
	 * Read the bound review stably. Tool captures (`final: false`) are gated by
	 * the full review-block policy and recheck shutdown, the binding epoch, and
	 * the captured parent revision between awaits before issuing a token.
	 * Archive captures (`archive: true`) run for the applied parent — including
	 * transition snapshots published while the desired parent has already moved
	 * on — so the parent-moved gate is waived for them, and the desired
	 * checkout's Git discovery never gates the applied child's archive;
	 * readiness, the clean gate, and the binding-epoch proof still hold, and
	 * only `final: true` runs for a soft-shutting-down primary with no view
	 * token minted.
	 */
	async #captureInner(signal: AbortSignal | undefined, final: boolean, archive = false): Promise<CaptureOutcome> {
		if (!final) {
			const blocked = this.#reviewBlockReason(archive ? { allowParentMoved: true, archive: true } : undefined);
			if (blocked) return { ok: false, reason: blocked };
		}
		const binding = this.#binding;
		if (!binding) return { ok: false, reason: "Hunk review is not ready yet; try again shortly." };
		if (this.#pendingScopeReload !== undefined) {
			return {
				ok: false,
				reason: "Hunk: the selected diff scope is not applied to the companion yet; capture is paused until it is.",
			};
		}
		if (this.#child !== "ready" || this.#cleanForSessionId !== binding.hunkSessionId) {
			return { ok: false, reason: this.#reviewBlockReason() ?? "Hunk review is not ready yet; try again shortly." };
		}
		const epoch0 = this.#bindingEpoch;
		const revision0 = this.#revision;
		const applied0 = this.#applied;
		const sessionId = binding.hunkSessionId;
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
		if (this.#bindingEpoch !== epoch0 || this.#binding?.hunkSessionId !== sessionId || this.#applied !== applied0) {
			return { ok: false, reason: "Companion rebound during capture; call hunk_review again." };
		}
		if (this.#revision !== revision0) {
			return { ok: false, reason: "The parent session changed during capture; call hunk_review again." };
		}
		if (this.#shutdownStarted && !final) {
			return { ok: false, reason: SHUTDOWN_MESSAGE };
		}
		const token = final ? "" : this.#issueViewToken(generation);
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
			existing.bindingEpoch === this.#bindingEpoch &&
			existing.hunkSessionId === this.#binding?.hunkSessionId &&
			existing.publicationGeneration === publicationGeneration
		) {
			return existing.token;
		}
		const token = crypto.randomUUID();
		this.#viewToken = {
			token,
			bindingEpoch: this.#bindingEpoch,
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
			const blocked = this.#reviewBlockReason();
			if (blocked) return { ok: false, error: blocked };
			const binding = this.#binding;
			if (!binding) return { ok: false, error: "Hunk review is not ready yet; try again shortly." };
			if (this.#lock?.acquired !== true || (await this.#verifyControllerIdentity()) !== "ok") {
				return { ok: false, error: PANE_IDENTITY_BLOCKED_MESSAGE };
			}
			const record = this.#viewToken;
			if (
				record === undefined ||
				record.token !== token ||
				record.bindingEpoch !== this.#bindingEpoch ||
				record.hunkSessionId !== binding.hunkSessionId
			) {
				return { ok: false, error: "Unknown or stale view token; call hunk_review again before annotating." };
			}
			const revision0 = this.#revision;
			let current: SessionSnapshot;
			try {
				current = await this.#cli.sessionGet(binding.hunkSessionId, { signal });
			} catch (error) {
				return { ok: false, error: this.#captureErrorReason(error) };
			}
			if (current.publication?.generation !== record.publicationGeneration) {
				return { ok: false, error: "Review changed; call hunk_review again before annotating." };
			}
			// The preflight read awaited: shutdown and the token/binding/parent the
			// token was minted for must all still hold before anything else runs.
			if (this.#shutdownStarted) return { ok: false, error: SHUTDOWN_MESSAGE };
			if (this.#viewToken !== record || this.#binding !== binding || this.#revision !== revision0) {
				return { ok: false, error: "Unknown or stale view token; call hunk_review again before annotating." };
			}
			// The preflight read also gives the controller's native reservation a
			// fresh window to move or lose ownership: reprove it, then re-fence
			// the token state with no await before the write dispatches.
			if (this.#lock?.acquired !== true || (await this.#verifyControllerIdentity()) !== "ok") {
				return { ok: false, error: PANE_IDENTITY_BLOCKED_MESSAGE };
			}
			if (this.#shutdownStarted) return { ok: false, error: SHUTDOWN_MESSAGE };
			if (this.#viewToken !== record || this.#binding !== binding || this.#revision !== revision0) {
				return { ok: false, error: "Unknown or stale view token; call hunk_review again before annotating." };
			}
			let result: CommentAddResult;
			try {
				result = await this.#cli.commentAdd(binding.hunkSessionId, request, { signal });
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
				const after = await this.#cli.sessionGet(binding.hunkSessionId, { signal });
				reviewChanged = after.publication?.generation !== record.publicationGeneration;
			} catch {
				reviewChanged = true;
			}
			return { ok: true, result, reviewChanged };
		});
	}


	/**
	 * Export the ready, clean binding to the applied parent's artifact
	 * destination. The writer slot is held from the moment a write starts until
	 * the filesystem work actually settles — a deadline only stops THIS caller
	 * from waiting; the abandoned capture still occupies the writer, so an
	 * older rename can never overtake a newer archive at the same destination
	 * and no second writer can start meanwhile. The `mayPublish` fence discards
	 * captures whose parent observation, binding, or clean state changed while
	 * they were in flight; a transition archive is judged against the desired
	 * revision it was started under, so it still publishes.
	 * `final: true` admits the soft-shutdown path's last read-only archive.
	 */
	async snapshotNow(options?: { deadlineMs?: number; final?: boolean }): Promise<boolean> {
		if (this.#archiveWriteInFlight) return false;
		if (this.#role !== "primary") return false;
		if (this.#shutdownStarted && options?.final !== true) return false;
		if (this.#child !== "ready" || !this.#binding || !this.#scope || !this.#applied) return false;
		if (this.#cleanForSessionId !== this.#binding.hunkSessionId) {
			this.#deps.logger.debug("archive skipped: clean-slate clear pending");
			return false;
		}
		if (this.#pendingScopeReload !== undefined) {
			this.#deps.logger.debug("archive skipped: pinned scope not applied yet");
			return false;
		}
		const artifactsDir = this.#applied.parent.artifactsDir;
		if (artifactsDir === null) {
			this.#deps.logger.debug("skipping archive: session has no artifact directory");
			return false;
		}
		this.#archiveWriteInFlight = true;
		const write = this.#snapshotWrite(artifactsDir, options?.final === true, options?.deadlineMs);
		void write.then(
			() => {
				this.#archiveWriteInFlight = false;
			},
			() => {
				this.#archiveWriteInFlight = false;
			},
		);
		// The deadline detaches this caller only; the writer slot above is
		// released solely by the write's actual settlement.
		if (options?.deadlineMs === undefined) return write;
		const settled = await this.#withDeadline(write, options.deadlineMs);
		return settled ?? false;
	}

	async #snapshotWrite(artifactsDir: string, final: boolean, deadlineMs?: number): Promise<boolean> {
		try {
			// Capture identity/destination before awaiting; the publish fence
			// discards outdated work instead of writing into a replacement's archive.
			const captured = {
				epoch: this.#bindingEpoch,
				hunkSessionId: this.#binding?.hunkSessionId ?? "",
				ompSessionId: this.#applied?.parent.ompSessionId ?? "",
				// The desired revision at write entry — not the applied parent's — so
				// a deliberate transition snapshot (started after the desired parent
				// already moved on) still publishes, while a write whose parent was
				// re-observed mid-flight is discarded before the rename.
				desiredRevision: this.#desired?.revision ?? -1,
				workspaceId: this.#workspaceId(),
				tabId: this.#record?.tabId ?? "",
				paneId: this.#record?.paneId ?? "",
				repoRoot: this.#applied?.root ?? "",
			};
			const capture = await this.#withDeadline(this.#captureInner(undefined, final, true), deadlineMs);
			if (capture === undefined) {
				this.#deps.logger.debug("archive capture exceeded its deadline");
				return false;
			}
			if (!capture.ok || !capture.capture) {
				this.#deps.logger.debug("archive capture skipped", { reason: capture.reason });
				return false;
			}
			const envelope: SnapshotEnvelope = {
				version: 1,
				capturedAt: capture.capture.capturedAt,
				ompSessionId: captured.ompSessionId,
				workspaceId: captured.workspaceId,
				tabId: captured.tabId,
				paneId: captured.paneId,
				hunkSessionId: capture.capture.hunkSessionId,
				repoRoot: captured.repoRoot,
				scope: capture.capture.scope,
				publication: {
					generation: capture.capture.publication.generation,
					stateRevision: capture.capture.publication.stateRevision,
				},
				review: capture.capture.review,
			};
			return await atomicWriteJson(`${artifactsDir}/hunk/review-notes.json`, envelope, 0o600, () =>
				this.#desired?.revision === captured.desiredRevision &&
				this.#bindingEpoch === captured.epoch &&
				this.#binding?.hunkSessionId === captured.hunkSessionId &&
				this.#cleanForSessionId === captured.hunkSessionId,
			);
		} catch (error) {
			this.#deps.logger.warn("archive write failed", { error });
			return false;
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


	/**
	 * Soft retirement: stop new work and invalidate tool tokens, then attempt
	 * one final read-only archive of the still-applied clean view. Never calls
	 * child teardown, pane close, send-keys, comment clear, reload, or launch;
	 * never deletes child ownership or launch evidence; the process-owned
	 * primary lock stays held until actual process exit. A successor primary —
	 * not this shutdown — performs replacement.
	 */
	async shutdown(deadlineMs: number): Promise<void> {
		if (this.#shutdownStarted) return;
		this.#shutdownStarted = true;
		this.#viewToken = undefined;
		// The in-flight creation keeps its nonce and submission state: its own
		// cancellation removes a proven pre-submission intent (a recordless
		// sidecar would strand the successor as an unknown creation), while a
		// possibly-submitted intent stays on disk as durable evidence. Clearing
		// the memory here would orphan that decision.
		try {
			// One final read-only archive of the still-applied clean view; the
			// deadline stops the wait, never the write's settlement.
			await this.#withDeadline(this.snapshotNow({ deadlineMs, final: true }), deadlineMs);
		} catch (error) {
			this.#deps.logger.debug("final snapshot failed", { error });
		}
	}

	/** Resolves immediately once shutdown started so poll loops never hang. */
	#sleep(ms: number): Promise<void> {
		if (this.#shutdownStarted) return Promise.resolve();
		const { promise, resolve } = Promise.withResolvers<void>();
		this.#deps.timers.setTimeout(resolve, ms);
		return promise;
	}
}
