# Release quality and evaluations

Doxloop applies quality gates at every step of the loop in the control center:

- **Planning** cannot be approved while clarification questions are open, and
  generation refuses to start if the approved plan or its source snapshot
  changed.
- **Proposals** run page validation before they appear on the **Review** page.
  The **Why this change** panel shows each file's error and warning counts,
  supporting evidence, reader-facing claims, and assumptions to verify.
  Direct page edits are validated before they are saved.
- **Deploy** validates the documentation again, and **Dry run** additionally
  runs the selected generator's strict build without uploading anything.
  Validation errors stop a deployment; warnings are reported.

The versioned release-quality contract described below extends those checks
with external links, OpenAPI linting, documentation lint, claim
reverification, and opt-in executable, accessibility, and visual checks. It is
the release-grade definition of "ready", stores its complete JSON report below
`.doxloop/quality-reports/`, and is designed for the headless checks described
in [automation and CI](./ci-and-automation.md). A failing gate exits with
status 1; warnings exit 0 unless the contract is run with warnings treated as
errors.

## Shared quality configuration

Optional settings live in `.doxloop/quality.json`:

```json
{
  "schemaVersion": 1,
  "links": {
    "mode": "online",
    "allowHosts": ["developer.example.com"],
    "ignore": ["https://status.example.com/"],
    "timeoutMs": 8000,
    "retries": 2,
    "cacheHours": 24
  },
  "examples": { "enabled": true },
  "rendered": {
    "enabled": true,
    "routes": ["/", "/quickstart"],
    "themes": ["light", "dark"],
    "maximumDiffRatio": 0.001,
    "viewports": [
      { "name": "desktop", "width": 1440, "height": 900 },
      { "name": "mobile", "width": 390, "height": 844 }
    ]
  },
  "lint": {
    "maximumTitleLength": 72,
    "maximumNavigationLabelLength": 42
  },
  "suppressions": [{
    "code": "quality.claim.needs-human",
    "file": "reference/legacy.md",
    "reason": "Owner-approved migration exception",
    "expires": "2026-09-30"
  }],
  "ratchet": {
    "enabled": true,
    "baselineFile": ".doxloop/quality-baseline.json"
  },
  "readerVerification": { "enabled": false }
}
```

External checks cache successful and broken responses, so an offline run can
use only that cache. Authentication responses and temporary network/server
failures are warnings, not broken-link failures. Private destinations and
credential-bearing URLs are blocked.

Suppressions require a reason, can be limited to one file, and can expire. They
remain in the report as `skipped`; they are not silently removed. Ratcheting
matches the exact issue code, file, and message so an approved legacy issue does
not permit a different regression with the same broad code. The current
reviewed findings can be approved as the baseline from the headless quality
check. Advanced policy stays in this shared configuration so the control
center remains a simple status, fix, and recheck flow.

## Executable examples

Example execution is opt-in through `.doxloop/examples.json`:

```json
{
  "schemaVersion": 1,
  "examples": [{
    "id": "parse-config",
    "runtime": "node",
    "file": "examples/parse-config.mjs",
    "workingDirectory": ".",
    "fixtures": ["examples/config.json"],
    "network": "denied",
    "expected": { "exitCode": 0, "stdoutIncludes": "valid" }
  }]
}
```

Node examples run from a temporary workspace with a minimal environment,
explicit filesystem permissions, no network permission, a timeout, and no
shell. Python examples use `runtime: "python"` and require a locally installed,
digest-pinned Docker image configured with `DOXLOOP_PYTHON_SANDBOX_IMAGE`
(for example, `python@sha256:<the approved image digest>`). Doxloop never
executes Python examples directly on the host. Without the configured image,
the check is skipped and cannot earn executed-example credit. Containers use
no network, a read-only filesystem and fixture mount, an unprivileged user,
no Linux capabilities, and CPU, memory, PID and time limits. The image is
never pulled automatically. A missing image or unavailable daemon fails the
execution check; it does not fall back to host Python. Apparent credentials are rejected. Use `runtime:
"shell-source-verified"` or `runtime: "source-verified"` when a command cannot
be executed with a portable network/filesystem sandbox; the report keeps that
distinction instead of overstating verification.

Use `runtime: "openapi-request"` for `.http` request examples. The first
`METHOD /path` line and an optional `# expect-status: 202` directive are checked
against the currently connected OpenAPI contract without contacting an API.

## Rendered accessibility and visual checks

Rendered checks use a managed browser only when enabled. Representative pages
are checked at configured widths for landmarks, accessible names, images,
heading order, and horizontal overflow. The report always retains a manual
WCAG review requirement for keyboard order, focus, contrast, zoom, reflow, and
assistive-technology output.

Current screenshots are stored in `.doxloop/quality-artifacts/`. Approved
baselines are separate by generator, theme, route, and viewport under
`.doxloop/visual-baselines/`, and are updated from the headless quality check
after an intentional design change has been reviewed.

## Documentation lint and safe fixes

Linting reports terminology drift, substantial duplicate prose, common
spelling errors, difficult sentences, title length, and navigation-label
length. Safe fixes only perform deterministic formatting changes: inferred code
fence languages, unambiguous heading-rank repair, normalized local-link syntax,
trailing whitespace, and final newlines. They never rewrite factual prose.

## Claim states and reader metadata

Evidence-map claims resolve to `verified`, `inferred`, `contradicted`, or
`needs-human`. Changed evidence never remains verified automatically. When
`readerVerification.enabled` is true, Doxloop writes
`.doxloop/verification-metadata.json` and supplies the matching locale,
verification date, source revision, confidence, and state to native Doxbrix
preview and deployment output. The feature is disabled by default.

## Evaluations

Doxloop maintainers score generation, update, and review quality across agents
and models with fixture projects. Those evaluations drive the same plan-first
control-center workflow as a user, need a locally signed-in agent, and are
documented for contributors in [releasing](./releasing.md). Machine-readable
v1 schemas and the append-only issue-code policy are published in
`contracts/`. Codes can be baselined, suppressed, or ratcheted; presentation
text is not an API.
