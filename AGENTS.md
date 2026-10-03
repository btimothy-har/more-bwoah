# more-bwoah

`more-bwoah` is the extension library for the
[`omp`](https://github.com/btimothy-har/bwoah-my-pi) coding agent.

## Repo layout

One extension per top-level directory, consumed by `omp`'s extension loader:

- `<name>/index.ts` — default-exports a factory `(pi: ExtensionAPI) => void | Promise<void>`
- or `<name>/package.json` with an `omp`/`pi` → `extensions: [...]` manifest
  for multi-file extensions

Loading is one level deep and symlink-friendly. The extension API surface and
loader behavior are documented in the `omp` repo (`docs/extensions.md`,
`docs/extension-loading.md`) — consult them when needed; nothing here mirrors
them.

## Conventions

This repo owns its conventions independently. Keep them light:

- TypeScript, Bun runtime. Extensions are plain modules — no build step, no
  bundler.
- Extensions are self-contained: one directory each, no cross-extension
  imports, no assumptions beyond the `ExtensionAPI` passed to the factory.
- Target the installed `omp` binary's API surface, not upstream npm packages;
  verify against the installed binary when in doubt.
- Inside extension runtime code use the provided `logger`, never `console.*`
  (it corrupts the TUI/protocols the host may be running).
