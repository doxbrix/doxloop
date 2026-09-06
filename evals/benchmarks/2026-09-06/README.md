# Product hardening validation — 6 September 2026

The recorded real-agent review passed: Codex CLI 0.151.0 with `gpt-5.5`
identified all four expected defect signals and all three expected evidence
groups in the deliberately flawed CLI fixture. It returned prioritized,
structured findings, left the fixture unchanged, and took 130.466 seconds.
The matrix's 100 score measures known-signal detection. The agent rated the
fixture documentation itself 28/100 and failed its release gates.

Repeat after `pnpm run build`:

```sh
node scripts/run-authoring-evals.mjs --agent codex --model codex=gpt-5.5 --case cli --mode review
```

`review-matrix.json` records the fixture digest, versions, timing and checks.
`review-findings.json` contains the actual final structured response. This is
one agent/model/fixture observation, not a general claim of documentation
quality. The review observation is now recorded in `evals/baseline.json` under the requested follow-through work.

Earlier attempts exposed two toolchain/harness problems:

- The locally configured default model required a newer Codex CLI; that run
  exited before performing the review. The supported explicit model above ran.
- A Claude Code 2.1.217 generation attempt completed planning and applied its
  proposal after 761.696 seconds, despite shell-launch `E2BIG` errors. Its
  recorded quality score was invalid because the old harness parsed the text
  evaluation output as JSON and did not preserve diagnostics. No generation
  quality claim is made from that attempt. The runner now requests JSON,
  tolerates build progress before JSON, and preserves generated workspaces and
  raw quality/evaluation output for inspection and rescoring.

Review scoring now reads the final response rather than counting terms in the
CLI's echoed prompt or tool transcript, and recognizes the structured rubric.
The passing review above was run with those scoring corrections.

`existing-sites.json` records separate real-generator checks: Docusaurus
3.10.2 and MkDocs 1.6.1 each built before import, after an accepted update, and
after undo. Fixtures were adopted without changing native pages/configuration.
Assertions cover `/manual/help/start-here`, `/operations/guides/custom-export.html`,
static and relative assets, exact prose restoration, and unchanged assets.
Repeat with `node scripts/ci-existing-sites.mjs`. These are representative
existing-site fixtures, not an audit of customer production sites.

Python container command restrictions and fail-closed behavior passed targeted
tests. A Docker daemon was unavailable on this machine, so actual container
execution was not claimed; unconfigured Python checks stay skipped.

The follow-through existing-site run passed six native builds for each generator, including version and locale creation and undo. Screenshots: [Docusaurus](docusaurus-existing.png), [MkDocs](mkdocs-existing.png). The real container boundary result is in `python-boundary.json`.
