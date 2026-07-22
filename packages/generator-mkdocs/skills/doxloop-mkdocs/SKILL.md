---
name: doxloop-mkdocs
description: Author and maintain native MkDocs Material documentation, including Markdown pages, YAML frontmatter, mkdocs.yml navigation, Material extensions, application-derived colors, fonts, logos, and strict builds. Use with doxloop-authoring whenever .doxloop/project.json selects the mkdocs generator, when creating or editing MkDocs pages or themes, or when reviewing MkDocs navigation and presentation correctness.
---

# Doxloop MkDocs Format

Produce documentation that builds and renders through MkDocs Material. Use this
skill with `$doxloop-authoring`; that skill owns discovery, consultation,
coverage, evidence, editorial quality, and accessibility.

## Read before editing

1. Read `.doxloop/project.json` and confirm `generator` is `mkdocs`.
2. Read [references/project-format.md](references/project-format.md).
3. Read [references/authoring.md](references/authoring.md).
4. Inspect `mkdocs.yml`, `requirements.txt`, `docs/stylesheets/extra.css`, and
   existing pages before editing.

If the generator differs, stop and use its installed Doxloop format skill.

## Author native MkDocs content

- Write `.md` pages under the configured `contentDir`.
- Include `title` and an outcome-focused `description` in YAML frontmatter.
- Use standard Markdown unless a configured Material extension materially
  improves the reader's task.
- Use Material admonitions, details, content tabs, annotations, and code blocks
  only with syntax documented in [references/authoring.md](references/authoring.md).
- Indent admonition and tab content exactly as Python Markdown requires.
- Preserve page paths when they are referenced by `mkdocs.yml`.
- Use documentation-root-relative paths in `mkdocs.yml` and page-relative links
  in Markdown.

Do not emit Doxbrix JSX components, Docusaurus `:::` directives, React imports,
`sidebars.js`, or `.mdx` pages.

## Maintain navigation

Implement the semantic top/left navigation plan from `$doxloop-authoring` in
Material-native configuration. Use theme features or verified external links
for major top-level surfaces and translate the left hierarchy into `nav`. Keep
labels, order, nesting, and routes consistent; omit empty template groups.

Treat `nav` in `mkdocs.yml` as the reader-facing information architecture. Add
every page exactly once, use nested mappings for groups, and preserve external
links. Keep filenames explicit rather than depending on filesystem ordering.

## Apply captured branding

Map confirmed product identity through Material-native configuration:

- put logos, favicons, fonts, and images under `docs/assets` or another
  documented directory inside `contentDir`;
- configure `theme.logo`, `theme.favicon`, palette, and font settings in
  `mkdocs.yml`;
- put verified CSS variables and `@font-face` declarations in
  `docs/stylesheets/extra.css`;
- keep both light and dark palette contrast accessible.

Read [references/project-format.md](references/project-format.md) before
changing theme configuration.

## Verify

Run `doxloop test`, then `.doxloop/venv/bin/mkdocs build --strict` on macOS or
Linux (or `.doxloop\venv\Scripts\mkdocs.exe build --strict` on Windows). Fix
YAML, navigation, Markdown extension, missing-file, warning, and link failures. Use
`doxloop preview --open` for an interactive Material preview. The first preview
creates `.doxloop/venv` and installs the pinned `requirements.txt`.
