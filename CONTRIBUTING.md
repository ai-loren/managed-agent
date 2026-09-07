# Contributing

## Commit conventions

Commits follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <subject>

<body — what changed and, more importantly, why>

Assisted-By: <tool>
```

Types: `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `build`, `ci`, `chore`.
Scopes are package names without the `@ma/` prefix: `core`, `contracts`, `store`,
`engine`, `runtime`, `sandbox`, `connectors`, `gateway`, `scheduler`, `cli`, `sdk`,
`console`, `server`, or `repo` for cross-cutting changes.

### AI assistance attribution

Work produced with AI assistance is marked with an **`Assisted-By:`** trailer, never
`Co-Authored-By:`. Authorship stays with the human who reviewed and accepted the change;
the tool is credited as an instrument, which is what it is.

```
Assisted-By: Claude Code
```

Do **not** add `Co-Authored-By: Claude`, `Co-Authored-By: <any agent>`, or list a tool as
an author or committer.

## Development

```bash
pnpm install
pnpm check        # lint + typecheck + test
pnpm test         # tests only
pnpm dev          # run the server
```

Requirements: Node >= 22.5 (we rely on native TypeScript execution, `node:test`, and
`node:sqlite`), pnpm 9.

## Code standards

- **TypeScript strict**, including `noUncheckedIndexedAccess`. No `any` in exported
  signatures; no `@ts-expect-error` without an adjacent comment explaining it.
- **Errors** cross module boundaries as `MaError` with a stable code. Never throw bare
  strings or leak a dependency's error type.
- **Time** is injected as a `Clock`. Code that calls `Date.now()` or `setTimeout`
  directly cannot be tested deterministically and will be asked to change.
- **Secrets** never enter logs, error details, or API responses. Credential values are
  write-only through the API.
- **Comments** explain *why*. The code already says what it does.

## Tests

Tests live in `packages/<name>/test/*.test.ts` and use `node:test` + `node:assert/strict`.
A test's name should state the behaviour being guaranteed, not the function being called:
`'refuses to decrypt when the AAD context differs'`, not `'unseal works'`.

New behaviour needs a test that would fail without it. Bug fixes need a test that
reproduces the bug first.
