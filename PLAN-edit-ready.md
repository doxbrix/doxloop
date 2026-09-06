# Plan: make Doxloop edit-ready

Implementation plan, not shipped documentation. Goal: take Doxloop from an
agent-only generator to a tool where a person can create, edit, review, export,
and publish professional documentation from the control center.

Scope note: **quality gates are deliberately out of scope.** Link checking,
lint, spelling, claim re-verification, rendered accessibility, code-sample
execution, and running `doxloop quality` inside the pipeline are parked for a
later pass. Phases 2 and 4 only display or emit what already exists; they add
no new checks.

Baseline: v0.1.5 on branch `stage`, 486 unit tests passing, no CI workflow.
Effort is in engineer-weeks for one engineer, and is rough.
A rendered version of this plan is published at
<https://claude.ai/code/artifact/35044c36-5732-456d-a8ef-115f900327d8>.

## Why this order

Phase 0 and Phase 1 are independent of each other and should start together.
Phase 0's stage events and Phase 1's page service are the two foundations every
later phase builds on, and both are visible to users inside the first two weeks.
Phases 3 through 7 each depend only on Phase 1's page API, so they can be
reordered if priorities change.

| Phase | Scope | Effort |
| --- | --- | --- |
| 0 | Run control and live progress | 1.5 wk |
| 1 | Direct page editing | 3 wk |
| 2 | Review and workspace fixes | 1.5 wk |
| 3 | Project switcher and import | 2 wk |
| 4 | Export and deploy targets | 3 wk |
| 5 | Local monitoring and agent parity | 2 wk |
| 6 | Generator tiers and adapters | 2.5 wk |
| 7 | Navigation, theme, assets, content types | 4 wk |

Total: roughly 19–20 engineer-weeks.

---

## Phase 0 — Run control and live progress

**Runs alongside Phase 1. ~1.5 weeks. Depends on nothing.**

> **Shipped on 4 Sep 2026** on branch `stage`. Deviations from the task list
> below: unattended agents run in their own process group (new
> `src/agent-process.ts`) and the whole group is stopped, which covers the
> capture MCP server and its browser without tracking them separately; on
> Windows the tree is ended with `taskkill /T`. Stage derivation lives in
> `src/authoring-progress.ts` (chokidar watcher for every agent plus Claude
> tool-call hooks) and stages are announced as `pending` first, which extends
> the `agent-events-v1` contract with a `pending` status and an optional
> `progress` object. Codex and Gemini output is piped but not yet formatted;
> that formatting stays in Phase 5. The spending cap is edited under
> **Monitoring → Advanced watch scope and budgets** rather than the wizard.
> Still to do: confirm the acceptance list below against a real agent run.

Make every agent run stoppable, bounded, and visible. This is small, touches
only the pipeline and job plumbing, and removes the class of "the run is stuck
and I cannot tell what it is doing" complaints that will otherwise dominate
feedback on every later phase.

### Tasks

**Forward termination to the agent.** When the doxloop CLI receives SIGTERM or
SIGINT during an agent run, kill the agent child, wait up to 10 s, then SIGKILL.
Also shut down the capture MCP browser it started. Today the UI kills the
doxloop CLI child ([src/ui-server.ts:355](src/ui-server.ts:355)) but neither the
CLI nor the author module forwards the signal, so the agent and its browser keep
running and writing into the workspace after "Stop". The only signal handlers in
the codebase are in the demo command ([src/cli.ts:157](src/cli.ts:157)). Add a
`runWithSignalForwarding(child)` helper near the spawn in
[src/author.ts:209](src/author.ts:209) and the existing kill at
[src/author.ts:254](src/author.ts:254), reused by the plan, author, revise, and
resume paths.

**Planning timeout.** Default 20 minutes, overridable by
`project.sync.budget.maxMinutes` and a `DOXLOOP_PLAN_TIMEOUT_MINUTES` env var.
On timeout, fail the job with a named reason.
[src/documentation-plan.ts:959](src/documentation-plan.ts:959) has no budget at
all today; reuse the timer pattern from
[src/author.ts:247](src/author.ts:247) but add SIGKILL escalation.

**Claude spend cap.** Pass `--max-budget-usd` from a new
`project.sync.budget.maxUsd` (default unset, wizard suggests 10), and surface the
stop reason when Claude ends on budget. Argument builder is at
[src/author.ts:469](src/author.ts:469). Codex has no equivalent flag; say so in
the Settings copy.

