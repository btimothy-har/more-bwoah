# hunk — Hunk companion extension for omp

Pairs each main omp session inside a [herdr](https://herdr.dev) workspace with a
persistent, workspace-owned [Hunk](https://hunk.dev) review tab. omp owns the
exact companion binding (herdr tab/pane + Hunk session id + process id); Hunk
owns all live annotation state. The conversation explains the task; the Hunk
tab explains the code.

## Prerequisites

- `omp` running inside a herdr pane (`HERDR_ENV=1`) — outside herdr the
  extension registers but does nothing.
- `hunk` on PATH (verified against 0.22.0), `herdr` on PATH or
  `HERDR_BIN_PATH` (verified against 0.9.3), and `git`.
- A git repository with at least one commit; the checkout root is the
  companion's review root.

## Install

Point omp at the extension entry (absolute path recommended):

```sh
omp -e /absolute/path/to/more-bwoah/hunk/index.ts
```

Or copy/symlink this directory into `~/.omp/agent/extensions/hunk` for
automatic discovery. Disable with `disabledExtensions: ["extension-module:hunk"]`.

## What you get

- **Companion tab.** On startup (main session, inside herdr, in a git repo) the
  extension creates a background `hunk` tab labeled `hunk` in your workspace
  and binds the exact session id it registers — by process id, not by label or
  repo path, so unrelated Hunk windows on the same checkout are never touched.
  The tab is created without stealing focus.
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
  reloaded, and focused. A closed companion stays closed until you complete a
  `/diff` selection.
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
  once, at the boundary. Within a session, edits and scope changes never
  intentionally delete notes.
- Leaving the checkout (e.g. `/move` to another worktree) retires the review
  process cleanly and relaunches it for the new root with a new session id;
  archives stay under the same omp session. If the pane is busy with an
  unrelated process, it is left untouched and reported.
- On omp exit the companion tab stays open for review.
- If you close the tab, the extension respects that for the rest of the omp
  session (tools will tell you to use `/diff`); a fresh omp session may reopen
  it at startup.

## State files

- Ownership record (which pane/tab the extension created, keyed by herdr
  socket + workspace): `${XDG_STATE_HOME}/more-bwoah/hunk/<hash>.json`
  (mode 0600). This is pairing metadata only — never notes.
- Rolling archive: `<omp session home>/hunk/review-notes.json`.

Delete the ownership record to make the extension forget a pairing.

## Troubleshooting

- **"requires omp running inside a herdr workspace"** — launch omp from a
  herdr pane; the extension is intentionally inert elsewhere.
- **"needs a git repository with at least one commit"** — the cwd must be a
  git checkout with a committed HEAD.
- **"review not ready yet (timed out)"** — Hunk may still be loading; the tab
  stays and a later health check binds it. `/diff` also re-checks.
- **"owned by another agent pane"** — one main agent owns the workspace
  companion; close the other owner or delete the ownership record.
- **"could not identify the companion session uniquely"** — something launched
  a second review in the companion pane; the extension refuses to guess.
  `/diff` relaunches cleanly.
- **Daemon version mismatch after a `hunk` upgrade** — restart the companion
  via `/diff`; the extension never restarts Hunk's daemon on its own.
