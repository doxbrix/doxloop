---
name: doxloop-vitepress
description: Author and maintain native VitePress documentation, including Markdown, custom containers, Vue-enhanced content, sidebar configuration, theme tokens, and static builds. Use for Doxloop projects whose generator is vitepress.
---

# Doxloop VitePress

Use this skill with `$doxloop-authoring`. Use VitePress-native Markdown, theme
configuration, custom containers, and Vue features.

## Work natively

1. Confirm `.doxloop/project.json` selects `vitepress`.
2. Read [references/project-format.md](references/project-format.md).
3. Inspect config, sidebar, theme extension, components, and existing pages.
4. Keep pages in `docs/` and configuration under `docs/.vitepress/`.
5. Give pages `title` and outcome-focused `description` frontmatter.
6. Maintain `themeConfig.sidebar` with stable clean routes.

Implement the semantic top/left navigation plan from `$doxloop-authoring` in
`themeConfig.nav` and `themeConfig.sidebar`. Preserve planned labels, order,
hierarchy, and routes across desktop and mobile; omit empty template groups and
keep shared destinations in one primary sidebar location.

Prefer Markdown, native containers, and code groups. Use Vue components only
when they improve the reader task, import or register them correctly, and keep
browser-only behavior client-safe. Apply branding through theme tokens and
shared styles while preserving VitePress accessibility and responsiveness.

## Verify

Run `doxloop test`, then `npm run docs:build`. Inspect representative pages with
`doxloop preview --open`. Fix dead links, duplicate routes, invalid containers,
SSR failures, missing sidebar entries, and broken component imports.

Do not emit Docusaurus or MkDocs syntax or edit `.vitepress/cache/` or
`.vitepress/dist/`.
