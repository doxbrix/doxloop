# Markdoc project format

- Content root: `docs/`
- Schema/configuration: `markdoc.config.mjs`
- Navigation and routes: `navigation.json`
- Static renderer: `scripts/build.mjs`
- Required frontmatter: `title` and `description`
- Custom syntax: `{% tag attribute="value" %}...{% /tag %}`
- Use only tags registered in `markdoc.config.mjs`.
- Preserve `parse` → `validate` → `transform` → `renderers.html`.
- Build: `npm run build`; output: `dist/`

## Navigation and routes

- Keep every reader page in `navigation.json` exactly once.
- Preserve explicit route identifiers when reorganizing labels or groups.
- Validate navigation targets against source files before building.

## Tags and rendering

- Define attributes, types, defaults, required values, and child constraints in
  `markdoc.config.mjs`.
- Prefer transform-safe data over raw HTML.
- Escape content in custom renderers and preserve semantic HTML.
- Keep theme tokens and layouts in renderer-owned assets.
- Put committed guide screenshots under `assets/guides/<guide>/`, reference
  them as `/assets/guides/<guide>/<image>.png`, and preserve the scaffolded
  build copy step that publishes them.

## Common failures

- Unknown tags may parse but fail validation.
- Attribute expressions can produce unexpected types after transformation.
- Rendering without validation can publish malformed or unsafe output.
- `dist/` is generated and never a source of documentation truth.
