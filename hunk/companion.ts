/**
 * Companion controller: binds exactly one herdr tab + Hunk session per
 * workspace and owns its lifecycle.
 *
 * Identity model (verified against hunk 0.22.0 + herdr 0.9.3):
 * - Hunk generates its own session UUID and registers {pid, cwd, repoRoot,
 *   terminal metadata}; it exposes no herdr pane ids. Label matching and
 *   repo-only matching are therefore NOT identity proofs. The proof is a PID
 *   intersection: the registered Hunk session PID must appear in the owned
 *   pane's foreground processes.
 * - The persistent ownership record (keyed by herdr socket + workspace) proves
 *   which tab/pane this extension created. It stores no notes and is never a
 *   replay journal.
 */

import * as nodeFs from "node:fs/promises";
import {
	CompanionUnavailable,
	HunkCli,
	HunkCliError,
	type CommentAddRequest,
	type CommentAddResult,
	type ExecRunner,
	type ReviewPublication,
	type SessionSnapshot,
} from "./hunk-cli";
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

const STICKY_CLOSED: ReadonlySet<ClosedReason> = new Set(["user", "exited", "unverified"]);

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

/** Boundary guard for external JSON objects (herdr envelopes, CLI payloads). */
function asRecord(value: unknown): Record<string, unknown> | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

async function canonicalPath(path: string): Promise<string> {
	try {
		return await nodeFs.realpath(path);
	} catch {
		return path;
	}
}

interface PaneProcessInfo {
	shellPid?: number;
	foregroundPids: number[];
}

interface HerdrPane {
	paneId: string;
	tabId?: string;
	workspaceId?: string;
}

export class CompanionController {
	readonly #deps: CompanionDeps;
	readonly #cli: HunkCli;
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
	#resetFailed = false;
	#shutdownStarted = false;
	#lifecycleTickRunning = false;
	#archiveTickRunning = false;
	#launchInFlight = false;
	#readinessPollHandle: unknown;
	#lastNotifyKey: string | undefined;
	readonly #eligible: boolean;

	constructor(deps: CompanionDeps) {
		this.#deps = deps;
		this.#cli = new HunkCli(deps.exec, deps.hunkPath);
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

	get annotationsAvailable(): boolean {
		return this.isReady && !this.#resetFailed;
	}

	#herdrPath(): string {
		return this.#deps.env.HERDR_BIN_PATH ?? "herdr";
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

	#notifyOnce(key: string, message: string, level: NotifyLevel): void {
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

	async #herdr(args: string[], context: string, timeoutMs = 5_000): Promise<Record<string, unknown>> {
		const outcome = await this.#deps.exec(this.#herdrPath(), args, { timeoutMs });
		if (outcome.code !== 0 || outcome.killed) {
			const detail = outcome.stderr.trim() || outcome.stdout.trim();
			throw new HunkCliError(`${context}: ${detail || "herdr call failed"}`, outcome.code, detail);
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(outcome.stdout);
		} catch {
			throw new HunkCliError(`${context}: herdr returned malformed JSON`, 0, outcome.stdout.slice(0, 400));
		}
		const envelope = asRecord(parsed);
		if (!envelope) {
			throw new HunkCliError(`${context}: herdr returned an unexpected payload`, 0, "");
		}
		const result = asRecord(envelope["result"]);
		if (!result) {
			throw new HunkCliError(`${context}: herdr response missing result`, 0, "");
		}
		return result;
	}