**Real stage progress.** Replace the all-at-once stage flips at
[src/documentation-plan.ts:527](src/documentation-plan.ts:527) with events
derived from what the agent actually does: page write → authoring, nav file
write → navigation, evidence-map write → evidence, capture tool call →
screenshots, `doxloop test` call → validating. Add a "pages written N of M"
counter to the authoring stage. For Claude, derive these from the stream
formatter, which already extracts file paths at
[src/author.ts:844](src/author.ts:844). For Codex and Gemini, switch stdio from
inherit to piped so output is captured in-process, and add a chokidar watcher on
the run workspace as the agent-agnostic fallback (chokidar is already a
dependency, used in [src/preview.ts](src/preview.ts)).

**Every job type gets a live view and a cancel.** Include `proposal:revise`,
`proposal:resume`, `sync`, `login`, and agent install jobs in the activity feed.
A failed revision must raise a banner on Review. The UI filter is at
[ui/src/WorkspaceApplication.tsx:717](ui/src/WorkspaceApplication.tsx:717); the
unused `JobTable` at [ui/src/components.tsx:340](ui/src/components.tsx:340)
already has cancel buttons.

**Keep the deploy progress panel on failure**, and show a "finish sign-in in your
browser" state while the login job runs.
[ui/src/WorkspaceApplication.tsx:2449](ui/src/WorkspaceApplication.tsx:2449)
hides the panel the moment the job stops running; render it until dismissed.

**Tests.** Signal forwarding with a fake agent script that traps SIGTERM;
timeout; stage derivation per event type; job feed snapshot. Extend
`author.test.ts`, `documentation-plan.test.ts`, `job-events.test.ts`.

### Acceptance

- Clicking Stop during generation ends the agent process and the capture browser
  within 10 s, and no further files change in the run workspace.
- A planner that never returns fails with "Planning stopped after 20 minutes"
  instead of running forever.
- During generation the stage list advances one stage at a time and shows pages
  written out of pages planned.
- "Ask agent to revise" shows a running job with a Stop button; a failed revision
  shows a banner naming the reason.

---

## Phase 1 — Agent-driven page editing

**~3 weeks. Depends on nothing; Phase 0 recommended in parallel.**

> **Scope revised on 4 Sep 2026.** Editing is agent-only: the user picks a page
> in a new **Pages** view, describes the change in plain language, and the agent
> makes it in an isolated proposal that the user accepts, rejects, refines, or
> undoes. There is no manual text editor. The detailed implementation guide is
> [PLAN-phase-1-page-editing.md](PLAN-phase-1-page-editing.md); it supersedes the
> design and task table below where they differ (the CodeMirror editor, the
> `PUT /api/pages/content` write route, and the "edit with live preview" items
> are dropped; the page list, preview, history, scope enforcement, and entry
> points remain).

Let a person open any accepted page and get it changed by describing what
should change, without planning a full agent run. Today the only content write
path is scoped to a proposal change
([src/ui-server.ts:671](src/ui-server.ts:671)), so fixing a typo costs a full
plan-and-generate cycle. This is the core of the request.

### Design

- **One page service, two callers.** Extract the validate-then-write-with-rollback
  logic from `editSyncRunChange`
  ([src/sync-runs.ts:896](src/sync-runs.ts:896)) into a shared `src/pages.ts`.
  The proposal editor and the new direct editor both call it, so validation,
  fingerprint conflict checks, and evidence disposition behave identically.
- **Pages are addressed by project-relative path**, listed from the generator's
  navigation plus any page files missing from navigation (flagged as orphans).
  For Doxbrix `validateProject` already computes this list; for external
  generators use `adapter.readPage` and the adapter's page extensions.
- **Preview renders server-side.** Doxbrix pages render through the existing
  `doxbrixDocument` ([src/preview.ts:238](src/preview.ts:238)). External
  generators get a generic Markdown render with a "components render in the full
  preview" note, since their native build is far too slow for keystroke preview.
- **Edits are recorded.** Each save writes a history row of action `edit` with the
  path and byte delta, and updates the page's evidence-map entry with the chosen
  disposition (evidence preserved, or needs review). This keeps drift detection
  honest.
- **Editor component.** CodeMirror 6 with the Markdown language pack, bundled
  through the existing Vite UI build. Gives syntax highlighting, line numbers,
  search, and a stable API for later snippet insertion.

### Tasks

