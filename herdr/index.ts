/**
 * Herdr companion extension for omp.
 *
 * One primary omp controller per herdr workspace manages one persistent Hunk
 * diff child; additional omp processes in the same workspace are secondaries
 * that never manage, touch, or replace that child. `/diff` (selectors only)
 * switches the primary's review scope; `hunk_review` pulls the live review and
 * every saved note on demand; `hunk_comment` adds line notes and in-thread
 * replies. A 30-second rolling archive exports the published review under the
 * omp session's artifact home; primary exit soft-retires the integration and
 * the next primary replaces the retained child by recorded IDs.
 *
 * Registration only happens at factory time; subprocess/UI work strictly runs
 * inside runtime handlers (`pi.exec` throws before `ExtensionRunner.initialize`).
 */

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import guidance from "./hunk/guidance.md" with { type: "text" };
import {
	CompanionController,
	eligibleEnv,
	PENDING_OWNERSHIP_MESSAGE,
	SECONDARY_INACTIVE_MESSAGE,
	type CompanionDeps,
	type ParentSnapshot,
	type SessionContext,
} from "./hunk/companion";
import { acquireHostPrimaryLock, type PrimaryLockFactory } from "./primary-lock";
import { SessionNaming } from "./naming";
import { HerdrCli } from "./herdr-cli";
import { CompanionUnavailable, type CompanionLogger, type CompanionTimers, type NotifyLevel } from "./contracts";
import { CommandCliError } from "./exec";
import { listBranches, listRecentCommits, type BranchChoice, type CommitChoice } from "./hunk/diff-targets";

const SCOPE_LABELS = {
	session: "Full session",
	branch: "Against a base branch",
	commit: "Specific commit",
} as const;

const SCOPE_INDEX: Record<string, number> = {
	[SCOPE_LABELS.session]: 0,
	[SCOPE_LABELS.branch]: 1,
	[SCOPE_LABELS.commit]: 2,
};

const ARCHIVE_INTERVAL_MS = 30_000;
const LIFECYCLE_INTERVAL_MS = 3_000;
const ADMISSION_INTERVAL_MS = 3_000;
const SHUTDOWN_BUDGET_MS = 1_500;
const REVIEW_SPILL_BYTES = 16 * 1024;

type UiLike = {
	notify(message: string, level?: NotifyLevel): void;
	select(
		title: string,
		options: Array<{ label: string; description?: string }>,
		dialogOptions?: { initialIndex?: number },
	): Promise<string | undefined>;
};

interface Runtime {
	controller: CompanionController;
	naming: SessionNaming;
	ui: UiLike | null;
	timers: CompanionTimers | null;
	lifecycleHandle: unknown;
	archiveHandle: unknown;
	admissionHandle: unknown;
	admissionInFlight: boolean;
	namingAttempted: boolean;
	stopped: boolean;
}

/** Host context surface this extension consumes; satisfied by every runtime ctx. */
interface HostContext {
	agent: { kind: string };
	mode: string;
	sessionManager: { getSessionId(): string; getArtifactsDir(): string | null; getCwd(): string };
}

function createLogger(pi: ExtensionAPI): CompanionLogger {
	// pi.logger's surface is host-provided; guard each level defensively.
	const sink = (pi as unknown as { logger?: Record<string, ((message: string, detail?: unknown) => void) | undefined> })
		.logger;
	return {
		debug(message, detail) {
			sink?.debug?.(message, detail);
		},
		info(message, detail) {
			sink?.info?.(message, detail);
		},
		warn(message, detail) {
			sink?.warn?.(message, detail);
		},
		error(message, detail) {
			sink?.error?.(message, detail);
		},
	};
}

function unavailableReason(ctx: { agent: { kind: string }; mode: string }): string | undefined {
	if (ctx.agent.kind !== "main") return "Herdr integration runs only in the main session.";
	if (ctx.mode !== "tui") return "Herdr integration requires an interactive TUI session; headless mode is disabled.";
	if (!eligibleEnv(process.env)) return "Not running inside a herdr workspace; skipping Herdr integration.";
	return undefined;
}

