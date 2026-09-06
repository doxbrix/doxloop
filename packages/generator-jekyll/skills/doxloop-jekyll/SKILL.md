---
name: doxloop-jekyll
description: Author and maintain native Jekyll documentation, including collection pages, YAML frontmatter, Liquid layouts and includes, navigation data, assets, and strict builds. Use for Doxloop projects whose generator is jekyll.
---

# Doxloop Jekyll

Use this skill with `$doxloop-authoring`. Use Jekyll-native Markdown, Liquid,
collections, layouts, and data.

## Work natively

1. Confirm `.doxloop/project.json` selects `jekyll`.
2. Read [references/project-format.md](references/project-format.md).
3. Read [references/authoring.md](references/authoring.md) for callout, tab,
   code, image, and diagram syntax.
4. Inspect `_config.yml`, the `_docs` collection, layouts, includes, data, and
   assets before editing.
5. Give every page `title` and outcome-focused `description` frontmatter.
6. Maintain navigation in `_config.yml` and preserve permalinks.

Implement the semantic top/left navigation plan from `$doxloop-authoring` using
the project's `_config.yml`, navigation data, collections, and layout includes.
Keep labels, order, hierarchy, and routes consistent across header and sidebar
navigation; omit empty template groups.

Prefer Markdown for content and small, escaped Liquid expressions for reusable
presentation. Never evaluate source evidence as Liquid or place secrets,
untrusted HTML, or reader-controlled values into templates without escaping.
Apply confirmed branding through layouts and assets while preserving keyboard,
contrast, zoom, and responsive behavior.

## Verify

Run `doxloop test`, then `bundle exec jekyll build --strict_front_matter`.
Inspect representative pages with `doxloop preview --open`. Treat Liquid,
frontmatter, missing collection documents, and route collisions as failures.

Do not emit another generator's components or edit `_site/`, `.jekyll-cache/`,
or generated metadata.
