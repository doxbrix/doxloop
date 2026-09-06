---
name: doxloop-static
description: Author and maintain prebuilt static HTML documentation, including semantic HTML pages, accessible navigation, metadata, assets, links, and directly hostable output. Use for Doxloop projects whose generator is static.
---

# Doxloop Static HTML

Use this skill with `$doxloop-authoring`. Author complete, directly hostable
semantic HTML; no framework or compilation step will repair incomplete markup.

## Work natively

1. Confirm `.doxloop/project.json` selects `static`.
2. Read [references/project-format.md](references/project-format.md).
3. Read [references/authoring.md](references/authoring.md) for callout, tab,
   code, image, and diagram syntax.
4. Inspect shared CSS, scripts, navigation, and existing route structure.
5. Keep the deployable site under `site/` with directory indexes.
6. Give every page a unique `<title>`, meta description, one `<h1>`, landmarks,
   and consistent descriptive navigation.

Implement the semantic top/left navigation plan from `$doxloop-authoring` as
consistent `<header><nav>` and complementary sidebar navigation landmarks on
every page. Preserve planned labels, order, hierarchy, routes, current-page
state, and narrow-screen access; omit empty template groups.

Keep links root-relative, assets portable, images dimensioned, and alternative
text meaningful. Prefer HTML and CSS; use small progressive-enhancement scripts
only when the task requires interaction. Preserve keyboard access, visible
focus, contrast, zoom, narrow layouts, and reduced motion.

## Verify

Run `doxloop test`, then `npm run build`. Validate representative HTML, inspect
the overview, a guide, and a reference page in `doxloop preview --open`, and
test without JavaScript.

Do not introduce a framework, unsafe inline scripts, or generator-specific
syntax.
