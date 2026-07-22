# External documentation design references

Use this reference when `.doxloop/project.json` contains `designReferences` or
the user supplies a documentation URL whose presentation should guide the
result.

## Keep evidence boundaries explicit

- Use configured local product sources for every product fact, command,
  parameter, example, limitation, and reader outcome.
- Use the external site only for visual tokens, layout measurements,
  responsive behavior, component treatment, and information-architecture
  patterns.
- Do not copy its prose, code examples, product names, navigation labels,
  illustrations, logos, or proprietary assets.
- Use the documented product's own identity unless the user owns or is
  authorized to reuse the reference identity.

## Confirm fidelity

Propose one of these levels during create consultation:

- **Adapted** (default): reproduce the design grammar while keeping the
  documented product's colors, assets, and distinctive identity.
- **Close**: match typography, colors, spacing, component geometry, and layout
  where the selected generator supports them, but keep product content and
  assets independent.
- **Exact authorized**: attempt a visually equivalent implementation only after
  the user confirms they own the design or have permission to reproduce it.

Never select or infer **exact authorized** on your own, even when the request
says to copy or clone the site. It requires an explicit user statement of
rights in this conversation. Record the confirmed level in the design profile's
`fidelity` field; for exact-authorized work also record a `rightsConfirmation`
note quoting the user's statement and its date. Without that statement, use
**close** and explain why.

Never promise pixel identity across different generators, browser engines,
fonts, content lengths, or unsupported components. State the concrete fidelity
limits before editing.

## Inspect representative rendered pages

Prefer a browser or rendered-page inspection tool when one is available: only
rendered inspection yields computed styles, responsive behavior, and
client-rendered navigation. When the agent has no browser tool, run
`doxloop capture` — Doxloop's built-in rendered inspection. When even that is
unavailable, use the raw HTML-and-CSS fallback below instead of stopping.

Treat the user-supplied reference URL as authorization to inspect the public
page and up to two additional public documentation pages on the same origin.
Do not ask permission before opening each page. Use one browser session, reuse
the same tab or browser context, and batch navigation and extraction whenever
the tool supports it.

Choose up to three pages without consulting the user:

1. the documentation landing or overview page;
2. a procedural guide with headings, lists, callouts, and code;
3. a dense reference page with tables or API elements, when present.

Capture desktop and narrow/mobile states. Capture light and dark states when
the site supports both. Follow same-site documentation links only as needed for
those representative states. If a useful page or state is unavailable, record
the limitation and continue; do not stop to ask for another URL.

Do not sign in, submit forms, accept downloads, or leave the supplied
documentation origin. Ask once only when the task genuinely requires
authenticated content, another origin, or confirmation of exact-reproduction
rights. Otherwise complete the bounded capture without further user questions.

Tool-enforced permission dialogs cannot be bypassed by this skill. Minimize them
by opening the supplied origin once, navigating through same-origin links in
that session, and avoiding separate search or fetch calls for every page.

## Degrade gracefully without a browser

Missing design evidence must never block documentation work.

If no browser tool is available, first run Doxloop's built-in capture with the
chosen representative pages:

```bash
doxloop capture <landing-url> <guide-url> <reference-url>
```

It renders each page headlessly in desktop and mobile viewports and light and
dark color schemes, then writes full-page screenshots and measured styles
(root CSS variables, computed typography and colors, content width) to
`.doxloop/cache/reference/<page>/`. Read each `capture.json` and screenshot as
measured evidence for the design profile. The first run installs a managed
Playwright Chromium (a one-time download of a few hundred MB); tell the user
before triggering it. Capture only accepts pages on configured
design-reference origins.

If `doxloop capture` also fails (offline, installation blocked, site blocks
headless browsers):

1. Fetch the raw HTML and linked stylesheets of the same representative pages
   (same origin, same three-page budget) with the available fetch tool. Extract
   font families, CSS custom properties, colors, spacing and radius scales,
   breakpoints, and color-mode rules. Record them as **inferred**, not
   measured, and list the inference in `constraints`.
2. Build the design profile from those inferred values. For anything still
   unknown, mark it unknown and fall back to the adapted default theme derived
   from the documented product's own identity. Do not guess between plausible
   alternatives.
3. Continue the create workflow. In the single consolidated consultation
   message, note that fidelity is limited without rendered inspection and that
   the user may optionally attach full-page desktop and mobile screenshots or
   theme/token files to improve it — as an offer alongside the plan, never as
   a demand that blocks authoring. No response about screenshots means:
   proceed with the inferred profile.
4. Skip the side-by-side rendered comparison, report which characteristics
   were inferred or unverified in the final summary, and recommend fixing
   whatever blocked `doxloop capture` (or attaching screenshots) if the user
   wants measured fidelity later.

## Build a normalized design profile

Record the following evidence in `.doxloop/reference-design.json`. Include the
source URL and representative page URL for every material value:

- **Typography**: body, heading, UI, and monospace families; base size; heading
  scale; font weights; line heights; letter spacing.
- **Color**: page and surface backgrounds; text and muted text; accent and link
  colors; borders; code, callout, and navigation states in each color mode.
- **Spacing and geometry**: spacing scale; header and sidebar sizes; content and
  reading-column widths; gutters; radii; borders; shadows.
- **Layout**: header, left navigation, page content, right table of contents,
  footer, breakpoints, sticky behavior, and mobile collapse behavior.
- **Content components**: heading rhythm, breadcrumbs, cards, steps, tabs,
  callouts, code blocks, tables, API blocks, previous/next links, and search.
- **Information architecture**: navigation depth, grouping strategy, page
  anatomy, progressive disclosure, and cross-link patterns.
- **Constraints**: blocked pages, unavailable fonts, inaccessible color
  combinations, unsupported generator behavior, and inferred rather than
  measured values.

Prefer computed values and bounding-box measurements over visual guesses.
Consolidate repeated values into a small token scale rather than preserving
irrelevant sub-pixel noise.

Use this compact shape:

```json
{
  "version": 1,
  "references": [
    {
      "url": "https://docs.example.com/",
      "capturedPages": [],
      "capturedAt": "ISO-8601 timestamp"
    }
  ],
  "fidelity": "adapted",
  "rightsConfirmation": "Required for exact-authorized only: the user's statement and its date",
  "tokens": {
    "typography": {},
    "color": {},
    "space": {},
    "geometry": {}
  },
  "layout": {},
  "components": {},
  "informationArchitecture": {},
  "constraints": []
}
```

Do not place downloaded third-party HTML, CSS, JavaScript, screenshots, or font
files in the documentation project, except under the Git-ignored
`.doxloop/cache/` directory where `doxloop capture` stores local evidence.

## Translate, do not transplant

Map the normalized profile through the selected generator's native theme and
components. Preserve the reference's hierarchy, rhythm, density, and interaction
patterns where useful, but let the documented product determine page names,
navigation groups, examples, and coverage.

Resolve conflicts in this order:

1. verified product correctness;
2. reader task completion;
3. accessibility target;
4. generator correctness and maintainability;
5. reference-site fidelity.

Correct inaccessible contrast, focus, semantics, or responsive behavior rather
than reproducing the defect. Record the intentional difference in
`constraints`.

## Verify side by side

Render the generated overview, guide, and reference page at matching desktop
and mobile viewport sizes. Compare:

- type scale and line length;
- major column widths and offsets;
- vertical rhythm and component density;
- color roles and contrast;
- navigation, table-of-contents, and responsive behavior.

Fix systematic token or layout differences before page-specific details.
Report matched characteristics, intentional adaptations, unsupported details,
and any unverified states in the final summary.
