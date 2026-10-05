import { describe, expect, test } from "bun:test";
import { HerdrCli } from "./herdr-cli";
import { SessionNaming } from "./naming";
import type { ExecOutcome } from "./exec";

describe("naming shutdown", () => {
	for (const action of ["tab", "title"] as const) {
		test(`does not rename the ${action} after an identity lookup crosses shutdown`, async () => {
			let finishLookup!: (result: ExecOutcome) => void;
			let lookupStarted!: () => void;
			const started = new Promise<void>(resolve => { lookupStarted = resolve; });
			const lookup = new Promise<ExecOutcome>(resolve => { finishLookup = resolve; });
			const mutations: string[][] = [];
			const cli = new HerdrCli(async (_command, args) => {
				if (args[0] === "pane" && args[1] === "get") {
					lookupStarted();
					return lookup;
				}
				mutations.push(args);
				return { stdout: JSON.stringify({ result: { type: "ok" } }), stderr: "", code: 0, killed: false };
			}, "herdr");
			const logger = { debug() {}, info() {}, warn() {}, error() {} };
			const naming = new SessionNaming(cli, logger);
			const pending = action === "tab"
				? naming.initializeTab("w1:p1", "w1")
				: naming.syncPaneTitle("w1:p1", "w1", "Session name");
			await started;
			naming.stop();
			finishLookup({
				stdout: JSON.stringify({ result: { pane: { pane_id: "w1:p1", tab_id: "w1:t1", workspace_id: "w1" } } }),
				stderr: "", code: 0, killed: false,
			});
			await pending;
			expect(mutations).toEqual([]);
		});
	}
});
