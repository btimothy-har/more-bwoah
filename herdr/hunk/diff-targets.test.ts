import { afterEach, describe, expect, test } from "bun:test";
import * as nodeFs from "node:fs/promises";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import {
	hunkReloadArgs,
	listBranches,
	listRecentCommits,
	mergeBase,
	resolveCheckout,
	resolveCommitSha,
} from "./diff-targets";
import { FakeExec, canon, createTempRepo, headSha, type GitFixture } from "../test-helpers";

const cleaners: Array<() => Promise<void>> = [];
afterEach(async () => {
	while (cleaners.length > 0) {
		const clean = cleaners.pop();
		if (clean) await clean();
	}
});

async function repoWithBranches(): Promise<GitFixture> {
	const repo = await createTempRepo(["a", "b", "c"]);
	const run = async (args: string[]): Promise<string> => {
		const proc = Bun.spawn(["git", ...args], { cwd: repo.path, stdout: "pipe", stderr: "pipe" });
		const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		if (code !== 0) throw new Error(`git ${args.join(" ")} failed`);
		return stdout;
	};
	await run(["checkout", "-b", "feature"]);
	await Bun.write(nodePath.join(repo.path, "feat.txt"), "feature work\n");
	await run(["add", "."]);
	await run(["commit", "-m", "feature commit"]);
	// Diverge main with its own commit so merge-base != either tip.
	await run(["checkout", "main"]);
	await Bun.write(nodePath.join(repo.path, "main.txt"), "main-only work\n");
	await run(["add", "."]);
	await run(["commit", "-m", "main-only commit"]);
	// Remote-tracking duplicate + symbolic ref.
	await run(["update-ref", "refs/remotes/origin/main", (await run(["rev-parse", "main"])).trim()]);
	await run(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
	cleaners.push(repo.cleanup);
	return repo;
}

describe("diff targets", () => {
	test("resolveCheckout reports root and pinned head", async () => {
		const repo = await createTempRepo(["x"]);
		cleaners.push(repo.cleanup);
		const exec = new FakeExec().runner();
		const status = await resolveCheckout(exec, repo.path);
		expect(status.ok).toBe(true);
		if (status.ok) {
			expect(status.repoRoot).toBe(await canon(repo.path));
			expect(status.headSha).toBe(await headSha(repo.path));
		}
	});

	test("resolveCheckout reports not-git and unborn repositories", async () => {
		const plain = await nodeFs.mkdtemp(nodePath.join(nodeOs.tmpdir(), "hunk-dt-plain-"));
		cleaners.push(async () => nodeFs.rm(plain, { recursive: true, force: true }));
		const exec = new FakeExec().runner();
		const notGit = await resolveCheckout(exec, plain);
		expect(notGit).toEqual({ ok: false, reason: "not-git", detail: expect.any(String) });

		const unborn = await nodeFs.mkdtemp(nodePath.join(nodeOs.tmpdir(), "hunk-dt-unborn-"));
		cleaners.push(async () => nodeFs.rm(unborn, { recursive: true, force: true }));
		await Bun.spawn(["git", "init", "-b", "main"], { cwd: unborn, stdout: "ignore" }).exited;
		const status = await resolveCheckout(exec, unborn);
		expect(status.ok).toBe(false);
		if (!status.ok) expect(status.reason).toBe("unborn");
	});

	test("listBranches puts main first, dedupes remotes, and skips symbolic refs", async () => {
		const repo = await repoWithBranches();
		const branches = await listBranches(new FakeExec().runner(), repo.path);
		const labels = branches.map(branch => branch.label);
		expect(labels[0]).toBe("main");
		expect(labels).toContain("feature");
		expect(labels.filter(label => label === "main").length).toBe(1); // remote dup dropped
		expect(labels).not.toContain("origin/HEAD"); // symbolic ref dropped
		const mainChoice = branches.find(branch => branch.label === "main");
		expect(mainChoice?.fullRef).toBe("refs/heads/main");
	});

	test("listRecentCommits returns newest-first display rows and caps at 20", async () => {
		const repo = await createTempRepo(["x"]);
		cleaners.push(repo.cleanup);
		const run = async (args: string[]): Promise<void> => {
			const proc = Bun.spawn(["git", ...args], { cwd: repo.path, stdout: "pipe", stderr: "pipe" });
			if ((await proc.exited) !== 0) throw new Error("fixture commit failed");
		};
		for (let index = 0; index < 22; index += 1) {
			await Bun.write(nodePath.join(repo.path, `f${index}.txt`), `${index}\n`);
			await run(["add", "."]);
			await run(["commit", "-m", `commit ${index}`]);
		}
		const commits = await listRecentCommits(new FakeExec().runner(), repo.path);
		expect(commits.length).toBe(20);
		expect(commits[0]?.display).toBe(`${commits[0]?.sha.slice(0, 7)} commit 21`);
	});

	test("merge-base pins the divergence point and unrelated histories fail", async () => {
		const repo = await repoWithBranches();
		const exec = new FakeExec().runner();
		const mainSha = await resolveCommitSha(exec, repo.path, "refs/heads/main");
		const featureSha = await resolveCommitSha(exec, repo.path, "refs/heads/feature");
		const seedSha = await resolveCommitSha(exec, repo.path, "main~1");
		const base = await mergeBase(exec, repo.path, mainSha, featureSha);
		expect(base).toBe(seedSha);

		// Orphan branch: unrelated history.
		await Bun.spawn(["git", "checkout", "--orphan", "orphan"], { cwd: repo.path, stdout: "ignore", stderr: "ignore" }).exited;
		await Bun.spawn(["git", "commit", "--allow-empty", "-m", "orphan root"], {
			cwd: repo.path,
			stdout: "ignore",
			stderr: "ignore",
		}).exited;
		const orphanSha = await resolveCommitSha(exec, repo.path, "HEAD");
		await expect(mergeBase(exec, repo.path, orphanSha, mainSha)).rejects.toThrow();
	});

	test("hunkReloadArgs map scopes to pinned diff/show argv", () => {
		expect(hunkReloadArgs({ kind: "session", baseSha: "aaa" })).toEqual(["diff", "aaa", "--watch"]);
		expect(hunkReloadArgs({ kind: "branch", baseBranch: "refs/heads/main", baseSha: "bbb" })).toEqual([
			"diff",
			"bbb",
			"--watch",
		]);
		expect(hunkReloadArgs({ kind: "commit", commitSha: "ccc" })).toEqual(["show", "ccc", "--watch"]);
	});
});
