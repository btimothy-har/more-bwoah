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
- `companion.ts` — ownership record, launch/adoption,
  PID∩registry identity handshake, readiness polling, cwd following, clean-slate
  resets, serialized control queue, stable review capture, snapshot writer.
- `herdr-cli.ts` — tab/pane transport, response validation, and proven-absence
  error classification; other failures stay indeterminate.
- `hunk-cli.ts` — typed `hunk session …` wrappers (envelope parsing, exit-code
  mapping). Always targets the captured positional session id; never `--repo`.
- `diff-targets.ts` — git queries and `ReviewScope` → reload argv.
- `boundary.ts` — shared `asRecord`/`canonicalPath` guards for external JSON
  payloads and paths; import them, never re-copy.
- `storage.ts` — atomic JSON writes (stage → verify → chmod → rename),
  ownership record schema/validation, record path (SHA-256 of
  `[socketPath, workspaceId]` under `$XDG_STATE_HOME` when absolute, else
  `~/.local/state`).

## Invariants

- Gate every runtime action on `ctx.agent.kind === "main"`, `ctx.mode ===
  "tui"`, and the herdr env (`HERDR_ENV=1` + workspace/pane/socket ids).
  Subagents and non-herdr runs observe but never mutate; outside the gate,
  `/diff` and the tools report why the feature is inactive.
- herdr read failures are classified: `tab_not_found`/`pane_not_found`
  mean absent; any other failure (timeout, socket error, malformed reply) is
  indeterminate — skip the check and retry on a later tick, never sticky-close
  a healthy companion or mint a duplicate tab.
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
- Before release: the disposable-workspace TUI smoke, in a scratch herdr
  workspace and scratch git repos only — never against the user's live
  companion or panes. Condensed checklist:
  1. Startup creates exactly one `hunk` tab, no focus theft, exact PID/UUID
     binding; a second manual Hunk window on the same repo is never adopted.
  2. `/diff` matrix: all three scopes, nested branch/commit pickers, Escape at
     every level, `/diff main` rejected; same-root scope changes keep the
     session id and watching active.
  3. Native human note (`c`) shows up in `hunk_review`; `hunk_comment` line
     note and reply appear in Hunk.
  4. After 30 s the rolling `review-notes.json` is replaced; normal quit does a
     final snapshot and leaves the Hunk tab running; relaunch adopts the same
     companion without duplicating and starts with fresh annotations.
  5. Closed tab: no respawn on ticks or a canceled `/diff`; a completed
     selection reopens it; an unrelated process in the old pane is untouched.
  6. Cross-worktree move → new root/new session id, artifacts under the same
     session home; non-herdr launch and a missing `hunk` binary stay inert
     with local errors.
