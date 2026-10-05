/**
 * One-time own-tab naming and primary pane-title sync for the omp agent pane.
 *
 * Herdr 0.9.3 projects custom names and generated numeric names into the same
 * `label`, so there is no default-label heuristic: every eligible omp process
 * renames its own tab to `omp` exactly once per process launch (a later
 * manual rename then persists for that process's lifetime). Afterwards, only
 * primary lifecycle events sync the pane title via `pane rename`; the managed
 * diff child is named once at creation and is never retouched here.
 */

import type { CompanionLogger } from "./contracts";
import { HerdrCli } from "./herdr-cli";

const AGENT_TAB_LABEL = "omp";
const CLEAR_FLAG = "--clear";

export class SessionNaming {
	#lastAppliedTitle: string | undefined;
	#titleQueue: Promise<void> = Promise.resolve();
	#warnedLiteralClear = false;
	#stopped = false;

	stop(): void {
		this.#stopped = true;
	}

	constructor(
		private readonly cli: HerdrCli,
		private readonly logger: CompanionLogger,
	) {}

	/**
	 * Rename the tab hosting this process's own pane to `omp`. Validates the
	 * pane/workspace/tab identity through `pane get` first; identity mismatch,
	 * proven absence, or transport failure logs and returns (or rejects) so the
	 * caller's one-time marker — not this method — decides retry policy.
	 */
	async initializeTab(paneId: string, workspaceId: string): Promise<void> {
		if (this.#stopped) return;
		const pane = await this.cli.paneState(paneId);
		if (this.#stopped) return;
		if (pane === null) {
			this.logger.debug("skipping own-tab naming: pane is gone", { paneId });
			return;
		}
		if (pane.workspaceId !== workspaceId || pane.tabId === undefined) {
			this.logger.debug("skipping own-tab naming: pane identity mismatch", { paneId, workspaceId });
			return;
		}
		await this.cli.run(["tab", "rename", pane.tabId, AGENT_TAB_LABEL], "tab rename");
	}

	/**
	 * Publish the session name as the pane title. Overlapping updates serialize
	 * through one queue, already-applied titles are skipped, and an empty or
	 * missing title clears the title. A literal `--clear` cannot be expressed
	 * as a CLI label on herdr 0.9.3 and is refused with a single diagnostic.
	 */
	async syncPaneTitle(paneId: string, workspaceId: string, title: string | undefined): Promise<void> {
		if (this.#stopped) return;
		const label = title !== undefined && title.length > 0 ? title : undefined;
		if (label === CLEAR_FLAG) {
			if (!this.#warnedLiteralClear) {
				this.#warnedLiteralClear = true;
				this.logger.warn("refusing pane title equal to the clear flag; herdr cannot express it literally");
			}
			return;
		}
		const attempt = this.#titleQueue.then(() => this.#applyTitle(paneId, workspaceId, label));
		// Overlapping callers coalesce behind one serialized queue; a failure
		// must reject only its own caller, not poison the shared chain.
		this.#titleQueue = attempt.then(
			() => undefined,
			() => undefined,
		);
		await attempt;
	}

	async #applyTitle(paneId: string, workspaceId: string, label: string | undefined): Promise<void> {
		if (this.#stopped) return;
		const requested = label ?? CLEAR_FLAG;
		if (requested === this.#lastAppliedTitle) return;
		const pane = await this.cli.paneState(paneId);
		if (this.#stopped) return;
		if (pane === null) {
			this.logger.debug("skipping pane title sync: pane is gone", { paneId });
			return;
		}
		if (pane.workspaceId !== workspaceId) {
			this.logger.debug("skipping pane title sync: pane identity mismatch", { paneId, workspaceId });
			return;
		}
		await this.cli.run(
			label === undefined ? ["pane", "rename", paneId, CLEAR_FLAG] : ["pane", "rename", paneId, label],
			"pane rename",
		);
		this.#lastAppliedTitle = requested;
	}
}
