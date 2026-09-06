# Automation and CI

Doxloop automates documentation maintenance from the control center. Monitoring
watches the product repository, drafts a proposal when pages go stale, and
leaves the decision to a reviewer. Hosted continuous integration is a separate,
narrower concern: a runner has no signed-in coding agent and no browser, so it
can only run deterministic checks.

## Doxloop's own CI

The Doxloop repository runs `.github/workflows/ci.yml` on every pull request:
typecheck, the unit suite, skill validation, and a matrix that scaffolds,
previews, and builds every official generator with `scripts/ci-generator-smoke.mjs`.
`pnpm test` no longer triggers the full build; it compiles the core and the
generator packages only (`pnpm run build:test`), and the UI bundle is built by
`pnpm run build`.

## Automate maintenance with Monitoring

Open **Sources** and choose **Monitoring**. The dialog asks for:

- **Product branch**: the branch documentation follows.
- **Schedule**: daily, weekdays, weekly, monthly, or a custom interval in
  minutes or hours. Times use the device timezone.
- **Advanced watch scope and budgets**: watched paths, ignored paths, the
  maximum agent minutes and runs per day, the maximum Claude spend per run in
  US dollars (Claude Code only; Codex and Gemini have no spending flag), how
  many days verified evidence may age before it is re-verified, and whether
  expired verification warns or fails validation. The agent-minutes budget
  also bounds planning; `DOXLOOP_PLAN_TIMEOUT_MINUTES` overrides it for
  planning alone, and both default to 20 minutes for the planner.

**Save and install** registers a local OS scheduled job using launchd,
systemd or cron, or Windows Task Scheduler. On macOS, Doxloop smoke-tests the
new job in the real scheduler context before reporting success, including
whether the background process can find the coding agent. Other platforms
verify that the native schedule was installed.

Each cycle compares the documented commit with the provider's branch head
through the provider's read-only API. When the commit changed, Doxloop asks for
the changed-file list, downloads that exact commit as isolated evidence, and
checks which pages the change made stale. Current documentation records a quiet
no-op and starts no agent. Stale documentation starts the coding agent already
signed in on the machine, in an isolated workspace, and the result appears as a
proposal under **Review**. Monitoring never clones, fetches, commits, pushes, or
changes hooks in a source checkout, never edits the real documentation before a
reviewer accepts it, and never publishes.

Scheduled monitoring works with every source type. A Git repository source is
checked through the provider's API. A local folder is checked in place: a Git
checkout by its HEAD commit and working tree, any other folder by the file
digests recorded at the last sync, so even a plain folder can name the files
that changed. Private GitHub repositories use the environment variable named
by the source's `tokenEnv` setting, `GITHUB_TOKEN` by default, which is read
at runtime and never saved.

Every cycle computes what to do from the current repository state rather than
from the event that triggered it, so a missed, delayed, or duplicated run costs
time but never correctness.

## Check status and run a cycle

The **Sources** page shows each connected source with its last check time and
a **Test connection** action. **Overview** shows when the loop was last
checked and whether a proposal needs review. In the Monitoring dialog, **Check
now** starts one cycle as a visible job: its live log is under **Update**, and
when it finishes a notice reports whether anything changed, how many pages
are stale, and which proposal was drafted. **Disable** removes the schedule
while keeping the saved settings for later.

## Review background proposals

Background proposals stay pending until reviewed. Open **Review** to see every
proposal with its trigger and status. Each file shows the current version
beside the proposed version, rendered the way the published site renders them,
with changed words highlighted. The source view shows line-level context with
an **Accept change** button on each change. Only accepted changes are applied:
current file fingerprints are verified and the selected result is validated
before the actual documentation is touched.

## Deploy from the control center

Publishing is always an explicit action on the **Deploy** page. Sign in with
your browser, confirm visibility, run a **Dry run** to validate and build
without uploading, then choose **Deploy to Doxbrix**. Deployments are private by
default, and a public deployment is shown clearly before it happens.

## Headless checks for hosted CI

A hosted runner cannot open the control center or run a signed-in coding
agent, so keep it limited to deterministic checks that need no agent, no model,
and no credentials. The Doxloop package exposes three headless checks for that
purpose, each with a `--format json` option and a non-zero exit status on
failure:

| Check | Purpose |
| --- | --- |
| `doxloop check` | Report the pages a source change made stale, using the committed evidence map and the provider branch. |
| `doxloop test` | Validate pages, navigation, links, metadata, code fences, and page depth. Errors fail; warnings do not. |
| `doxloop quality` | Run the versioned release-quality contract, including the generator's strict build. See [release quality](./release-quality.md). |

Keep authoring on machines where a coding agent is signed in: a developer
workstation or a self-hosted runner on hardware the team controls. Never deploy
from an untrusted pull-request context; use protected environments and
short-lived, scoped credentials.
