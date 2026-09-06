# Changelog

All notable reader-visible changes to Doxloop are documented here. The project
uses semantic versioning after its first stable release.

## Unreleased

### Added

- **Screenshots behind a login.** **Settings → Visual evidence → Application
  sign-in** (and the **Does this page require sign-in?** step of the setup
  wizard) gets the capture browser past a login page two ways. **Sign in with
  browser** opens a Chrome window where you sign in by hand, including MFA,
  SSO, or passkeys; **Save session** records the cookies and local storage,
  and every planning and capture run starts with that session loaded. For a
  plain form you can save a test account's credentials instead: the agent
  types the secret names `DOXLOOP_APP_USERNAME` and `DOXLOOP_APP_PASSWORD`,
  the capture server substitutes the values and redacts them from every tool
  result. **Test application** now reports whether the saved session still
  signs in and which sign-in method a run will use. Sessions and credentials
  live under the user's Doxloop config home, keyed by project root, never in
  the repository; `application.authentication.loginPath` records only the
  sign-in route. The CLI settings menu offers the same under **Application
  sign-in**.
- **Navigation editor.** **Pages → Navigation** shows the sidebar as a tree
  you can drag to reorder, group into sections, rename, give icons, or hide
  (Doxbrix), with keyboard equivalents on every row and a live preview
  beside it. Doxbrix writes `docs.json`; MkDocs writes the `nav` list in
  `mkdocs.yml` through new `readNavigationTree` and `writeNavigationTree`
  adapter hooks. Generators whose navigation is code are named instead of
  edited. Every write is validated and rolled back if it would break the site,
  and the plan review gets the same editor for a plan's sections.
- **Branding panel.** **Settings → Branding** edits the Doxbrix logo,
  favicon, primary and light/dark accent colours, page backgrounds, colour
  mode, code theme, and body, heading, and code fonts, with an image picker
  and a live preview that reloads on save. Other generators are pointed at
  their theme configuration file.
- **Images and files.** **Pages → Images & files** uploads PNG, JPEG, GIF,
  WebP, SVG, AVIF, ICO, PDF, video, and zip files (10 MB each, content
  checked against the extension, SVG refused when it scripts) into the
  generator's asset directory, lists where each one is used, edits alt text
  across every embedding page, replaces or deletes files, and offers
  **Insert an image…** in the page composer. Screenshot gallery rows gain
  **Replace screenshot** for a run that is still under review.
- **Page metadata.** Each page on **Pages** has a metadata form for the
  title, description, sidebar icon, canonical URL, and social image, written
  straight to frontmatter with validation, rollback, and history. The local
  preview now emits the canonical and social tags the static build already
  produced.
- **Release notes template.** When a directory source is a Git checkout,
  **Update** offers **Release notes**: pick the repository, version, and two
  refs, and Doxloop collects the commits, changed files, and the matching
  changelog section deterministically, then hands that inventory to the
  planner and writer as the only evidence for a `release` page at
  `release-notes/<version>`.
- **Glossary page.** **Settings → Audience and voice** edits terminology as
  term and definition rows and can generate a glossary page (Markdown, MDX,
  reStructuredText, or HTML) from them, add it to the navigation, and record
  it in the evidence map; hand-written glossaries are never overwritten
  without asking.
- **Planned diagrams.** Plan pages carry a `diagram` decision, defaulting
  to required for concept pages and editable in plan review. The writer is
  told which pages need a Mermaid block, validation reports a
  `missing-diagram` warning for planned pages without one, and the preview
  renders the diagram.
- Update history records navigation, branding, asset, metadata, and glossary
  writes alongside agent runs.

- **Generator tiers and a toolchain check in the wizard.** Every generator now
  carries a support tier (**Full**: Doxbrix, Docusaurus, MkDocs Material;
  **Supported**: Sphinx, Hugo, VitePress, Starlight; **Basic**: Nextra,
  Markdoc, Jekyll, Static HTML) and the runtime it needs. The **Tools** step
  shows the tier beside the selected generator, checks that Node.js with a
  package manager, Python with `venv`, Hugo, or Ruby with Bundler is installed,
  and lists every generator's tier and requirements under **What each
  generator supports**. **Settings → Generator** shows the same label.
