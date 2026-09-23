# Generation performance and usage budgets

Planning saves useful browser screenshots while it explores the application.
The application research checkpoint records capture IDs, paths, visible states,
labels, alt text and review checks. The approved plan references those IDs in
`visuals.captureIds`, in the same order as `captureSequence`. A missing capture
uses an empty ID. New plans prefer meaningful saved images over fixed image
counts per page type. Explicit user requirements remain authoritative.

Generation copies selected, reviewed PNGs into the generator's asset directory.
Missing, corrupt, unreviewed or ambiguous captures remain pending. Missing states
run in short capture-only sessions before writing. Writers receive a compact
plan slice, relevant source excerpts, extracted English UI labels and saved
image descriptions. They choose and embed the images without browsing again.
Older plans without a capture catalogue use the separate capture stage.

Completed writing is checkpointed independently of capture and validation.
Resume retains written pages and verified captures; validation defects are sent
to targeted repairs. A crashed child can retry without cancelling the entire
run. An account-limit response stops further scheduling and retries immediately.

## Limits

A plan shares one persistent usage ledger across planning, capture, writing,
repairs and resumed attempts: `.doxloop/plans/<id>/usage-budget.json`.
There is **no limit by default**: a run only stops when a cap is set
explicitly. Set `sync.budget.maxUsd` in the project, or the variables below,
to enforce one. The first reached limit stops active sessions and preserves
work.

Environment overrides, read when Doxloop starts a stage:

| Variable | Default | Meaning |
| --- | ---: | --- |
| `DOXLOOP_MAX_TOKENS` | unlimited | Total reported tokens for this plan, across attempts |
| `DOXLOOP_MAX_USD` | unlimited | Total reported dollars; overrides the project setting |
| `DOXLOOP_AUTHORING_PARALLEL` | 3 | Concurrent writer sessions (the first batch of a new site runs alone) |
| `DOXLOOP_AUTHORING_EFFORT` | plan's effort | Reasoning effort of the writer sessions (`low`…`max`) |
| `DOXLOOP_SUPPORT_EFFORT` | low | Reasoning effort of capture, fix, and retake sessions |
| `DOXLOOP_CAPTURE_GUIDES_PER_SESSION` | 3 | Guides per capture session (one sign-in each) |
| `DOXLOOP_AUTHORING_BATCH_PAGES` | 4 | Pages per writer session |
| `DOXLOOP_PLANNING_PARALLEL` | 2 | Concurrent research sessions (Gemini runs serially) |

Limits are enforced when agents report usage. An in-flight response may
overshoot; providers that report cost only on completion cannot be stopped
mid-response by cost alone. These counters are not the provider's five-hour
subscription allowance. Work done before this ledger existed is not backfilled.
A quota pause can resume after the provider reset. A Doxloop budget pause requires
explicitly raising its limit; resume does not reset the ledger.

New starter plans default to 5 pages and 15 captures. Standard and
comprehensive plans have no page cap: the evidence sets their size, up to the
300-capture run maximum. A reviewer can still set a cap on the plan review's
batch-limits panel. Approved plans keep their existing scope. Reducing parallelism limits simultaneous spend, but does
not by itself reduce total tokens.

## Comparing performance

Compare identical source snapshots, approved pages, capture states, model and
effort. Measure planning and authoring wall time separately, total reported
input/cache/output tokens, reported cost, missing-state browser calls, and final
validation outcome. Exclude idle time between attempts. Local fake-agent tests
verify reuse and recovery without consuming model allowance; a real-agent
comparison is needed before claiming a percentage saving.

Offline prompt comparison on the saved `vikunja7` first six-page batch:
the previous full-request construction was 40,000 bytes; the compact batch
construction was 10,208 bytes (74% smaller). This comparison holds page scope
constant and excludes tool results, source excerpts and model completions. It
is a prompt-size measurement, not a claim of 74% lower billed usage or latency.

## Verifying a change without a run

`doxloop replay <run-directory>` copies a recorded run's workspace
(`.doxloop/runs/<run-id>`) and re-runs the end-of-generation pipeline over it:
capture status from the images on disk, the tolerant screenshot check, the
deterministic post-pass, starter cleanup, and the validation "Accept all"
performs. It prints every repair and the errors left, exits 1 when the accept
check would still fail, and never modifies the run folder. Keep the run
folders of runs that ended blocked: each is a regression fixture for the gate
that blocked it.


## Planning research is scoped to the request

Planning research (product audit, application exploration, existing-site
audits) is the largest cost of an update run. Before any session starts,
Doxloop triages the update request:

| Request | Research | Planner |
|---|---|---|
| Navigation, icons, ordering, group names, branding, metadata | none | one session, given the current navigation and the icon names the generator can draw; returns preserved pages plus `workspaceInstructions` |
| Names existing pages (by file name or path) | product audit focused on those pages; application only when screenshots are required | one session from the focused brief |
| Product-wide, or adds pages on subjects not yet documented | full research, as a create run | one session from every brief |

Deterministic rules decide the clear cases. An ambiguous request gets one
short triage session that reads nothing and answers from the request and the
page list; if it fails, the full research runs. The decision is stored on the
plan (`research`) and shown as the first review advisory.

Briefs are keyed by source snapshot, capture intent, agent, model, and focus,
not by plan id, so a later plan on unchanged sources borrows the newest saved
product and existing-documentation briefs instead of auditing again. The
application brief is never borrowed: it names captures under its own plan.

Generation applies `workspaceInstructions` in one short session after the
pages are written, editing only the navigation configuration (or theme and
brand files) and never page content.
