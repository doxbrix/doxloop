# CI and automation

Deterministic checks are suitable for pull requests. Agent authoring is not: it
runs the developer's own signed-in agent CLI, which a hosted runner does not
have. Split the two.

## Detect drift in CI

`doxloop check` reports which pages no longer match the configured sources. It
starts no agent, uses no model, and needs no credentials, so it belongs in
ordinary continuous integration:

```bash
doxloop check
```

It exits `1` when pages are stale or when drift cannot be determined, and `0`
when documentation is current. Machine-readable output lists the affected pages,
the source paths responsible, and the commit range:

```bash
doxloop check --format json > doxloop-drift.json
```

`check` compares the recorded sync baseline with the configured provider branch,
so the job needs only the documentation project and read access to the provider
API. Answers come from remote repository state rather than from event payloads,
which makes repeated, delayed, or duplicated runs safe.

## Authoring runs locally

`doxloop create` and `doxloop update` start Codex, Claude Code, or Gemini using
that machine's existing sign-in. Doxloop never accepts or stores a model API
key. Run authoring where an agent CLI is signed in — a developer machine, or a
self-hosted runner on hardware the team controls — and keep hosted CI limited to
`check` and `test`.

Set up read-only remote polling with:

```bash
doxloop sync setup
```

This installs an OS scheduler job, not a source-repository hook. The job checks
the configured source branch through the provider's read API. If its commit
changed, Doxloop downloads an isolated snapshot for evidence and runs
`doxloop sync now`. Propose and auto modes create a validated review run and
never edit the real documentation before a user accepts it. Doxloop never
clones, fetches, commits, pushes, or changes hooks in the source checkout.

When an `every@Nm`, `every@Nh`, or `daily@HH:MM` trigger is chosen, Doxloop installs and smoke-tests a job
in the platform's own scheduler (launchd, a systemd timer, cron, or Task
Scheduler). Each scheduled run executes `doxloop sync now`, which authors only
when the mode allows it and the daily run budget is unspent. Verify the whole
path — including provider access, agent sign-in, and the
native scheduler's last exit — before depending on it:

```bash
doxloop sync status
```

Background runs remain pending until reviewed. List them in the terminal or open
the local visual review center:

```bash
doxloop sync history
doxloop sync review --open
```

The review center opens a proposal, lists the pages it changes and why, and then
walks through them one at a time. Each page shows the current version beside the
proposed version, both rendered the way the published site renders them, with the
changed words highlighted; the View menu switches to a line-by-line source diff
where each individual change carries its own Accept button. Only accepted hunks
are applied: current file fingerprints are verified and the selected result is
validated before the actual documentation is touched.

Every run computes what to do from the current repository state rather than from
the event that triggered it, so a missed, delayed, or duplicated run costs time
but never correctness.

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

Project identity, slug, destination, and visibility can be committed through
`doxloop settings`. An approved non-interactive job then runs:

```bash
doxloop deploy --yes
```

Use `doxloop deploy --public --yes` only when the job is explicitly authorized
to override the saved visibility and publish to everyone.
