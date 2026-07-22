---
name: doxloop-hugo
description: Author and maintain native Hugo documentation, including Markdown content, YAML frontmatter, menus, layouts, shortcodes, assets, and static builds. Use for Doxloop projects whose generator is hugo.
---

# Doxloop Hugo

Use this skill with `$doxloop-authoring`. Keep discovery, evidence, and
editorial decisions in the shared workflow; use this skill for Hugo-native
files and rendering.

## Work natively

1. Confirm `.doxloop/project.json` selects `hugo`.
2. Read [references/project-format.md](references/project-format.md).
3. Inspect `hugo.toml`, layouts, shortcodes, assets, and existing content.
4. Keep reader pages under `content/`; use `_index.md` for home and section
   pages.
5. Give every page `title` and outcome-focused `description` frontmatter.
6. Maintain `menus.main` with stable `pageRef` values.

Implement the semantic top/left navigation plan from `$doxloop-authoring` with
Hugo menus, section pages, and the selected theme's supported sidebar data.
Preserve planned labels, order, hierarchy, and routes across desktop and mobile;
omit empty template groups and never make generated filesystem order the IA.

Use standard Markdown first. Use project-defined shortcodes, render hooks, or
layouts only when they improve the reader's task. Never invent a shortcode.
Map confirmed branding through Hugo parameters, processed assets, layouts, and
CSS while preserving accessible light, dark, focus, and mobile states.

## Verify

Run `doxloop test`, then `hugo --minify`. Inspect the home page, one guide, and
one dense reference page in `doxloop preview --open`. Fix missing menu entries,
unsafe HTML, shortcode failures, duplicate routes, and broken resources.

Do not emit components from another generator or edit `public/`, generated
resources, or caches.