| Layer | Work | Touchpoints |
| --- | --- | --- |
| Server | `GET /api/pages`: tree with title, path, section, word count, evidence status, orphan flag | New `src/pages.ts`; nav parsing from [src/validation.ts:209](src/validation.ts:209) |
| Server | `GET /api/pages/content?path=` returns content, frontmatter, fingerprint. `PUT` takes content + fingerprint + disposition, 409 on mismatch, validates and rolls back on error | Route beside [src/ui-server.ts:671](src/ui-server.ts:671); refuse writes during a project-writing job via `assertNoActiveDocumentationJob` ([src/ui-server.ts:1665](src/ui-server.ts:1665)) |
| Server | `POST /api/pages/render` returns preview HTML for unsaved content, debounced client side | [src/preview.ts:238](src/preview.ts:238) |
| Server | `POST /api/pages` create from a page-type template, plus `DELETE` and rename; Doxbrix updates `docs.json` navigation | Templates from `skills/doxloop-authoring/references/page-depth.md`; new optional adapter hook `writeNavigation` in [src/generator-api.ts](src/generator-api.ts), built out in Phase 7 |
| CLI | `doxloop pages list` and `doxloop pages edit <path> --from <file>` so scripts and UI share one path | [src/cli.ts](src/cli.ts) command table |
| UI | New **Pages** route: left tree, editor, right live preview, frontmatter form, toolbar for callout / steps / code group / image / table. Validation issues inline with line jump. Conflict dialog offers reload or overwrite | Add `pages` to [ui/src/routes.ts](ui/src/routes.ts); new `ui/src/PagesEditor.tsx`; snippets keyed by generator |
| UI | Replace the proposal edit textarea with the same editor; refresh diff and rendered preview after save or accept | Textarea at [ui/src/WorkspaceApplication.tsx:1951](ui/src/WorkspaceApplication.tsx:1951); stale refetch keys at 2126 and 1877 |
| UI | Entry points: "Edit this page" on Overview coverage rows, on the Review file header, and a page picker in the top bar | Keeps the loop visible: edit → preview → deploy |
| Tests | Page service units (conflict, rollback, disposition), route tests for all verbs, e2e open-edit-save-preview against a real server | New `src/pages.test.ts`; extend `e2e/control-center.spec.mjs`, which mocks every API call today |

### Decision to make

CodeMirror 6 (recommended; roughly 300 KB gzipped once, real editing) versus a
textarea with preview (zero dependencies, weaker). The rest of the phase is
identical either way.

### Acceptance

- A user fixes a typo on an accepted page, sees the rendered result while typing,
  saves, and the change is in the local preview within a second, with no agent run.
- Saving a page that breaks validation shows the issue inline and leaves the file
  untouched on disk.
- Two editors on the same page: the second save gets a conflict dialog, never a
  silent overwrite.
- Update history lists the manual edit with the page path.
- The proposal editor and the pages editor are the same component.

---

## Phase 2 — Review and workspace fixes

**~1.5 weeks. Depends on Phase 1 for the editor swap.**

> **Shipped on 4 Sep 2026** on branch `stage`. Deviations from the task list
> below: the three-way comparison keeps a content-hash manifest of the run
> workspace (`baseline.json` beside `run.json`) rather than the file bodies,
> which is enough to tell "agent only", "project only", and "both" apart; the
> live file stays the before side, so the diff shows exactly what an accept
> would replace. Files changed by both sides carry `changedDuringRun` and
> `POST /api/proposals/:id/accept` needs `confirmChangedDuringRun: true` for
> them. Internal route ids (`authoring`, `proposals`, `publish`) were kept and
> only the URL segments renamed, so `doxloop ui --page` accepts both. The
> "editor swap" this phase depended on no longer exists after the Phase 1
> scope change, so nothing here touches an editor. Still to do: walk the
> review flow once against a real generated proposal.

Remove the friction found in a live walkthrough of the control center: review
opens on internal files, URLs do not match the navigation, edits made during a
run are proposed as reverts, and several forms and error paths misbehave. None is
large; together they are what a first-time user notices.

### Tasks

**Diff against the run-start snapshot, not the live project.** Files the user
changed during the run appear as a separate "changed while the agent ran" group
needing explicit confirmation to overwrite. Today
[src/sync-runs.ts:1372](src/sync-runs.ts:1372) collects the before side from the
live root, while the snapshot already exists at
[src/sync-runs.ts:1270](src/sync-runs.ts:1270). Compare snapshot, live, and
workspace three ways.

**Default the file list to pages, navigation, and assets.** Put evidence,
configuration, and skill files under a "Supporting files" toggle, and open on the
first page rather than `evidence-map.json`. Categories exist at
[src/types.ts:395](src/types.ts:395). Also exclude `.doxloop/capture-output` from
diffs ([src/sync-runs.ts:74](src/sync-runs.ts:74)).

**"Review changes" in the ready dialog opens the proposal**, and Accept updates
hunk badges immediately.
[ui/src/WorkspaceApplication.tsx:235](ui/src/WorkspaceApplication.tsx:235) only
closes the dialog today.

