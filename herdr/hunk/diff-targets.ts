/**
 * Git discovery for /diff selectors and ReviewScope → Hunk reload argv.
 *
 * Scope semantics (verified against hunk 0.22.0's git adapter):
 * - session/branch scopes diff a pinned base SHA against the live worktree, so
 *   checkpoint commits, staged, unstaged, and untracked changes all show.
 *   `diff main...HEAD` would exclude uncommitted work; `diff main` would
 *   compare against main's tip instead of the divergence point — both wrong
 *   for this product, hence merge-base resolution to a fixed SHA.
 * - commit scope pins one commit (`hunk show <sha>`), immune to HEAD movement.
 */

import { canonicalPath } from "../boundary";
import { CommandCliError, type ExecRunner } from "../exec";

export type ReviewScope =
	| { kind: "session"; baseSha: string }
	| { kind: "branch"; baseBranch: string; baseSha: string }
	| { kind: "commit"; commitSha: string };

export interface BranchChoice {
	label: string;
	fullRef: string;
}

export interface CommitChoice {
	sha: string;
	display: string;
}

export type CheckoutStatus =
	| { ok: true; repoRoot: string; headSha: string }
	| { ok: false; reason: "not-git" | "unborn"; detail: string };

const GIT_TIMEOUT_MS = 5_000;

function firstLine(text: string): string {
	const line = text.trim().split("\n", 1)[0] ?? "";
	return line.trim();
}

function sanitizeControl(text: string): string {
	// Strip C0/C1 control characters from git-supplied display text; the
	// underlying SHA/ref values are always carried separately.
	// eslint-disable-next-line no-control-regex
	return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
}

async function git(exec: ExecRunner, cwd: string, args: string[]): Promise<string> {
	const outcome = await exec("git", args, { cwd, timeoutMs: GIT_TIMEOUT_MS });
	if (outcome.code !== 0 || outcome.killed) {
		const detail = firstLine(outcome.stderr) || `git ${args[0]} failed`;
		throw new CommandCliError(detail, outcome.code, outcome.stderr);
	}
	return outcome.stdout;
}

export async function resolveCheckout(exec: ExecRunner, cwd: string): Promise<CheckoutStatus> {
	let rootOutcome: string;
	try {
		rootOutcome = await git(exec, cwd, ["rev-parse", "--show-toplevel"]);
	} catch (error) {
		return {
			ok: false,
			reason: "not-git",
			detail: error instanceof Error ? error.message : "not a git repository",
		};
	}
	const repoRoot = await canonicalPath(rootOutcome.trim());
	let headSha: string;
	try {
		headSha = await git(exec, cwd, ["rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"]);
	} catch (error) {
		return {
			ok: false,
			reason: "unborn",
			detail: error instanceof Error ? error.message : "no commits yet",
		};
	}
	return { ok: true, repoRoot, headSha: headSha.trim() };
}

export async function resolveCommitSha(exec: ExecRunner, cwd: string, ref: string): Promise<string> {
	const out = await git(exec, cwd, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
	return out.trim();
}

export async function mergeBase(
	exec: ExecRunner,
	cwd: string,
	baseSha: string,
	headSha: string,
): Promise<string> {
	const out = await git(exec, cwd, ["merge-base", baseSha, headSha]);
	return out.trim();
}

/**
 * List local and remote branches without fetching. Symbolic refs (e.g.
 * refs/remotes/origin/HEAD) are excluded; a remote branch sharing a short name
 * with a local one is dropped in favor of the local entry. `main` sorts first
 * when present.
 */
export async function listBranches(exec: ExecRunner, cwd: string): Promise<BranchChoice[]> {
	const out = await git(exec, cwd, [
		"for-each-ref",
		"--format=%(refname)%09%(refname:short)%09%(symref)",
		"refs/heads",
		"refs/remotes",
	]);
	const seenLabels = new Set<string>();
	const choices: BranchChoice[] = [];
	for (const line of out.split("\n")) {
		if (line.trim().length === 0) continue;
		const [fullRef, shortName, symref] = line.split("\t");
		if (!fullRef || !shortName || (symref !== undefined && symref.trim().length > 0)) continue;
		// refs/heads precedes refs/remotes in for-each-ref output, so the first
		// occurrence of a short name is the local branch when both exist.
		if (seenLabels.has(shortName)) continue;
		seenLabels.add(shortName);
		choices.push({ label: shortName, fullRef });
	}
	choices.sort((a, b) => {
		if (a.label === "main") return -1;
		if (b.label === "main") return 1;
		return a.label.localeCompare(b.label);
	});
	return choices;
}

/** 20 most recent commits reachable from HEAD, oldest-display last. */
export async function listRecentCommits(exec: ExecRunner, cwd: string): Promise<CommitChoice[]> {
	const out = await git(exec, cwd, ["log", "-20", "--format=%H%x09%s"]);
	const commits: CommitChoice[] = [];
	for (const line of out.split("\n")) {
		if (line.trim().length === 0) continue;
		const separator = line.indexOf("\t");
		if (separator <= 0) continue;
		const sha = line.slice(0, separator);
		const subject = sanitizeControl(line.slice(separator + 1));
		commits.push({ sha, display: `${sha.slice(0, 7)} ${subject}` });
	}
	return commits;
}

export function hunkReloadArgs(scope: ReviewScope): string[] {
	if (scope.kind === "commit") return ["show", scope.commitSha, "--watch"];
	return ["diff", scope.baseSha, "--watch"];
}
