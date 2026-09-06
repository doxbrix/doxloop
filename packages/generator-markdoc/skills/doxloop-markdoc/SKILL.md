---
name: doxloop-markdoc
description: Author and maintain native Markdoc documentation, including Markdown, Markdoc tags, schemas, navigation metadata, renderer-safe content, and static output. Use for Doxloop projects whose generator is markdoc.
---

# Doxloop Markdoc

Use this skill with `$doxloop-authoring`. Use only tags, nodes, and schemas
registered by the Markdoc project.

## Work natively

1. Confirm `.doxloop/project.json` selects `markdoc`.
2. Read [references/project-format.md](references/project-format.md).
3. Read [references/authoring.md](references/authoring.md) for callout, tab,
   code, image, and diagram syntax.
4. Inspect `markdoc.config.mjs`, `navigation.json`, the renderer, and existing
   pages.
5. Keep pages in `docs/` with `title` and outcome-focused `description`.
6. Maintain navigation and stable routes when pages change.

Implement the semantic top/left navigation plan from `$doxloop-authoring` in
`navigation.json` and the renderer's supported header and sidebar structures.
Preserve planned labels, order, hierarchy, and routes; omit empty template
groups and verify every page is reachable exactly once.

Prefer CommonMark unless a registered tag adds meaningful semantics. Never
invent a tag without defining and testing its schema and renderer. Preserve the
parse, validate, transform, and render pipeline. Map branding through renderer
templates and shared CSS, not page-specific inline presentation.

## Verify

Run `doxloop test`, then `npm run build`. Treat Markdoc validation diagnostics,
unknown tags, invalid attributes, unsafe rendered HTML, missing navigation, and
broken routes as failures. Inspect representative output with
`doxloop preview --open`.

Do not emit JSX, generator-specific directives, or edit `dist/`.