**Rename routes to match labels** (`/update`, `/review`, `/deploy`) with
redirects from the old names, and put the selected proposal, file, and settings
section in the URL so refresh and back work
([ui/src/routes.ts](ui/src/routes.ts)). The README promise of stable URLs then
holds.

**Error boundary around the workspace**, and treat a validation error object as
"validation unavailable" instead of crashing on `.pages`
([ui/src/WorkspaceApplication.tsx:309](ui/src/WorkspaceApplication.tsx:309);
type the error union at [src/types.ts:340](src/types.ts:340)). Distinguish
transient poll failures from action failures by retrying quietly three times
before a banner (poll loop at
[ui/src/WorkspaceApplication.tsx:193](ui/src/WorkspaceApplication.tsx:193)).

**Forms resync from props after reload** (Settings at 2471, Deploy at 2273),
unsaved plan edits prompt before a background refresh replaces them (890), and
Update history lists the page names it already fetches (1494).

**Show the fetched but hidden state:** validation summary and agent sign-in status
on Overview, drift on Sources. The data is already in `/api/state`
([src/ui-server.ts:936](src/ui-server.ts:936)); this is rendering only, no
quality logic.

**Setup wizard:** step 3 Continue requires a successful "Check page" when
screenshots are on, and step errors render on the step where they happen
([ui/src/SetupApplication.tsx:340](ui/src/SetupApplication.tsx:340) and 471).
Remove the fake "Synced / Just now" chrome at
[ui/src/SetupApplication.tsx:420](ui/src/SetupApplication.tsx:420).

**Tests.** Route tests for redirects and URL state, three-way diff tests, e2e for
the review default view.

### Acceptance

- Opening a proposal lands on the first documentation page with internal files
  collapsed.
- A page edited by hand during a run is never silently reverted by Accept all.
- Refreshing on a selected proposal or settings section returns to the same view.
- A failing validation call degrades to a notice; the workspace never renders blank.

---

## Phase 3 — Project switcher and import

**~2 weeks. Depends on Phase 1 (page listing).**

> **Shipped on 4 Sep 2026** on branch `stage`. Deviations from the task list
> below: detection and import live in new `src/project-detect.ts` and
> `src/project-import.ts` rather than a branch of
> `assertUiProjectDirectoryAvailable`, and the registry in
> `src/project-registry.ts` honours a `DOXLOOP_HOME` override for tests. The
> API grew a read-only `POST /api/projects/inspect` (used before import so the
> person can correct the generator, content directory, and title), plus
> `browse` and `forget` routes. Import writes `.doxloop/project.json`, an
> evidence map with every page at `needs-human`, `.gitignore` entries, and the
> agent skills; an external generator's package must be resolvable, and the
> UI offers to add it to the folder's `package.json` as the one write outside
> `.doxloop`. Switching refuses while any non-preview job runs and stops
> previews. Creating a project from an open workspace accepts a parent
> location. Still to do: confirm import against a real MkDocs or Docusaurus
> checkout outside this monorepo, where the generator package is not
> pre-resolvable.

Replace the `alert()` stub at
[ui/src/WorkspaceApplication.tsx:248](ui/src/WorkspaceApplication.tsx:248) with a
real way to open, switch, and create projects, and let a team bring existing
documentation into Doxloop instead of starting from a blank scaffold.

### Design

- **A user-level registry** at `~/.doxloop/projects.json` records every project
  opened, with path, title, generator, and last opened time. The server keeps one
  active root at a time (the current model); switching swaps it after confirming
  no job is running.
- **Import means adopt, not convert.** Detect the generator from marker files
  (`docs.json`, `docusaurus.config.*`, `mkdocs.yml`, `conf.py`, `hugo.toml`, and
  so on), write only `.doxloop/project.json` plus an empty evidence map, install
  the matching skill, and run a read-only discovery so coverage and the page list
  are populated. Never touch the existing pages.

### Tasks

| Layer | Work | Touchpoints |
| --- | --- | --- |
| Server | `GET /api/projects` recent list; `POST /api/projects/open` (validated, refuses while jobs run); `POST /api/projects/import` | Root resolution at [src/ui-server.ts:169](src/ui-server.ts:169); `assertUiProjectDirectoryAvailable` at [src/ui-server.ts:1179](src/ui-server.ts:1179) gains an import branch; new `src/project-detect.ts` |
| Server | Import writes the minimal project file, runs discovery, seeds the evidence map with pages marked unverified so the first update can attach evidence | [src/project.ts](src/project.ts) scaffold, [src/evidence.ts](src/evidence.ts) |
| CLI | `doxloop init --existing`, and `doxloop ui --project <path>` | [src/cli.ts](src/cli.ts) |
| UI | Sidebar project switcher (recent, open folder, new project); wizard gains a first choice of "Start new" or "Use existing documentation folder" | [ui/src/SetupApplication.tsx](ui/src/SetupApplication.tsx) step 1; reuse the folder browser from the sources dialog |
| Tests | Detection fixtures per generator marker, import against the eval fixtures, switch refuses during a running job | `evals/fixtures/*/project` already give several layouts |

