/**
 * Typed wrappers over the installed `herdr` CLI for companion tab/pane control.
 *
 * Failure classification (verified against herdr 0.9.3): failures exit 1 with a
 * structured envelope on stderr (`{"error":{"code":...}}`); usage errors exit
 * 2. Only the proven absence codes `tab_not_found`/`pane_not_found` mean the
 * referenced tab/pane is gone, and only `server_not_running` proves a command
 * was rejected before the daemon could submit it (the CLI never reached the
 * socket). Every other failure — socket hiccup, herdr restart, timeout,
 * malformed output, a connection lost mid-command — is indeterminate: callers
 * must treat it as "unknown", never as absence or proven rejection, or one
 * transient error would sticky-close a healthy companion or mint a duplicate
 * tab.
 */

import { CommandCliError, type ExecOutcome, type ExecRunner } from "./exec";
import { asRecord } from "./boundary";

export interface HerdrPane {
	paneId: string;
	tabId?: string;
	workspaceId?: string;
}

export interface PaneProcessInfo {
	shellPid?: number;
	foregroundPids: number[];
}

/** Codes herdr sends to prove the referenced tab/pane does not exist. */
const ABSENT_BY_CODE: Record<string, true> = {
	tab_not_found: true,
	pane_not_found: true,
};

/** Codes proving the command was rejected before the daemon submitted anything. */
const UNSUBMITTED_BY_CODE: Record<string, true> = {
	server_not_running: true,
};

/** herdr proved the referenced tab/pane does not exist (structured error code). */
export class HerdrAbsentError extends CommandCliError {
	constructor(
		message: string,
		readonly absentCode: string,
	) {
		super(message, 1, "");
		this.name = "HerdrAbsentError";
	}
}

/**
 * herdr proved the command was rejected before any job was submitted
 * (structured error code). A `pane run` answered with this can never produce
 * a foreground process later: pre-submission proof, unlike a timeout or a
 * dropped connection.
 */
export class HerdrRejectedError extends CommandCliError {
	constructor(
		message: string,
		readonly rejectCode: string,
	) {
		super(message, 1, "");
		this.name = "HerdrRejectedError";
	}
}

function structuredCodeFrom(stderr: string): string | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stderr);
	} catch {
		return undefined;
	}
	const envelope = asRecord(parsed);
	const error = envelope ? asRecord(envelope["error"]) : null;
	const code = error?.["code"];
	return typeof code === "string" && (ABSENT_BY_CODE[code] || UNSUBMITTED_BY_CODE[code]) ? code : undefined;
}

export class HerdrCli {
	constructor(
		private readonly exec: ExecRunner,
		private readonly herdrPath: string,
	) {}

	/**
	 * Run one herdr command and return its `result` payload. Throws
	 * HerdrAbsentError only for proven absence and HerdrRejectedError only for
	 * proven pre-submission rejection; every other failure (including
	 * kills/timeouts and malformed output) is a plain CommandCliError the
	 * caller must treat as indeterminate.
	 */
	async run(args: string[], context: string, timeoutMs = 5_000): Promise<Record<string, unknown>> {
		const outcome = await this.exec(this.herdrPath, args, { timeoutMs });
		if (outcome.code !== 0 || outcome.killed) {
			const detail = outcome.stderr.trim() || outcome.stdout.trim();
			const structuredCode = outcome.code === 1 && !outcome.killed ? structuredCodeFrom(outcome.stderr) : undefined;
			if (structuredCode !== undefined && ABSENT_BY_CODE[structuredCode]) {
				throw new HerdrAbsentError(`${context}: ${structuredCode}`, structuredCode);
			}
			if (structuredCode !== undefined && UNSUBMITTED_BY_CODE[structuredCode]) {
				throw new HerdrRejectedError(`${context}: ${structuredCode}`, structuredCode);
			}
			throw new CommandCliError(
				outcome.killed ? `${context}: herdr call timed out` : `${context}: ${detail || "herdr call failed"}`,
				outcome.code,
				detail,
			);
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(outcome.stdout);
		} catch {
			throw new CommandCliError(`${context}: herdr returned malformed JSON`, 0, outcome.stdout.slice(0, 400));
		}
		const envelope = asRecord(parsed);
		const result = envelope ? asRecord(envelope["result"]) : null;
		if (!result) {
			throw new CommandCliError(`${context}: herdr response missing result`, 0, "");
		}
		return result;
	}

	/**
	 * "absent" only on herdr's structured tab_not_found; unreachable servers,
	 * timeouts and malformed replies reject so callers can retry instead of
	 * relaunching.
	 */
	async tabPresence(tabId: string): Promise<"present" | "absent"> {
		try {
			const result = await this.run(["tab", "get", tabId], "tab get");
			const tab = asRecord(result["tab"]);
			if (!tab || tab["tab_id"] !== tabId) throw new CommandCliError("tab get: malformed identity", 0, "");
			return "present";
		} catch (error) {
			if (!(error instanceof HerdrAbsentError)) throw error;
			return "absent";
		}
	}

