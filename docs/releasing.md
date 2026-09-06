# Releasing Doxloop

Doxloop releases are published interactively from a maintainer's machine. The
release command performs versioning, changelog promotion, validation, npm
publishing, Git commit and tag creation, pushing, and GitHub Release creation.

## Prerequisites

- Start on `main`, with local `main` matching `origin/main`.
- Install the Node.js and pnpm versions required by `package.json`.
- Authenticate the writable `doxbrix` GitHub account with `gh auth login` once.
  The release command selects that account automatically and configures Git to
  use its GitHub CLI credential.
- Have npm publish access to `@doxbrix/doxloop` and any modified generator
  packages, with 2FA/WebAuthn configured.

Preview the next patch release without changing files or publishing:

```bash
pnpm release:local --dry-run
```

Publish the next patch release:

```bash
pnpm release:local
```

Choose another semantic-version increment or an exact version:

```bash
pnpm release:local minor
pnpm release:local major
pnpm release:local 0.2.0
```

The command shows every package it will publish and every uncommitted file that
will enter the release commit. It requires typing the exact target version
before it changes files. If there is no active npm session, it starts
`npm login`. During each `npm publish`, complete npm's interactive 2FA or
WebAuthn prompt.

Before confirmation or pushing, the command temporarily applies the proposed
versions and runs each selected package's complete npm `prepack` lifecycle. It
then restores the original worktree. This makes a dry run exercise the same
version-sensitive tests and builds that npm publishing will execute.

If publishing or GitHub Release creation fails after the release commit and tag
are created, fix the reported issue and rerun `pnpm release:local`. The command
detects the prepared tag, skips work already completed, and resumes the release.
It also verifies that the remote tag resolves to the exact prepared commit
before publishing.

The root package is always released. The command also compares each generator
package with its currently published source revision. Modified or unpublished
generators are assigned the same target version as the root package, their core
peer range is updated when necessary, and they are built and published after
the root package. Unchanged generators keep their existing versions and are
skipped. A dry run lists the exact package set without changing versions or
publishing.

## Evaluations

Model-backed evaluations are maintainer tooling, not part of the reader
workflow. Keep the deterministic typecheck, tests, skill validation, build, and
package checks on every pull request, and run evaluations from a scheduled or
manually approved job on a developer machine or self-hosted worker where a
coding agent is signed in.

```bash
doxloop evaluate --mode generation --max-pages 12
doxloop evaluate --mode update --before ../docs-before \
  --expected-change guides/billing.md --approve-baseline
pnpm eval:agents -- --agent codex --case cli
pnpm eval:agents -- --agent codex --model codex=<model> --case localized-update
pnpm eval:agents -- --mode generation --agent codex --case rest-api
pnpm eval:agents -- --mode update --agent codex --case localized-update
```

Review evaluations run the agent read-only. A review case must exit
successfully, identify the required behaviour signals, cite enough configured
source evidence, prioritize findings, report a score out of 100, and leave the
fixture project byte-for-byte unchanged.

Generation and update evaluations instead exercise the same plan-first
control-center contract as a user: wait for the proposed plan, approve it,
generate into an isolated proposal, accept that proposal, and score the
resulting documentation. They mutate only the temporary fixture copy.

Workspace evaluations score factual grounding, unsupported claims, coverage,
information architecture, executable examples, evidence precision, page
economy, update locality and preservation, accessibility, and reviewer
outcomes. Reports compare with `.doxloop/evaluation-baseline.json` and can
block on a configured regression threshold. The agent matrix runs identical
fixtures across agents and models, records duration and scores, and compares
with the reviewed `evals/baseline.json`. Output is written below the
Git-ignored `evals/results/` directory. Use `--approve-baseline` only after
reviewing a deliberate improvement or model change.

### Product hardening acceptance checks

Run `DOXLOOP_E2E_REAL=1 pnpm exec playwright test` after building. CI runs this
suite against the actual local UI server and a deterministic fake agent. The
Pages test verifies proposed changes stay isolated, accepts an edit, compares
exact file contents after undo, and exercises direct draft preview/save/undo.

Run `node scripts/ci-existing-sites.mjs` for two existing-site fixtures in
`evals/native-sites`. The script installs the real Docusaurus and MkDocs
runtimes, builds before import, imports without changing pages/configuration,
creates a fake-agent update, accepts it, builds the result, undoes it, and
builds again. It asserts custom slugs, non-root base paths, file-style URLs,
asset contents and exact restored prose. CI runs this separately from unit
tests and uploads `evals/results/existing-sites.json`.

Real-agent evaluation remains opt-in, outside `pnpm test` and ordinary CI:

```sh
pnpm run build
node scripts/run-authoring-evals.mjs --agent codex --model codex=gpt-5.5 --case cli --mode review
node scripts/run-authoring-evals.mjs --agent claude --case cli --mode generation
node scripts/run-authoring-evals.mjs --agent codex --model codex=gpt-5.5 --case localized-update --mode update
```

Choose a model supported by the installed agent CLI and your account. Results
record the CLI version, model selection, fixture digest, elapsed time, exit
status, matched evidence and quality measurements. Review scoring uses the
final response rather than the agent's echoed prompt or tool transcript.
Generation/update runs preserve generated workspaces and raw quality/evaluation
reports under the ignored results folder. Tooling failures remain failed runs;
they do not earn content-quality credit. No new baseline is approved unless
`--approve-baseline` is explicitly supplied. Review scores measure detection of
known fixture defects; they are not proof of production documentation quality.
