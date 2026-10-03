# hunk extension — contributor notes

Supplements the repository-root `AGENTS.md`; read that first. Product usage
lives in [README.md](./README.md); model-facing instructions live in
[guidance.md](./guidance.md) (imported as static text by `index.ts` — link to
those files instead of duplicating their content).

## Module map

- `index.ts` — factory: registers `/diff`, `hunk_review`, `hunk_comment`,
  lifecycle/before_agent_start handlers, and the two managed intervals.
  Registration only at factory time; subprocess/UI work strictly inside runtime
  handlers (`pi.exec` throws before `ExtensionRunner.initialize`).
- `companion.ts` — herdr CLI adapter, ownership record, launch/adoption,
  PID∩registry identity handshake, readiness polling, cwd following, clean-slate
  resets, serialized control queue, stable review capture, snapshot writer.
- `hunk-cli.ts` — typed `hunk session …` wrappers (envelope parsing, exit-code
  mapping). Always targets the captured positional session id; never `--repo`.
- `diff-targets.ts` — git queries and `ReviewScope` → reload argv.
- `storage.ts` — atomic JSON writes (stage → verify → chmod → rename),
  ownership record schema/validation, record path (SHA-256 of
  `[socketPath, workspaceId]` under XDG state).

## Invariants

- Gate every runtime action on `ctx.agent.kind === "main"`, `ctx.mode ===
  "tui"`, and the herdr env (`HERDR_ENV=1` + workspace/pane/socket ids).
  Subagents and non-herdr runs observe but never mutate.
- Identity is PID∩registry within the owned pane. Hunk's registration exposes
  no herdr ids; labels and repo paths are never proof. Fail closed on ambiguity;
  never ctrl+c or `pane run` into a pane whose ownership is not proven by the
  record + shell pid + foreground pid.
- All timing goes through the injected `CompanionTimers` (host managed timers /
  test fakes). Never raw `setTimeout`/`setInterval`; never `Bun.sleep` in the
  controller.
- Read live cwd via `ctx.sessionManager.getCwd()` at use time; `ctx.cwd` is a
  snapshot. Artifact/snapshot destinations come from
  `sessionManager.getArtifactsDir()` (session home), never the checkout.
- Live notes belong to Hunk. This extension journals nothing about notes: no
  registries, no replay, no per-edit invalidation. The only destructive op is
  the once-per-session-boundary `comment clear --all --yes` on the bound id.
- `hunk_review` binds writes to a view token (binding generation + session id +
  publication generation). The public Hunk CLI has no write-time CAS: recheck
  generation after a write and report `reviewChanged` honestly.
- Tool output spills to `saveArtifact` above 16 KiB; archives are a separate
  rolling file via `storage.atomicWriteJson`.

## Verification

- `bun test hunk` from the checkout root — behavioral suites
  (`companion.test.ts`, `diff-targets.test.ts`, `feedback.test.ts`,
  `storage.test.ts`) use real temp git repos, fake timers, and injectable
  command runners. Assert consumer-visible outcomes, not registration counts
  or source text.
- Before release: the disposable-workspace TUI smoke from the plan (scratch
  herdr workspace + scratch repos; never against the user's live companion or
  panes). See `local://hunk-companion-plan.md` in the planning session for the
  full script.