	/** null means herdr proved the pane is gone; other failures reject. */
	async paneState(paneId: string, timeoutMs?: number): Promise<HerdrPane | null> {
		let result: Record<string, unknown>;
		try {
			result = await this.run(["pane", "get", paneId], "pane get", timeoutMs);
		} catch (error) {
			if (!(error instanceof HerdrAbsentError)) throw error;
			return null;
		}
		const pane = asRecord(result["pane"]);
		if (!pane) throw new CommandCliError("pane get: malformed response", 0, "");
		const paneIdValue = pane["pane_id"];
		if (paneIdValue !== paneId) throw new CommandCliError("pane get: malformed identity", 0, "");
		const tabId = pane["tab_id"];
		const workspaceId = pane["workspace_id"];
		if (typeof tabId !== "string" || typeof workspaceId !== "string") {
			throw new CommandCliError("pane get: missing workspace/tab identity", 0, "");
		}
		return {
			paneId: paneIdValue,
			tabId: typeof tabId === "string" ? tabId : undefined,
			workspaceId: typeof workspaceId === "string" ? workspaceId : undefined,
		};
	}

	async paneProcessInfo(paneId: string, timeoutMs?: number): Promise<PaneProcessInfo> {
		const result = await this.run(["pane", "process-info", "--pane", paneId], "pane process-info", timeoutMs);
		const info = asRecord(result["process_info"]);
		if (!info) {
			throw new CommandCliError("pane process-info: malformed response", 0, "");
		}
		if (info["pane_id"] !== paneId) {
			throw new CommandCliError("pane process-info: malformed identity", 0, "");
		}
		// herdr 0.9.3 omits `foreground_processes` when empty; omission means an
		// empty set, but foreground data that is present must be well-formed.
		const foregroundValue = info["foreground_processes"];
		const foreground = foregroundValue === undefined ? [] : foregroundValue;
		if (!Array.isArray(foreground)) {
			throw new CommandCliError("pane process-info: malformed foreground processes", 0, "");
		}
		const foregroundPids: number[] = [];
		for (const entry of foreground) {
			const pid = asRecord(entry)?.["pid"];
			if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
				throw new CommandCliError("pane process-info: malformed foreground process", 0, "");
			}
			foregroundPids.push(pid);
		}
		const shellPidValue = info["shell_pid"];
		const shellPid =
			typeof shellPidValue === "number" && Number.isInteger(shellPidValue) ? shellPidValue : undefined;
		return { shellPid, foregroundPids };
	}

	/**
	 * Panes currently in `workspaceId`. Malformed payloads reject so callers
	 * treat the workspace as indeterminate instead of acting on a partial list.
	 */
	async paneList(workspaceId: string, timeoutMs?: number): Promise<HerdrPane[]> {
		const result = await this.run(["pane", "list", "--workspace", workspaceId], "pane list", timeoutMs);
		const panes = result["panes"];
		if (!Array.isArray(panes)) {
			throw new CommandCliError("pane list: malformed response", 0, "");
		}
		const listed: HerdrPane[] = [];
		for (const entry of panes) {
			const pane = asRecord(entry);
			const paneId = pane?.["pane_id"];
			if (!pane || typeof paneId !== "string") {
				throw new CommandCliError("pane list: malformed pane entry", 0, "");
			}
			const tabId = pane["tab_id"];
			const entryWorkspaceId = pane["workspace_id"];
			if ((tabId !== undefined && typeof tabId !== "string") || (entryWorkspaceId !== undefined && typeof entryWorkspaceId !== "string")) {
				throw new CommandCliError("pane list: malformed pane entry", 0, "");
			}
			listed.push({ paneId, tabId, workspaceId: entryWorkspaceId });
		}
		return listed;
	}

	/**
	 * Resolve only on herdr's structured `ok` reply; `pane_not_found` surfaces
	 * as HerdrAbsentError and every other outcome rejects as indeterminate.
	 */
	async closePane(paneId: string, timeoutMs?: number): Promise<void> {
		const result = await this.run(["pane", "close", paneId], "pane close", timeoutMs);
		if (result["type"] !== "ok") {
			throw new CommandCliError("pane close: unexpected result", 0, JSON.stringify(result).slice(0, 400));
		}
	}

	/** `envArgs` carries extra `--env KEY=VALUE` pairs the caller wants passed through. */
	async tabCreate(
		workspaceId: string,
		repoRoot: string,
		envArgs: string[],
	): Promise<{ tabId: string; paneId: string }> {
		const result = await this.run(
			["tab", "create", "--workspace", workspaceId, "--cwd", repoRoot, "--label", "diff", "--no-focus", ...envArgs],
			"tab create",
			10_000,
		);
		const tab = asRecord(result["tab"]);
		const rootPane = asRecord(result["root_pane"]);
		if (!tab || !rootPane) {
			throw new CommandCliError("tab create: malformed response", 0, "");
		}
		const tabId = tab["tab_id"];
		const paneId = rootPane["pane_id"];
		if (typeof tabId !== "string" || typeof paneId !== "string") {
			throw new CommandCliError("tab create: missing tab/pane ids", 0, "");
		}
		return { tabId, paneId };
	}
}
