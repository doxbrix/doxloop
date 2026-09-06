# Doxloop project format

Doxloop stores project configuration under `.doxloop/`. Commit the configuration
and synchronization state when a team should share the same authoring decisions.

The setup wizard creates a new documentation project beside, never inside, the
product source. Use **Settings** in the control center to change shared
configuration without editing JSON by hand; this page documents the files
themselves for review, version control, and advanced options that have no
form field.

## `project.json`

```json
{
  "schemaVersion": 1,
  "title": "Example documentation",
  "contentDir": "",
  "generator": "doxbrix",
  "sources": [{
    "name": "product",
    "path": "../product",
    "remote": {
      "provider": "github",
      "repository": "example/product",
      "branch": "main",
      "tokenEnv": "GITHUB_TOKEN"
    }
  }],
  "designReferences": [{ "url": "https://docs.example.com/" }],
  "deployment": {
    "target": "doxbrix",
    "name": "Example documentation",
    "slug": "example-docs",
    "visibility": "private",
    "apiUrl": "https://app.doxbrix.com"
  },
  "application": {
    "baseUrl": "http://localhost:3000/",
    "source": "product",
    "readyPath": "/health",
    "screenshots": {
      "policy": "requested",
      "viewport": { "width": 1440, "height": 900 },
      "highlight": true,
      "startPath": "/settings/team",
      "workflow": "Reuse the signed-in demo workspace and synthetic team members. Capture the invite form and successful invitation state."
    }
  },
  "documentation": {
    "primaryAudience": "Application developers",
    "experienceLevel": "intermediate",
    "priorityOutcomes": ["Install the SDK", "Send the first request"],
    "preferredExamples": ["TypeScript", "curl"],
    "designDirection": "Compact developer reference with task-led guides",
    "locale": "en-US",
    "tone": ["clear", "direct", "professional"],
    "standardsProfile": "doxloop-v1",
    "styleGuide": "doxloop",
    "terminology": {},
    "exclusions": [],
    "accessibilityTarget": "WCAG 2.2 AA"
  },
  "sync": {
    "mode": "check",
    "branch": "main",
    "on": ["every@15m"],
    "watch": ["src/**", "openapi.yaml"],
    "ignore": ["pnpm-lock.yaml"],
    "budget": { "maxRunsPerDay": 8, "maxMinutes": 15, "maxUsd": 10 },
    "maxVerificationAgeDays": 30,
    "maxVerificationAgeSeverity": "warn"
  }
}
```

- `title` and `defaultAgent` are edited under **Settings → General**.
- `contentDir` is empty for new native Doxbrix projects, meaning reader content
  lives at the project root. Existing projects may retain a non-symlinked
  relative directory such as `docs`; external generators use their native
  content directories.
- `sources` is the read-only evidence allowlist managed on the **Sources**
  page. It may be empty when no local product source is available. Configured
  source paths must be outside the documentation project; sibling product and
  documentation directories are the recommended layout. Git repository sources
  carry a `remote` object and are downloaded as read-only snapshots into a
  `.doxloop-sources` directory beside the project. A source may declare
  `scope.space`, `scope.routePrefix`, and `scope.navigationGroup`, edited
  through **Documentation ownership** on the Sources page. Route prefixes
  cannot overlap. Pages intentionally shared by several sources must be named
  in `scope.sharedPages`.
- `generatorPackage` is required for an external generator and must match the
  official package selected by `generator`.
- `designReferences` accept absolute HTTP or HTTPS URLs without credentials.
- `application` is edited under **Settings → Visual evidence** and describes a
  safe local or test application surface for guide screenshots. `source` names
  a configured source. A legacy `startCommand` is preserved when present but
  is never executed by the capture workflow; the user owns application startup
  and test data. Screenshot policy is `requested`, `auto`, or `off`; projects
  without this object keep the existing behaviour. `screenshots.startPath`
  records the default starting route, and `screenshots.workflow` records
  authentication, safe fixture data, ordered actions, and expected outcomes
  that constrain capture planning. `authentication.loginPath` names the
  sign-in route the browser sign-in opens. Sign-in secrets are never stored
  here: the recorded browser session and any test-account credentials live
  under `~/.config/doxloop/capture-auth/<project key>/` (or
  `$DOXLOOP_CONFIG_HOME`) with owner-only permissions, keyed by the project
  root, and are managed under **Settings → Visual evidence → Application
  sign-in**.
