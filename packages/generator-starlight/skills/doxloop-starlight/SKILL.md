---
name: doxloop-starlight
description: Author and maintain native Astro Starlight documentation, including Markdown or MDX pages, Starlight components, sidebar configuration, content schemas, custom CSS, and static builds. Use for Doxloop projects whose generator is starlight.
---

# Doxloop Starlight

Use this skill with `$doxloop-authoring`. Use Starlight-native Markdown, MDX,
Astro configuration, content collections, and components.

## Work natively

1. Confirm `.doxloop/project.json` selects `starlight`.
2. Read [references/project-format.md](references/project-format.md).
3. Inspect Astro config, the content schema, sidebar, components, and styles.
4. Keep pages in `src/content/docs/` and preserve the content collection.
5. Give pages `title` and outcome-focused `description` frontmatter.
6. Maintain the Starlight sidebar and stable slugs.

Implement the semantic top/left navigation plan from `$doxloop-authoring` with
Starlight header links and sidebar configuration. Preserve planned labels,
order, hierarchy, and routes across desktop and mobile; omit empty template
groups instead of exposing unsupported destinations.

Prefer Markdown, native asides, and built-in Starlight components. Import Astro
or Starlight components explicitly in MDX and keep framework code out of
ordinary pages. Apply branding through Starlight configuration and shared CSS
while preserving color modes, focus, search, and narrow layouts.

## Verify

Run `doxloop test`, then `npm run build`. Inspect representative pages with
`doxloop preview --open`. Fix content-schema errors, unknown components,
duplicate slugs, sidebar omissions, and broken links.

Do not emit another generator's directives or edit `.astro/` or `dist/`.
