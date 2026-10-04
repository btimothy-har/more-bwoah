# hunk — Hunk companion extension for omp

Pairs each main omp session inside a [herdr](https://herdr.dev) workspace with a
persistent, workspace-owned [Hunk](https://hunk.dev) review tab. omp owns the
exact companion binding (herdr tab/pane + Hunk session id + process id); Hunk
owns all live annotation state. The conversation explains the task; the Hunk
tab explains the code.

## Prerequisites

- `omp` running as the **main agent session, in TUI mode, inside a herdr pane**
  (`HERDR_ENV=1`). Subagents and headless runs (`-p`, rpc/SDK) stay inert, and
  outside herdr a main TUI session reports the skipped launch at startup.
  Explicit `/diff` and tool calls also explain why the companion is unavailable.
- `hunk` on PATH (verified against 0.22.0), `herdr` on PATH or
  `HERDR_BIN_PATH` (verified against 0.9.3), and `git`.
- A git repository with at least one commit; the checkout root is the
  companion's review root.

## Install

Install from a durable checkout with omp's native CLI:

```sh
omp install /absolute/path/to/more-bwoah/hunk
```

For a local directory, `omp install` links the extension rather than copying
it, so edits in that checkout propagate. Keep the checkout at that path;
install from the main checkout after merging, not a temporary worktree you
intend to remove. Preview without changing anything with `--dry-run`.

For one-off loading without installation:

```sh
omp -e /absolute/path/to/more-bwoah/hunk/index.ts
```

Disable with `disabledExtensions: ["extension-module:hunk"]`.

## What you get

- **Companion tab.** On startup (main session, inside herdr, in a git repo) the
  extension creates a background `hunk` tab labeled `hunk` in your workspace
  and binds the exact session id it registers — by process id, not by label or
  repo path, so unrelated Hunk windows on the same checkout are never touched.
  The tab is created without stealing focus. Completing a `/diff` selection
  retitles the tab to `diff` so its name reflects the active view.
- **`/diff`** — selector-only scope control for the companion:
  - **Full session** — the HEAD captured when this omp session entered the
    checkout, diffed against the live working tree. Includes checkpoint
    commits plus staged, unstaged, and untracked changes.
  - **Against a base branch** — the merge-base of the selected branch and the
    current HEAD, diffed against the working tree. Pinpointed to the divergence
    commit, so ongoing work stays visible (this is not `diff main...HEAD`,
    which excludes uncommitted work).
  - **Specific commit** — one pinned commit (`hunk show <sha>`).
  Canceling any selector changes nothing. Non-argument policy: `/diff` takes no
  arguments. After a completed selection the companion is (re)opened if needed,
  reloaded, and focused. A companion you closed stays closed until you
  complete a `/diff` selection (leaving git entirely is different — see
  Lifecycle).
- **Two-way annotations.** Your inline notes in Hunk (the `c` action) are the
  feedback channel; the agent pulls them on demand with `hunk_review` and can
  reply in-thread or leave rationale notes with `hunk_comment`. Saving a note
  never interrupts or wakes the agent, and note text is treated as ordinary
  data, never as instructions.
- **Rolling archive.** Every 30 seconds the extension snapshots the published
  review (structure, selection, and all saved notes; no patch text) to
  `<session artifacts>/hunk/review-notes.json`, plus a best-effort final
  snapshot on exit. The archive is a record, not a restorable session: drafts,
  notes on files that left the diff, and full UI state are not captured, and
  nothing is ever replayed into Hunk.

## Lifecycle

- A new omp session starts the companion with **fresh annotations**: notes from
  the previous session in that companion are cleared (`comment clear --all`)
  once, at the boundary. If that reset fails, annotations stay disabled until
  a completed `/diff` selection retries it successfully. Ordinary edits and
  scope changes do not clear notes.
- Moving between checkouts/worktrees (e.g. `/move`) relaunches the review
  process for the new root with a new session id; archives stay under the same
  omp session. If the pane is busy with an unrelated process, it is left
  untouched and reported; a completed `/diff` can open a new companion tab
  without sending any input to the blocked pane.
- Leaving git entirely parks the companion: the tab and its last review stay
  open, while annotations and archiving pause. It reopens on its own when you
  return to a git checkout — unlike a tab you closed deliberately, which stays
  closed until you complete a `/diff` selection.
- On omp exit the companion tab stays open for review.
- If you close the tab, the extension respects that for the rest of the omp
  session (tools will tell you to use `/diff`); a fresh omp session may reopen
  it at startup.

## State files

- Ownership record (which pane/tab the extension created, keyed by herdr
  socket + workspace): `$XDG_STATE_HOME/more-bwoah/hunk/<hash>.json` when
  `XDG_STATE_HOME` is set to an absolute path, otherwise
  `~/.local/state/more-bwoah/hunk/<hash>.json` (mode 0600). This is pairing
  metadata only — never notes.
- Rolling archive: `<omp session home>/hunk/review-notes.json`.

Delete the ownership record to make the extension forget a pairing.

## Troubleshooting

- **"requires omp running inside a herdr workspace"** — launch omp from a
  herdr pane; the extension is intentionally inert elsewhere.
- **"needs a git repository with at least one commit"** — the cwd must be a
  git checkout with a committed HEAD.
- **"review not ready yet (timed out)"** — Hunk may still be loading; the tab
  stays and a later health check binds it. `/diff` also re-checks.
- **Transient herdr/hunk failures** (timeouts, socket errors, malformed
  replies) are classified as indeterminate, never as "the tab is gone": the
  extension skips that check and retries on the next lifecycle tick instead of
  closing a healthy companion or creating a duplicate tab. Only a definitive
  tab/pane-not-found reply counts as absence.
- **"owned by another agent pane"** — one main agent owns the workspace
  companion; close the other owner or delete the ownership record.
- **"could not identify the companion session uniquely"** — something launched
  a second review in the companion pane; the extension refuses to guess and
  never relaunches into that pane. Close the stuck companion tab, then
  complete a `/diff` selection to launch a fresh companion; deleting the
  ownership record (see State files) also clears the pairing.
- **Daemon version mismatch after a `hunk` upgrade** — restart the companion
  via `/diff`; the extension never restarts Hunk's daemon on its own.
