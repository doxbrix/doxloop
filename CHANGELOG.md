# Changelog

All notable reader-visible changes to Doxloop are documented here. The project
uses semantic versioning after its first stable release.

## Unreleased

### Added

- `doxloop ui` opens a loopback-only project control center covering setup,
  product evidence and GitHub connection tests, agent authoring, source
  monitoring, proposal review, quality diagnostics, preview, publishing, and
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
