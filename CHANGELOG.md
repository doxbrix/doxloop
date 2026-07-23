# Changelog

All notable reader-visible changes to Doxloop are documented here. The project
uses semantic versioning after its first stable release.

## Unreleased

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
