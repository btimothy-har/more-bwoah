import { describe, expect, test } from "bun:test";
import { HerdrAbsentError, HerdrCli, HerdrRejectedError } from "./herdr-cli";
import { CommandCliError, type ExecOutcome, type ExecRunner, type ExecRunnerOptions } from "./exec";

interface FakeCall {
	args: string[];
	options?: ExecRunnerOptions;
}

function ok(result: unknown): ExecOutcome {
	return { stdout: JSON.stringify({ id: "cli:test", result }), stderr: "", code: 0, killed: false };
}

function fail(code: number, stderr: string): ExecOutcome {
	return { stdout: "", stderr, code, killed: false };
}

function runner(replyFor: (call: FakeCall) => ExecOutcome): { exec: ExecRunner; calls: FakeCall[] } {
	const calls: FakeCall[] = [];
	const exec: ExecRunner = async (_command, args, options) => {
		const call: FakeCall = { args, options };
		calls.push(call);
		return replyFor(call);
	};
	return { exec, calls };
}

const ABSENT = fail(1, JSON.stringify({ error: { code: "pane_not_found" } }));

describe("herdr cli boundaries", () => {
	test("paneList parses native pane identities", async () => {
		const { exec } = runner(() =>
			ok({
				panes: [
					{ pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1" },
					{ pane_id: "w1:p2" },
				],
			}),
		);
		const panes = await new HerdrCli(exec, "herdr").paneList("w1", 1_234);
		expect(panes).toEqual([
			{ paneId: "w1:p1", tabId: "w1:t1", workspaceId: "w1" },
			{ paneId: "w1:p2", tabId: undefined, workspaceId: undefined },
		]);
	});

	for (const [name, payload] of [
		["missing panes", {}],
		["non-array panes", { panes: { p1: true } }],
		["non-record pane entry", { panes: ["w1:p1"] }],
		["pane entry without pane id", { panes: [{ tab_id: "w1:t1" }] }],
		["pane entry with non-string tab id", { panes: [{ pane_id: "w1:p1", tab_id: 7 }] }],
		["pane entry with non-string workspace id", { panes: [{ pane_id: "w1:p1", workspace_id: 9 }] }],
	] as const) {
		test(`paneList rejects ${name} as indeterminate`, async () => {
			const { exec } = runner(() => ok(payload));
			await expect(new HerdrCli(exec, "herdr").paneList("w1")).rejects.toBeInstanceOf(CommandCliError);
		});
	}


	test("closePane rejects a non-ok structured result as indeterminate", async () => {
		const { exec } = runner(() => ok({ type: "would_close_workspace" }));
		await expect(new HerdrCli(exec, "herdr").closePane("w1:p1")).rejects.toBeInstanceOf(CommandCliError);
	});

	test("closePane surfaces proven pane_not_found absence", async () => {
		const { exec } = runner(() => ABSENT);
		await expect(new HerdrCli(exec, "herdr").closePane("w1:p1")).rejects.toBeInstanceOf(HerdrAbsentError);
	});

	test("pane run surfaces server_not_running as proven pre-submission rejection", async () => {
		const { exec } = runner(() => fail(1, JSON.stringify({ error: { code: "server_not_running" } })));
		const error = await new HerdrCli(exec, "herdr")
			.run(["pane", "run", "w1:p1", "true"], "pane run")
			.catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(HerdrRejectedError);
		expect((error as HerdrRejectedError).rejectCode).toBe("server_not_running");
	});

	test("pane run keeps a dropped connection and internal errors indeterminate", async () => {
		for (const outcome of [
			fail(1, JSON.stringify({ error: { code: "internal_error" } })),
			fail(1, "connection lost"),
			{ stdout: "", stderr: "", code: 1, killed: true },
		]) {
			const error = await new HerdrCli(runner(() => outcome).exec, "herdr")
				.run(["pane", "run", "w1:p1", "true"], "pane run")
				.catch((caught: unknown) => caught);
			expect(error).toBeInstanceOf(CommandCliError);
			expect(error).not.toBeInstanceOf(HerdrRejectedError);
			expect(error).not.toBeInstanceOf(HerdrAbsentError);
		}
	});

	test("paneState distinguishes proven absence from failure", async () => {
		const absent = runner(() => ABSENT);
		expect(await new HerdrCli(absent.exec, "herdr").paneState("w1:p1", 1_500)).toBeNull();

		const unreachable = runner(() => fail(1, "connection refused"));
		await expect(new HerdrCli(unreachable.exec, "herdr").paneState("w1:p1")).rejects.toBeInstanceOf(CommandCliError);

		const timedOut = runner(() => ({ stdout: "", stderr: "", code: 143, killed: true }));
		await expect(new HerdrCli(timedOut.exec, "herdr").paneState("w1:p1", 500)).rejects.toThrow("timed out");
	});

	test("paneProcessInfo normalizes omitted foreground_processes to an empty set", async () => {
		const { exec } = runner(() => ok({ process_info: { pane_id: "w1:p1", shell_pid: 42 } }));
		const info = await new HerdrCli(exec, "herdr").paneProcessInfo("w1:p1", 3_000);
		expect(info).toEqual({ shellPid: 42, foregroundPids: [] });
	});

	test("paneProcessInfo keeps well-formed present foreground data", async () => {
		const empty = runner(() => ok({ process_info: { pane_id: "w1:p1", foreground_processes: [] } }));
		expect(await new HerdrCli(empty.exec, "herdr").paneProcessInfo("w1:p1")).toEqual({
			shellPid: undefined,
			foregroundPids: [],
		});

		const populated = runner(() =>
			ok({ process_info: { pane_id: "w1:p1", foreground_processes: [{ pid: 7, name: "hunk" }, { pid: 9 }] } }),
		);
		expect(await new HerdrCli(populated.exec, "herdr").paneProcessInfo("w1:p1")).toEqual({
			shellPid: undefined,
			foregroundPids: [7, 9],
		});
	});

	for (const [name, info] of [
		["missing process_info pane id", { shell_pid: 42 }],
		["foreign process_info pane id", { pane_id: "w1:other" }],
		["explicit null foreground array", { pane_id: "w1:p1", foreground_processes: null }],
		["non-array foreground data", { pane_id: "w1:p1", foreground_processes: "7" }],
		["foreground entry without pid", { pane_id: "w1:p1", foreground_processes: [{ name: "hunk" }] }],
		["foreground entry with non-positive pid", { pane_id: "w1:p1", foreground_processes: [{ pid: 0 }] }],
	] as const) {
		test(`paneProcessInfo rejects ${name} as indeterminate`, async () => {
			const { exec } = runner(() => ok({ process_info: info }));
			await expect(new HerdrCli(exec, "herdr").paneProcessInfo("w1:p1")).rejects.toBeInstanceOf(CommandCliError);
		});
	}

});
