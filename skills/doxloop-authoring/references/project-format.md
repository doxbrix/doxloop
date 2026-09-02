# Doxloop project format

Read this reference before creating or moving documentation pages.

## Project settings

`.doxloop/project.json` contains:

```json
{
  "schemaVersion": 1,
  "title": "Example documentation",
  "contentDir": "",
  "generator": "doxbrix",
  "sources": [
    {
      "name": "product",
      "path": "../product",
      "remote": {
        "provider": "github",
        "repository": "example/product",
        "branch": "main",
        "tokenEnv": "GITHUB_TOKEN"
      }
    },
    {
      "name": "api",
      "path": "https://example.com/openapi.json",
      "kind": "openapi"
    }
  ],
  "designReferences": [
    {
      "url": "https://docs.example.com/"
    }
  ],
  "deployment": {
    "name": "Example documentation",
    "slug": "example-docs",
    "visibility": "private",
    "apiUrl": "https://app.doxbrix.com"
  },
  "application": {
    "baseUrl": "http://localhost:3000/",
    "source": "product",
    "readyPath": "/health",
    "screenshots": {
      "policy": "requested",
      "viewport": { "width": 1440, "height": 900 },
      "highlight": true,
      "startPath": "/settings/team",
      "workflow": "Reuse the signed-in demo workspace and synthetic team members. Capture the invite form and successful invitation state."
    }
  },
  "documentation": {
    "primaryAudience": "Application developers",
    "experienceLevel": "intermediate",
    "priorityOutcomes": [
      "Install the SDK",
      "Complete the first API request"
    ],
    "preferredExamples": ["TypeScript", "curl"],
    "designDirection": "Compact developer reference with task-led guides",
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
- Treat `contentDir` as the only documentation content directory. An empty
  value means the project root for native Doxbrix projects; external generators
  keep their generator-specific content directories.
- Treat `sources` as an allowlist for product research.
- A source with `"kind": "openapi"` is an OpenAPI or Swagger document — a
  local file path or an HTTP(S) URL. Read it as authoritative API evidence for
  endpoints, parameters, schemas, and examples. A source without `kind` is a
  read-only local directory.
- Respect `source.scope`. Pages grounded in a scoped source must stay below its
  `routePrefix` and should use its `space` and `navigationGroup`. A page outside
  that boundary is allowed only when it matches `sharedPages`; never move one
  source's claims into another source's assigned section.
- `defaultAgent` optionally records the coding agent (`codex`, `claude`, or
  `gemini`) the user chose for this project. Do not change it.
- `deployment` optionally records the hosted project identity, visibility, and
  Doxbrix destination. Preserve it during authoring; users change it through
  `doxloop settings`.
- Treat `designReferences` as presentation and information-architecture
  evidence only. Never use them as evidence for product behavior.
- Treat `application` as the optional safe browser surface for application
  guide screenshots. Resolve its `source` through the configured source
  allowlist, and follow [screenshots.md](screenshots.md) before starting or
  operating the application. Treat `screenshots.startPath` and
  `screenshots.workflow` as the user-approved default capture boundary. A
  missing object preserves request-driven capture behavior and does not affect
  design-reference capture.
- Keep source paths local. Never copy them into documentation or deployment
  content.
- A directory source may include a read-only `remote` used by scheduled sync.
  Preserve its provider, repository, branch, token environment-variable name,
  and API base URL. Never store a token or write to that repository.
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

## Approved documentation plan

When `.doxloop/documentation-plan.json` exists, it is the approved, immutable
scope for the current create or update run. It uses schema version 2 and records
the reader brief, evidence-backed capabilities, navigation outline, page
actions, structured page evidence, generator target, and approval hash.

- Create, update, preserve, or remove only the pages named in the plan.
- Treat its `target.navigationFiles` as the generator-owned navigation
  boundaries; the matching generator skill still owns their native syntax.
- Do not turn exclusions, unknowns, or recommendations into reader content.
- Do not add a future backlog or deferred pages to the current generation.
- If evidence contradicts the approved plan, stop and report it instead of
  silently expanding scope.

## Evidence map

`.doxloop/evidence-map.json` records which configured source produced each page.
Doxloop uses it to tell readers and maintainers exactly which pages a later
source change affects, without starting an agent. Write it whenever you create
or change pages:

```json
{
  "schemaVersion": 1,
  "pages": {
    "guides/authentication.md": {
      "sources": [
        { "source": "product", "paths": ["src/auth.ts", "src/session.ts"] },
        { "source": "api", "operations": ["POST /oauth/token"] }
      ],
      "verifiedAt": { "product": "9f2c1ab...", "api": "sha256..." },
      "verifiedOn": { "product": "2026-08-26T10:00:00.000Z", "api": "2026-08-26T10:00:00.000Z" },
      "confidence": "verified",
      "claims": ["Access tokens expire after 900 seconds"],
      "claimVerification": {
        "Access tokens expire after 900 seconds": "verified"
      }
    }
  }
}
```

- Key every entry by the page path relative to the project root, including its
  extension, exactly as `doxloop test` reports it.
- `source` must name a configured source in `sources`.
- `paths` are source-relative files, directories, or globs you actually read as
  evidence for that page. A directory matches everything below it. Record the
  narrowest paths that support the page: listing a whole source makes every
  future change look relevant.
- Shared routers, application entry points, and integration-test files are not
  automatically evidence for every endpoint or workflow they exercise. Record
  one only for pages whose reader-facing claims depend on its relevant branch
  or assertion. If one path appears on more than half of all pages, audit every
  occurrence and retain only direct claim support. This prevents a localized
  product change from conservatively marking the whole documentation set stale.
- Omit `paths` only for a page that genuinely depends on the whole source, such
  as a release overview.
- `operations` name documented API operations for an OpenAPI source.
- `verifiedAt` records the exact source revision or OpenAPI content hash.
  `verifiedOn` records the ISO timestamp when you actually checked the claims;
  update both for every source used by a created or changed page.
- `confidence` is `verified` when you read the source and confirmed the claims,
  `inferred` when you reasoned from indirect evidence, or `needs-human` when a
  claim could not be verified and a person must confirm it.
- `claims` optionally lists the reader-facing facts most worth re-checking when
  the source changes. `claimVerification` records each exact claim as
  `verified`, `inferred`, `contradicted`, or `needs-human`; never overstate
  evidence.
- Preserve entries for pages you did not touch, and remove entries for pages you
  deleted or renamed.

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
