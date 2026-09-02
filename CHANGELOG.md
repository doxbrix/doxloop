# Changelog

All notable reader-visible changes to Doxloop are documented here. The project
uses semantic versioning after its first stable release.

## Unreleased

### Changed

- **Comprehensive is now the default documentation depth** in the setup wizard
  and on the Create page, and the depth cards no longer show fixed page ranges
  such as "8–15 pages". Depth chooses which product surface to cover; the page
  count comes from the discovered evidence. The planner contract for the
  Standard scope no longer targets a 15-page ceiling, the Standard estimate is
  no longer clamped at 20 pages, and migrated version-1 plans no longer cap
  their estimates at 15 or 30 pages.

### Added

- **Failed runs continue where they stopped.** A generation run that fails
  after the agent wrote pages — required screenshots missing for a guide, a
  time budget reached, a validation error — keeps its workspace, and the plan
  review now offers **Resume generation** and **Ignore problems & continue**.
  Resuming restarts the agent in the same workspace with a brief of what is
  already finished, so verified screenshots and completed pages are never
  captured or written again; ignoring accepts the generated files for review
  with every screenshot problem recorded as a text-only step and counted on the
  proposal. The same actions appear on a failed proposal under **Review**, and
  a plan whose planner missed a planning gate can be opened for review anyway.
  Source changes made while a run sat failed no longer block continuing it:
  the proposal records an advisory and refreshes its evidence snapshot instead.
  Under the hood each run records the instructions it was started with in
  `.doxloop/runs/<id>/authoring.json`, `doxloop proposal resume --id <run>` and
  `doxloop proposal recover --id <run> --ignore-screenshot-problems` drive the
  two paths, and `POST /api/plans/:id/continue` and
  `POST /api/proposals/:id/resume` expose them to the control center.
- Plans can carry a **minimum page count**. The Create and Update forms have a
  "Minimum pages to write" field (and `POST /api/plans` accepts `targetPages`),
  the planner must reach it with distinct evidence-backed pages or record a
  scope exception, and the comprehensive scope no longer stops at thirty pages:
  the estimate now scales with the discovered public surface, so a product with
  many screens, commands, and configuration groups gets the forty or eighty
  pages it needs instead of being compressed into overviews.
- A **page depth gate**. `doxloop test` now reports `thin-page` for a page with
  too little prose for its type and `thin-procedure` for a guide with fewer
  than three real steps. Both are warnings, and the authoring contract, the
  plan generation request, and the new authoring-skill reference
  `references/page-depth.md` require the agent to resolve every one on a page
  in scope before finishing. The reference defines what a complete landing
  page, quickstart, guide, tutorial, concept, reference, and troubleshooting
  page contains, so a run can no longer finish with a site of one-paragraph
  pages that passes validation.
- UI guides now plan and capture **one screenshot per screen-changing step**.
  The planner is told to plan a capture for the entry screen, each dialog or
  section a step opens, the filled form, and the result; a required-screenshot
  plan whose procedural guide plans fewer than three captures is sent back for
  revision unless its workflow says the guide is a single screen; and the
  authoring prompt places an image inside every such step. The plan form also
  defaults to screenshots when an application capture surface is configured.

### Fixed

- A plan whose generation failed can be approved again from the plan review.
  **Approve & generate** returned "cannot be approved from status failed",
  leaving **Retry stage** in the activity log as the only way forward. The
  approval bar now reads **Retry generating …** for a failed plan and starts a
  fresh run from the reviewed structure.
- Documentation generation no longer stops at 60 agent turns. Unattended
  Claude runs were launched with a fixed `--max-turns 60`, so a 44-page plan
  with 85 planned screenshots ended while the agent was still exploring the
  application and before it had written a page, reported only as "The
  documentation agent exited with status 1." The cap now scales with the
  approved plan (30 turns per page written plus 12 per planned screenshot,
  never below 400; `DOXLOOP_AGENT_MAX_TURNS` overrides it), planning runs get
  100 turns instead of 30, and when Claude does stop early the activity log and
  the failure message name the reason, such as the turn limit or a reported
  API error.
- The control center no longer freezes after a long agent run. Every job kept
  its complete output in memory — a single planning run left about 2 MB of
  streamed JSON — and that whole job list was re-serialized for every
  subscriber on every output chunk of the next run, written to `ui-jobs.json`
  and returned by every state request. Buttons such as **Continue planning**
  then sat on "Working…" with nothing happening. Jobs now keep a recent tail of
  their log in memory (the full log stays on disk behind **Open full log**),
  job-stream updates are coalesced, and a tab that cannot keep up no longer
  has snapshots buffered on its behalf. A control-center request that gets no
  answer for two minutes now reports that instead of waiting forever.
