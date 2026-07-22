# Doxloop project format

Read this reference before creating or moving documentation pages.

## Project settings

`.doxloop/project.json` contains:

```json
{
  "schemaVersion": 1,
  "title": "Example documentation",
  "contentDir": "docs",
  "generator": "doxbrix",
  "sources": [
    {
      "name": "product",
      "path": "../product"
    }
  ],
  "designReferences": [
    {
      "url": "https://docs.example.com/"
    }
  ],
  "application": {
    "baseUrl": "http://localhost:3000/",
    "source": "product",
    "startCommand": "npm run dev",
    "readyPath": "/health",
    "screenshots": {
      "policy": "requested",
      "viewport": { "width": 1440, "height": 900 },
      "highlight": true
    }
  },
  "documentation": {
    "primaryAudience": "Application developers",
    "experienceLevel": "intermediate",
    "priorityOutcomes": [
      "Install the SDK",
      "Complete the first API request"
    ],
    "locale": "en-US",
    "tone": ["clear", "direct", "professional"],
    "standardsProfile": "doxloop-v1",
    "styleGuide": "doxloop",
    "terminology": {
      "tenant": "workspace"
    },
    "exclusions": [
      "Internal service architecture"
    ],
    "accessibilityTarget": "WCAG 2.2 AA"
  }
}
```

- `generator` is `doxbrix`, `docusaurus`, `mkdocs`, `sphinx`, `hugo`,
  `vitepress`, `markdoc`, `nextra`, `starlight`, `jekyll`, or `static`. A
  missing value in an older project means `doxbrix`.
- `generatorPackage` records the npm package for an external generator.
  Doxbrix is built in and does not use this field.
- Treat `contentDir` as the only documentation content directory.
- Treat `sources` as an allowlist for product research.
- Treat `designReferences` as presentation and information-architecture
  evidence only. Never use them as evidence for product behavior.
- Treat `application` as the optional safe browser surface for application
  guide screenshots. Resolve its `source` through the configured source
  allowlist, and follow [screenshots.md](screenshots.md) before starting or
  operating the application. A missing object preserves request-driven capture
  behavior and does not affect design-reference capture.
- Keep source paths local. Never copy them into documentation or deployment
  content.
- Treat `documentation` as the persisted reader and editorial brief. Older
  projects may omit it and use Doxloop defaults.
- Use `standardsProfile` to version the curated information-architecture,
  evidence, accessibility, and quality rules. `doxloop-v1` is the current
  profile.
- On create, save confirmed audience, experience, outcomes, terminology,
  meaningful exclusions, locale, tone, style guide, and accessibility target.
- On update and review, preserve the brief unless the user explicitly changes
  it. Report a contradiction between the brief and current product evidence
  instead of silently rewriting the brief.

## Select the format

Always use the installed `$doxloop-<generator>` skill matching the project:

| Generator | Format skill owns |
| --- | --- |
| `doxbrix` | `docs.json`, spaces, nested navigation, and Doxbrix MDX |
| `docusaurus` | Docusaurus config, sidebars, and Markdown/MDX |
| `mkdocs` | `mkdocs.yml`, Material Markdown, and theme overrides |
| `sphinx` | `conf.py`, toctrees, and reStructuredText |
| `hugo` | `hugo.toml`, menus, layouts, and content frontmatter |
| `vitepress` | VitePress config, theme, sidebar, and Markdown |
| `markdoc` | Markdoc config, navigation data, tags, and nodes |
| `nextra` | Next.js/Nextra config, page map, metadata, and MDX |
| `starlight` | Astro/Starlight config, sidebar, and Markdown/MDX |
| `jekyll` | Jekyll config, layouts, collections, Liquid, and frontmatter |
| `static` | Semantic HTML pages, navigation, assets, and build script |

Never add both navigation systems or mix component dialects in one project.
Every reader-facing page should be reachable through the selected generator's
navigation.

## Page metadata

Every page needs a short title and should have an outcome-focused description:

```markdown
---
title: Authenticate requests
description: Send your first authenticated API request.
---
```

Follow the selected format skill for additional frontmatter and route behavior.
