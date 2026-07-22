# Nextra project format

- Nextra version: 4, Next.js app router
- Content root: `content/`
- Navigation: `content/_meta.js`
- Catch-all route: `app/[[...mdxPath]]/page.jsx`
- Theme shell: `app/layout.jsx`
- MDX components: `mdx-components.jsx`
- Required frontmatter: `title` and `description`
- Prefer exports from `nextra/components` and `nextra-theme-docs`.
- Static export is enabled in `next.config.mjs`.
- Build: `npm run build`; output: `out/`

## Navigation and routes

- Keep page-map names and groups in `content/_meta.js`.
- Add every reader page exactly once and preserve stable path segments.
- Keep static-export constraints in mind; avoid undocumented dynamic routes.

## MDX and presentation

- Import supported components through `mdx-components.jsx` or directly from
  Nextra packages.
- Keep server components as the default; use `"use client"` only when required.
- Put tokens and shared layout changes in the theme shell rather than pages.
- Preserve search, table-of-contents, dark mode, and mobile behavior.

## Common failures

- Pages-router `_meta.json` patterns do not apply to Nextra 4 app-router sites.
- Browser-only code in a server component breaks the build.
- A page missing from `_meta.js` may be unreachable.
- `.next/` and `out/` are generated output.