- A code change no longer invalidates a documentation plan. Approving a plan
  whose configured sources changed after it was proposed used to fail with
  "Configured source evidence changed", mark the plan **stale**, and demand a
  full agent revision, so any edit while a plan waited for review threw the
  review away. Approval now proceeds with the structure as proposed, records
  a note that the sources changed, and generation reads the current sources
  when it writes each page. A change made between approval and generation is
  logged instead of failing the run. Plans already marked stale by an earlier
  version can be approved directly, or cleared with
  `POST /api/plans/<plan-id>/resume`. Clicking **Use recommendation** on a
  planner question now visibly confirms that the recommendation was applied.
- A code change no longer blocks a generated proposal from being edited or
  applied. Proposals now refresh their configured-source snapshot and show a
  non-blocking review advisory; proposals marked stale by an earlier version
  are restored to review automatically. Concurrent edits to the documentation
  itself remain protected by the file-level conflict check.
- A stale failed-plan screen no longer reports that a generated plan has no
  failure to ignore. Recovery actions are idempotent once generation has
  completed and return the generated plan so the browser refreshes to the
  ready proposal.
- Plan workflow manifests under `.doxloop/plans/` no longer leak into generated
  documentation proposals. Existing proposals automatically drop those
  internal changes and clear the resulting false conflict, while real
  documentation-file concurrency checks remain enforced.
- The local preview now renders `<Mermaid>` diagrams. It emitted the diagram
  block but never loaded a renderer, so every lifecycle or architecture diagram
  appeared as raw `flowchart LR …` text until the site was published.
- Coverage no longer counts prose as product surface. Discovery ran its
  authentication, authorization, and integration keyword scans over every text
  file — changelogs, roadmaps, skill references, evaluation fixtures, tests —
  and every matching line became its own "public signal", so a sixteen-page
  site reported 23% security coverage with 186 items and a hundred-odd "gaps"
  that were sentences from a roadmap. Keyword signals now come only from
  product code, once per keyword family per file; fixture, test, example, and
  documentation paths contribute file-level evidence only; and exports count
  only from package entry points (`main`, `exports`, `bin`, `index`), not from
  every internal module.

- The live activity panel now has a Screenshots tab showing the images a run has
  captured, refreshed while the run is still going. Captures that repeat an
  earlier image are flagged, so a step saved under the name of a state the agent
  never reached is visible before anything is applied.
- A failed documentation run whose preserved workspace still validates can now
  be recovered into review instead of requiring a full agent re-run. Retrying
  generation for an approved plan recovers the newest matching failed proposal
  automatically, and `doxloop proposal recover --id <run-id>` or
  `POST /api/proposals/<run-id>/recover` recover one directly. Recovery refuses
  archived runs, runs without a workspace, and runs whose configured source
  evidence changed after the failure.

### Fixed

- A screenshot run can no longer quietly drop half its approved guides. The
  agent built the capture manifest at the end, out of whatever it had captured,
  so guides it decided to skip never appeared in the file at all — in one run it
  covered four of eight guides, having decided the other four were "not a
  distinct new screen" without ever navigating to them, and still reported
  success. Doxloop now writes the manifest before the agent starts, with every
  approved guide staged as `planned`, so capture is filling in a form rather
  than inventing one. A guide left untouched is reported by name with the route
  to open, instead of surfacing as a vague missing-manifest error, and the
  authoring contract forbids judging a screen without opening it first.

- Screenshot runs no longer fail over repeated images they were told to take.
  Capture sequences were planned with steps that are not distinct states —
  "scroll to the history area", "focus the request field", "inspect the coverage
  panel" — and on a screen that already fits the viewport each produced a
  byte-identical file, so a run that followed its approved plan exactly was
  rejected for duplicates. The planner no longer proposes a capture for a step
  that does not change the screen, the authoring guidance treats the approved
  count as a target rather than a quota, and Doxloop keeps the first image of a
  screen and records the repeats as text-only instead of failing. Repeats are
  judged within a guide: two guides showing the same screen is ordinary
  documentation and is now reported for review rather than counted as a defect.

