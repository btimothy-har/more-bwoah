/**
 * CLI-neutral process-execution vocabulary shared by the hunk, herdr, and git
 * command wrappers. Imports nothing.
 */

export interface ExecOutcome {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
}

export interface ExecRunnerOptions {
	cwd?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
}

export type ExecRunner = (
	command: string,
	args: string[],
	options?: ExecRunnerOptions,
) => Promise<ExecOutcome>;

/**
 * CLI-neutral failure for any wrapped external command (hunk, herdr, git):
 * carries exit code and stderr so callers can classify without instanceof
 * per-CLI hierarchies.
 */
export class CommandCliError extends Error {
	constructor(
		message: string,
		readonly exitCode: number,
		readonly stderrText: string,
	) {
		super(message);
		this.name = "CommandCliError";
	}
}