function uiFrom(ctx: unknown): UiLike | null {
	const candidate = ctx as { ui?: Partial<UiLike>; mode?: string };
	if (candidate.mode !== "tui" || typeof candidate.ui?.select !== "function") return null;
	return {
		notify: (message, level) => candidate.ui?.notify?.(message, level),
		select: (title, options, dialogOptions) => candidate.ui.select(title, options, dialogOptions),
	};
}

function errorText(error: unknown): string {
	if (error instanceof CompanionUnavailable) return error.message;
	if (error instanceof CommandCliError) return `CLI error: ${error.message}`;
	return error instanceof Error ? error.message : "Unexpected Herdr companion failure.";
}

export function createHerdrExtension(tryPrimaryLock: PrimaryLockFactory): (pi: ExtensionAPI) => void {
	return (pi: ExtensionAPI) => {
		const deps: CompanionDeps = {
			exec: (command, args, options) =>
				pi.exec(command, args, {
					cwd: options?.cwd,
					timeout: options?.timeoutMs,
					signal: options?.signal,
				}),
			env: process.env,
			timers: {
				setInterval: () => undefined,
				clearInterval: () => undefined,
				setTimeout: () => undefined,
				clearTimeout: () => undefined,
				now: () => Date.now(),
			},
			logger: createLogger(pi),
			notify: (message, level) => runtime.ui?.notify(message, level),
			hunkPath: "hunk",
			tryPrimaryLock,
			controllerPid: process.pid,
			isProcessAlive: pid => {
				try {
					process.kill(pid, 0);
					return true;
				} catch (error) {
					// ESRCH proves the pid is gone; any other probe failure is indeterminate.
					return error instanceof Error && "code" in error && error.code === "ESRCH" ? false : "unknown";
				}
			},
		};
		const runtime: Runtime = {
			controller: new CompanionController(deps),
			naming: new SessionNaming(new HerdrCli(deps.exec, process.env.HERDR_BIN_PATH ?? "herdr"), deps.logger),
			ui: null,
			timers: null,
			lifecycleHandle: undefined,
			archiveHandle: undefined,
			admissionHandle: undefined,
			admissionInFlight: false,
			namingAttempted: false,
			stopped: false,
		};

		const liveContext = (ctx: HostContext): SessionContext => ({
			ompSessionId: ctx.sessionManager.getSessionId(),
			artifactsDir: ctx.sessionManager.getArtifactsDir(),
			cwd: ctx.sessionManager.getCwd(),
		});

		const ownPaneIdentity = (): { paneId: string; workspaceId: string } | undefined => {
			const paneId = process.env.HERDR_PANE_ID;
			const workspaceId = process.env.HERDR_WORKSPACE_ID;
			if (paneId === undefined || paneId.length === 0) return undefined;
			if (workspaceId === undefined || workspaceId.length === 0) return undefined;
			return { paneId, workspaceId };
		};

		const attachTimers = (timers: CompanionTimers): void => {
			runtime.timers = timers;
			deps.timers = timers;
		};

		const stopTicks = (): void => {
			runtime.stopped = true;
			runtime.naming.stop();
			if (runtime.timers !== null) {
				if (runtime.lifecycleHandle !== undefined) runtime.timers.clearInterval(runtime.lifecycleHandle);
				if (runtime.archiveHandle !== undefined) runtime.timers.clearInterval(runtime.archiveHandle);
				if (runtime.admissionHandle !== undefined) runtime.timers.clearInterval(runtime.admissionHandle);
			}
			runtime.lifecycleHandle = undefined;
			runtime.archiveHandle = undefined;
			runtime.admissionHandle = undefined;
		};

		const syncOwnTitle = async (): Promise<void> => {
			const identity = ownPaneIdentity();
			if (identity === undefined || runtime.stopped) return;
			if (!("getSessionName" in pi) || typeof pi.getSessionName !== "function") {
				deps.logger.debug("host exposes no session name; skipping pane title sync");
				return;
			}
			const name: unknown = pi.getSessionName();
			const title = typeof name === "string" ? name : undefined;
			try {
				await runtime.naming.syncPaneTitle(identity.paneId, identity.workspaceId, title);
			} catch (error) {
				// Naming errors never disable primary reconciliation.
				deps.logger.debug("pane title sync failed", { error });
			}
		};

		const startNaming = (): void => {
			const identity = ownPaneIdentity();
			if (identity === undefined || runtime.stopped || runtime.namingAttempted) return;
			// The one-time attempt is marked before awaiting: ticks, /new, resume,
			// branch, and /diff never reissue it, even after a failed rename.
			runtime.namingAttempted = true;
			runtime.naming.initializeTab(identity.paneId, identity.workspaceId).catch(error => {
				deps.logger.warn("own-tab naming failed", { error });
			});
		};

		const ensureAdmissionInterval = (): void => {
			if (runtime.timers === null || runtime.admissionHandle !== undefined || runtime.stopped) return;
			runtime.admissionHandle = runtime.timers.setInterval(() => {
				void startAdmission();
			}, ADMISSION_INTERVAL_MS);
		};

		const clearAdmissionInterval = (): void => {
			if (runtime.timers !== null && runtime.admissionHandle !== undefined) {
				runtime.timers.clearInterval(runtime.admissionHandle);
			}
			runtime.admissionHandle = undefined;
		};

		// The host ctx that drives live identity; captured once at session_start.
		let lifecycleCtx: HostContext | undefined;

		const runLifecycleTick = async (): Promise<void> => {
			const ctx = lifecycleCtx;
			if (ctx === undefined || runtime.stopped || unavailableReason(ctx)) return;
			try {
				await syncOwnTitle();
				await runtime.controller.reconcile(liveContext(ctx));
			} catch (error) {
				deps.logger.debug("lifecycle tick failed", { error });
			}
		};

		const runArchiveTick = async (): Promise<void> => {
			const ctx = lifecycleCtx;
			if (ctx === undefined || runtime.stopped || unavailableReason(ctx)) return;
			try {
				await runtime.controller.snapshotNow({ deadlineMs: 10_000 });
			} catch (error) {
				deps.logger.debug("archive tick failed", { error });
			}
		};

		const beginPrimaryDuties = async (): Promise<void> => {
			const timers = runtime.timers;
			if (timers === null || runtime.lifecycleHandle !== undefined || runtime.stopped) return;
			runtime.lifecycleHandle = timers.setInterval(() => {
				void runLifecycleTick();
			}, LIFECYCLE_INTERVAL_MS);
			runtime.archiveHandle = timers.setInterval(() => {
				void runArchiveTick();
			}, ARCHIVE_INTERVAL_MS);
			await syncOwnTitle();
			const ctx = lifecycleCtx;
			if (ctx === undefined) return;
			try {
				await runtime.controller.reconcile(liveContext(ctx));
			} catch (error) {
				deps.logger.debug("startup reconcile failed", { error });
			}
		};

		const startAdmission = async (): Promise<void> => {
			if (runtime.stopped || runtime.admissionInFlight || runtime.controller.role !== "pending") return;
			runtime.admissionInFlight = true;
			try {
				await runtime.controller.admit();
			} catch (error) {
				// Import/native/filesystem failures leave the role pending; the
				// admission tick retries with deduplicated diagnostics.
				deps.logger.debug("workspace admission failed; still pending", { error });
			} finally {
				runtime.admissionInFlight = false;
			}
			if (runtime.stopped) return;
			const role = runtime.controller.role;
			if (role === "pending") {
				ensureAdmissionInterval();
				return;
			}
			clearAdmissionInterval();
			if (role === "primary") await beginPrimaryDuties();
			// A decided secondary starts no recurring work.
		};

		const roleGateMessage = (): string | undefined => {
			const role = runtime.controller.role;
			if (role === "secondary") return SECONDARY_INACTIVE_MESSAGE;
			if (role === "pending") return PENDING_OWNERSHIP_MESSAGE;
			return undefined;
		};

		pi.on("session_start", async (_event, ctx) => {
			const reason = unavailableReason(ctx);
			if (reason) {
				if (ctx.agent.kind === "main" && ctx.mode === "tui") uiFrom(ctx)?.notify(reason, "info");
				deps.logger.debug(reason);
				return;
			}
			runtime.ui = uiFrom(ctx);
			lifecycleCtx = ctx;
			attachTimers({
				setInterval: (callback, ms) => ctx.setInterval(callback, ms),
				clearInterval: handle => ctx.clearTimer(handle as Parameters<typeof ctx.clearTimer>[0]),
				setTimeout: (callback, ms) => ctx.setTimeout(callback, ms),
				clearTimeout: handle => ctx.clearTimer(handle as Parameters<typeof ctx.clearTimer>[0]),
				now: () => Date.now(),
			});
			// One managed deferred callback starts the one-time own-tab naming
			// and workspace admission independently; a naming failure can never
			// block admission.
			ctx.setTimeout(() => {
				startNaming();
				void startAdmission();
			}, 0);
		});

		const archiveBeforeTransition = async (ctx: HostContext): Promise<void> => {
			if (runtime.stopped || unavailableReason(ctx)) return;
			if (runtime.controller.role !== "primary") return;
			try {
				await runtime.controller.snapshotNow({ deadlineMs: 1_000 });
			} catch (error) {
				deps.logger.debug("pre-transition archive failed", { error });
			}
		};

		pi.on("session_before_switch", async (_event, ctx) => {
			await archiveBeforeTransition(ctx);
		});
		pi.on("session_before_branch", async (_event, ctx) => {
			await archiveBeforeTransition(ctx);
		});

		for (const eventName of ["session_switch", "session_branch"] as const) {
			pi.on(eventName, async (_event, ctx) => {
				if (runtime.stopped || unavailableReason(ctx)) return;
				if (runtime.controller.role !== "primary") return;
				try {
					await runtime.controller.reconcile(liveContext(ctx));
				} catch (error) {
					deps.logger.debug("session transition reconcile failed", { error });
				}
			});
		}

		pi.on("before_agent_start", async (event, ctx) => {
			if (unavailableReason(ctx)) return undefined;
			if (runtime.stopped || runtime.controller.role !== "primary") return undefined;
			if (!runtime.controller.isReady) return undefined;
			if (event.systemPrompt.includes(guidance)) return undefined;
			return { systemPrompt: [...event.systemPrompt, guidance] };
		});

		pi.on("session_shutdown", async (_event, ctx) => {
			stopTicks();
			if (unavailableReason(ctx)) return;
			// Secondary/pending roles perform no shared-state operation; neither
			// role releases a won primary lock here — ownership must survive
			// until the actual process exits.
			if (runtime.controller.role !== "primary") return;
			await runtime.controller.shutdown(SHUTDOWN_BUDGET_MS);
		});

		pi.registerCommand("diff", {
			description: "Switch the Hunk companion's diff view (selectors only)",
			handler: async (args, ctx) => {
				const reason = unavailableReason(ctx);
				if (reason) {
					uiFrom(ctx)?.notify(reason, "warning");
					deps.logger.debug(reason);
					return;
				}
				const gate = roleGateMessage();
				if (gate !== undefined) {
					runtime.ui?.notify(gate, "warning");
					return;
				}
				if (args.trim().length > 0) {
					runtime.ui?.notify("Use /diff without arguments.", "warning");
					return;
				}
				const controller = runtime.controller;
				// The picker resolves against the captured parent revision: a
				// session/cwd change while it is open invalidates the queued
				// application inside the controller instead of racing it here.
				const expected: ParentSnapshot = controller.observeParent(liveContext(ctx));
				const scopeKind = controller.scope?.kind ?? "session";
				const selection = await runtime.ui?.select(
					"Diff view",
					[
						{
							label: SCOPE_LABELS.session,
							description: "Baseline commit → working tree (committed + staged + unstaged + untracked)",
						},
						{
							label: SCOPE_LABELS.branch,
							description: "Merge-base with the selected branch → working tree",
						},
						{ label: SCOPE_LABELS.commit, description: "Show one specific commit" },
					],
					{ initialIndex: SCOPE_INDEX[SCOPE_LABELS[scopeKind]] ?? 0 },
				);
				if (selection === undefined) return;

				let branchChoice: BranchChoice | undefined;
				let commitChoice: CommitChoice | undefined;
				if (selection === SCOPE_LABELS.branch) {
					const branches = await listBranches(deps.exec, expected.cwd);
					if (branches.length === 0) {
						runtime.ui?.notify("No branches found.", "warning");
						return;
					}
					const label = await runtime.ui?.select(
						"Select base branch",
						branches.map(branch => ({ label: branch.label, description: branch.fullRef })),
					);
					if (label === undefined) return;
					branchChoice = branches.find(branch => branch.label === label);
					if (branchChoice === undefined) return;
				}
				if (selection === SCOPE_LABELS.commit) {
					const commits = await listRecentCommits(deps.exec, expected.cwd);
					if (commits.length === 0) {
						runtime.ui?.notify("No commits found.", "warning");
						return;
					}
					const label = await runtime.ui?.select(
						"Select commit",
						commits.map(commit => ({ label: commit.display })),
					);
					if (label === undefined) return;
					commitChoice = commits.find(commit => commit.display === label);
					if (commitChoice === undefined) return;
				}

				const kind =
					selection === SCOPE_LABELS.session ? "session" : selection === SCOPE_LABELS.branch ? "branch" : "commit";
				try {
					await controller.reconcile(liveContext(ctx));
					const scope = await controller.resolveScope(expected, kind, {
						branchFullRef: branchChoice?.fullRef,
						commitSha: commitChoice?.sha,
					});
					await controller.selectScope(scope, expected);
				} catch (error) {
					runtime.ui?.notify(errorText(error), "error");
					return;
				}
				try {
					await controller.focusTab(expected);
				} catch (error) {
					runtime.ui?.notify(`Scope changed, but focusing the Hunk tab failed: ${errorText(error)}`, "warning");
				}
			},
		});

		const z = pi.zod;

		pi.registerTool({
			name: "hunk_review",
			label: "Hunk Review",
			description:
				"Read the live Hunk review: reviewed files, hunks, the user's current selection, and every saved note. " +
				"Human notes (source \"user\") are the user's feedback. Returns {capturedAt, scope, viewToken, review}; " +
				"pass the viewToken to hunk_comment when replying or annotating.",
			parameters: z.object({}),
			approval: "read",
			execute: async (_toolCallId, _params, signal, _onUpdate, ctx) => {
				const reason = unavailableReason(ctx);
				if (reason) return { content: [{ type: "text", text: reason }] };
				const gate = roleGateMessage();
				if (gate !== undefined) return { content: [{ type: "text", text: gate }] };
				const controller = runtime.controller;
				if (!runtime.stopped) {
					try {
						await controller.reconcile(liveContext(ctx));
					} catch (error) {
						return { content: [{ type: "text", text: errorText(error) }] };
					}
				}
				const outcome = await controller.captureStable(signal);
				if (!outcome.ok || !outcome.capture) {
					return { content: [{ type: "text", text: outcome.reason ?? "Review capture failed." }] };
				}
				const capture = outcome.capture;
				const payload = JSON.stringify(
					{
						capturedAt: capture.capturedAt,
						scope: capture.scope,
						viewToken: capture.viewToken,
						review: capture.review,
					},
					null,
					"\t",
				);
				if (Buffer.byteLength(payload) > REVIEW_SPILL_BYTES) {
					let artifactId: string | undefined;
					try {
						artifactId = await ctx.sessionManager.saveArtifact(payload, "hunk-review");
					} catch (error) {
						deps.logger.warn("review artifact spill failed", { error });
					}
					if (artifactId === undefined) {
						return {
							content: [
								{
									type: "text",
									text: "Review captured but too large to inline, and artifact spill failed. Call hunk_review again.",
								},
							],
						};
					}
					return {
						content: [
							{
								type: "text",
								text: `Full review spilled to artifact://${artifactId}. viewToken: ${capture.viewToken}. viewToken remains valid while the review generation is unchanged; call hunk_review again after the review reloads.`,
							},
						],
						details: {
							capturedAt: capture.capturedAt,
							scope: capture.scope,
							viewToken: capture.viewToken,
							spilledTo: `artifact://${artifactId}`,
						},
					};
				}
				return { content: [{ type: "text", text: payload }], details: { viewToken: capture.viewToken } };
			},
		});

		const lineCommentSchema = z.object({
			kind: z.literal("line"),
			viewToken: z.string(),
			filePath: z.string(),
			side: z.enum(["old", "new"]),
			line: z.number().min(1),
			summary: z.string(),
			rationale: z.string().optional(),
		});
		const replyCommentSchema = z.object({
			kind: z.literal("reply"),
			viewToken: z.string(),
			replyTo: z.string(),
			summary: z.string(),
			rationale: z.string().optional(),
		});

		pi.registerTool({
			name: "hunk_comment",
			label: "Hunk Comment",
			description:
				"Add an inline note or in-thread reply to the live Hunk review. kind \"line\" anchors to a diff line " +
				"(filePath + side + line from a fresh hunk_review); kind \"reply\" answers an existing note by noteId. " +
				"Use sparingly: rationale and risks, not narration of every edit.",
			parameters: z.union([lineCommentSchema, replyCommentSchema]),
			approval: "write",
			execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
				const reason = unavailableReason(ctx);
				if (reason) return { content: [{ type: "text", text: reason }] };
				const gate = roleGateMessage();
				if (gate !== undefined) return { content: [{ type: "text", text: gate }] };
				const controller = runtime.controller;
				if (!runtime.stopped) {
					try {
						await controller.reconcile(liveContext(ctx));
					} catch (error) {
						return { content: [{ type: "text", text: errorText(error) }] };
					}
				}
				const input = params as
					| { kind: "line"; viewToken: string; filePath: string; side: "old" | "new"; line: number; summary: string; rationale?: string }
					| { kind: "reply"; viewToken: string; replyTo: string; summary: string; rationale?: string };
				if (input.kind === "line" && !Number.isInteger(input.line)) {
					return { content: [{ type: "text", text: "line must be an integer >= 1." }] };
				}
				const request =
					input.kind === "line"
						? {
								file: input.filePath,
								side: input.side,
								line: input.line,
								summary: input.summary,
								rationale: input.rationale,
							}
						: { replyTo: input.replyTo, summary: input.summary, rationale: input.rationale };
				const outcome = await controller.commentWrite(input.viewToken, request, signal);
				if (!outcome.ok) {
					return { content: [{ type: "text", text: outcome.error ?? "Comment write failed." }] };
				}
				const parts = [`Comment created: ${outcome.result?.commentId ?? "unknown id"}.`];
				if (outcome.reviewChanged === true) {
					parts.push(
						"Warning: the review reloaded while the comment was written, so its anchor may be stale. Call hunk_review before further annotations.",
					);
				}
				return { content: [{ type: "text", text: parts.join(" ") }], details: outcome.result };
			},
		});
	};
}

export default createHerdrExtension(acquireHostPrimaryLock);