- Screenshot runs no longer throw away the screenshots they took. Doxloop asked
  the agent to open each saved PNG and inspect it before marking the step
  verified, which no agent CLI can do: a careful agent concluded it could not
  verify anything, recorded every step as `text-only`, and a run whose captures
  were all valid failed with "requires 1 verified capture, but produced 0".
  Verification now happens before the shutter — confirm the state in a page
  snapshot, then capture — and Doxloop checks the saved file itself, as it
  already did. A capture left unrecorded is adopted into the step its filename
  names, so a real screenshot is never lost to bookkeeping.

- Screenshot planning no longer collapses a whole product to one capture. The
  planner treated screens as URL routes, so in a single-page control center it
  saw one route, recorded every other screen as "not visibly reachable", and
  planned a single screenshot for an entire documentation set. It is now told to
  reveal screens through read-only in-app navigation — tabs, steps, disclosure
  controls — to change no data, and to record a state as unavailable only after
  actually trying to reach it. Thin screenshot coverage is now reported on the
  plan for review — naming the likely cause, an application left on its initial
  or empty state — instead of silently shipping or blocking the run.
- Planning no longer reads the wrong JSON object out of an agent transcript. It
  previously took the first fenced block in the whole reply, which is usually a
  quoted example from the skill references — an `.doxloop/project.json` or an
  evidence map — rather than the plan. Doxloop now asks for the plan inside a
  `<doxloop-plan>` block, ignores JSON it sent the agent itself, ignores objects
  that are not plan-shaped, and takes the last real plan in the reply.
- An unreadable plan reply is retried once with the defect quoted back, instead
  of failing the whole planning run. A malformed plan now reports the actual
  JSON defect and its position, and is never silently truncated into a plan that
  has lost pages.

- Plan approval no longer stalls behind an unexplained disabled button. The
  application readiness check ran once when the plan opened and rendered nothing
  when it failed, so a reviewer whose application started later saw a disabled
  "Approve & generate" with no reason. The plan now always shows the readiness
  state, offers "Check again", re-checks when the tab regains focus, and names
  the one thing blocking approval.
- The plan screen no longer stays on "Researching sources" after planning has
  finished. A refresh of the persisted plan is now triggered whenever a plan job
  stops running, instead of being suppressed by the guard that exists only to
  prevent duplicate navigation.
- Screenshot capture no longer fails silently on a missing folder. The capture
  tool resolves its filename against the project root and does not create
  directories, so a nested guide path whose folder did not exist failed with
  `ENOENT` and wrote nothing — which is why runs reported screenshots that were
  never taken. Doxloop now creates the guide asset directories for the approved
  plan, per generator, before the capture browser starts, and the agent is told
  that a failed call means no image exists.
- Captured screenshots are no longer lost to page placement. Doxloop's own
  guidance told agents to put each image "inside the same ordered-list item",
  while the Doxbrix skill told them to write procedures with `<Steps>`/`<Step>`
  and showed no example of an image inside a step — so agents captured every
  planned state, embedded the first, and orphaned the rest, failing the run.
  The step components now document the pattern, the placement rule covers them,
  and Doxloop places any verified capture the agent left unembedded into the
  step it belongs to before validation runs.
- A repeated screenshot no longer throws away an otherwise good capture run. One
  or two images reused for a state the agent could not reach are now reported on
  the run for review — and flagged in the Screenshots tab — instead of failing
  generation. A run where repeats outnumber distinct captures still fails, since
  that means the capture pass did not really happen.
- Screenshot validation now reports every problem in a run at once instead of
  failing on the first one. A run whose manifest marked a dozen steps verified
  while capturing two images used to surface as a single misplaced screenshot,
  hiding the rest until the next retry. The agent is also told to mark a step
  verified only after its image exists, has been opened, and is embedded.
- Screenshots taken before a client-rendered application finished loading are
  now rejected instead of published. Capturing straight after navigation returns
  the splash or skeleton screen, which the old "at least four colours" emptiness
  check accepted, so whole guides shipped as repeated pictures of a loading
  page. A capture that is 98% or more a single colour is refused, and the agent
  is told to confirm the expected content in a snapshot before capturing.
- A screenshot embedded in a page written at a generator-native path — a Doxbrix
  overview saved as `index.mdx` rather than the planned `overview` slug — no
  longer fails validation as "not embedded in its matching guide". Only an image
  that no page references at all is now treated as a defect.