- **Navigation validation that understands real sites.** Sphinx follows
  nested and glob toctrees from the root document; Hugo accepts section
  pages, front-matter menus, and menu `pageRef`s from any TOML configuration
  file; Starlight reads `autogenerate` groups, `slug` and `link` entries, and
  lists every page when no sidebar is configured; VitePress reads
  multi-sidebar objects and `base` prefixes; Docusaurus checks explicit doc ids
  and trusts autogenerated sidebars; Jekyll reads nested `_data/navigation.yml`;
  Nextra checks every `_meta` file against its own directory and no longer
  demands that every page be listed; Static HTML follows links through
  section pages. When a theme, plugin, function, or import builds the
  navigation, validation reports one `navigation-unverified` warning instead of
  false `unnavigated-page` errors.
- **Authoring references for every generator.** Hugo, Jekyll, Markdoc,
  Nextra, Starlight, and Static HTML skills gained `references/authoring.md`
  covering callouts, tabs, code blocks, images, and Mermaid diagrams in the
  generator's own syntax; the Docusaurus and MkDocs references gained image
  and diagram sections. The Docusaurus scaffold enables
  `@docusaurus/theme-mermaid`, the MkDocs scaffold registers the `mermaid`
  fence, the Sphinx scaffold adds `sphinxcontrib-mermaid`, and the Hugo,
  Jekyll, Markdoc, and Static scaffolds ship callout and tab markup plus a
  Mermaid render path.
- **Generator API hooks.** Adapters may implement `writeNavigation` (MkDocs
  edits `nav` in place, keeping comments and Python tags; Markdoc rewrites
  `navigation.json`) and `renderPage` (Static HTML returns the page's `<main>`
  landmark), so later work can create pages and preview external generators
  without a native build.
- **Continuous integration.** `.github/workflows/ci.yml` runs typecheck, unit
  tests, skill validation, and the boundary check on every pull request, then
  scaffolds, previews, and builds every official generator through
  `scripts/ci-generator-smoke.mjs`. `pnpm test` now compiles only the core and
  generator packages instead of running the full build.

### Fixed

- **A Claude API failure mid-run no longer fails the run.** When Claude's API
  request breaks off mid-response (a server error, an overload, a rate limit,
  or a dropped connection), Claude exits and the run used to fail with the
  unhelpful message `Claude stopped with result "success"`, discarding a
  session that might already have written pages and captured dozens of
  screenshots. Doxloop now recognizes the failure as transient, waits a
  moment, and resumes the same Claude session in the same workspace, up to
  twice per run, so the agent continues with its context and the pages and
  screenshots it already produced. Only when every resume fails does the run
  fail, and the message then names the API error, how many resumes were
  tried, and that **Resume the run** continues from the preserved workspace.
  Set `DOXLOOP_AGENT_API_RESUMES` to change the number of automatic resumes
  (`0` disables them).
- **Signed-in sessions no longer block plan approval.** The application
  readiness check follows redirects within the configured application, so a
  saved browser session that bounces a sign-up or landing route to the app
  shell (for example `/signup` → `/dashboard`) counts as reachable and the
  message names where the capture browser will land. Only a redirect to a
  sign-in route, to another origin, or a redirect loop still blocks approval.
- Nextra's and Markdoc's planning `navigationFiles` name files the scaffold
  actually creates (`content/_meta.js` and `app/layout.jsx`; `navigation.json`
  and `markdoc.config.mjs`). Sphinx starter pages carry the
  `.. doxloop:starter-page` marker, which validation now recognises. The
  Docusaurus and MkDocs adapters use the shared generator runtime instead of
  private copies of its helpers. Hugo, Starlight, VitePress, Nextra, and
  Jekyll no longer report a missing generator file when an adopted site uses
  a theme or a differently named configuration file.

- **Monitoring works on local folders.** A schedule no longer requires a Git
  remote. A local Git checkout is checked in place by its HEAD commit and
  working tree; a plain folder is compared against the file digests recorded
  at the last sync, so it can still name the files that changed. Nothing is
  fetched, pulled, or written in the source. **Check now** starts a visible job
  and, when it finishes, a notice reports whether anything changed, how many
  pages are stale, and which proposal was drafted.
