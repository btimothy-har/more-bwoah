# Development Rules

`more-bwoah` is the extension library for
[`btimothy-har/bwoah-my-pi`](https://github.com/btimothy-har/bwoah-my-pi) —
the `omp` coding agent. Cross-repo facts (fork context, read-only sibling
rules) live in `~/.omp/agent/shared-contexts/bwoah-shared-context.md`, injected
into sessions in both checkouts; this file governs work in this repo.

## Repo purpose

Each extension is a directory consumed by `omp`'s extension system:

- `<name>/index.ts` — default-exports a factory `(pi: ExtensionAPI) => void | Promise<void>`
- or `<name>/package.json` with an `omp`/`pi` → `extensions: [...]` manifest
  for multi-file extensions

Loading is one level deep and symlink-friendly; the authoring surface is
documented in the parent's `docs/extensions.md` and `docs/extension-loading.md`.
The parent checkout is a related read-only workspace in sessions here — read it
for reference, never modify it from this repo's sessions.

## Rules

- Extensions target the **installed** `omp` binary's API, not upstream npm
  packages — the install refuses `omp update`, so upstream may drift. Check
  the installed binary's actual surface before using an API.
- One extension per directory; keep extensions self-contained: no
  cross-extension imports, no runtime assumptions beyond `ExtensionAPI`
  (`@oh-my-pi/pi-coding-agent`).
- TypeScript throughout; Bun runtime. Follow the parent repo's code-quality
  rules for code written here: no `any`, no inline imports, Bun APIs over
  `node:*` where cleaner, `logger` (never `console.*`) in extension code.