- Duplicate captures are reported together instead of one at a time, naming every
  file in each identical group, and the agent is told to record states it cannot
  reach as text-only rather than resaving the current screen under another name.
- Screenshot manifest validation no longer fails a completed run when the agent
  writes a terse step field such as `action: "Open /"`: approved
  capture-sequence text now maps by capture ordinal (text-only steps no longer
  shift the mapping), the minimum-specificity rule is stated in the agent
  prompt and authoring skill, and the validation error now explains what a
  specific value requires.

- Post-Phase-4 hardening expands deterministic discovery across security,
  errors, events, integrations, configuration, and framework routes; reports
  unmeasurable coverage as Unknown; and revalidates semantic claims against
  current source and OpenAPI facts.
- Interrupted UI authoring jobs now recover as safe retry checkpoints. Reviewer
  revisions, rejections, and inline edits build a bounded, redacted local
  preference record used by later planning and generation.
- The `doxloop quality` command now runs the configured isolated Node/Python and
  OpenAPI example checks, axe and keyboard accessibility checks, light/dark
  multi-viewport visual baselines, exact pixel tolerances, reviewed
  suppressions, and quality ratcheting. Advanced policy remains in the shared
  project configuration and CLI instead of crowding the main workflow. Public
  coverage, quality, and evaluation payloads are schema validated before they
  are stored or emitted.
- Agent generation/update evaluations now complete the real UI plan, approval,
  proposal, and acceptance workflow. Proposal review can prepare an isolated
  Git branch and commit, then push it or open a pull request only on explicit
  request, without switching or editing the current checkout.

- Phase 4 release quality: `doxloop quality` now runs
  one versioned contract across deterministic validation, generator strict
  builds, cached external links, opt-in isolated Node examples, OpenAPI lint,
  documentation lint, claim reverification, and optional rendered
  accessibility and visual regression checks. Text/JSON output and CI exit
  behavior share stable machine-readable codes.
- `doxloop evaluate` scores generation and update quality, preservation, and
  reviewer outcomes against an approved baseline. The agent/model matrix now
  records model, duration, score, and release-blocking regressions across ten
  realistic evaluation fixtures.
- Optional evidence-derived reader verification metadata and Doxbrix badges
  surface verified, inferred, contradicted, or needs-review states without
  overstating source certainty. Versioned public contracts are shipped in
  `contracts/`.

- Stable workspace routes now match UI navigation and unsupported deep links
  show an explicit not-found state.
- `doxloop demo` (including `npx @doxbrix/doxloop demo`) builds a complete,
  validated seven-page example in a temporary directory, demonstrates a
  generated plan, evidence map, source baseline, and structured review, opens
  the preview, and cleans up safely unless `--keep` is selected.
- Connected source cards now use real connector checks and expose provider,
  branch, subdirectory, revision, check time, OpenAPI metadata, and actionable
  redacted failures. Monitoring is explicitly project-wide and exposes both
  daily run and agent-minute budgets.

- Versioned directory and OpenAPI source connectors now provide validated
  JSON/YAML inspection, safe remote caching, structural API diffs, and targeted
  drift.
- Source ownership scopes, public-surface coverage in UI/CLI/JSON, evidence
  precision diagnostics, and configurable maximum verification age make source
  traceability visible and enforceable.

- Proposal review is now evidence-aware. Every file has a compact rationale
  drawer with source paths or API operations, revisions, affected interfaces,
  reader claims, confidence, assumptions, validation, and plan/request origin.
- Reviewers can ask the terminal agent to revise one hunk, one file, selected
  files, or the whole proposal without changing the real documentation.
  Revisions remain isolated and scope-checked, while the original proposal is
  retained as superseded for audit.
- Proposed pages can be edited directly in the review UI. Doxloop validates the
  result, records human authorship, and either preserves the evidence
  association or marks it for re-checking.
- Applied proposals now support conflict-aware atomic undo from exact
  pre-acceptance snapshots. Proposal lifecycle controls add regeneration,
  stale-source protection, archive, 30-day retention, cleanup, and a focused
  responsive rendered comparison without manual device or theme selectors.
- Create and update now use a persisted, versioned documentation plan before
  authoring. A deterministic, safely cached source inventory maps public
  capabilities to an evidence-backed page tree; users can edit the brief and
  page structure, answer one consolidated set of planner questions, compare
  plan versions, inspect structured evidence, and approve the exact scope.
- Scope presets show source-derived page estimates, and generator adapters
  declare their native navigation boundaries while keeping the plan portable.
