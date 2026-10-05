/**
 * Shared injected-runtime contracts: host environment shape, managed timers,
 * logger surface, notification levels, and the feature-gating error thrown
 * when the extension runs outside an eligible Herdr workspace. Imports
 * nothing.
 */

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

export class CompanionUnavailable extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CompanionUnavailable";
	}
}
