import { afterEach, describe, expect, test } from "bun:test";
import * as nodeFs from "node:fs/promises";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import {
	StorageError,
	atomicWriteJson,
	companionRecordPath,
	parseCompanionRecord,
	readCompanionRecord,
	readJsonFile,
	writeCompanionRecord,
} from "./storage";

const cleaners: Array<() => Promise<void>> = [];
afterEach(async () => {
	while (cleaners.length > 0) {
		const clean = cleaners.pop();
		if (clean) await clean();
	}
});

async function tempDir(): Promise<string> {
	const dir = await nodeFs.mkdtemp(nodePath.join(nodeOs.tmpdir(), "hunk-storage-"));
	cleaners.push(async () => nodeFs.rm(dir, { recursive: true, force: true }));
	return dir;
}

describe("storage", () => {
	test("atomicWriteJson replaces content atomically with restrictive permissions", async () => {
		const dir = await tempDir();
		const filePath = nodePath.join(dir, "nested", "state.json");
		await atomicWriteJson(filePath, { v: 1 });
		expect(JSON.parse(await nodeFs.readFile(filePath, "utf8"))).toEqual({ v: 1 });
		const firstMode = (await nodeFs.stat(filePath)).mode & 0o777;
		expect(firstMode).toBe(0o600);

		await atomicWriteJson(filePath, { v: 2 });
		expect(JSON.parse(await nodeFs.readFile(filePath, "utf8"))).toEqual({ v: 2 });
		// No temp siblings left behind.
		const siblings = (await nodeFs.readdir(nodePath.dirname(filePath))).filter(name => name.includes(".tmp-"));
		expect(siblings).toEqual([]);
	});

	test("failed writes preserve the previous file and leave no temp files", async () => {
		const dir = await tempDir();
		const filePath = nodePath.join(dir, "state.json");
		await atomicWriteJson(filePath, { good: true });
		const original = await nodeFs.readFile(filePath, "utf8");

		// Make the directory read-only so staging the temp file fails.
		await nodeFs.chmod(dir, 0o500);
		try {
			await expect(atomicWriteJson(filePath, { bad: true })).rejects.toThrow();
		} finally {
			await nodeFs.chmod(dir, 0o700);
		}
		expect(await nodeFs.readFile(filePath, "utf8")).toBe(original);
		const leftovers = (await nodeFs.readdir(dir)).filter(name => name.includes(".tmp-"));
		expect(leftovers).toEqual([]);
	});

	test("readJsonFile: null when missing, StorageError when malformed", async () => {
		const dir = await tempDir();
		expect(await readJsonFile(nodePath.join(dir, "absent.json"))).toBeNull();

		const malformed = nodePath.join(dir, "broken.json");
		await Bun.write(malformed, "{not json");
		await expect(readJsonFile(malformed)).rejects.toBeInstanceOf(StorageError);
	});

	test("companionRecordPath honors XDG_STATE_HOME and separates sockets/workspaces", () => {
		const env = { XDG_STATE_HOME: "/tmp/state-home" };
		const a = companionRecordPath(env, "/sock-1", "w1");
		expect(a.startsWith("/tmp/state-home/more-bwoah/hunk/")).toBe(true);

		const sameContents = companionRecordPath(env, "/sock-1", "w1");
		expect(a).toBe(sameContents);
		const otherSocket = companionRecordPath(env, "/sock-2", "w1");
		const otherWorkspace = companionRecordPath(env, "/sock-1", "w2");
		expect(a).not.toBe(otherSocket);
		expect(a).not.toBe(otherWorkspace);

		const fallback = companionRecordPath({}, "/s", "w");
		expect(fallback.startsWith(nodePath.join(nodeOs.homedir(), ".local", "state", "more-bwoah", "hunk"))).toBe(true);
	});

	test("record round-trip validates shape and rejects malformed records", async () => {
		const dir = await tempDir();
		const filePath = nodePath.join(dir, "record.json");
		const record = {
			version: 1,
			socketPath: "/s",
			workspaceId: "w1",
			ownerPaneId: "w1:p0",
			tabId: "w1:t1",
			paneId: "w1:p1",
			shellPid: 42,
			repoRoot: "/repo",
			hunkSessionId: "sess",
			hunkPid: 7,
		};
		await writeCompanionRecord(filePath, record);
		expect(await readCompanionRecord(filePath)).toEqual(record);

		await Bun.write(filePath, JSON.stringify({ ...record, version: 2 }));
		await expect(readCompanionRecord(filePath)).rejects.toBeInstanceOf(StorageError);

		await Bun.write(filePath, JSON.stringify({ ...record, paneId: "" }));
		await expect(readCompanionRecord(filePath)).rejects.toBeInstanceOf(StorageError);

		await Bun.write(filePath, JSON.stringify({ ...record, hunkPid: "seven" }));
		await expect(readCompanionRecord(filePath)).rejects.toBeInstanceOf(StorageError);

		await Bun.write(filePath, "not json at all");
		await expect(readCompanionRecord(filePath)).rejects.toBeInstanceOf(StorageError);
	});

	test("parseCompanionRecord accepts records without optional process fields", () => {
		const parsed = parseCompanionRecord(
			{
				version: 1,
				socketPath: "/s",
				workspaceId: "w1",
				ownerPaneId: "w1:p0",
				tabId: "w1:t1",
				paneId: "w1:p1",
				repoRoot: "/repo",
			},
			"/tmp/record.json",
		);
		expect(parsed.shellPid).toBeUndefined();
		expect(parsed.hunkSessionId).toBeUndefined();
		expect(parsed.hunkPid).toBeUndefined();
	});
});
