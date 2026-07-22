# Jekyll project format

- Reader collection: `_docs/`
- Configuration and navigation: `_config.yml`
- Layouts: `_layouts/`; reusable fragments: `_includes/`
- Static assets: `assets/`
- Required frontmatter: `title` and `description`
- Home page sets `permalink: /`; collection pages use configured permalinks.
- Use Liquid output escaping where reader-controlled values are possible.
- Dependencies: `Gemfile`
- Build: `bundle exec jekyll build --strict_front_matter`; output: `_site/`

## Navigation and routes

- Keep `_docs` collection output and permalink rules intact.
- Add every reader page exactly once to the configured navigation structure.
- Use `{% link %}` or `{% post_url %}` where supported for checked internal
  destinations; preserve `relative_url` and `absolute_url` filters.
- Do not change established permalinks without redirects.

## Liquid and presentation

- Prefer layouts and includes over repeated page markup.
- Escape reader-controlled values and avoid `include` paths derived from data.
- Keep design tokens in shared CSS and public assets under `assets/`.
- Preserve semantic landmarks, visible focus, and accessible mobile navigation.

## Common failures

- YAML scalars containing punctuation may need quoting.
- Liquid inside fenced code can be evaluated unless wrapped in `{% raw %}`.
- Collection documents disappear when `_config.yml` omits `output: true`.
- `_site/` is generated output and must not be edited.
