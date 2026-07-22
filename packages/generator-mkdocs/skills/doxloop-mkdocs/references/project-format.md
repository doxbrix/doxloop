# MkDocs Material project format

A Doxloop-created MkDocs project contains:

```text
.
├── .doxloop/project.json
├── docs/
│   ├── index.md
│   ├── quickstart.md
│   └── stylesheets/extra.css
├── mkdocs.yml
├── requirements.txt
└── package.json
```

`mkdocs.yml` owns metadata, theme configuration, Markdown extensions,
navigation, and output settings. `requirements.txt` pins the Python build
environment. `package.json` pins Doxloop and the MkDocs generator adapter; it
does not replace the Python dependencies.

## Navigation

Use explicit `nav` entries:

```yaml
nav:
  - Overview: index.md
  - Guides:
      - Authentication: guides/authentication.md
      - Deploy: guides/deploy.md
  - Status: https://status.example.com
```

Paths are relative to `docs_dir`, not to `mkdocs.yml`. Add every reader-facing
Markdown page. Do not add assets or generated `site/` files.

## Frontmatter

Use YAML metadata at the top of every page:

```markdown
---
title: Configure authentication
description: Require API keys for protected requests.
---
```

Keep the visible level-one heading aligned with the frontmatter title.

## Application brand mapping

Configure native Material assets and palette in `mkdocs.yml`:

```yaml
theme:
  name: material
  logo: assets/logo.svg
  favicon: assets/favicon.svg
  font: false
  palette:
    - media: "(prefers-color-scheme: light)"
      scheme: default
      primary: indigo
    - media: "(prefers-color-scheme: dark)"
      scheme: slate
      primary: indigo

extra_css:
  - stylesheets/extra.css
```

Use `font: false` when loading redistributable local fonts. Put verified tokens
in `docs/stylesheets/extra.css`:

```css
@font-face {
  font-family: 'Brand Sans';
  src: url('../assets/fonts/brand-sans.woff2') format('woff2');
  font-display: swap;
}

:root {
  --md-primary-fg-color: #4f46e5;
  --md-text-font: 'Brand Sans', system-ui, sans-serif;
}
```

Do not invent palette shades or download fonts without redistribution rights.
Verify light and dark color schemes visually.
