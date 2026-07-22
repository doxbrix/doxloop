---
name: doxloop-nextra
description: Author and maintain native Nextra 4 documentation using the Next.js app router, MDX content directory, docs-theme components, _meta navigation, and static exports. Use for Doxloop projects whose generator is nextra.
---

# Doxloop Nextra

Use this skill with `$doxloop-authoring`. Use Nextra 4 with the Next.js app
router; never use Nextra 3 pages-router conventions.

## Work natively

1. Confirm `.doxloop/project.json` selects `nextra`.
2. Read [references/project-format.md](references/project-format.md).
3. Inspect the app-router shell, `_meta.js`, MDX components, theme options, and
   content.
4. Keep reader pages in `content/` and shell code in `app/`.
5. Give pages `title` and outcome-focused `description` frontmatter.
6. Maintain `_meta.js` with stable routes and purposeful groups.

Implement the semantic top/left navigation plan from `$doxloop-authoring` with
the docs-theme navbar or verified header links and `_meta.js` page maps. Preserve
planned labels, order, hierarchy, and routes across desktop and mobile; omit
empty template groups.

Prefer ordinary MDX, Nextra components, and GitHub alerts. Import components
explicitly and mark client-only React code deliberately. Apply branding through
the docs theme, layout, and shared styles while preserving server rendering,
color modes, focus, and mobile navigation.

## Verify

Run `doxloop test`, then `npm run build`; confirm the static export in `out/`.
Inspect representative pages with `doxloop preview --open`. Fix RSC/client
boundary errors, missing metadata entries, MDX imports, and non-static routes.

Do not emit Nextra 3 conventions or edit `.next/` or `out/`.
