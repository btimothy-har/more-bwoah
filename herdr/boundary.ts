/**
 * Shared boundary guards for external CLI payloads and filesystem paths.
 *
 * Single source for helpers that were duplicated across hunk/cli.ts,
 * hunk/diff-targets.ts, and hunk/companion.ts; import instead of re-copying.
 */

import * as nodeFs from "node:fs/promises";

/** Narrow an untrusted JSON value to a plain object record. */
export function asRecord(value: unknown): Record<string, unknown> | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

/** Resolve to the real filesystem path, falling back to the input on error. */
export async function canonicalPath(path: string): Promise<string> {
	try {
		return await nodeFs.realpath(path);
	} catch {
		return path;
	}
}

/** Test a caught filesystem error for Node's absent-path code. */
export function isEnoent(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
