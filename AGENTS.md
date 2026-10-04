# more-bwoah

`more-bwoah` is the extension library for the
[`omp`](https://github.com/btimothy-har/bwoah-my-pi) coding agent.

## Repo layout

One installable extension package per top-level directory:

- `<name>/index.ts` — default-exports a factory `(pi: ExtensionAPI) => void | Promise<void>`.
- `<name>/package.json` — required even for a single-file extension. Include a
  unique package `name` (`@more-bwoah/<name>`), a `version`, `"private": true`,
  `"type": "module"`, and `"omp": { "extensions": ["./index.ts"] }`.
  Declare every entry explicitly; helper/test files are not entry points.
- Keep extension-specific helpers, tests, and assets inside that directory.

Bare `index.ts` discovery and explicit `omp -e` loading can work without a
manifest, but `omp install <directory>` requires `package.json`. Verify new
packages with a real install and startup in an isolated home/profile; the
installer's `--dry-run` only previews actions and does not validate the package.

Loading is one level deep and symlink-friendly. The extension API surface and
loader behavior are documented in the `omp` repo (`docs/extensions.md`,
`docs/extension-loading.md`) — consult them when needed.

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
