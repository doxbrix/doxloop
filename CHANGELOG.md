# Changelog

All notable reader-visible changes to Doxloop are documented here. The project
uses semantic versioning after its first stable release.

## Unreleased

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
