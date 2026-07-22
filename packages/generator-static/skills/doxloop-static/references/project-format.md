# Static HTML project format

- Deployable root: `site/`
- Home page: `site/index.html`
- Clean route: `site/<route>/index.html`
- Shared assets: place under `site/` and reference with root-relative URLs.
- Every page needs a unique `<title>`, meta description, one `<h1>`, and semantic landmarks.
- Keep the primary navigation consistent across pages.
- Use valid, accessible HTML; do not depend on a build-time transformation.
- Verification command: `npm run build`; deploy `site/` unchanged.

## Navigation and routes

- Add every reader page to the primary navigation exactly once.
- Use directory indexes for clean, portable routes.
- Keep canonical links, breadcrumb relationships, and previous/next links
  consistent when present.

## HTML and presentation

- Use `header`, `nav`, `main`, `aside`, and `footer` landmarks appropriately.
- Keep shared design tokens in CSS custom properties.
- Use module scripts with `defer` semantics and progressive enhancement.
- Apply a strict Content Security Policy when hosting requirements are known.

## Common failures

- Root-relative links require hosting at the documented base path.
- Repeated hand-authored navigation can drift between pages.
- Missing dimensions cause layout shifts; missing focus styles block keyboard
  readers.
- The `site/` directory is source and deployable output, so verification must
  never overwrite it with a generated copy.