- UI jobs expose structured planning and generation stages while retaining the
  complete terminal log for diagnostics.

- The workspace Update page shows an update history table: every request, its
  result, the pages it changed, and how each page was reviewed. The Publish page
  shows a publishing history table covering successful and failed deployments.
- `doxloop history` shows what the project was asked to document and what
  happened: the request text, its outcome, the pages it touched, and whether
  each page was accepted or rejected in review. `--page` traces a single page,
  `--deployments` lists publishing history. Pages edited outside Doxloop are
  detected by content hash, so the record matches what is on disk.
- Documentation history is stored in `.doxloop/doxloop.db` using the SQLite
  built into the required Node.js 22.13-or-newer runtime. There is nothing extra
  to install, the file is gitignored and owner-readable, and runtime readiness
  is reported before authoring. `DOXLOOP_NO_HISTORY=1` explicitly turns
  recording off. Agent transcripts are
  never stored; they remain in `.doxloop/ui-job-logs/`.
- `doxloop ui` opens a loopback-only project control center covering setup,
  product evidence and GitHub connection tests, agent authoring, source
  monitoring, proposal review, preview, publishing, and
  complete project settings. Long-running work reports live output and can be
  cancelled. `doxloop sync review --open` now deep-links to its Proposals page.
- The unified proposal workspace compares rendered pages side by side or
  stacked, folds unchanged content, exposes the source diff, and accepts one
  hunk, one page, or a complete proposal. It uses a session cookie, validates
  the Host and Origin headers, and never binds to a non-loopback interface.
- `doxloop check` reports which documentation pages no longer match the
  configured sources. It starts no agent and uses no model: the answer comes
  from Git history, the recorded sync baseline, and the evidence map. It exits
  `1` when pages are stale, so it can gate a pull request without credentials.
- `.doxloop/evidence-map.json` records which configured source and which
  source-relative paths produced each page. Authoring runs write it, and
  `doxloop check` uses it to name the affected pages instead of reporting that
  "a source changed".
- A `sync` block in `.doxloop/project.json` configures automatic maintenance:
  `mode`, the product `branch` to follow, the triggers to run `on`, `watch` and
  `ignore` path patterns, and a run `budget`. Lock files and snapshots are
  ignored by default; test files are not, because the authoring workflow treats
  tests as evidence of supported behavior.
- `doxloop sync <setup|status|now|review|history|off>` sets up automatic maintenance. `setup`
  asks three questions and installs the triggers; `status` verifies the hook,
  schedule, agent sign-in, evidence map, and current drift before anyone
  depends on it; `now` generates one isolated proposal; `history` lists all
  runs; `review --open` opens the review center; `off` removes triggers and
  keeps the settings. The wizard prints the equivalent non-interactive command.
- `doxloop sync review --open` opens the unified control center on its Proposals
  page. Each page shows the current version beside the proposed version, both
  rendered the way the published site renders them, with changed words
  highlighted in place and untouched sections optionally folded away. View
  controls switch between side by side and stacked or open the line-by-line
  source diff with surrounding context and per-change Accept buttons. Acceptance
  works at three levels: one change, one page, or the whole proposal, and
  supporting files such as the evidence map are written automatically once every
  page has been accepted.
- Review-first synchronization works with ordinary local documentation folders
  and does not require Git. Authoring happens in `.doxloop/runs/<id>/workspace`;
  real files remain unchanged until acceptance. Accepted selections are checked
  for intervening local edits, applied atomically, and validated. Partial
  acceptance applies only selected line hunks, while the source baseline moves
  forward only when the full proposal is accepted.
- Git triggers are installed as marked blocks, so existing hooks are preserved,
  a second documentation project can share the same file, and Doxloop never
  blocks the Git operation. Pull and push triggers are mode-aware. `push`
  installs a real `pre-push`
  trigger; propose and auto hooks run a complete sync cycle while check hooks
  remain credential-free. Authoring triggers generate a pending review without
  editing or committing the actual documentation.
- macOS schedules launch through the system shell so user-managed Node binaries
  can run under launchd. Setup smoke-tests the job, and status reports scheduler
  registration, running state, and the native last-exit result instead of
  treating plist presence as proof of health.
- Evidence-map validation warns when one source path is attached to more than
  half the documentation pages, and authoring guidance requires an audit of
  shared routers, entry points, and integration tests to reduce false-positive
  stale-page reports.