- **Gemini parity.** Unattended Gemini runs receive external sources through
  `--include-directories`, read the capture browser from the workspace's
  `.gemini/settings.json`, stream `stream-json` output into the same one-line
  activity log Claude has, and are checked for sign-in from an API key, a
  Vertex AI project, or the Google sign-in token file instead of "unknown".
  Because Gemini cannot be denied writes to an extra directory, an unattended
  run reads a throwaway copy of each local source. Codex runs stream
  `exec --json` events into the same log. A capability matrix in the wizard's
  **Tools** step and under **Settings → General** marks each row where an
  assistant is **Limited**.

### Changed

- **Control center redesign.** The workspace gets one design system: Sora for
  page titles and figures, Instrument Sans for the interface, JetBrains Mono
  for paths, a single teal accent on a cool grey canvas, and consistent
  buttons, badges, tables, and cards. The sidebar now draws the documentation
  loop as a connected rail — Sources, Create/Update, Pages, Review, Deploy —
  with each stage marked done, next, or waiting and a one-line status under
  its name. The Overview leads with a status card (what is waiting on you and
  the action to take), three tiles for coverage, pages, and the published
  site, a validation-issues list when there are any, and an activity feed
  whose **Stop** and **Log** controls no longer overlap. Sources shows
  coverage as a white ring gauge instead of a dark gradient block and
  freshness as a status row with per-source chips; planned screenshots list
  their start route as a code chip with a count badge; the top bar shows the
  project and screen as a breadcrumb plus a live "tasks running" chip.

- **Review compares against what the agent started from.** A proposal now
  diffs the agent's output against a snapshot of the project taken when the
  run began, not against the live project at the end. A page you edit by hand
  while the agent runs is no longer proposed as a revert, and a file that both
  you and the agent changed is grouped under **Changed while the agent ran**,
  shows the proposal against your edited version, and asks for confirmation
  before **Accept all**, **Accept file**, or a hunk accept replaces your edit.
  Raw browser captures under `.doxloop/capture-output` never appear as changes.
- **Review opens on the documentation.** The changed-files list starts on the
  first page instead of the evidence map, lists pages, navigation, and assets
  first, and folds evidence, configuration, and skill files under **Supporting
  files** until asked for. Accepting a change refreshes its hunk badges at
  once, and **Review changes** in the ready dialog opens that proposal.
- **URLs match the navigation.** The screens are now at `/update`, `/review`,
  and `/deploy`; the previous addresses redirect. The selected proposal and
  file, the Pages selection, and the Settings section live in the URL, so a
  refresh or the back button returns to the same view. `doxloop ui --page`
  accepts the new names and still understands the old ones.
- **The workspace never renders blank.** A rendering error in one screen shows
  what broke and offers a reload instead of a white page. A validation failure
  is shown as "Validation unavailable" with the reason. Background polling
  retries quietly three times before raising a banner.
- **Forms keep up with the project.** Settings and Deploy forms reseed after a
  save or a reload, keep unsaved edits when the project changed elsewhere and
  say so, and the plan editor asks before a background refresh replaces edits
  you have not saved. **Update history** names the pages each request changed.
- **Hidden state is now shown.** Overview carries a validation summary with the
  first issues and the sign-in state of the agent updates run with. Sources
  shows documentation freshness: which pages fell behind which sources, and
  how many paths changed per source.
- **Setup wizard.** With screenshots on, step 3 requires a successful **Check
  page** before Continue. Errors appear on the step they belong to, and the
  sources table shows what was validated instead of a placeholder sync status.

- **Stop really stops the run.** Stopping a run from the control center now
  ends the coding agent and the capture browser it started within ten
  seconds, and nothing writes into the run workspace afterwards. Unattended
  agents run in their own process group; the CLI forwards a termination signal
  to that group, escalates to a forced stop after a grace period, and exits
  with the conventional signal status. Time budgets escalate the same way.
