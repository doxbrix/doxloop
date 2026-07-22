# CI and automation

Deterministic validation is suitable for pull requests. Agent authoring is
optional because it may require credentials, model access, and interactive
decisions.

## Validate in CI

```bash
pnpm install --frozen-lockfile
doxloop test
```

`doxloop test` exits with status 1 when validation errors remain. Warnings are
reported but do not change the exit status.

Use structured output when another tool consumes the result:

```bash
doxloop test --format json > doxloop-validation.json
doxloop status --format json
```

Run the selected generator's strict build after Doxloop validation. Obtain the
command and output directory with:

```bash
doxloop generator doctor
doxloop generator info <generator>
```

## Agent evaluations

```bash
pnpm eval:agents -- --agent codex --case cli
```

Real-agent evaluations run reviews in read-only/plan mode. A case must:

- exit successfully;
- identify the required behavior signals;
- cite enough configured source evidence;
- prioritize findings;
- report a score out of 100; and
- leave the fixture project byte-for-byte unchanged.

Evaluation output is written below the Git-ignored `evals/results/` directory.
Use a scheduled or manually approved job for model-backed evaluations; keep the
deterministic typecheck, tests, skill validation, build, and package checks on
every pull request.

## Publishing

Never run `doxloop deploy` in an untrusted pull-request context. Use protected
environments and short-lived or scoped credentials. Run `doxloop deploy
--dry-run` before an approved deployment.
