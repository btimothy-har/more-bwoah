/**
 * Adapter over the host's native process-owned `FileLock` (`@oh-my-pi/pi-natives`).
 *
 * The primary role is claimed exactly once per process from this primitive;
 * there is no fallback implementation and no second registry. Ownership lives
 * in the handle, not the file: the lock pathname must persist for the life of
 * the machine (removing it can admit two primaries on flock-backed platforms)
 * and ownership ends at `release()`, garbage collection, or process exit.
 */

import * as nodeFs from "node:fs/promises";
import * as nodePath from "node:path";
import type { CompanionLogger } from "./contracts";

/** Admission outcome for one omp process in a Herdr workspace. */
export type ControllerRole = "pending" | "primary" | "secondary";

export interface PrimaryLock {
	/** Whether this handle currently owns the primary role for the path. */
	readonly acquired: boolean;
	/** Idempotent; releases only this handle's ownership. */
	release(): void;
}

/** Injectable so tests model contention and native failures without the host. */
export type PrimaryLockFactory = (path: string, logger: CompanionLogger) => Promise<PrimaryLock>;

interface NativeFileLockHandle {
	readonly acquired: boolean;
	release(): void;
}

interface NativeFileLockModule {
	FileLock?: {
		tryAcquire(path: string): NativeFileLockHandle;
	};
}

class HostPrimaryLock implements PrimaryLock {
	constructor(
		private readonly handle: NativeFileLockHandle,
		private readonly exitRelease: (() => void) | null,
		private readonly logger: CompanionLogger,
	) {}

	get acquired(): boolean {
		return this.handle.acquired;
	}

	release(): void {
		if (this.exitRelease) process.off("exit", this.exitRelease);
		try {
			this.handle.release();
		} catch (error) {
			this.logger.debug("primary lock release failed", { error });
		}
	}
}

/**
 * Try to claim the primary lock at `path` without blocking. The returned
 * handle reports the outcome via `acquired`; callers decide the role and
 * release losing handles themselves. A winning handle is strongly referenced
 * by a process `exit` hook that releases it synchronously at actual process
 * exit, so garbage collection cannot drop ownership and `session_shutdown`
 * cannot strand the workspace without a primary.
 */
export async function acquireHostPrimaryLock(path: string, logger: CompanionLogger): Promise<PrimaryLock> {
	// The lock file itself is never created, unlinked, or truncated here: the
	// native handle owns a persistent flock inode at this pathname.
	await nodeFs.mkdir(nodePath.dirname(path), { recursive: true, mode: 0o700 });
	// Dynamic import is required: the host reroutes this specifier to its
	// bundled in-process natives module, so a static import would fail package
	// resolution in this self-contained extension and in injected-factory tests.
	const natives = (await import("@oh-my-pi/pi-natives")) as NativeFileLockModule | undefined;
	const FileLock = natives?.FileLock;
	if (!FileLock || typeof FileLock.tryAcquire !== "function") {
		throw new Error("Herdr integration requires the host FileLock API.");
	}
	const handle = FileLock.tryAcquire(path);
	if (!handle.acquired) {
		return new HostPrimaryLock(handle, null, logger);
	}
	const releaseAtExit = (): void => {
		try {
			handle.release();
		} catch (error) {
			logger.debug("primary lock release failed at process exit", { error });
		}
	};
	// The exit-listener table is the strong reference that keeps the native
	// handle out of the collector until the process is really gone.
	process.once("exit", releaseAtExit);
	return new HostPrimaryLock(handle, releaseAtExit, logger);
}