### Acceptance

- Pointing Doxloop at an existing MkDocs or Docusaurus repo yields a workspace
  with all pages listed, editable, and previewable, with no page modified.
- Switching between two projects from the sidebar takes one click and keeps both
  in the recent list.

---

## Phase 4 — Export and deploy targets

**~3 weeks. Depends on nothing hard; Phase 2 routing helps the Deploy page.**

> **Shipped on 4 Sep 2026** on branch `stage`. The built-in Doxbrix
> renderer now produces a portable static site with page directories, copied
> assets, search JSON, sitemap, robots metadata, canonical/social metadata, and
> configurable project-site base paths. `doxloop export --out <dir> [--zip]`
> works across generators, and every deploy dry run leaves a timestamped zip in
> `.doxloop/exports`. The Deploy page now selects Doxbrix, GitHub Pages
> (`gh-pages`), Netlify, or Vercel, edits target-specific configuration, stores
> Netlify/Vercel tokens outside the project (macOS Keychain on macOS, protected
> user config elsewhere, or environment variables), exposes folder/zip export,
> and keeps per-target history. GitHub's optional `docs/`-on-main and generated
> workflow variants were not added; the shipped target uses the dedicated
> `gh-pages` branch. Still to do: confirm the live-host acceptance items against
> real GitHub, Netlify, and Vercel accounts.

Break the Doxbrix-only lock-in. A user should be able to download the built site,
self-host it, and publish to common static hosts from the Deploy page. Today
deploy routes only to Doxbrix ([src/deploy.ts:82](src/deploy.ts:82)), and the
dry-run zip built in memory at
[src/artifact-deploy.ts:253](src/artifact-deploy.ts:253) is discarded.

### Design

- **A static build for Doxbrix.** The preview already renders every page
  in-process, including search and Mermaid
  ([src/preview.ts:76](src/preview.ts:76)). Turn that renderer into a build step
  that writes HTML, assets, a search index, and a sitemap to `build/`. This is the
  single biggest piece and is what makes every other target possible for the
  default generator.
- **A deploy target interface.** `DeployTarget { id, label, configure(), publish(bundle, options) }`
  in a new `src/deploy-targets/`, with Doxbrix moved behind it. Ship **Export
  folder or zip** and **GitHub Pages** first (both reuse existing code), then
  **Netlify** and **Vercel** through their deploy APIs, with tokens in the OS
  keychain or an env var, never in the project.
- **Dry run writes the bundle** to `.doxloop/exports/<timestamp>.zip`.

### Tasks

| Layer | Work | Touchpoints |
| --- | --- | --- |
| Core | Doxbrix static build: render all pages, copy assets, emit client search JSON, sitemap.xml, robots.txt, per-page meta from frontmatter | Extract [src/preview.ts:76](src/preview.ts:76)–225 into `src/doxbrix-build.ts`; register as the built-in `build` so [src/quality-gates.ts:163](src/quality-gates.ts:163) stops special-casing it |
| Core | `doxloop export --out <dir> [--zip]` for every generator | `packageStaticOutput` at [src/artifact-deploy.ts:205](src/artifact-deploy.ts:205) |
| Core | GitHub Pages target: push built output to `gh-pages` or `docs/` on main, optional generated workflow for CI builds | [src/git-delivery.ts:26](src/git-delivery.ts:26); needs a base-path option for project sites |
| Core | Netlify and Vercel targets via REST deploy endpoints; site id and token entered once, stored outside the project | Follow the device-login pattern in [src/auth.ts](src/auth.ts) |
| UI | Deploy page: target selector with per-target config, editable name / slug / API URL, export button, per-target history | Display-only fields at [ui/src/WorkspaceApplication.tsx:2401](ui/src/WorkspaceApplication.tsx:2401); the PATCH already exists at [src/ui-server.ts:1509](src/ui-server.ts:1509) |
| Tests | Static build snapshot on the demo project, export round-trip per generator with a CI toolchain, target publish against mocked APIs | Extend `deploy.test.ts`; add `doxbrix-build.test.ts` |

### Risk

The Doxbrix preview renderer may rely on runtime endpoints (search results, asset
resolution). Budget the first week of this phase for a spike that lists every
request the preview makes and decides what becomes static JSON versus what is
dropped in the static build.

