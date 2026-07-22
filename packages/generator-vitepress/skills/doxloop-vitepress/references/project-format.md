# VitePress project format

- Site root and content: `docs/`
- Configuration: `docs/.vitepress/config.mts`
- Theme extension: `docs/.vitepress/theme/`
- Navigation: `themeConfig.sidebar`
- Home route: `docs/index.md`; `/quickstart` maps to `docs/quickstart.md`
- Required frontmatter: `title` and `description`
- Native containers: `::: info`, `::: tip`, `::: warning`, `::: danger`
- Use fenced code groups and Vue components only when helpful.
- Build: `npm run docs:build`; output: `docs/.vitepress/dist/`

## Navigation and routes

- Add every reader page exactly once to the appropriate sidebar.
- Use clean root-relative routes in navigation and preserve explicit rewrites.
- Keep base-path configuration in mind for assets and deployment.

## Components and presentation

- Use supported custom containers and fenced code groups.
- Register global Vue components in the theme; import local components
  explicitly.
- Guard browser globals during SSR.
- Keep tokens and component overrides in the theme extension.

## Common failures

- Relative asset URLs can break under a configured base path.
- Browser-only Vue code fails during SSR.
- Sidebar links can target Markdown filenames instead of clean routes.
- Cache and dist directories are generated output.