	async #tabExists(tabId: string): Promise<boolean> {
		try {
			await this.#herdr(["tab", "get", tabId], "tab get");
			return true;
		} catch {
			return false;
		}
	}

	async #paneProcessInfo(paneId: string): Promise<PaneProcessInfo> {
		const result = await this.#herdr(["pane", "process-info", "--pane", paneId], "pane process-info");
		const info = result["process_info"];
		const record = asRecord(info);
		if (!record) {
			throw new HunkCliError("pane process-info: malformed response", 0, "");
		}
		const foreground: number[] = [];
		if (Array.isArray(record["foreground_processes"])) {
			for (const entry of record["foreground_processes"]) {
				const process = asRecord(entry);
				const pid = process?.["pid"];
				if (typeof pid === "number" && Number.isInteger(pid)) foreground.push(pid);
			}
		}
		const shellPidValue = record["shell_pid"];
		const shellPid =
			typeof shellPidValue === "number" && Number.isInteger(shellPidValue) ? shellPidValue : undefined;
		return { shellPid, foregroundPids: foreground };
	}

	async #paneGet(paneId: string): Promise<HerdrPane | null> {
		try {
			const result = await this.#herdr(["pane", "get", paneId], "pane get");
			const pane = asRecord(result["pane"]);
			if (!pane) return null;
			const paneIdValue = pane["pane_id"];
			if (typeof paneIdValue !== "string") return null;
			const tabId = pane["tab_id"];
			const workspaceId = pane["workspace_id"];
			return {
				paneId: paneIdValue,
				tabId: typeof tabId === "string" ? tabId : undefined,
				workspaceId: typeof workspaceId === "string" ? workspaceId : undefined,
			};
		} catch {
			return null;
		}
	}

	async #tabCreate(repoRoot: string): Promise<{ tabId: string; paneId: string }> {
		const args = [
			"tab",
			"create",
			"--workspace",
			this.#workspaceId(),
			"--cwd",
			repoRoot,
			"--label",
			"hunk",
			"--no-focus",
		];
		const host = this.#deps.env.HUNK_MCP_HOST;
		const port = this.#deps.env.HUNK_MCP_PORT;
		if (host !== undefined && host.length > 0) args.push("--env", `HUNK_MCP_HOST=${host}`);
		if (port !== undefined && port.length > 0) args.push("--env", `HUNK_MCP_PORT=${port}`);
		const result = await this.#herdr(args, "tab create", 10_000);
		const tab = asRecord(result["tab"]);
		const rootPane = asRecord(result["root_pane"]);
		if (!tab || !rootPane) {
			throw new HunkCliError("tab create: malformed response", 0, "");
		}
		const tabId = tab["tab_id"];
		const paneId = rootPane["pane_id"];
		if (typeof tabId !== "string" || typeof paneId !== "string") {
			throw new HunkCliError("tab create: missing tab/pane ids", 0, "");
		}
		return { tabId, paneId };
	}

	async #paneRun(paneId: string, command: string): Promise<void> {
		await this.#herdr(["pane", "run", paneId, command], "pane run");
	}

	async #sendCtrlC(paneId: string): Promise<void> {
		await this.#herdr(["pane", "send-keys", paneId, "ctrl+c"], "pane send-keys");
	}

	async focusTab(): Promise<void> {
		if (!this.#record) throw new CompanionUnavailable("No companion tab to focus.");
		await this.#herdr(["tab", "focus", this.#record.tabId], "tab focus");
	}

	/**
	 * Retitle the owned tab. Creation labels it "hunk"; a completed /diff
	 * scope change retitles it "diff" so the tab name reflects the active view.
	 */
	async renameTab(label: string): Promise<void> {
		if (!this.#record) throw new CompanionUnavailable("No companion tab to rename.");
		await this.#herdr(["tab", "rename", this.#record.tabId, label], "tab rename");
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
		this.#initPromise = this.enqueue(() => this.#initializeInner(options))
			.catch(error => {
				throw error;
			})
			.finally(() => {
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
			STICKY_CLOSED.has(this.#closedReason ?? "user") &&
			options?.explicit !== true
		) {
			throw new CompanionUnavailable("Open /diff to reopen the Hunk companion.");
		}

		let record: CompanionRecord | null = null;
		try {
			record = await readCompanionRecord(this.#recordFile());
		} catch (error) {
			this.#deps.notify("Hunk: companion ownership record is malformed; leaving it untouched.", "error");
			this.#deps.logger.error("companion record malformed", { path: this.#recordFile(), error });
			throw new CompanionUnavailable("Hunk companion ownership record is malformed.");
		}

		this.#repoRoot = checkout.repoRoot;
		this.#baselineHead = checkout.headSha;
		this.#state = "starting";
		this.#closedReason = undefined;

		if (record !== null && record.socketPath === (this.#deps.env.HERDR_SOCKET_PATH ?? "")) {
			if (record.ownerPaneId !== this.#agentPaneId()) {
				const ownerPane = await this.#paneGet(record.ownerPaneId);
				if (ownerPane !== null) {
					this.#state = "unavailable";
					this.#notifyOnce(
						"ownership-conflict",
						`Hunk companion is owned by another agent pane (${record.ownerPaneId}).`,
						"warning",
					);
					throw new CompanionUnavailable(
						`Hunk companion is owned by another agent pane (${record.ownerPaneId}).`,
					);
				}
				// Owner pane is gone: take over after full identity checks below.
			}
			const adopted = await this.#adoptOrLaunchFromRecord(record, checkout.repoRoot, checkout.headSha);
			if (adopted) return;
		}
		await this.#launchNewTab(checkout.repoRoot, checkout.headSha);
	}

	/** Returns true when the existing record produced a bound companion. */
	async #adoptOrLaunchFromRecord(
		record: CompanionRecord,
		repoRoot: string,
		headSha: string,
	): Promise<boolean> {
		// Bind paths below seed scope and persistence from these fields; the
		// root-change fallback calls this method outside #initializeInner, so
		// they must track the caller's target checkout, not the previous root.
		this.#repoRoot = repoRoot;
		this.#baselineHead = headSha;
		if (!(await this.#tabExists(record.tabId))) {
			// A previous session's closed tab does not bind a fresh session: relaunch.
			this.#deps.logger.debug("recorded companion tab is gone; creating a new one", { tabId: record.tabId });
			return false;
		}
		const pane = await this.#paneGet(record.paneId);
		if (pane === null || (pane.tabId !== undefined && pane.tabId !== record.tabId)) {
			this.#deps.logger.debug("recorded companion pane is gone; creating a new one", { paneId: record.paneId });
			return false;
		}
		const info = await this.#paneProcessInfo(record.paneId);

		if (record.hunkSessionId !== undefined && record.hunkPid !== undefined) {
			const sessions = await this.#cli.sessionList();
			const registered = sessions.find(entry => entry.sessionId === record.hunkSessionId);
			const registeredRoot =
				registered !== undefined ? await canonicalPath(registered.repoRoot ?? registered.cwd) : undefined;
			if (
				registered !== undefined &&
				registered.pid === record.hunkPid &&
				info.foregroundPids.includes(record.hunkPid) &&
				registeredRoot === repoRoot
			) {
				this.#record = { ...record, repoRoot, ownerPaneId: this.#agentPaneId() };
				await this.#finishBind(
					{ hunkSessionId: record.hunkSessionId, hunkPid: record.hunkPid },
					{ reloadToSessionScope: true },
				);
				return true;
			}
			// PID survives but the daemon lost the recorded id: re-resolve by pid.
			const byPid = sessions.filter(entry => entry.pid === record.hunkPid);
			const inPane = [];
			for (const entry of byPid) {
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
					{ hunkSessionId: session.sessionId, hunkPid: record.hunkPid },
					{ reloadToSessionScope: true },
				);
				return true;
			}
			if (inPane.length > 1) {
				this.#closeWithReason("unverified");
				this.#notifyOnce(
					"unverified",
					"Hunk: could not identify the companion session uniquely; use /diff to relaunch.",
					"error",
				);
				throw new CompanionUnavailable("Hunk companion session could not be identified.");
			}
			// Recorded hunk is gone. An idle pane may be reused; an occupied one is left alone.
			if (info.foregroundPids.length > 0) {
				return false; // fall through to a brand-new tab; never touch the occupant.
			}
			const shellMatches = record.shellPid === undefined || info.shellPid === record.shellPid;
			if (!shellMatches) return false;
			await this.#launchInPane(record.tabId, record.paneId, repoRoot, headSha, info);
			return true;
		}

		// Incomplete launch from a previous session: try a short late bind before
		// deciding the pane is unusable — the review may have registered late.
		const lateBind = await this.#handshake(record.paneId, repoRoot, new Set<string>(), 2_000);
		if (lateBind !== null && !("error" in lateBind)) {
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
		if (info.foregroundPids.length > 0) {
			this.#closeWithReason("blocked");
			this.#notifyOnce(
				"incomplete-launch",
				"Hunk: previous companion launch never completed and the pane is busy; use /diff to open a new tab.",
				"warning",
			);
			throw new CompanionUnavailable("Hunk companion launch was incomplete and the pane is occupied.");
		}
		const shellMatches = record.shellPid === undefined || info.shellPid === record.shellPid;
		if (!shellMatches) return false;
		await this.#launchInPane(record.tabId, record.paneId, repoRoot, headSha, info);
		return true;
	}

	async #launchNewTab(repoRoot: string, headSha: string): Promise<void> {
		const before = new Set((await this.#cli.sessionList()).map(entry => entry.sessionId));
		const { tabId, paneId } = await this.#tabCreate(repoRoot);
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
			this.#notifyOnce(
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
			try {
				const info = await this.#paneProcessInfo(paneId);
				if (info.shellPid !== undefined) return info;
			} catch (error) {
				this.#deps.logger.debug("pane process-info not ready yet", { paneId, error });
			}
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
		this.#repoRoot = repoRoot;
		this.#baselineHead = headSha;
		this.#launchInFlight = true;
		try {
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
		const command = `cd -- ${shellQuote(repoRoot)} && ${shellQuote(this.#deps.hunkPath)} diff ${shellQuote(headSha)} --watch --agent-notes`;
		await this.#paneRun(paneId, command);
		this.#state = "starting";
		const handshake = await this.#handshake(paneId, repoRoot, before, 20_000);
		if (handshake === null) {
			this.#notifyOnce(
				"launch-timeout",
				"Hunk: review not ready yet (timed out); it may still be loading.",
				"warning",
			);
			return;
		}
		if ("error" in handshake) {
			this.#closeWithReason("unverified");
			this.#notifyOnce("handshake-ambiguous", handshake.error, "error");
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

	async #handshake(
		paneId: string,
		expectedRoot: string,
		before: Set<string>,
		deadlineMs: number,
	): Promise<{ hunkSessionId: string; hunkPid: number } | { error: string } | null> {
		const startedAt = this.#deps.timers.now();
		for (;;) {
			try {
				const info = await this.#paneProcessInfo(paneId);
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
					return { hunkSessionId: session.sessionId, hunkPid: session.pid };
				}
				if (candidates.length > 1) {
					return { error: "Hunk: multiple new review sessions appeared; refusing to guess." };
				}
			} catch (error) {
				this.#deps.logger.debug("handshake poll failed", { paneId, error });
			}
			if (this.#deps.timers.now() - startedAt >= deadlineMs) return null;
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
		this.#state = "ready";
		this.#closedReason = undefined;
		this.#clearNotifyKey("closed-user");
		this.#clearNotifyKey("closed-exited");
		this.#clearNotifyKey("blocked");
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
	 * owned companion only. Failure blocks annotations until the next boundary.
	 */
	async #resetAnnotations(): Promise<void> {
		if (!this.#binding) return;
		try {
			await this.#cli.commentClearAll(this.#binding.hunkSessionId, { timeoutMs: 5_000 });
			this.#resetFailed = false;
		} catch (error) {
			this.#resetFailed = true;
			this.#deps.logger.warn("clean-slate clear failed", { error });
			this.#notifyOnce(
				"reset-failed",
				"Hunk: could not clear the previous session's notes; annotations stay disabled until the next session boundary.",
				"warning",
			);
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
	}

	#notReadyMessage(): string {
		if (this.#state === "starting") return "Hunk companion is still starting; try again shortly.";
		if (this.#state === "closed") return "Open /diff to reopen the Hunk companion.";
		return "Hunk companion is not available.";
	}

	// ------------------------------------------------------------------ ticks --

	/** Health check + cwd follow. Cheap, read-only, self-serialized per tick. */
	async lifecycleTick(): Promise<void> {
		if (this.#lifecycleTickRunning || this.#shutdownStarted) return;
		this.#lifecycleTickRunning = true;
		try {
			if (!this.#eligible) return;
			if (this.#state === "closed") {
				if (this.#closedReason === "left-git") {
					const checkout = await resolveCheckout(this.#deps.exec, this.#cwd);
					if (checkout.ok) await this.initialize();
				}
				return;
			}
			if (this.#state === "starting") {
				await this.#lateBindTick();
				return;
			}
			if (this.isReady && this.#record && this.#binding) {
				const healthy = await this.#healthCheck();
				if (!healthy) return;
			}
			const checkout = await resolveCheckout(this.#deps.exec, this.#cwd);
			if (!checkout.ok) {
				if (this.#state === "ready") {
					this.#closeWithReason("left-git");
					this.#notifyOnce(
						"left-git",
						"Hunk: left the git checkout; the review tab stays as-is until you return.",
						"info",
					);
				}
				return;
			}
			if (checkout.repoRoot === this.#repoRoot) return;
			await this.enqueue(() => this.#rootChange(checkout.repoRoot, checkout.headSha));
		} finally {
			this.#lifecycleTickRunning = false;
		}
	}

	async #lateBindTick(): Promise<void> {
		if (this.#launchInFlight) return; // an inline handshake already owns this bind
		if (!this.#record) return;
		let info: PaneProcessInfo;
		try {
			info = await this.#paneProcessInfo(this.#record.paneId);
		} catch {
			return;
		}
		if (info.foregroundPids.length === 0) return;
		const before = new Set<string>();
		const handshake = await this.#handshake(this.#record.paneId, this.#record.repoRoot, before, 2_000);
		if (handshake === null || "error" in handshake) return;
		this.#record.hunkSessionId = handshake.hunkSessionId;
		this.#record.hunkPid = handshake.hunkPid;
		await this.#persistRecord();
		await this.#finishBind(handshake, { reloadToSessionScope: false });
	}

	/** True when the recorded tab, pane, and hunk process all still line up. */
	async #healthCheck(): Promise<boolean> {
		if (!this.#record || !this.#binding) return false;
		if (!(await this.#tabExists(this.#record.tabId))) {
			this.#closeWithReason("user");
			this.#notifyOnce("closed-user", "Hunk: companion tab was closed. Use /diff to reopen it.", "info");
			return false;
		}
		let info: PaneProcessInfo;
		try {
			info = await this.#paneProcessInfo(this.#record.paneId);
		} catch {
			this.#closeWithReason("user");
			this.#notifyOnce("closed-user", "Hunk: companion tab was closed. Use /diff to reopen it.", "info");
			return false;
		}
		if (!info.foregroundPids.includes(this.#binding.hunkPid ?? -1)) {
			this.#closeWithReason("exited");
			this.#notifyOnce("closed-exited", "Hunk: the review process exited. Use /diff to relaunch it.", "info");
			return false;
		}
		try {
			const sessions = await this.#cli.sessionList();
			const registered = sessions.find(entry => entry.sessionId === this.#binding?.hunkSessionId);
			if (registered === undefined || registered.pid !== this.#binding.hunkPid) {
				this.#closeWithReason("exited");
				this.#notifyOnce("closed-exited", "Hunk: the review session is no longer registered. Use /diff to relaunch it.", "info");
				return false;
			}
		} catch (error) {
			this.#deps.logger.debug("health check session list failed", { error });
		}
		return true;
	}

	async #rootChange(newRoot: string, newHead: string): Promise<void> {
		await this.snapshotNow({ deadlineMs: 1_000 });
		if (this.isReady && this.#record && this.#binding) {
			const verified = await this.#verifyOwnedHunkAlive();
			if (verified) {
				const stopped = await this.#stopOwnedHunk();
				if (!stopped) {
					this.#closeWithReason("blocked");
					this.#notifyOnce(
						"blocked",
						"Hunk: companion pane is busy; it was left untouched. Use /diff to open a new tab.",
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
			const info = await this.#paneProcessInfo(this.#record.paneId);
			if (!info.foregroundPids.includes(this.#binding.hunkPid ?? -1)) return false;
			const sessions = await this.#cli.sessionList();
			return sessions.some(
				entry => entry.sessionId === this.#binding?.hunkSessionId && entry.pid === this.#binding?.hunkPid,
			);
		} catch {
			return false;
		}
	}

	/** ctrl+c the owned hunk and wait for the recorded shell to be idle again. */
	async #stopOwnedHunk(deadlineMs = 5_000): Promise<boolean> {
		if (!this.#record) return false;
		const shellPid = this.#record.shellPid;
		await this.#sendCtrlC(this.#record.paneId);
		const startedAt = this.#deps.timers.now();
		for (;;) {
			try {
				const info = await this.#paneProcessInfo(this.#record.paneId);
				if (info.foregroundPids.length === 0) return true;
				if (shellPid !== undefined && info.foregroundPids.every(pid => pid === shellPid)) return true;
				if (shellPid === undefined) return false;
			} catch {
				return false;
			}
			if (this.#deps.timers.now() - startedAt >= deadlineMs) return false;
			await this.#sleep(250);
		}
	}

	// ------------------------------------------------------------- /diff API --

	async selectScope(scope: ReviewScope): Promise<void> {
		await this.enqueue(async () => {
			if (!this.isReady || !this.#binding) {
				throw new CompanionUnavailable(this.#notReadyMessage());
			}
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
		if (error instanceof HunkCliError) return `Hunk CLI error: ${error.message}`;
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
					error: "Annotations are unavailable: the clean-slate reset failed earlier. Reopen via /diff.",
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
				if (error instanceof HunkCliError && (error.exitCode !== 0 || error.message.includes("timed out"))) {
					const timedOut = error.message.includes("timed out");
					return {
						ok: false,
						error: timedOut
							? "Comment write timed out; the outcome is unknown. Call hunk_review before retrying."
							: `Hunk rejected the comment: ${error.message}`,
					};
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
		if (this.#archiveTickRunning) return false;
		if (!this.isReady || !this.#binding || !this.#scope) return false;
		const artifactsDir = this.#artifactsDir;
		if (artifactsDir === null) {
			this.#deps.logger.debug("skipping archive: session has no artifact directory");
			return false;
		}
		this.#archiveTickRunning = true;
		try {
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
			const envelope: SnapshotEnvelope = {
				version: 1,
				capturedAt: capture.capture.capturedAt,
				ompSessionId: this.#ompSessionId ?? "",
				workspaceId: this.#workspaceId(),
				tabId: this.#record?.tabId ?? "",
				paneId: this.#record?.paneId ?? "",
				hunkSessionId: capture.capture.hunkSessionId,
				repoRoot: this.#repoRoot ?? "",
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
			this.#archiveTickRunning = false;
		}
	}

	async #withDeadline<T>(promise: Promise<T>, deadlineMs?: number): Promise<T | undefined> {
		if (deadlineMs === undefined) return promise;
		const { promise: raced, resolve } = Promise.withResolvers<T | undefined>();
		this.#deps.timers.setTimeout(() => resolve(undefined), deadlineMs);
		return Promise.race([promise, raced]);
	}

	// --------------------------------------------------------------- shutdown --

	async shutdown(deadlineMs: number): Promise<void> {
		this.#shutdownStarted = true;
		this.#deps.timers.clearInterval(this.#readinessPollHandle);
		this.#readinessPollHandle = undefined;
		try {
			await this.snapshotNow({ deadlineMs });
		} catch (error) {
			this.#deps.logger.debug("final snapshot failed", { error });
		}
		this.#state = "unavailable";
		this.#binding = undefined;
		this.#viewToken = undefined;
	}

	#sleep(ms: number): Promise<void> {
		const { promise, resolve } = Promise.withResolvers<void>();
		const handle = this.#deps.timers.setTimeout(() => resolve(), ms);
		if (this.#shutdownStarted) this.#deps.timers.clearTimeout(handle);
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
