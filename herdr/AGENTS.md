# herdr extension — contributor notes

Supplements the repository-root `AGENTS.md`; read that first. Product usage
lives in [README.md](./README.md); model-facing instructions live in
[guidance.md](./guidance.md) — imported as static text by `index.ts` and
injected only for ready primaries; link to those files instead of duplicating
their content.

## Module map

- `index.ts` — the single factory: `createHerdrExtension(tryPrimaryLock)`
  (default export binds the host `acquireHostPrimaryLock`). Registers `/diff`,
  `hunk_review`, `hunk_comment`, lifecycle handlers, and the managed intervals
  (lifecycle 3 s, archive 30 s, admission retry 3 s, shutdown budget 1.5 s).
  Registration only at factory time; subprocess/UI work strictly inside
  runtime handlers (`pi.exec` throws before `ExtensionRunner.initialize`).
  `session_start` starts one-time own-tab naming and admission independently;
  a naming failure never blocks admission.
- `companion.ts` — `CompanionController`: role admission, the one serialized
  reconciliation drain (revision-bearing `ParentSnapshot`), verified child
  replacement and sidecar-guarded launch, identity handshakes
  (PID∩registry + controller pane reservation), readiness/clean-note gating,
  stable review capture, view tokens, snapshot writer, soft shutdown.
- `primary-lock.ts` — adapter over the host's native process-owned `FileLock`
  (`@oh-my-pi/pi-natives`, dynamically imported; no fallback). A winning
  handle is strongly referenced and released at actual process exit; losing
  handles release only themselves.
- `naming.ts` — `SessionNaming`: one-time own-tab rename to `omp` per process
  launch and primary pane-title sync (`pane rename`, coalesced, redundant
  successes skipped; literal `--clear` titles are skipped with a diagnostic).
- `herdr-cli.ts` — tab/pane transport including `paneList`/`closePane`,
  response validation (absent `foreground_processes` normalizes to `[]`,
  malformed present data rejects), and proven-absence classification; other
  failures stay indeterminate.
- `hunk-cli.ts` — typed `hunk session …` wrappers (envelope parsing, exit-code
  mapping). Always targets the captured positional session id; never `--repo`.
- `diff-targets.ts` — git queries and `ReviewScope` → reload argv.
- `boundary.ts` — shared `asRecord`/`canonicalPath` guards for external JSON
  payloads and paths; import them, never re-copy.
- `storage.ts` — atomic JSON writes (stage → verify → chmod → rename, with a
  `mayPublish` recheck immediately before rename), record schema v1 and the
  launch-intent sidecar schema, record path and `primaryRoleLockPath` (same
  state directory and hash as the record, `.primary.lock` suffix).

## Invariants

- Gate every runtime action on `ctx.agent.kind === "main"`, `ctx.mode ===
  "tui"`, and the Herdr env (`HERDR_ENV=1`, no `OMPCODE`, workspace/pane/socket
  ids). Outside the gate, `/diff` and the tools report why the feature is
  inactive; nothing renames, launches, closes, clears, or starts timers.
- Role is fixed by the first successful lock attempt: won → primary, lost →
  secondary (release only the losing handle), import/filesystem failure →
  pending with deduplicated diagnostics, retried by the admission tick. A
  decided secondary is inert for the process lifetime and holds no
  reservation. The winning handle is held until actual process exit —
  `session_shutdown` never releases it.
- The `.primary.lock` pathname is a persistent flock inode: never unlink,
  rename, truncate, or garbage-collect it (macOS can then admit two
  primaries). File contents are irrelevant to role. Only the `.launch.json`
  intent is removable — by its own matching nonce before submission, or by the
  primary-lock holder after child-identity proof.
- One reconciliation path. `observeParent()` is pure (records desired context,
  bumps a monotonic revision); `reconcile()` drains it through the single
  queue; overlapping requests update the desired snapshot instead of dropping.
  Every managed mutation re-checks the synchronous fence (shutdown, role,
  lock, revision) with zero awaits before dispatch; a parent-revision change
  invalidates view tokens and queued picker applications (A → B → A included).
