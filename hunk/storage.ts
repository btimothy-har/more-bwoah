/**
 * Durable extension state: the workspace ownership record and the rolling
 * review archive. Both are written atomically (stage temp sibling, verify byte
 * count, restrictive permissions, rename) so a failed write never destroys the
 * previous good file. Nothing here is a note journal: the ownership record
 * proves which pane the extension created, and the archive is a read-only
 * export of the live Hunk review.
 */

import * as nodeFs from "node:fs/promises";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";

export interface CompanionRecord {
	version: 1;
	socketPath: string;
	workspaceId: string;
	ownerPaneId: string;
	tabId: string;
	paneId: string;
	shellPid?: number;
	repoRoot: string;
	hunkSessionId?: string;
	hunkPid?: number;
}

export class StorageError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "StorageError";
	}
}

type EnvLike = Record<string, string | undefined>;

function isEnoent(error: unknown): boolean {
	return (
		typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
	);
}

/** Stage, verify, and atomically publish one JSON document. */
export async function atomicWriteJson(filePath: string, value: unknown, mode = 0o600): Promise<void> {
	const json = `${JSON.stringify(value, null, "\t")}\n`;
	const expectedBytes = Buffer.byteLength(json);
	const directory = nodePath.dirname(filePath);
	await nodeFs.mkdir(directory, { recursive: true, mode: 0o700 });
	const tempPath = `${filePath}.tmp-${crypto.randomUUID()}`;
	try {
		const writtenBytes = await Bun.write(tempPath, json);
		if (writtenBytes !== expectedBytes) {
			throw new StorageError(`short write: ${writtenBytes} of ${expectedBytes} bytes`);
		}
		const file = Bun.file(tempPath);
		if (file.size !== expectedBytes) {
			throw new StorageError(`size mismatch after write: ${file.size} of ${expectedBytes} bytes`);
		}
		await nodeFs.chmod(tempPath, mode);
		await nodeFs.rename(tempPath, filePath);
	} catch (error) {
		await nodeFs.rm(tempPath, { force: true });
		throw error;
	}
}

/** Read one JSON document; `null` when absent, throw on malformed content. */
export async function readJsonFile(filePath: string): Promise<unknown | null> {
	let text: string;
	try {
		text = await Bun.file(filePath).text();
	} catch (error) {
		if (isEnoent(error)) return null;
		throw error;
	}
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw new StorageError(`malformed JSON in ${filePath}`);
	}
}

export function companionRecordPath(env: EnvLike, socketPath: string, workspaceId: string): string {
	const base =
		env.XDG_STATE_HOME !== undefined && nodePath.isAbsolute(env.XDG_STATE_HOME)
			? env.XDG_STATE_HOME
			: nodePath.join(nodeOs.homedir(), ".local", "state");
	const key = new Bun.CryptoHasher("sha256")
		.update(JSON.stringify([socketPath, workspaceId]))
		.digest("hex");
	return nodePath.join(base, "more-bwoah", "hunk", `${key}.json`);
}

function requireText(value: unknown, field: string, filePath: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new StorageError(`malformed companion record at ${filePath}: invalid "${field}"`);
	}
	return value;
}

function optionalPid(value: unknown, field: string, filePath: string): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
		throw new StorageError(`malformed companion record at ${filePath}: invalid "${field}"`);
	}
	return value;
}

/** Validate a stored ownership record; throw (never silently repair) on malformed shape. */
export function parseCompanionRecord(value: unknown, filePath: string): CompanionRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new StorageError(`malformed companion record at ${filePath}`);
	}
	const record: Record<string, unknown> = {};
	for (const field of [
		"version",
		"socketPath",
		"workspaceId",
		"ownerPaneId",
		"tabId",
		"paneId",
		"shellPid",
		"repoRoot",
		"hunkSessionId",
		"hunkPid",
	] as const) {
		if (field in value) record[field] = value[field as keyof typeof value];
	}
	if (record.version !== 1) {
		throw new StorageError(`unsupported companion record version at ${filePath}`);
	}
	const shellPid = optionalPid(record.shellPid, "shellPid", filePath);
	const hunkPid = optionalPid(record.hunkPid, "hunkPid", filePath);
	const hunkSessionId =
		record.hunkSessionId === undefined
			? undefined
			: requireText(record.hunkSessionId, "hunkSessionId", filePath);
	return {
		version: 1,
		socketPath: requireText(record.socketPath, "socketPath", filePath),
		workspaceId: requireText(record.workspaceId, "workspaceId", filePath),
		ownerPaneId: requireText(record.ownerPaneId, "ownerPaneId", filePath),
		tabId: requireText(record.tabId, "tabId", filePath),
		paneId: requireText(record.paneId, "paneId", filePath),
		shellPid,
		repoRoot: requireText(record.repoRoot, "repoRoot", filePath),
		hunkSessionId,
		hunkPid,
	};
}

export async function readCompanionRecord(filePath: string): Promise<CompanionRecord | null> {
	const value = await readJsonFile(filePath);
	if (value === null) return null;
	return parseCompanionRecord(value, filePath);
}

export async function writeCompanionRecord(filePath: string, record: CompanionRecord): Promise<void> {
	await atomicWriteJson(filePath, record, 0o600);
}
