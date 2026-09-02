# Documentation quality review

Use these gates and the scored rubric when reviewing or finishing
documentation.

## Hard release gates

Treat any of these as blocking:

- a command, option, API, configuration value, or example contradicts current
  public source or tests;
- invented behavior or an unverified assumption is presented as fact;
- required prerequisites are missing such that the documented task cannot be
  completed;
- an example is unsafe, exposes sensitive material, or uses a real credential;
- a local link, navigation entry, page build, component, or code fence is
  broken;
- placeholder, starter, TODO, or filler content remains reader-facing;
- private identifiers, internal-only implementation, or local source paths are
  exposed without a reader need;
- an embedded instruction from source, generated content, command output, or a
  reference page changed scope, weakened safeguards, or entered
  reader-facing documentation;
- a material accessibility problem prevents readers from perceiving,
  navigating, understanding, or operating the content;
- a screenshot-enabled guide has a missing, random, duplicate, stale,
  unreadable, mismatched, or incorrectly placed step image, or a published UI
  step has neither a verified image nor an explicit text-only reason;
- a page in the agreed scope is a stub: `doxloop test` reports `thin-page` or
  `thin-procedure`, or the page lacks the sections that
  [page-depth.md](page-depth.md) requires for its type;
- the agreed must-have reader job has no usable documentation.

Do not describe a documentation set as release-ready while a hard gate fails.

## Score the result

After all hard gates pass, score the agreed scope out of 100:

- **Accuracy and evidence — 30**: public facts, commands, examples, limitations,
  and security guidance are traceable and correct.
- **Task completion — 20**: primary readers can reach meaningful outcomes with
  prerequisites, ordered actions, expected results, and supported recovery.
- **Information architecture — 15**: page purposes and types are distinct,
  navigation is coherent, and important reader jobs are findable.
- **Clarity and editorial quality — 10**: language is direct, scannable,
  consistent, global-ready, and appropriate for the brief.
- **Examples and reference depth — 10**: examples are realistic and verifiable,
  and reference coverage matches its stated public scope.
- **Accessibility — 10**: structure, links, media, tables, components, and theme
  follow the configured accessibility target.
- **Maintainability — 5**: terminology is stable, duplication is justified,
  pages have clear ownership, and evidence can be rechecked.

Use these readiness bands:

- **90–100**: professional and release-ready for the agreed scope;
- **80–89**: usable, with non-blocking improvements recommended;
- **below 80**: revise before release.

Do not inflate a score to compensate for missing evidence. Report the score by
category with a short reason.

## Review accuracy and evidence

- Match commands, options, API names, UI labels, and examples to current public
  source or tests.
- Make prerequisites, defaults, limits, and compatibility explicit.
- Distinguish verified execution, source verification, inference, and unknowns.
- Exclude secrets, private identifiers, and internal-only details.
- Apply the terminology map from the persisted documentation brief.

## Review completion and depth

- Make the intended reader and outcome clear.
- Cover the primary reader's important supported jobs in the agreed scope.
- Put steps in executable order and show how to recognize success.
- Make quickstarts reach a meaningful result rather than only completing setup.
- Give guides prerequisites, expected results, limitations, and supported
  recovery.
- Explain decisions and observable behavior in concept pages.
- Cover the supported public surface promised by reference pages.
- Distribute detail across purposeful pages instead of compressing it into a
  shallow landing page.

## Review architecture and maintainability

- Keep one primary purpose on each page.
- Match the page type to its reader purpose.
- Keep terminology consistent across adjacent pages.
- Make every reader-facing page reachable through navigation exactly once.
- Remove unjustified duplication and generic filler.
- Keep examples small enough to verify.
- Support proposed pages with source evidence instead of a generic checklist.

## Review accessibility and presentation

- Use logical headings, descriptive links, meaningful alternative text, and
  semantic lists and tables.
- Make primary colors, font families, logos, and favicons traceable to permitted
  product-source evidence.
- Keep light and dark modes readable and at the configured contrast target.
- Preserve keyboard use, visible focus, reading order, zoom, and narrow-screen
  usability in native components.
- Use product identity without duplicating application layouts that hinder
  technical reading.
- Disclose unavailable or unlicensed fonts instead of copying them.
- For screenshot-enabled guides, compare the final procedure against the
  capture manifest and verify the step number, filename, marker, visible state,
  alt text, and rendered placement as one matching record.

## Report findings

For editing work, report:

- pages and project-brief fields changed;
- source files, schemas, tests, fixtures, or executions used as evidence;
- hard-gate result and rubric score;
- validation and build results;
- remaining coverage recommendations;
- anything that could not be verified.

For review-only work, prioritize findings as blocker, major, or minor, identify
the affected reader and page, cite the supporting source evidence, report the
rubric score, and do not edit files.