- `deployment.target` is `doxbrix`, `github-pages`, `netlify`, or `vercel`.
  Common fields save the project name and slug. Doxbrix also uses `visibility`
  and `apiUrl`; GitHub Pages uses `branch` and optional `basePath`; Netlify uses
  `siteId`; Vercel uses `projectId` and optional `teamId`. Provider tokens are
  never stored here—they come from the OS credential store, protected user
  configuration, or `DOXLOOP_NETLIFY_TOKEN` / `DOXLOOP_VERCEL_TOKEN`. Missing
  names and slugs are derived from the project title.
- `documentation` persists confirmed reader, scope, terminology, editorial,
  and accessibility decisions, edited under **Settings → Audience and voice**
  and in each plan's **Documentation brief**.
- `sync` configures automatic maintenance and is managed by the
  **Monitoring** dialog on the Sources page. `mode` is `check` (report only),
  `propose` (generate an isolated review when run manually), or `auto`
  (generate an isolated review from configured triggers). Authoring modes
  never alter real documentation before approval and do not require
  documentation Git. `branch` names the product branch documentation follows.
  `on` selects one polling frequency: `every@Nm`, `every@Nh`, `daily@HH:MM`,
  `weekdays@HH:MM`, `weekly@<day>@HH:MM`, or `monthly@<day>@HH:MM`. `watch`
  and `ignore` are path patterns applied to changed source files; `ignore`
  always wins. `budget` caps unattended runs: `maxRunsPerDay` limits scheduled
  runs, `maxMinutes` stops an agent (and the planner) after that many minutes,
  and `maxUsd` passes a spending cap to Claude Code, which is the only agent
  with such a flag. Missing values use the defaults below. `maxVerificationAgeDays` warns or fails (according to
  `maxVerificationAgeSeverity`) when evidence has not been reverified
  recently, even when source revisions are unchanged.

Default `ignore` patterns cover lock files and snapshots. Test files are
deliberately not ignored, because the authoring workflow treats tests as
evidence of supported behaviour, so a changed test can legitimately change
documentation.

Schema version 1 treats a missing legacy `generator` as `doxbrix` and supplies
the default documentation brief when it is absent. Unsupported structures fail
closed rather than being silently migrated.

### Imported projects

A folder that already holds a documentation site can be adopted from the
control center (**Use existing documentation folder** in the setup wizard, or
**Import existing documentation…** in the project switcher) or with
`doxloop init --existing [directory]`. The generator is recognized from its
configuration files: `docs.json` (Doxbrix), `docusaurus.config.*`,
`mkdocs.yml`, `astro.config.*` mentioning Starlight, `<dir>/.vitepress/config.*`,
`next.config.*` mentioning Nextra or `theme.config.*`, `markdoc.config.*`,
`hugo.*` or a Hugo `config.toml`, `<dir>/conf.py` (Sphinx), and `_config.yml`
(Jekyll). The content directory and title are read from the same files where
they are declared, and both can be overridden.

Import writes `project.json` with no sources and the default brief, an
`evidence-map.json` in which every existing page has no sources and the
confidence `needs-human` (so the first update run must attach evidence before
drift detection trusts the page), the machine-local `.gitignore` entries
listed above, and the agent skills. It then runs a read-only discovery pass.
Pages, navigation, and generator configuration are never modified. A
generator other than Doxbrix must have its Doxloop generator package
resolvable from the folder; the control center offers to add it as a
development dependency.

## `projects.json` (user level)

The control center keeps a list of the projects it has opened at
`~/.doxloop/projects.json` (`DOXLOOP_HOME` overrides the directory). Each
entry records the project path, title, generator, and when it was last opened,
newest first, capped at twenty entries. The file is a convenience: a damaged
one is ignored and rewritten on the next open, and a project whose
`.doxloop/project.json` has disappeared is shown as missing until it is removed
from the list.

```json
{
  "schemaVersion": 1,
  "projects": [
    { "path": "/work/product-docs", "title": "Product documentation", "generator": "doxbrix", "lastOpenedAt": "2026-09-04T10:12:00.000Z" }
  ]
}
```

## `quality.json`

`.doxloop/quality.json` is an optional version 1 contract for external-link
policy and cache lifetime, opt-in executable examples, rendered routes and
viewports, lint limits, and disabled-by-default reader verification metadata.
See [release quality](./release-quality.md) for the complete schema and safety
model. Quality reports, link caches, current screenshots, and evaluation
results are derived artifacts; approved visual and evaluation baselines may be
committed when a team wants CI regression protection.

