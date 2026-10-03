/**
 * Hunk companion extension for omp.
 *
 * Pairs each main omp session inside a herdr workspace with a persistent,
 * workspace-owned Hunk review tab. `/diff` (selectors only) switches the
 * companion's review scope; `hunk_review` pulls the live review and every
 * saved note on demand; `hunk_comment` adds line notes and in-thread replies.
 * A 30-second rolling archive exports the published review under the omp
 * session's artifact home. Hunk owns all live annotation state.
 */

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import guidance from "./guidance.md" with { type: "text" };
import {
	CompanionController,
	eligibleEnv,
	type CompanionDeps,
	type CompanionLogger,
	type CompanionTimers,
	type NotifyLevel,
} from "./companion";
import { CompanionUnavailable, CommandCliError } from "./hunk-cli";
import { listBranches, listRecentCommits, type BranchChoice, type CommitChoice } from "./diff-targets";

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
	ui: UiLike | null;
	timers: CompanionTimers | null;
	lifecycleHandle: unknown;
	archiveHandle: unknown;
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
	if (ctx.agent.kind !== "main") return "Hunk companion runs only in the main session.";
	if (ctx.mode !== "tui") return "Hunk companion requires an interactive TUI session; headless mode is disabled.";
	if (!eligibleEnv(process.env)) return "Not running inside a herdr workspace; skipping Hunk companion launch.";
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
	return error instanceof Error ? error.message : "Unexpected hunk companion failure.";
}

export default function hunkCompanionExtension(pi: ExtensionAPI): void {
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
	};
	const runtime: Runtime = {
		controller: new CompanionController(deps),
		ui: null,
		timers: null,
		lifecycleHandle: undefined,
		archiveHandle: undefined,
	};

	const syncContext = (ctx: {
		sessionManager: { getSessionId(): string; getArtifactsDir(): string | null; getCwd(): string };
		ui: unknown;
	}): void => {
		runtime.ui = uiFrom(ctx);
		runtime.controller.updateSessionContext({
			ompSessionId: ctx.sessionManager.getSessionId(),
			artifactsDir: ctx.sessionManager.getArtifactsDir(),
		});
		runtime.controller.setCwd(ctx.sessionManager.getCwd());
	};

	const attachTimers = (timers: CompanionTimers): void => {
		runtime.timers = timers;
		deps.timers = timers;
	};

	const stopTicks = (): void => {
		if (runtime.timers !== null) {
			if (runtime.lifecycleHandle !== undefined) runtime.timers.clearInterval(runtime.lifecycleHandle);
			if (runtime.archiveHandle !== undefined) runtime.timers.clearInterval(runtime.archiveHandle);
		}
		runtime.lifecycleHandle = undefined;
		runtime.archiveHandle = undefined;
	};

	const runLifecycleTick = async (ctx: {
		agent: { kind: string };
		mode: string;
		sessionManager: { getCwd(): string };
	}): Promise<void> => {
		if (unavailableReason(ctx)) return;
		try {
			runtime.controller.setCwd(ctx.sessionManager.getCwd());
			await runtime.controller.lifecycleTick();
		} catch (error) {
			deps.logger.debug("lifecycle tick failed", { error });
		}
	};

	const runArchiveTick = async (ctx: { agent: { kind: string }; mode: string }): Promise<void> => {
		if (unavailableReason(ctx)) return;
		try {
			await runtime.controller.snapshotNow({ deadlineMs: 10_000 });
		} catch (error) {
			deps.logger.debug("archive tick failed", { error });
		}
	};


	pi.on("session_start", async (_event, ctx) => {
		const reason = unavailableReason(ctx);
		if (reason) {
			if (ctx.agent.kind === "main" && ctx.mode === "tui") uiFrom(ctx)?.notify(reason, "info");
			deps.logger.debug(reason);
			return;
		}
		syncContext(ctx);
		attachTimers({
			setInterval: (callback, ms) => ctx.setInterval(callback, ms),
			clearInterval: handle => ctx.clearTimer(handle as Parameters<typeof ctx.clearTimer>[0]),
			setTimeout: (callback, ms) => ctx.setTimeout(callback, ms),
			clearTimeout: handle => ctx.clearTimer(handle as Parameters<typeof ctx.clearTimer>[0]),
			now: () => Date.now(),
		});
		if (runtime.lifecycleHandle === undefined) {
			runtime.lifecycleHandle = ctx.setInterval(() => void runLifecycleTick(ctx), LIFECYCLE_INTERVAL_MS);
			runtime.archiveHandle = ctx.setInterval(() => void runArchiveTick(ctx), ARCHIVE_INTERVAL_MS);
			ctx.setTimeout(() => {
				if (unavailableReason(ctx)) return;
				runtime.controller.initialize().catch(error => {
					deps.logger.warn("companion startup failed", { error });
				});
			}, 0);
		}
	});

	pi.on("session_before_switch", async (_event, ctx) => {
		if (unavailableReason(ctx)) return;
		syncContext(ctx);
		await runtime.controller.snapshotNow({ deadlineMs: 1_000 });
	});

	for (const eventName of ["session_switch", "session_branch"] as const) {
		pi.on(eventName, async (_event, ctx) => {
			if (unavailableReason(ctx)) return;
			syncContext(ctx);
			await runtime.controller.onSessionChanged(ctx.sessionManager.getSessionId());
		});
	}

	pi.on("before_agent_start", async (event, ctx) => {
		if (unavailableReason(ctx)) return undefined;
		syncContext(ctx);
		if (!runtime.controller.isReady) return undefined;
		if (event.systemPrompt.includes(guidance)) return undefined;
		return { systemPrompt: [...event.systemPrompt, guidance] };
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (unavailableReason(ctx)) return;
		stopTicks();
		await runtime.controller.shutdown(1_500);
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
			syncContext(ctx);
			if (args.trim().length > 0) {
				runtime.ui?.notify("Use /diff without arguments.", "warning");
				return;
			}
			const controller = runtime.controller;
			const capturedSessionId = ctx.sessionManager.getSessionId();
			const capturedCwd = ctx.sessionManager.getCwd();

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
				const branches = await listBranches(deps.exec, capturedCwd);
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
				const commits = await listRecentCommits(deps.exec, capturedCwd);
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

			if (
				ctx.sessionManager.getSessionId() !== capturedSessionId ||
				ctx.sessionManager.getCwd() !== capturedCwd
			) {
				runtime.ui?.notify("Session changed during selection; /diff cancelled.", "warning");
				return;
			}

			const kind = selection === SCOPE_LABELS.session ? "session" : selection === SCOPE_LABELS.branch ? "branch" : "commit";
			try {
				const scope = await controller.resolveScope(kind, {
					branchFullRef: branchChoice?.fullRef,
					commitSha: commitChoice?.sha,
				});
				await controller.initialize({ explicit: true });
				await controller.selectScope(scope);
			} catch (error) {
				runtime.ui?.notify(errorText(error), "error");
				return;
			}
			try {
				await controller.focusTab();
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
			syncContext(ctx);
			try {
				await runtime.controller.lifecycleTick();
			} catch (error) {
				return { content: [{ type: "text", text: errorText(error) }] };
			}
			const outcome = await runtime.controller.captureStable(signal);
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
			syncContext(ctx);
			try {
				await runtime.controller.lifecycleTick();
			} catch (error) {
				return { content: [{ type: "text", text: errorText(error) }] };
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
			const outcome = await runtime.controller.commentWrite(input.viewToken, request, signal);
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
}
