# Static HTML authoring patterns

There is no Markdown layer: every page is complete, hostable HTML. Reuse the
scaffold's `site/styles.css` classes below so pages stay consistent, and copy
the same header, sidebar navigation, and footer into every page.

## Callouts

```html
<aside class="callout callout-warning" role="note">
  <strong>Back up first</strong>
  <p>Restoring a snapshot replaces every record created after it.</p>
</aside>
```

Classes: `callout` alone for a note, plus `callout-warning` or
`callout-danger`.

## Tabs

Use disclosure elements so the page works without JavaScript; open the
default tab:

```html
<div class="tabs">
  <details open>
    <summary>npm</summary>
    <pre><code class="language-bash">npm install package</code></pre>
  </details>
  <details>
    <summary>pnpm</summary>
    <pre><code class="language-bash">pnpm add package</code></pre>
  </details>
</div>
```

## Code blocks

Escape `<`, `>`, and `&` inside `<code>` and name the language with a
`language-*` class:

```html
<pre><code class="language-yaml">server:
  port: 8080</code></pre>
```

## Images and assets

Keep assets under `site/assets/`, give every image `alt`, `width`, and
`height`, and lazy-load images below the fold:

```html
<img src="/assets/settings-api-keys.png" alt="Settings page with the API keys tab selected" width="1280" height="800" loading="lazy">
```

## Tables

Use `<table>` with a `<caption>`, `<thead>`, and `scope="col"` headers.

## Diagrams

Place the diagram source in a `<pre class="mermaid">` block and load Mermaid
once, at the end of the page, only on pages that contain a diagram:

```html
<pre class="mermaid">
flowchart LR
  Client --> API --> Database
</pre>
<script type="module">
  import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs'
  mermaid.initialize({ startOnLoad: true })
</script>
```

Prefer a committed SVG when the site must work offline or without scripts.

## Page metadata and navigation

Every page needs a unique `<title>`, a `<meta name="description">` with an
outcome-focused sentence, exactly one `<h1>`, and `<main>`. Link every new
page from the home page or from the section page that lists it, using
root-relative directory URLs such as `/guides/install/`.
