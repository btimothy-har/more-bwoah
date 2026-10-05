# herdr — Hunk companion extension for omp (`@more-bwoah/herdr`)

Pairs a Herdr workspace with one persistent [Hunk](https://hunk.dev) review tab,
managed by exactly one **primary** omp controller. Additional omp processes in
the same workspace are **secondaries**: they never create, close, focus, or
modify the primary's child. omp owns the exact binding (Herdr tab/pane IDs +
Hunk session id + process ids); Hunk owns all live annotation state. The
conversation explains the task; the Hunk tab explains the code.

## Prerequisites

- `omp` running as the **main agent session, in TUI mode, inside a Herdr pane**
  (`HERDR_ENV=1`). Subagents, headless runs (`-p`, rpc/SDK), and nested omp
  (`OMPCODE=1`) stay inert; outside Herdr a main TUI session reports the
  skipped launch at startup.
- `hunk` on PATH (verified against 0.22.0), `herdr` on PATH or
  `HERDR_BIN_PATH` (verified against 0.9.3), and `git`.
- A git repository with at least one commit; the checkout root is the
  companion's review root.

## Install

Install from a durable checkout with omp's native CLI:

```sh
omp install /absolute/path/to/more-bwoah/herdr
```

The package manifest declares exactly one entry point (`index.ts`). Never
install or load the old `@more-bwoah/hunk` package and `@more-bwoah/herdr`
together — the old package was replaced, not renamed side by side, and both
would register duplicate commands and tools. For a local directory,
`omp install` links the extension rather than copying it, so edits in that
checkout propagate; keep the checkout at that path. `--dry-run` previews the
action but does not validate the package or prove that installation succeeds.

For one-off loading without installation:

```sh
omp -e /absolute/path/to/more-bwoah/herdr/index.ts
```

Disable with `disabledExtensions: ["extension-module:herdr"]`.

## Primary and secondary

The first eligible omp process in a workspace to claim the native,
process-owned **primary lock** becomes the primary; processes that start while
the lock is held become secondaries. The role is fixed for the process's
lifetime: a secondary never takes over automatically, even after the primary
exits, and a newly started process becomes primary only once the previous
owner's process is actually gone (graceful or SIGKILL both count). Secondary
`/diff` and review tools report that the integration is inactive and touch
nothing; each process — primary or secondary — still names its own tab at
launch (below).

## What you get

- **Own tab named once.** Every eligible omp launch renames the tab hosting
  its pane to `omp` exactly once at startup, primary or secondary. Manual
  renames persist for that process's lifetime; `/new`, resume, and branch
  never re-run naming. The next actual omp launch in that tab resets it to
  `omp` again. The primary additionally keeps its pane title synced to the
  omp session name (a changed session name updates it; nothing else retouches
  labels).
- **Managed diff child (primary only).** The primary creates one background
  tab labeled `diff` (never steals focus) and binds it by Herdr tab/pane IDs,
  the Hunk session id, and process ids — never by labels or repo paths, so an
  unrelated tab named `diff` or a second Hunk window is never touched.
- **`/diff`** — selector-only scope control for the primary's companion:
  - **Full session** — the HEAD captured when this omp session entered the
    checkout, diffed against the live working tree. Includes checkpoint
    commits plus staged, unstaged, and untracked changes.
  - **Against a base branch** — the merge-base of the selected branch and the
    current HEAD, diffed against the working tree (not `diff main...HEAD`,
    which excludes uncommitted work).
  - **Specific commit** — one pinned commit (`hunk show <sha>`).
  `/diff` takes no arguments. Canceling any selector changes nothing; a
  completed selection resolves the scope against the parent snapshot captured
  when the picker opened — a session/cwd change in between discards the stale
  application — then reloads and focuses the child only after success.
- **Two-way annotations.** Your inline notes in Hunk (the `c` action) are the
  feedback channel; the agent pulls them on demand with `hunk_review` and can
  reply in-thread or leave rationale notes with `hunk_comment`. Saving a note
  never interrupts or wakes the agent, and note text is treated as ordinary
  data, never as instructions.
- **Rolling archive.** Every 30 seconds the primary snapshots the published
  review (structure, selection, and all saved notes; no patch text) to
  `<omp session artifacts>/hunk/review-notes.json`, plus a best-effort final
  snapshot on exit. The archive is a record, not a restorable session: drafts,
  notes on files that left the diff, and full UI state are not captured, and
  nothing is ever replayed into Hunk. Each omp session archives under its own
  artifact home; a new session's archive never contains the old session's
  notes.

## Lifecycle

