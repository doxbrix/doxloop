# Workflows for runs without an approved plan

Use these procedures only when no approved `.doxloop/documentation-plan.json`
scopes the run. Every reading list in `SKILL.md` still applies.

## Create

Read, in addition to the start-of-task references, [references/documentation-types.md](documentation-types.md),
[references/page-depth.md](page-depth.md), and
[references/branding.md](branding.md).

1. **Discover.** Inspect enough source to understand the reader-visible
   product: entry points, commands, routes, configuration schemas, runtime
   requirements, tests and fixtures that show supported workflows,
   authentication, permissions, errors, limits, recovery paths, theme tokens
   and public brand assets, and existing documentation that still matches.
   Classify the product, readers, first-success path, capabilities, workflows,
   and operational concerns, recording evidence for each conclusion.
2. **Consult once.** Present a concise discovery summary (expert profile,
   identity, pages grouped as must have / next / later with reasons, navigation
   outline) as a progress update. Ask once, with at most three decisions, only
   when a material decision is unresolved; otherwise state assumptions and
   continue in the same run — a plan alone is never a finished create run.
   Never ask what inspection can answer. Then update only the `documentation`
   object in `.doxloop/project.json`.
3. **Plan coverage.** Map reader jobs and capabilities to types, pages,
   evidence, and gaps. Comprehensive means complete for the agreed scope, not
   the largest page count; no filler or placeholder trees.
4. **Author.** Improve a page that already has the right purpose; create one per
   distinct reader job. Cover overview and a verified first-success path,
   prerequisites and configuration, each important workflow, needed concepts,
   public interfaces, evidence-backed troubleshooting, limitations, and next
   steps. Add every page to native navigation, apply the identity through
   native theme configuration, replace every generated starter page, and remove
   every `doxloop:starter-page` marker. Do not stop after the landing page and
   quickstart when the source supports more. Complete factual, task, editorial,
   and accessibility passes. For a screenshot-enabled guide, finish the text
   procedure first, then capture in manifest order.

## Update

1. Classify the request: source synchronization (use the prompt's change
   summary and `git diff` against the listed baseline), a scoped content
   change, or transformation (inspect existing pages first; an unrelated change
   summary never redefines the scope).
2. Find affected pages: read `.doxloop/evidence-map.json` first when it exists,
   verify its candidates against the source, and check for pages it misses.
3. Reuse the existing expert profile when valid. Read the routing, domain/type,
   audience, and navigation references only when the update adds a journey,
   changes audience or domain, or restructures IA;
   [references/branding.md](branding.md) when theme tokens or brand
   assets changed; [references/reference-sites.md](reference-sites.md)
   when the design reference changed;
   [references/screenshots.md](screenshots.md) when screenshots are
   enabled and an affected UI workflow, label, layout, or outcome changed —
   refresh only those images.
4. Update all affected pages to the depth contract, preserving verified facts,
   examples, routes, and links during transformation; inspect adjacent pages
   for contradictions or new gaps.
5. Preserve the brief, terminology, and structure unless the user changes them
   or verified behavior contradicts them. Recommend new pages for gaps; ask
   before broadening scope. Make no edit when the change is entirely internal,
   and say why.

## Review

Do not edit files. Read
[references/documentation-types.md](documentation-types.md),
[references/branding.md](branding.md), and
[references/quality.md](quality.md), plus the relevant expert
templates and [references/navigation-architecture.md](navigation-architecture.md)
when domain correctness, depth, audience fitness, or IA is in scope. Report
blocking accuracy or usability problems, missing coverage, IA and depth
problems, smaller clarity improvements, the evidence for each finding, and the
hard-gate result with the scored rubric. Do not penalize omitting a generic
topic the product does not support; do not report speculation as fact.