- Identity is PID∩registry within the owned pane plus this controller's own
  foreground PID and native workspace/tab/pane reservation. Labels and repo
  paths are never proof. Fail closed on ambiguity, malformed storage, or
  unverifiable identity: preserve evidence, report the cause, mutate nothing.
  A recorded child is torn down only by a newly admitted primary replacing it;
  a secondary never reclaims it.
- Replacement policy: new primary replaces the retained record's child; new
  session id or verified canonical root archives + retires + launches fresh;
  same id + canonical root (including cwd moves) keeps child, notes, and
  scope; indeterminate Git keeps the same-parent child untouched and retries
  on the tick (a committed id transition still retires); a child proven gone
  is recreated automatically, preserving the pinned baseline/scope; soft exit
  touches nothing.
- Launch proof: `wx`-created sidecar before `tab create`; identity record
  persisted immediately after the reply; shell-qualified provisional record
  before intent removal and `pane run`. A run timeout keeps verifying the
  known child and never resubmits. Any unprovable outcome retains the intent
  and record and reports the inspect-before-clearing message instead of
  risking a duplicate.
- Soft retirement: `shutdown()` stops timers and queued work, invalidates
  tool tokens, and attempts one final read-only archive within the host's
  handler cap. Never close, interrupt, clear, reload, or launch; never delete
  ownership or launch evidence. An archive write occupies its writer until
  actual settlement even when the deadline stops waiting.
- All timing goes through the injected `CompanionTimers` (host managed timers
  / test fakes). Never raw `setTimeout`/`setInterval`; never `Bun.sleep` in
  the controller.
- Read live cwd via `ctx.sessionManager.getCwd()` at use time; `ctx.cwd` is a
  snapshot. Artifact/snapshot destinations come from
  `sessionManager.getArtifactsDir()` (session home), never the checkout.
- Live notes belong to Hunk. This extension journals nothing about notes: no
  registries, no replay, no per-edit invalidation. The only destructive op is
  the once-per-session-boundary `comment clear --all --yes` on the bound id;
  a failed clear blocks export/annotation until the ordinary reconciler
  retries — never `/diff`.
- `hunk_review` binds writes to a view token (binding generation + session id +
  publication generation); old tokens never address a replacement child. The
  public Hunk CLI has no write-time CAS: recheck generation after a write and
  report `reviewChanged` honestly.
- Tool output spills to `saveArtifact` above 16 KiB; archives are a separate
  rolling file via `storage.atomicWriteJson` (boolean result honors
  `mayPublish`).

## Verification

- `bun test herdr` from the checkout root — behavioral suites
  (`companion.test.ts`, `diff-targets.test.ts`, `feedback.test.ts`,
  `storage.test.ts`, `naming.test.ts`, `herdr-cli.test.ts`) use real temp git
  repos, fake timers, and injectable command runners, including the factory
  lock harness (`createHerdrExtension(harness.tryPrimaryLock)`). Assert
  consumer-visible outcomes, not registration counts or source text.
- Before release: the disposable-workspace installed-binary smoke, against a
  scratch Herdr server/home/state and scratch git repos only — never the
  user's live panes, daemon, or config. Condensed checklist:
  1. Fresh primary names its own tab `omp` once and creates exactly one
     unfocused `diff` child; record + persistent lock inode exist, no
     sidecar left. A secondary in the same workspace names its own tab,
     gets the inactive message from `/diff`, and mutates nothing.
  2. Manual tab renames survive ticks and `/diff`; targeting stays by ID.
     `/new` retires the old child (pane not found + Hunk deregistered), the
     fresh child has zero notes, the old session's artifact keeps its notes,
     and the controller tab is not reset.
  3. Primary `/exit`: identical child pane/process/session IDs, record and
     lock intact, zero close/kill/clear commands; the running secondary stays
     secondary. The next primary resets its tab once and replaces the
     retained (renamed) child by recorded IDs with no note leak.
  4. SIGKILL the verified primary PID: child, record, and lock stay intact;
     successor recovery is identical to the graceful path.
  5. `/diff` matrix: Escape at the top and nested pickers changes nothing;
     commit/branch/full-session scopes apply with the same child UUID and
     focus only after selection.
  6. A native `c` note shows source `user` in `hunk session review --json`;
     the new session's archive has no old notes; a second scratch workspace
     with its own notes stays unchanged throughout.