- **Progress is real.** The stage list for a generation, revision, or page
  edit now advances from what the agent actually does: a page write starts
  **Authoring approved pages** and counts towards a "pages written N of M"
  figure, a navigation write starts **Updating navigation and theme**, an
  evidence-map write starts **Recording page evidence**, a capture starts
  **Capturing application screenshots**, and validation starts when the agent
  runs `doxloop test` or when the run hands over to Doxloop. Stages are
  announced up front as pending, and a stage that saw no activity finishes as
  "unchanged" instead of pretending the work happened. Codex and Gemini output
  is now piped through Doxloop so it appears in the run log, and a workspace
  watcher tracks their progress the same way.
- **Planning has a time budget.** A planner that never returns now fails with
  "Planning stopped after 20 minutes without a plan reply" instead of running
  forever. The budget follows **Maximum agent minutes** when set, and the
  `DOXLOOP_PLAN_TIMEOUT_MINUTES` environment variable overrides both.
- Every job the control center starts has a labelled entry in **Recent
  activity** with a log link and, while it runs, a **Stop** button: source
  checks, sign-in, agent installs, screenshot captures, deployments, and
  proposal revisions. The **Review** page shows a running revision or
  resumption with its live log and a Stop button, and a failed one raises a
  banner naming the reason. The deployment progress panel stays on screen
  after a failure until it is dismissed, and the **Deploy** page explains that
  sign-in finishes in the browser while the login job runs.

### Added

- **Portable static exports.** Doxbrix now builds page directories, reader CSS,
  copied assets, client search data, sitemap and robots files, and page metadata
  into `build/`, including a configurable base path for project sites.
  `doxloop export --out <directory> [--zip]` provides the same self-hostable
  output for every generator. Deployment dry runs leave their zip in
  `.doxloop/exports` instead of discarding it.
- **More deployment targets.** The Deploy page and `doxloop deploy --target`
  now support GitHub Pages, Netlify, and Vercel alongside Doxbrix. The page has
  per-target settings, local folder/zip export, protected provider credentials,
  and a shared deployment history. GitHub Pages publishes to `gh-pages`;
  Netlify uploads the static zip; Vercel uploads content-addressed files before
  creating its production deployment.
- **Project switcher and import.** The project name in the sidebar opens a
  switcher that lists recently opened projects, opens any folder, imports an
  existing documentation site, or starts the setup wizard for a new project,
  all without restarting `doxloop ui`. Every opened project is remembered in
  a user-level list. The setup wizard's first step now offers **Use existing
  documentation folder**, which recognizes Doxbrix, Docusaurus, MkDocs,
  Sphinx, Hugo, VitePress, Starlight, Nextra, Markdoc, and Jekyll sites from
  their configuration files, shows the detected generator, content directory,
  and pages for correction, and adopts the folder without modifying a page.
  Existing pages start as unverified in the evidence map so the first update
  attaches evidence. Switching is refused while a run is in progress and stops
  a local preview. `doxloop init --existing [directory]` and
  `doxloop ui --project <directory>` cover the same from a terminal.
- **Maximum Claude spend (USD)** under **Monitoring → Advanced watch scope and
  budgets** passes a spending cap to Claude Code for unattended runs and
  planning. A run that ends on the cap says so in the log and the proposal
  error. Codex and Gemini expose no equivalent flag, so the setting is ignored
  for them; the field says so.

- **Comprehensive is now the default documentation depth** in the setup wizard
  and on the Create page, and the depth cards no longer show fixed page ranges
  such as "8–15 pages". Depth chooses which product surface to cover; the page
  count comes from the discovered evidence. The planner contract for the
  Standard scope no longer targets a 15-page ceiling, the Standard estimate is
  no longer clamped at 20 pages, and migrated version-1 plans no longer cap
  their estimates at 15 or 30 pages.

### Added

- A new **Pages** view lists documentation by navigation section with search,
  word counts, evidence state, update dates, current previews, and page
  history. Select one or several pages, describe an edit in plain language,
  watch the agent work in an isolated proposal, then compare rendered and
  source versions before accepting, rejecting, refining, or undoing it.
  Selected-page scope is enforced after every agent run; related navigation
  and page-image changes require the explicit **Also allow related changes**
  toggle.
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
