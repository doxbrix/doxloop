# Contributing

Use Node.js 22.13 or later and the pnpm version declared in `package.json`.

Maintainers publish npm and GitHub releases with the guarded local workflow in
[`docs/releasing.md`](docs/releasing.md).

```bash
pnpm install --frozen-lockfile
pnpm run check
```

Keep changes scoped and add tests for reader-visible CLI behavior, security
boundaries, adapters, and validators. Use `apply_patch`-style focused edits in a
dirty worktree and never replace unrelated work.

Generator changes must preserve the versioned adapter contract, update their
format skill and references, and pass scaffold/load/validate tests. Skill
changes must remain concise, link every required reference directly, and pass
`pnpm validate:skill`.

Model-backed evaluations are optional locally:

```bash
pnpm eval:agents -- --agent codex
```

They may consume external model quota. Do not include private source or
credentials in fixtures or reports.

Report vulnerabilities through the private process in `SECURITY.md`. Ordinary
bugs and enhancements may use the public issue tracker.
