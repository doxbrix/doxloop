import { describe, expect, test } from 'vitest'
import { flattenMarkdown } from './markdown-flatten.js'

describe('flattenMarkdown', () => {
  test('strips frontmatter, MDX module lines, and comments but keeps code fences verbatim', () => {
    const output = flattenMarkdown([
      '---',
      'title: Install',
      '---',
      "import { Chart } from '../components/chart'",
      'export const meta = {',
      "  owner: 'docs',",
      '}',
      '',
      '{/* internal note */}',
      '<!-- hidden -->',
      'Install the CLI.',
      '',
      '```mdx',
      "import { Keep } from 'this'",
      '<Note>inside a fence</Note>',
      '```',
    ].join('\n'))
    expect(output).toBe([
      'Install the CLI.',
      '',
      '```mdx',
      "import { Keep } from 'this'",
      '<Note>inside a fence</Note>',
      '```',
      '',
    ].join('\n'))
  })

  test('turns callouts into labelled blockquotes', () => {
    expect(flattenMarkdown('<Warning>Back up the database first.</Warning>')).toBe('> **Warning:** Back up the database first.\n')
    expect(flattenMarkdown('<Tip title="Faster setup">\n- Use the template\n- Skip samples\n</Tip>')).toBe('> **Tip: Faster setup**\n>\n> - Use the template\n> - Skip samples\n')
    expect(flattenMarkdown('<Info>\n```bash\nnpm test\n```\n</Info>')).toContain('> **Info**\n>\n> ```bash\n> npm test\n> ```')
  })

  test('numbers steps with bold titles and indented bodies', () => {
    const output = flattenMarkdown('<Steps>\n  <Step title="Install">\n    Run the installer.\n  </Step>\n  <Step title="Verify">\n    ```bash\n    app --version\n    ```\n  </Step>\n</Steps>')
    expect(output).toBe('1. **Install**\n\n   Run the installer.\n\n2. **Verify**\n\n   ```bash\n   app --version\n   ```\n')
  })

  test('gives each tab a heading and accordions a bold title', () => {
    expect(flattenMarkdown('<Tabs>\n<Tab title="macOS">\nUse Homebrew.\n</Tab>\n<Tab title="Linux">\nUse apt.\n</Tab>\n</Tabs>'))
      .toBe('### macOS\n\nUse Homebrew.\n\n### Linux\n\nUse apt.\n')
    expect(flattenMarkdown('<AccordionGroup>\n<Accordion title="Why?">\nBecause.\n</Accordion>\n</AccordionGroup>')).toBe('**Why?**\n\nBecause.\n')
    expect(flattenMarkdown('<Expandable title="Fields">\nMore detail.\n</Expandable>')).toBe('**Fields**\n\nMore detail.\n')
  })

  test('renders cards as bullet links and keeps code group titles', () => {
    expect(flattenMarkdown('<CardGroup cols={2}>\n<Card title="Quickstart" href="/quickstart">\nFirst request.\n</Card>\n<Card title="API" description="Every endpoint." />\n</CardGroup>'))
      .toBe('- [Quickstart](/quickstart): First request.\n- **API**: Every endpoint.\n')
    expect(flattenMarkdown('<CodeGroup>\n```bash npm\nnpm i app\n```\n```bash pnpm\npnpm add app\n```\n</CodeGroup>'))
      .toBe('**npm**\n\n```bash\nnpm i app\n```\n\n**pnpm**\n\n```bash\npnpm add app\n```\n')
  })

  test('maps frames, images, mermaid, and inline badges to plain Markdown', () => {
    expect(flattenMarkdown('<Frame caption="The dashboard">\n![Dashboard](/img/dash.png)\n</Frame>')).toBe('![Dashboard](/img/dash.png)\n\n*The dashboard*\n')
    expect(flattenMarkdown('<Image src="/a.png" alt="A chart" />')).toBe('![A chart](/a.png)\n')
    expect(flattenMarkdown('<Mermaid>\ngraph TD\n  A-->B\n</Mermaid>')).toBe('```mermaid\ngraph TD\n  A-->B\n```\n')
    expect(flattenMarkdown('Status: <Badge color="green">Stable</Badge> <Icon name="rocket" /> ready')).toBe('Status: Stable  ready\n')
  })

  test('describes an API endpoint with a parameter table and response examples', () => {
    const output = flattenMarkdown([
      '<ApiEndpoint method="post" path="/v1/keys" summary="Create a key" description="Creates an API key.">',
      '<Param name="Authorization" in="header" type="string" required>Bearer token.</Param>',
      '<Param name="name" in="body" type="string">Display name.</Param>',
      '<Response status="201" description="Created">',
      '{ "id": "key_1" }',
      '</Response>',
      '</ApiEndpoint>',
    ].join('\n'))
    expect(output).toContain('### POST /v1/keys')
    expect(output).toContain('**Create a key**')
    expect(output).toContain('Creates an API key.')
    expect(output).toContain('| Name | In | Type | Required | Description |')
    expect(output).toContain('| `Authorization` | header | string | yes | Bearer token. |')
    expect(output).toContain('| `name` | body | string | no | Display name. |')
    expect(output).toContain('- `201` Created\n\n```json\n{ "id": "key_1" }\n```')
  })

  test('reads Mintlify ParamField locations and multi-line opening tags', () => {
    const output = flattenMarkdown('<ParameterTable title="Query">\n<ParamField\n  query="limit"\n  type="integer">\nPage size.\n</ParamField>\n</ParameterTable>')
    expect(output).toContain('**Query**')
    expect(output).toContain('| `limit` | query | integer | no | Page size. |')
    expect(flattenMarkdown('<ResponseExample>\n```json\n{"ok": true}\n```\n</ResponseExample>')).toBe('```json\n{"ok": true}\n```\n')
  })

  test('keeps the inner content of unknown components and plain Markdown as it was', () => {
    expect(flattenMarkdown('<Columns cols={2}>\n<Custom>Plain words.</Custom>\n</Columns>')).toBe('Plain words.\n')
    const plain = '# Title\n\nA paragraph with **bold** and a [link](/x).\n\n| a | b |\n| - | - |\n| 1 | 2 |\n'
    expect(flattenMarkdown(plain)).toBe(plain)
  })
})
