# Hugo project format

- Content root: `content/`
- Configuration: `hugo.toml`
- Home/section documents: `_index.md`
- Leaf documents: `<route>.md`
- Navigation: `[[menus.main]]` with `pageRef`
- Required frontmatter: `title` and `description`
- Layouts: `layouts/`; reusable templates: `layouts/partials/`
- Processed styles and images: `assets/`; copied files: `static/`
- Prefer Markdown and project-defined shortcodes.
- Build: `hugo --minify`; output: `public/`

## Navigation and routes

- Use `pageRef` instead of hard-coded URLs for internal menu destinations.
- Keep menu weights stable and add every reader page exactly once.
- Preserve explicit `url`, `slug`, aliases, language, and version settings.
- Avoid route collisions between branch bundles (`_index.md`) and leaf bundles.

## Components and presentation

- Prefer Markdown render hooks for consistent links, code, and images.
- Use shortcodes only when they are defined under `layouts/shortcodes/`.
- Keep shared tokens in processed CSS under `assets/`; use `static/` only for
  files that must be copied unchanged.
- Put public logos and fonts inside the project and preserve their licenses.

## Common failures

- A missing `_index.md` can remove section content while leaving child pages.
- A menu URL can drift from content routes; prefer `pageRef`.
- Raw HTML may be disabled by Goldmark or introduce unsafe markup.
- Generated files under `public/` are never source files.