### Acceptance

- Any project, including Doxbrix, exports to a folder that serves correctly from
  a plain static file server, with working navigation, search, and images.
- GitHub Pages deploy from the UI produces a live site on the next Pages build.
- Dry run leaves a zip on disk and names it in the log.

---

## Phase 5 — Local monitoring and agent parity

**~2 weeks. Depends on Phase 0 (job visibility, piped output).**

> **Shipped on 4 Sep 2026** on branch `stage`. Deviations from the task list
> below: the schedule does not fetch before checking. Doxloop never writes
> into a source checkout, and the documentation is generated from the working
> tree, so a local Git folder is compared by HEAD plus working tree and a
> plain folder by a per-file digest manifest recorded in `sync-state.json`
> (new `LOCAL_CONTENT_BASELINE` in `src/sync.ts`), which names added,
> modified, and deleted files. "Check now" reports through a new `outcome`
> event in the `agent-events-v1` contract (`src/job-events.ts`), stored on the
> job and shown as a toast with a **Review** shortcut. Gemini receives sources
> through `--include-directories`, the capture server through the workspace's
> `.gemini/settings.json` with `trust: true`, and streams `--output-format
> stream-json`; because it cannot be denied writes, an unattended Gemini run
> reads a throwaway copy of each local source made by the new
> `src/local-source-snapshot.ts`. Its sign-in probe is file-based (API key,
> Vertex AI project, or `~/.gemini/oauth_creds.json` presence). Codex streams
> `exec --json`. All three formatters live in the new `src/agent-log.ts` and
> feed one tool-call classifier, so stage progress works for every agent, and
> the planner's live log is formatted too. The capability matrix is a static
> table in `ui/src/agent-capabilities.tsx`, mirrored in
> `docs/agent-compatibility.md`. Still to do: exercise a real Gemini and a
> real Codex run against the current CLI versions, since the event shapes
> were implemented from their documentation, and confirm the scheduled local
> check on a machine whose launchd job runs unattended.

Monitoring currently refuses the default setup, because Save is disabled whenever
a local-folder source exists
([ui/src/WorkspaceApplication.tsx:1620](ui/src/WorkspaceApplication.tsx:1620)),
and Gemini is offered as an equal agent while getting none of the source,
screenshot, or safety plumbing. Either bring both to parity or label them
honestly.

### Tasks

**Local-source schedule.** The scheduled job runs `doxloop sync now` against the
local checkout, using git HEAD when the folder is a repository (optionally
fetching first) and the existing content fingerprint otherwise. The fingerprint
already exists at [src/sync.ts:77](src/sync.ts:77); only the scheduler in
[src/schedule.ts](src/schedule.ts) and the UI gate insist on a remote.

**"Check now" starts a visible job** and reports "no change" or "N pages stale"
in a toast, not only via reload. Depends on Phase 0's job feed.

**Gemini parity.** Pass `--include-directories` for external sources, write the
capture MCP server into the run workspace's `.gemini/settings.json`, and probe
authentication non-interactively. Where Gemini cannot deny writes to sources, run
it against the read-only source snapshot the remote path already uses.
[src/author.ts:487](src/author.ts:487)–502 is Claude and Codex only;
[src/agents.ts:263](src/agents.ts:263) returns `unknown` for Gemini.

**Codex and Gemini live log.** With output piped from Phase 0, format their
output into the same one-line activity summaries Claude gets, by generalizing the
stream formatter at [src/author.ts:632](src/author.ts:632) behind a per-agent
formatter.

**Capability matrix in the wizard and Settings** (screenshots, external sources,
cost cap, live log) so the agent choice is informed. Anything not at parity is
labeled "Limited".

**Tests.** Local schedule end to end on a temp git repo; Gemini argv tests beyond
the four-token check at `author.test.ts:458`.

### Decision to make

If Gemini parity needs more than a week, ship the capability matrix and the
"Limited" label first and defer the parity work. Honest labeling is the
user-facing fix; parity is the engineering fix.

### Acceptance

- The Quickstart setup (local folder, Doxbrix, Claude) can save a daily schedule
  and drafts a proposal when the checkout changes.
- A Gemini run with screenshots enabled either captures them or is refused up
  front with a clear reason, never fails mid-run.

---

## Phase 6 — Generator tiers and adapters

**~2.5 weeks. Depends on nothing; Phase 4's build hook helps.**

