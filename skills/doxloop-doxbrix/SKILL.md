---
name: doxloop-doxbrix
description: Author and maintain documentation in native Doxbrix format, including the versioned spaces-and-navigation docs.json manifest, application-derived colors, fonts, and logos, MDX page frontmatter, rich components, and interactive API reference pages built with ApiEndpoint, Param, and Response. Use with doxloop-authoring whenever .doxloop/project.json selects the doxbrix generator, when creating or editing Doxbrix pages, API endpoint reference, or themes, or when reviewing Doxbrix presentation, component, and navigation correctness.
---

# Doxloop Doxbrix Format

Produce documentation that renders natively in Doxbrix. Use this skill together
with `$doxloop-authoring`; that skill owns discovery, consultation, coverage, and
writing quality.

## Read before editing

1. Read `.doxloop/project.json` and confirm `generator` is `doxbrix` or absent.
2. Read [references/manifest.md](references/manifest.md).
3. Read [references/components.md](references/components.md) before authoring
   rich layouts.
4. Inspect existing `docs.json` and pages for established theme, terminology,
   paths, and component patterns.

When creating or changing HTTP API reference, also read
[references/api-endpoints.md](references/api-endpoints.md) and follow its
contract exactly.

If the generator is not `doxbrix`, stop and use its installed Doxloop format
skill instead.

## Author native Doxbrix content

- Write `.mdx` when using Doxbrix components.
- Include `title` and an outcome-focused `description` in frontmatter.
- Use standard Markdown for ordinary prose.
- Use a rich component only when it communicates the content more clearly.
- Use `<Steps>` for sequential procedures, `<CodeGroup>` for alternative
  commands, `<Accordion>` for compact FAQs, and `<CardGroup>` for purposeful
  navigation.
- Use the six Doxbrix callout types accurately: `<Info>`, `<Note>`, `<Tip>`,
  `<Check>`, `<Warning>`, and `<Danger>`.
- Use one native `<ApiEndpoint>` block per HTTP operation, with a `<Param>` for
  every verified parameter and a `<Response>` for every documented status.
  Never replace the native endpoint block with Markdown tables or standalone
  request and response code fences.
- Keep component tags balanced and put nested block content on separate lines.
- Use root-relative page links that match manifest page files.

Do not emit Docusaurus directives such as `:::tip`, Docusaurus theme imports, or
`sidebars.js` entries in a Doxbrix project.

## Maintain navigation

Implement the semantic top/left navigation plan composed by
`$doxloop-authoring`. Map major reader surfaces to Doxbrix spaces or supported
site links and map left-navigation groups to nested `docs.json` nodes. Preserve
the planned labels, order, hierarchy, and routes unless Doxbrix requires a
documented adaptation; do not copy empty template groups.

Treat `docs/docs.json` as the canonical manifest for new Doxloop projects.
Legacy projects may keep `docs.json` at the project root. Add every
reader-facing page exactly once under a relevant space and navigation group.
Assign meaningful named icons to spaces and primary group, page, link, and API
nodes. Choose icons by reader meaning, keep the vocabulary consistent, and
preserve visible text labels; icons supplement labels rather than replace them.
Preserve supported link, label, divider, and API nodes.

## Apply captured branding

Use the identity and any confirmed external design profile gathered through
`$doxloop-authoring` and [references/manifest.md](references/manifest.md):

- write colors, mode, fonts, logos, favicon, and backgrounds under `theme`;
- copy public logos and licensed local font files into the documentation content
  directory and use root-relative paths;
- provide separate light and dark assets when the application does;
- preserve readable contrast and use fallbacks for fonts that cannot be copied.

Do not invent missing brand values or reference files outside the documentation
project.

## Verify

Run `doxloop test` and `doxloop preview --open`. Confirm rich blocks, navigation,
page title, description, code highlighting, and responsive layout render in the
Doxbrix preview.
