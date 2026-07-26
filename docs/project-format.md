# Doxloop project format

Doxloop stores project configuration under `.doxloop/`. Commit the configuration
and synchronization state when a team should share the same authoring decisions.

Create a new documentation project beside, never inside, the product source:

```bash
doxloop init
```

Run `doxloop settings` inside the documentation project to change shared
configuration without editing JSON by hand.

## `project.json`

```json
{
  "schemaVersion": 1,
  "title": "Example documentation",
  "contentDir": "docs",
  "generator": "doxbrix",
  "sources": [{ "name": "product", "path": "../product" }],
  "designReferences": [{ "url": "https://docs.example.com/" }],
  "deployment": {
    "name": "Example documentation",
    "slug": "example-docs",
    "visibility": "private",
    "apiUrl": "https://app.doxbrix.com"
  },
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
    "priorityOutcomes": ["Install the SDK", "Send the first request"],
    "locale": "en-US",
    "tone": ["clear", "direct", "professional"],
    "standardsProfile": "doxloop-v1",
    "styleGuide": "doxloop",
    "terminology": {},
    "exclusions": [],
    "accessibilityTarget": "WCAG 2.2 AA"
  }
}
```

- `contentDir` must be a non-symlinked relative directory inside the project.
- `sources` is the optional read-only evidence allowlist used by the authoring
  workflow. It may be empty when no local product source is available. Configured
  source paths must be outside the documentation project; sibling product and
  documentation directories are the recommended layout.
- `generatorPackage` is required for an external generator and must match the
  official package selected by `generator`.
- `designReferences` accept absolute HTTP or HTTPS URLs without credentials.
- `application` is optional and describes a safe local or test application
  surface for guide screenshots. `source` names a configured source and is
  required when `startCommand` is present. Screenshot policy is `requested`,
  `auto`, or `off`; projects without this object keep the existing behavior.
- `deployment` optionally saves the hosted project name, slug, visibility, and
  Doxbrix destination used by `doxloop deploy`. Missing values are derived from
  the project title and default to private.
- `documentation` persists confirmed reader, scope, terminology, editorial, and
  accessibility decisions.

Schema version 1 treats a missing legacy `generator` as `doxbrix` and supplies
the default documentation brief when it is absent. Unsupported structures fail
closed rather than being silently migrated.

## `sync-state.json`

Each Git source records the commit, timestamp, and a fingerprint of tracked and
untracked non-ignored, non-credential source content used by the last successful
authoring run. The fingerprint prevents an unchanged dirty working tree from
being reported again after its content is committed.

Doxloop updates synchronization state only when create or update exits
successfully, documentation validation passes, and create has saved a primary
audience and priority outcomes.

## `last-run.json`

After a successful create or update, Doxloop records the mode, selected agent,
completion time, validation summary, and synchronized source count. This is an
ignored operational receipt, not an evidence map or a substitute for version
control.

## Reference-design evidence

`.doxloop/reference-design.json` is authored by the design-reference workflow.
Screenshots and raw measurements remain under `.doxloop/cache/` and should not
be committed.

Application guide screenshots are different: they are reader-facing assets,
are placed in the selected generator's native asset directory, and should be
committed with the guide. `doxloop create --screenshots` and
`doxloop update --screenshots` require them explicitly; a request that clearly asks for
screenshots also enables the authoring workflow. Contextual focus rings and
numbered markers are baked into the image so they render consistently across
generators.