- **Replacement, not adoption.** A newly admitted primary replaces the
  workspace's recorded child — left by a soft exit or a crash — before
  launching its own, matched by recorded IDs (user-renamed tabs don't matter).
  It never adopts the old review: the fresh child starts with no notes.
  Before closing, it revalidates the child’s location, original shell, and
  foreground ownership. A conflicting live registration or a pane repurposed
  for another program preserves the pane and ownership evidence.
- **Session transitions.** A new omp session id (`/new`, resuming a different
  session, fork/branch) retires the current child and launches a fresh one at
  the new session's HEAD and artifact destination. The same session id in the
  same canonical checkout — including a same-session reload or a cwd move
  within that checkout — keeps the same child, its notes, and the selected
  scope. A move to a different canonical checkout retires and relaunches.
- **Automatic child replacement.** If the child pane is proven gone while the
  primary lives (closed tab, or Hunk exited back to its original idle shell),
  reconciliation recreates it automatically — no `/diff` needed. The
  replacement reviews from the same pinned baseline and selected scope, even
  if HEAD advanced meanwhile.
  A launch proven rejected before submission also retries through ordinary
  reconciliation; an unknown dispatch outcome is verified, never resubmitted.
- **Transient failures stay safe.** Indeterminate Git discovery pauses review
  access without disturbing a same-parent child. A committed parent-ID change
  still snapshots its clean applied review and retires the old child even if
  the desired checkout cannot be resolved; creation waits for Git recovery.
  Unreachable Herdr/Hunk observations never prove absence or authorize another
  child.
  Ordinary lifecycle ticks retry, including failed initial note-clearing;
  export and annotation remain blocked until that clean gate succeeds.
- **Exit is soft retirement.** On omp exit the child pane and process, its
  notes, labels, and ownership metadata all stay exactly as they are, and a
  final best-effort archive is attempted. omp exit — graceful or SIGKILL —
  never closes, interrupts, clears, reloads, or replaces the child. The next
  primary, not the exit, performs replacement.

## State files

- **Ownership record (v1).** Which pane/tab the primary created, keyed by
  Herdr socket + workspace:
  `$XDG_STATE_HOME/more-bwoah/hunk/<hash>.json` when `XDG_STATE_HOME` is an
  absolute path, otherwise `~/.local/state/more-bwoah/hunk/<hash>.json`
  (mode 0600). Pairing metadata only — never notes.
- **Primary-role lock.** `<hash>.primary.lock` next to the record. This is a
  persistent, process-owned native flock inode: it decides who becomes
  primary, and ownership ends only when the owning process exits. **Never
  delete, rename, or truncate it** to force takeover — removing the inode can
  admit two primaries at once. It is not child-control permission, and it is
  safe to leave in place forever.
- **Launch-intent sidecar.** `<hash>.json.launch.json` exists only while a
  child creation is in flight or its outcome is unproven. If a creation reply
  is lost or a crash interrupts a launch, the extension keeps it and reports
  `Hunk creation outcome is unknown; inspect the workspace before clearing
  <path>`. Inspect the workspace (look for an orphan `diff` tab) before
  removing anything — the next primary recovers a provable child automatically.
- **Rolling archive.** `<omp session artifacts>/hunk/review-notes.json`.

## Troubleshooting

- **"Herdr integration runs only in the main session." / "…requires an
  interactive TUI session…" / "Not running inside a herdr workspace…"** — the
  extension is intentionally inert for subagents, headless runs, nested omp,
  and non-Herdr launches.
- **"Herdr integration requires the host FileLock API."** — the omp host
  lacks the required native lock; admission remains pending. Use a host build
  exposing `@oh-my-pi/pi-natives`'s `FileLock`.
- **"Herdr integration is waiting for workspace ownership."** — admission
  could not be decided (host or filesystem error); it retries every 3 seconds.
- **"Herdr integration is inactive in this secondary omp session."** — another
  omp process owns this workspace. Use `/diff` and the review tools in the
  primary; the secondary never touches its child.
- **"This repository has no commits yet." / "This directory is not a git
  repository."** — the cwd must be a git checkout with a committed HEAD for a
  diff to exist. With Git resolution merely indeterminate (e.g. a timeout),
  review access pauses (`the checkout cannot be resolved right now`) and
  resumes on the next tick without disturbing the existing child.
- **"review not ready yet"** — Hunk may still be loading; the child stays and
  a later lifecycle tick binds it. `/diff` also re-checks readiness.
- **Transient Herdr/Hunk failures** (timeouts, socket errors, malformed
  replies) are classified as indeterminate, never as absence: the extension
  pauses that action and retries on the next tick instead of closing a healthy
  child or creating a duplicate. Only a definitive pane-not-found reply (or
  proven process death) counts as gone.
- **"Hunk creation outcome is unknown; inspect the workspace before clearing
  …"** — a tab creation was submitted but its result could not be proven.
  Inspect the workspace before deleting the sidecar or record; the primary
  lock holder recovers automatically once the child's identity is provable.
- **`reviewChanged` after a comment write** — the review reloaded while the
  write was in flight; call `hunk_review` again before further annotations.
- **After a `hunk` upgrade** — the extension never restarts Hunk's daemon. If
  the child's Hunk process has exited to its idle shell, reconciliation retires
  that verified pane and launches a fresh child on its own.