Proposal runs live under `.doxloop/runs/<id>/`: the isolated `workspace/`
the agent wrote into, the reviewed `run.json`, `baseline.json`, which holds a
content hash of every file as the workspace was created so review can tell
what the agent changed from what changed in the project while it ran, and
`authoring.json`, which records the instructions, agent, model, screenshot
mode, and source summary the run was started with so a failed run can be
resumed in place. UI recovery
checkpoints and logs live in `.doxloop/ui-jobs.json` and
`.doxloop/ui-job-logs/`. Learned local review guidance is stored in
`.doxloop/review-preferences.json`, and prepared Git delivery metadata is stored
in `.doxloop/deliveries/`. These machine-local artifacts are owner-readable,
excluded from proposal snapshots, and added to `.gitignore`; they are not part
of the portable project contract.

## Documentation plans

The control center creates `.doxloop/plans/<plan-id>/plan.json` before any
create or update authoring begins. The current approved snapshot is copied to
`.doxloop/documentation-plan.json` for the generation agent. Plan version 2 is
generator-neutral and records:

- the confirmed reader brief, scope, exclusions, terminology, locale,
  accessibility target, and style guide;
- deterministic discovery metadata and an evidence-backed capability map;
- page actions, purposes, priorities, structured source evidence, and the
  navigation outline;
- open clarification questions and their confirmed answers;
- the selected generator's content format, extensions, and native navigation
  boundaries; and
- the estimated page count, effort, execution settings, approval hash, and
  resulting proposal ID.

Every reviewable revision is archived in
`.doxloop/plans/<plan-id>/versions/v<N>.json`. Version 1 plans are migrated on
read without changing reader-facing documentation. Planning discovery is cached
by safe source-content hash under `.doxloop/cache/discovery/`; cache files and
plan run logs are operational state and should not be committed.

A plan in `planning`, `revising`, or `needs-input` cannot authorize authoring.
**Approve & generate** records an integrity hash, and generation refuses to
proceed if either the approved plan or its configured source snapshot changed.
Pages marked for a future backlog are omitted from the current proposed run.

## Quality review reports

Read-only agent reviews are stored as owner-readable JSON files under
`.doxloop/reviews/`. A report records the selected agent, model and reasoning,
the bounded score, hard-gate result, summary, and structured findings with page
and evidence references. Raw agent transcripts are not copied into these
reports. Reviews do not edit documentation, alter an approved plan, or create a
proposal; deterministic validation remains a separate release signal.

Request and deployment history uses `.doxloop/doxloop.db` and therefore requires
the package runtime contract, Node.js 22.13 or newer. Set
`DOXLOOP_NO_HISTORY=1` in the environment that starts the control center only
as an explicit opt-out; the **Update history** and **Deployment history**
panels surface that state.

## `sync-state.json`

Each source records the provider commit and timestamp used by the last accepted
automatic proposal. Local manual workflows can also record a fingerprint of
tracked and untracked non-ignored, non-credential source content used by the
last successful authoring run. The fingerprint prevents an unchanged dirty
working tree from being reported again after its content is committed.

A local folder without Git history records the marker commit `local-content`
together with the fingerprint and a `files` map of source-relative paths to
content digests. A later check compares the folder against that map, so it
can name the added, modified, and deleted files even though there is no
commit range to diff. Credential files are never read or listed.

Doxloop updates synchronization state only when a create or update proposal
has been fully accepted, documentation validation passes, and the brief has a
primary audience and priority outcomes. Automatic review runs keep their staged
state separate and copy it into the real project only after every proposed
change has been accepted.

## `runs/`

`.doxloop/runs/` is ignored runtime state for generated documentation reviews.
Each run contains an isolated workspace, original copies of changed files, a
`baseline.json` hash manifest of the project as the run started, and a
`run.json` manifest with the trigger, validation result, exact line hunks, and
acceptance decisions. A change whose file also moved in the project while the
agent ran is marked `changedDuringRun`; the **Review** page groups those under
**Changed while the agent ran** and asks before applying them. The **Review** page lists the manifests and renders them.
The directory is not required to be committed and can be retained according to
local review policy; **Clean up archived** on the Review page removes eligible
workspaces.

The current run manifest is schema version 2. Each file change records its
reason, configured source paths or operations and revisions, affected public
interfaces, reader-facing claims, file-relevant validation, confidence,
assumptions, originating plan or request, and agent or human authorship. This
is what the **Why this change** panel shows. Schema-version-1 manifests are
migrated when read.

**Ask agent to revise** seeds a new isolated workspace from the prior proposal
and records the selected files or hunks and reviewer instruction. The old
proposal is retained as superseded. **Edit page** changes remain inside the
workspace, run validation, and record whether existing evidence still applies
or needs review.

