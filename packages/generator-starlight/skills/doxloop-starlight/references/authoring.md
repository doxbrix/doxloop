# Starlight authoring syntax

Use standard Markdown in `.md` pages. Use `.mdx` only when a page needs a
component, and import each component from `@astrojs/starlight/components`.

## Asides

Native aside syntax works in `.md` and `.mdx`. Types are `note`, `tip`,
`caution`, and `danger`; the bracket sets a custom title:

```markdown
:::caution[Back up first]
Restoring a snapshot replaces every record created after it.
:::
```

## Tabs

```mdx
import { Tabs, TabItem } from '@astrojs/starlight/components'

<Tabs syncKey="package-manager">
  <TabItem label="npm">
    ```bash
    npm install package
    ```
  </TabItem>
  <TabItem label="pnpm">
    ```bash
    pnpm add package
    ```
  </TabItem>
</Tabs>
```

`syncKey` keeps the same tab selected across pages.

## Steps and cards

```mdx
import { Steps, Card, CardGrid, LinkCard } from '@astrojs/starlight/components'

<Steps>
1. Install the CLI.
2. Sign in.
3. Run the first sync.
</Steps>

<CardGrid>
  <LinkCard title="Quickstart" href="/quickstart/" description="Reach a first result in ten minutes." />
</CardGrid>
```

## Code blocks

Expressive Code handles fences. Name the language and add a `title` when the
reader edits a file; mark changed lines with `ins={3}` or `del={2}`:

````markdown
```yaml title="config.yaml" {3}
server:
  port: 8080
```
````

## Images and assets

Put images under `src/assets/` and import them in MDX for optimisation, or
under `public/` for root-relative references:

```markdown
![Settings page with the API keys tab selected](/images/settings-api-keys.png)
```

## Diagrams

Starlight does not render Mermaid by default. If `astro.config.mjs` configures
`rehype-mermaid` or the `astro-mermaid` integration, use a `mermaid` fence;
otherwise commit an SVG under `src/assets/` and embed it as an image.

## Front matter and navigation

Every page needs `title` and an outcome-focused `description`. A page is
listed in the sidebar when `astro.config.mjs` names its `slug`, when its
directory is covered by an `autogenerate` group, or when the site defines no
`sidebar` at all. Use `sidebar: { hidden: true }` in front matter for pages
that should stay reachable but unlisted.