> **Shipped on 5 Sep 2026** on branch `stage`. Deviations from the task list
> below: the navigation validators go further than the four named generators.
> Docusaurus reads explicit doc ids and trusts autogenerated sidebars, Jekyll
> reads nested `_data/navigation.yml`, Nextra checks every `_meta` file
> against its own directory and drops the `unnavigated-page` check (Nextra
> lists every file itself), and Static HTML follows links through section
> pages. Whatever cannot be read statically (themes, navigation plugins,
> sidebars built by code or imported) produces one `navigation-unverified`
> warning from a shared `navigationUnverifiedIssue` helper in the generator
> runtime. `writeNavigation` is implemented for MkDocs (YAML document model,
> comments and Python tags preserved) and Markdoc, `renderPage` for Static
> HTML; the other adapters leave both hooks to Phase 7. The tier catalog and
> a `POST /api/setup/generator/preflight` route live in `src/generators.ts`
> and `src/generator-preflight.ts`; the wizard shows the tier beside the
> generator, runs the toolchain check when the Tools step opens, and lists
> every generator under **What each generator supports**. Missing tools do
> not block Continue, since the adapter installs with npm. Two scaffold bugs
> found by the new smoke script were fixed on the way: Docusaurus's Mermaid
> theme needs `@mermaid-js/layout-elk` installed, and Astro 7 daemonises
> `astro dev` when it detects a coding agent, so the Starlight preview now
> pins it to the foreground. `pnpm test` runs `build:test` (core `tsc` plus
> generator packages) instead of the full build. Verified locally with
> `scripts/ci-generator-smoke.mjs` for Docusaurus, MkDocs, Sphinx, VitePress,
> Starlight, Nextra, Markdoc, Jekyll, and Static; Hugo has no local binary and
> is covered only by the CI matrix. Still to do: watch the first CI run of
> `.github/workflows/ci.yml` on GitHub, since the Hugo job and the Ubuntu
> toolchain steps have not run yet.

Eight of ten external generators validate only that files exist, six assume a flat
navigation, two point the planner at files the scaffold never creates, and six
skills give the agent no callout or tab syntax. Fix the cheap defects, tier the
rest honestly, and add the missing authoring references.

### Tasks

| Layer | Work | Touchpoints |
| --- | --- | --- |
| Adapters | Metadata fixes: Nextra and Markdoc `planning.navigationFiles` name real files; Sphinx starter pages carry the starter marker; Docusaurus and MkDocs use the shared runtime instead of local copies | [packages/generator-nextra/src/index.ts:42](packages/generator-nextra/src/index.ts:42), [packages/generator-markdoc/src/index.ts:44](packages/generator-markdoc/src/index.ts:44), [packages/generator-sphinx/src/index.ts:132](packages/generator-sphinx/src/index.ts:132), [packages/generator-docusaurus/src/index.ts:278](packages/generator-docusaurus/src/index.ts:278) |
| Adapters | Navigation validators that understand real sites: nested toctrees (Sphinx), section pages (Hugo), `autogenerate` sidebars (Starlight), function-built sidebars (VitePress) — falling back to "cannot verify" rather than false errors | Each adapter's `validate`; add a fixture per generator that is not the 2-page scaffold |
| Adapters | Optional `writeNavigation` and `renderPage` hooks so Phases 1 and 7 can create pages and preview for external generators | [src/generator-api.ts:43](src/generator-api.ts:43) |
| Skills | An `authoring.md` for Hugo, Jekyll, Markdoc, Nextra, Starlight, Static covering callouts, tabs, code groups, images, Mermaid setup; configure Mermaid in the Docusaurus and MkDocs scaffolds | Model on `packages/generator-docusaurus/skills/doxloop-docusaurus/references/authoring.md` |
| Wizard | Tier labels — **Full** (Doxbrix, Docusaurus, MkDocs), **Supported** (Sphinx, Hugo, VitePress, Starlight), **Basic** (Nextra, Jekyll, Markdoc, Static) — with the toolchain each needs and a pre-flight check | [ui/src/SetupApplication.tsx](ui/src/SetupApplication.tsx) Tools step; catalog in [src/generators.ts](src/generators.ts) |
| CI | Add a GitHub Actions workflow: typecheck, unit tests, and a generator matrix that scaffolds, builds, and previews each generator installable in CI. Stop `pnpm test` from triggering a full build via `pretest` | No `.github/workflows` exists today |

### Acceptance

- A Starlight or Sphinx site with nested navigation validates without false
  "unnavigated page" errors.
- An agent writing for any tier-Supported generator has documented syntax for
  callouts, tabs, and diagrams.
- CI runs on every pull request and builds at least Docusaurus, MkDocs, VitePress,
  and Static end to end.

---

## Phase 7 — Navigation, theme, assets, and content types

**~4 weeks (2 core + 2 stretch). Depends on Phases 1 and 6 hooks.**