Before the first accepted hunk, Doxloop snapshots the exact affected files and
operational sync state. A completed application also snapshots the exact
applied result. Undo compares the live files with that result and stops instead
of overwriting a later edit; successful undo restores the pre-acceptance
snapshot atomically. Proposals receive a 30-day retention date. Archived
workspaces are removed only through explicit cleanup, while expired rejected,
failed, superseded, and undone workspaces are eligible for cleanup.

## `evidence-map.json`

`.doxloop/evidence-map.json` records which configured source, and which
source-relative paths or API operations, produced each page. Commit it: it is
what lets Monitoring name the individual pages a later source change made
stale, rather than reporting only that a source changed.

```json
{
  "schemaVersion": 1,
  "pages": {
    "docs/guides/authentication.md": {
      "sources": [{ "source": "product", "paths": ["src/auth.ts"] }],
      "verifiedAt": { "product": "9f2c1ab..." },
      "verifiedOn": { "product": "2026-08-26T10:00:00.000Z" },
      "confidence": "verified",
      "claims": ["Access tokens expire after 900 seconds"],
      "claimVerification": {
        "Access tokens expire after 900 seconds": "verified"
      }
    }
  }
}
```

Pages are keyed by project-relative path including the extension. A recorded
directory matches everything below it. An entry without `paths` means the page
depends on the whole source. `confidence` is `verified`, `inferred`, or
`needs-human`; the last raises a validation warning so an unverified claim is
visible rather than silently published.

Authoring runs write this file. A malformed file fails closed: delete it and
run an update from the **Update** page to rebuild it.

`verifiedAt` records the source revision or content hash. `verifiedOn` records
when the claims were actually checked and drives the maximum-age policy. Claim
checks treat changed or expired evidence as `needs-human` rather than
preserving an old verified state. `claimVerification` may record an exact claim
as `verified`, `inferred`, `contradicted`, or `needs-human`; it must never
claim more certainty than the configured source supports.

The **Documentation coverage** section of the Sources page reports connector
health, coverage by public surface and source scope, and evidence-precision
suggestions. Coverage describes traceability to discovered evidence; it is not
a correctness score.

## `coverage-resolutions.json`

`.doxloop/coverage-resolutions.json` records explicit decisions made from the
coverage gap review on the Sources page. A resolution can link a reader journey
to an existing page (**Link existing page**), exclude a discovered source item
from the supported public surface (**Mark as internal**), drop a journey that
is no longer a priority, or retain a needs-human decision (**Decide later**).
Commit this file so exclusions and journey mappings remain stable for every
contributor and CI run.

Linking a product surface also writes its precise identifier to
`.doxloop/evidence-map.json`. Removing a reader journey updates
`documentation.priorityOutcomes` in `project.json`. Future documentation plans
preserve those configured outcomes verbatim, even when the planning agent adds a
more specific description, so wording changes do not reset journey coverage.

Coverage uses the newest approved, generating, or generated plan. Planning,
cancelled, failed, and stale drafts do not replace the coverage baseline.

## `last-run.json`

After a successful create or update, Doxloop records the mode, selected agent,
completion time, validation summary, and synchronized source count. This is an
ignored operational receipt, not an evidence map or a substitute for version
control.

## Reference-design evidence

`.doxloop/reference-design.json` is authored by the design-reference workflow.
Screenshots and raw measurements remain under `.doxloop/cache/` and should not
be committed.

Application guide screenshots are different: they are reader-facing assets,
are placed in the selected generator's native asset directory, and should be
committed with the guide. They are enabled per run by **Add product
screenshots?** on the Create and Update pages, or by the screenshot policy
under **Settings → Visual evidence**; a request that clearly asks for
screenshots also enables the capture workflow. Contextual focus rings and
numbered markers are baked into the image so they render consistently across
generators. Plans record whether screenshots are automatic, required, or
disabled and identify the specific UI guides, application-relative start path,
ordered safe workflow, and an explicit capture sequence from entry through
verification before approval. The sequence contains one meaningful visible
state per planned image; UI-heavy tutorials and how-to guides therefore plan
several captures instead of defaulting to one final-state screenshot. Approval
requires a reachable configured application and complete capture details for
every visual guide. During generation the agent writes
`.doxloop/screenshot-manifest.json`; Doxloop verifies the planned page, purpose,
expected state, PNG dimensions, uniqueness, embedding, and completed privacy and
legibility checks before it creates a review proposal.
