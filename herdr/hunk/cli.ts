/**
 * Typed wrappers over the installed `hunk` session CLI.
 *
 * Verified against hunk 0.22.0: every `hunk session` command prints its payload
 * as JSON on stdout and exits 0 on success; failures print a diagnostic on
 * stderr and exit 1 (`--json` does not change error transport). All calls pass
 * an explicit `<session-id>` positional — never `--repo`, which matches by repo
 * root and can bind to a different live session.
 */

import { asRecord } from "../boundary";
import { CommandCliError, type ExecRunner } from "../exec";

export interface RegisteredSession {
	sessionId: string;
	pid: number;
	cwd: string;
	repoRoot?: string;
	inputKind?: string;
}

export interface ReviewPublication {
	generation: string;
	stateRevision?: number;
}

export interface CommentAddRequest {
	file?: string;
	side?: "old" | "new";
	line?: number;
	replyTo?: string;
	summary: string;
	rationale?: string;
}

export interface CommentAddResult {
	commentId: string;
	filePath?: string;
	hunkIndex?: number;
	side?: string;
	line?: number;
}

export interface HunkCliCallOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" ? value : undefined;
}

function optionalNumber(record: Record<string, unknown>, key: string): number | undefined {
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function requireString(record: Record<string, unknown>, key: string, context: string): string {
	const value = record[key];
	if (typeof value !== "string" || value.length === 0) {
		throw new CommandCliError(`${context}: missing or invalid "${key}"`, 0, "");
	}
	return value;
}

function requireNumber(record: Record<string, unknown>, key: string, context: string): number {
	const value = record[key];
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new CommandCliError(`${context}: missing or invalid "${key}"`, 0, "");
	}
	return value;
}

function parseEnvelope(stdout: string, context: string): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		throw new CommandCliError(`${context}: hunk returned malformed JSON`, 0, stdout.slice(0, 400));
	}
	const record = asRecord(parsed);
	if (!record) {
		throw new CommandCliError(`${context}: hunk returned an unexpected JSON payload`, 0, "");
	}
	return record;
}

function parseSession(value: unknown, context: string): RegisteredSession {
	const record = asRecord(value);
	if (!record) throw new CommandCliError(`${context}: malformed session entry`, 0, "");
	return {
		sessionId: requireString(record, "sessionId", context),
		pid: requireNumber(record, "pid", context),
		cwd: optionalString(record, "cwd") ?? "",
		repoRoot: optionalString(record, "repoRoot"),
		inputKind: optionalString(record, "inputKind"),
	};
}

function publicationFromSession(record: Record<string, unknown>): ReviewPublication | undefined {
	const snapshot = asRecord(record["snapshot"]);
	const state = snapshot ? asRecord(snapshot["state"]) : undefined;
	const publication = state ? asRecord(state["reviewPublication"]) : undefined;
	if (!publication) return undefined;
	const generation = publication["generation"];
	if (typeof generation !== "string" || generation.length === 0) return undefined;
	const stateRevision = optionalNumber(publication, "stateRevision");
	return stateRevision === undefined ? { generation } : { generation, stateRevision };
}

export interface SessionSnapshot {
	session: RegisteredSession;
	publication?: ReviewPublication;
}

export interface ReviewCapture {
	/** Verbatim `review` JSON from Hunk; passed through without reinterpretation. */
	review: Record<string, unknown>;
}

export interface ReloadResult {
	sessionId: string;
}

export interface CommentClearResult {
	removedCount?: number;
}

export class HunkCli {
	constructor(
		private readonly exec: ExecRunner,
		private readonly hunkPath: string,
	) {}