> **Core shipped on 5 Sep 2026** on branch `stage`. Deviations from the task
> list below: every direct write (navigation, branding, assets, page
> metadata, glossary) goes through one `applyDirectEdit` contract in
> `src/direct-edit.ts` that snapshots the files, revalidates, rolls back any
> new validation error, and records a history row with a new request kind,
> so drift detection sees these edits. The navigation editor writes Doxbrix
> `docs.json` directly and external generators through new
> `readNavigationTree`/`writeNavigationTree` adapter hooks, implemented for
> MkDocs; the other adapters report that their navigation lives in code and
> name the file. Removing a page from Doxbrix navigation is refused (the
> validator requires every page), so the editor offers **hidden** instead.
> The branding panel edits only the Doxbrix theme block; external generators
> get the name of their theme file rather than a field subset, since no
> adapter exposes a theme schema yet. Assets are uploaded as base64 JSON
> (10 MB cap, content sniffed per extension, scripted SVG refused) rather than
> multipart, and a referenced asset cannot be force-deleted because the
> broken link would only be rolled back. "Insert into page from the editor
> toolbar" became **Insert an image…** in the agent composer, since Phase 1
> dropped the manual editor. Alt text is rewritten across every embedding page
> in one validated write. Release notes are a `template` on the plan request
> (`kind: release-notes`, version, from, to, sources) whose inventory Doxloop
> collects from `git log`/`git diff` and the source's changelog before the
> planner runs; both prompts carry the inventory verbatim. Diagrams are a
> per-page `diagram` field defaulting to `required` for concept pages, with a
> `missing-diagram` validation warning rather than a gate. SEO fields live in
> a page-metadata form with a fingerprint-checked PUT. The **stretch** items
> (versioning, localization) were not started, per the plan's own note to
> decide after real demand. Still to do: drive the navigation editor, asset
> upload, and branding panel once against the dxb-docs project in a browser,
> and run a real release-notes plan against a tagged product repository.

The remaining pieces of a professional docs site that today are either free text
for the agent or absent.

### Tasks

| Layer | Work | Touchpoints |
| --- | --- | --- |
| Navigation | Drag-and-drop tree editor on the Pages route: reorder, group, rename labels, set icons, mark hidden. Writes through `writeNavigation`; Doxbrix writes `docs.json` directly. Plan navigation becomes editable in plan review using the same component | The plan payload already round-trips `navigation` ([ui/src/WorkspaceApplication.tsx:1242](ui/src/WorkspaceApplication.tsx:1242), [src/types.ts:156](src/types.ts:156)) |
| Theme | Branding panel for Doxbrix: logo and favicon upload, primary and accent colors for light and dark, font choice, reflected in live preview. External generators get the fields their theme config supports, otherwise a link to the config file | Theme shape at [src/types.ts:356](src/types.ts:356); allowed fields defined by validation at [src/validation.ts:287](src/validation.ts:287) |
| Assets | `POST /api/assets` upload, list, replace, delete; alt-text editing; "replace screenshot" on capture gallery rows; insert-into-page from the editor toolbar | Captures are read-only today ([src/ui-server.ts:734](src/ui-server.ts:734)) |
| Content types | Release notes: a plan template that feeds the git log between two refs plus the product CHANGELOG to the planner and writes a versioned page. Glossary: generated from the brief's terminology map with an edit form. Diagrams: planner marks concept pages as needing one, the writer prompt requires a Mermaid block, and the editor previews it. SEO fields (canonical, social image) join the frontmatter form and the Phase 4 static build | Playbooks exist in `skills/doxloop-authoring/references/type-migration-release.md` and `documentation-types.md`; wire them to real inputs |
| Stretch | Versioning: Docusaurus versions and MkDocs `mike` through the adapter; a `versions` block in Doxbrix `docs.json` with a switcher in the static build. Localization: per-locale content folders, one plan per locale | Decide after Phase 4 ships whether either is asked for by real users |
| Tests | Nav write round-trip per generator, theme validation per field, asset upload limits and path traversal, release-notes template on the migration-release eval fixture | `evals/fixtures/migration-release` |

### Acceptance

- A user reorders the sidebar, uploads a logo, changes the accent color, and sees
  all three in preview without an agent run.
- A "Release notes for v0.2.0" request produces a page grounded in the actual
  commit range.
- Every concept page in a new plan has a diagram, and the editor previews it.

---

## Parked for the later quality pass

Intentionally untouched by this plan: running the quality command inside the
pipeline, real spelling and style-guide checks, external link checking during
authoring, claim re-verification, rendered accessibility, code-sample execution,
stale-screenshot detection, and promoting validation warnings to gates.