- A local scheduled run (`daily@HH:MM`) is registered with the platform's own
  scheduler — launchd, a systemd timer, cron, or Task Scheduler — so unattended
  runs use the agent CLI already signed in on that machine. Doxloop still never
  accepts or stores a model API key.
- Unattended authoring: `create` and `update` can run without a terminal, with
  writes confined by the agent's own sandbox and a wall-clock budget. Validation
  must still pass before the sync baseline advances, and automation never
  deploys.
- Validation warns when a page is missing from the evidence map, when the map
  references a deleted page or an unconfigured source, and when a page is
  recorded as needing human verification. These are warnings and appear only
  once a project has an evidence map.

### Fixed

- Plan-first creation now becomes Update after its proposal is accepted. While
  generated files are awaiting review, Authoring shows the proposal handoff
  instead of reopening a second Create form, and planning buttons describe the
  action they start rather than claiming a proposal already exists.

### Changed

- New native Doxbrix projects place `docs.json`, pages, and reader assets at the
  documentation project root instead of creating an additional `docs/`
  directory. Existing projects with `contentDir: "docs"` continue to work, and
  external generators keep their generator-native content directories.

## 0.1.5 - 2026-07-26

### Changed

- Interactive authoring now always lists Codex, Claude Code, and Gemini. When
  the selected agent is missing, Doxloop installs its official npm package
  globally before starting the run.

## 0.1.4 - 2026-07-26

### Added

- Interactive mode: `doxloop init` with no arguments walks through project
  location, detected product evidence, title, and simplified generator
  selection, shows a setup summary, then prints the equivalent non-interactive
  command. Prompts appear only in a terminal and never in CI; the new global
  `--yes` flag disables them everywhere.
- Command-first workflow: normal interactive use requires only `doxloop init`,
  `doxloop create`, `doxloop update`, and `doxloop deploy`; configuration flags
  remain optional automation overrides.
- `doxloop settings` provides an interactive home for product evidence, site
  identity, the default agent, documentation preferences, design references,
  screenshots, and saved deployment settings.
- OpenAPI specifications as first-class evidence: `--spec <name=file-or-url>`
  on `init` and `create`, including creating a documentation project from a
  specification alone. Spec files are fingerprinted for `doxloop update`
  change tracking, and remote specs are flagged for comparison.
- `doxloop create` run inside a product directory now offers the complete setup
  wizard for a separate sibling documentation project, then continues into the
  same request, agent, and confirmation flow as an existing project.
- `doxloop update` shows the source-change summary before starting the agent
  and, when everything is in sync, asks before spending an agent run. When no
  request is given interactively, `create` and `update` ask what you need.
- Agent selection prompt when several agent CLIs are installed, with an
  optional remembered `defaultAgent` per project.
- `doxloop deploy` uses saved project settings, validates before approval,
  shows the exact destination and deployment summary, uses one confirmation
  (default-no for public sites), and offers sign-in only after approval.

## 0.1.3 - 2026-07-25

## 0.1.2 - 2026-07-25

### Fixed

- Launch Codex, Claude Code, and Gemini correctly through npm and Volta
  command shims on Windows.

## 0.1.1 - 2026-07-23

### Added

- Request-driven application guide screenshots for `doxloop create` and
  `doxloop update`, with `--screenshots` and `--no-screenshots` overrides.
- Optional application launch, viewport, screenshot policy, and contextual
  highlighting configuration without changing design-reference capture.
- Read-only agent invocation for documentation review.
- Post-authoring validation receipts and guarded synchronization baselines.
- Source-content fingerprints for committed and uncommitted synchronization.
- JSON output for `test` and `status`.
- Private-by-default deployment visibility and a confirmation-gated `--public`
  deploy option.
- Guarded local npm and GitHub releases that automatically include modified
  generator packages.
- Security, project-format, agent, CI, generator-authoring, generator-selection,
  and troubleshooting documentation.

### Changed

- Release validation now runs npm package lifecycle checks against the proposed
  version before committing or pushing.
- Expanded native guidance for every official generator skill.
- Strengthened real-agent review evaluation with evidence, prioritization,
  rubric, and read-only checks.
- CLI parsing now rejects unknown options and handles boolean flags
  deterministically.

### Security

- Documentation content directories must remain inside the project and cannot
  use symlinks.
- Authenticated HTTP refuses redirects and requires HTTPS outside loopback.
- Design capture blocks private destinations and cross-origin navigation.
