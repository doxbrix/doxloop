# Doxbrix project format

The canonical manifest is `docs.json` at the project root for a new native
Doxbrix project whose `contentDir` is empty. Existing projects with
`contentDir: "docs"` keep the manifest at `docs/docs.json`.

```json
{
  "version": 1,
  "name": "Example",
  "description": "Learn how to use Example.",
  "spaces": [
    {
      "name": "Documentation",
      "slug": "docs",
      "icon": "book",
      "nav": [
        {
          "type": "group",
          "label": "Get started",
          "icon": "rocket",
          "items": [
            {
              "type": "page",
              "file": "index",
              "title": "Overview",
              "icon": "compass"
            },
            {
              "type": "page",
              "file": "quickstart",
              "icon": "bolt"
            }
          ]
        },
        {
          "type": "link",
          "title": "Service status",
          "href": "https://status.example.com",
          "icon": "globe"
        },
        {
          "type": "api",
          "title": "HTTP API",
          "spec": "openapi.yaml",
          "icon": "plug"
        }
      ]
    }
  ],
  "theme": {
    "primaryColor": "#6366f1",
    "lightColor": "#4f46e5",
    "darkColor": "#818cf8",
    "mode": "system",
    "font": "Inter",
    "headingFont": "Inter",
    "codeFont": "JetBrains Mono",
    "logoLight": "/assets/logo-light.svg",
    "logoDark": "/assets/logo-dark.svg",
    "logoHref": "https://example.com",
    "favicon": "/assets/favicon.svg",
    "backgroundColorLight": "#ffffff",
    "backgroundColorDark": "#12131a",
    "fontSources": [
      {
        "family": "Inter",
        "source": "/fonts/inter-regular.woff2",
        "format": "woff2",
        "weight": 400
      }
    ]
  }
}
```

Page `file` values are relative to the content directory without `.md` or
`.mdx`. A group can contain pages and nested groups.

Supported navigation nodes:

- `page`: `file`, with optional `title`, `icon`, and `hidden`;
- `group`: `label` and nested `items`, with optional `icon` and `hidden`;
- `label`: non-clickable section text;
- `divider`: visual separation;
- `link`: external or internal `title` and `href`, with optional `icon`;
- `api`: API reference `title` and specification path, with optional `icon`.

Every reader-facing page should appear exactly once in navigation.

## Navigation icons

Give each space and primary group, page, link, and API node a semantic `icon`.
Prefer stable lowercase kebab-case Doxbrix names such as `book`, `rocket`,
`compass`, `bolt`, `globe`, and `plug`. Reuse one icon for one concept, preserve
an established project vocabulary, and avoid decorative or arbitrary choices.
Keep the visible `name`, `label`, or `title`; an icon never replaces text.
For a page with an explicit navigation icon, put the same semantic icon in the
page frontmatter so local preview and deployed page metadata stay aligned.
Labels and dividers do not take icons.

## Theme values

Use six-digit hexadecimal colors. `mode` is `light`, `dark`, or `system`.

- `primaryColor`: default accent;
- `lightColor` and `darkColor`: accessible accent variants for each mode;
- `font`, `headingFont`, and `codeFont`: font-family names;
- `logoLight`, `logoDark`, and `favicon`: public root-relative or HTTPS assets;
- `logoHref`: an HTTPS or root-relative destination for the logo;
- `backgroundColorLight`, `backgroundColorDark`, and `backgroundImage`: reader
  backgrounds;
- `fontSources`: copied local font files with `family`, `source`, `format`,
  `weight`, and optional `style`.

Root-relative assets resolve from the documentation content directory. Copy
them into that directory; never point the manifest at the configured product
source.