	async #run(args: string[], context: string, options?: HunkCliCallOptions): Promise<Record<string, unknown>> {
		const outcome = await this.exec(this.hunkPath, args, {
			timeoutMs: options?.timeoutMs ?? 5_000,
			signal: options?.signal,
		});
		if (outcome.code !== 0 || outcome.killed) {
			const detail = outcome.stderr.trim() || outcome.stdout.trim();
			throw new CommandCliError(
				outcome.killed ? `${context}: hunk call timed out` : `${context}: ${detail || "hunk call failed"}`,
				outcome.code,
				detail,
			);
		}
		return parseEnvelope(outcome.stdout, context);
	}

	async sessionList(options?: HunkCliCallOptions): Promise<RegisteredSession[]> {
		const envelope = await this.#run(["session", "list", "--json"], "session list", options);
		const sessions = envelope["sessions"];
		if (!Array.isArray(sessions)) {
			throw new CommandCliError("session list: malformed response", 0, "");
		}
		return sessions.map(entry => parseSession(entry, "session list"));
	}

	async sessionGet(sessionId: string, options?: HunkCliCallOptions): Promise<SessionSnapshot> {
		const envelope = await this.#run(["session", "get", sessionId, "--json"], "session get", options);
		const session = asRecord(envelope["session"]);
		if (!session) throw new CommandCliError("session get: malformed response", 0, "");
		return {
			session: parseSession(session, "session get"),
			publication: publicationFromSession(session),
		};
	}

	async sessionReview(sessionId: string, options?: HunkCliCallOptions): Promise<ReviewCapture> {
		const envelope = await this.#run(
			["session", "review", sessionId, "--include-notes", "--json"],
			"session review",
			options,
		);
		const review = asRecord(envelope["review"]);
		if (!review) throw new CommandCliError("session review: malformed response", 0, "");
		return { review };
	}

	async reload(
		sessionId: string,
		nestedArgs: string[],
		options?: HunkCliCallOptions,
	): Promise<ReloadResult> {
		const envelope = await this.#run(
			["session", "reload", sessionId, "--json", "--", ...nestedArgs],
			"session reload",
			options,
		);
		const result = asRecord(envelope["result"]);
		if (!result) throw new CommandCliError("session reload: malformed response", 0, "");
		const reloadedId = requireString(result, "sessionId", "session reload");
		if (reloadedId !== sessionId) {
			throw new CommandCliError("session reload: hunk reloaded a different session", 0, "");
		}
		return { sessionId: reloadedId };
	}

	async commentAdd(
		sessionId: string,
		request: CommentAddRequest,
		options?: HunkCliCallOptions,
	): Promise<CommentAddResult> {
		const args = ["session", "comment", "add", sessionId];
		// Value options use joined --opt=value form so a value binds to its
		// option lexically and can never be read as a flag.
		if (request.replyTo !== undefined) {
			args.push(`--reply-to=${request.replyTo}`);
		} else {
			if (!request.file) {
				throw new CommandCliError("comment add: line comments require a file path", 0, "");
			}
			args.push(`--file=${request.file}`);
			args.push(
				request.side === "old" ? `--old-line=${request.line}` : `--new-line=${request.line}`,
			);
		}
		args.push(`--summary=${request.summary}`);
		if (request.rationale !== undefined && request.rationale.length > 0) {
			args.push(`--rationale=${request.rationale}`);
		}
		args.push("--author=omp", "--json");
		const envelope = await this.#run(args, "comment add", options);
		const result = asRecord(envelope["result"]);
		if (!result) throw new CommandCliError("comment add: malformed response", 0, "");
		return {
			commentId: requireString(result, "commentId", "comment add"),
			filePath: optionalString(result, "filePath"),
			hunkIndex: optionalNumber(result, "hunkIndex"),
			side: optionalString(result, "side"),
			line: optionalNumber(result, "line"),
		};
	}

	async commentClearAll(sessionId: string, options?: HunkCliCallOptions): Promise<CommentClearResult> {
		const envelope = await this.#run(
			["session", "comment", "clear", sessionId, "--all", "--yes", "--json"],
			"comment clear",
			options,
		);
		const result = asRecord(envelope["result"]);
		if (!result) throw new CommandCliError("comment clear: malformed response", 0, "");
		return { removedCount: optionalNumber(result, "removedCount") };
	}
}
