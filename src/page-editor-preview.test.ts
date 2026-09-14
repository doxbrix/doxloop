import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { renderEditableMarkdown, renderMarkdown } from './doxbrix-markdown.js'
import { pageEditorPreview } from './page-editor-preview.js'
import { scaffoldProject } from './project.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

test('editable spans retain exact source boundaries across components and fences', () => {
  const source = '# Title\n\n## Before you begin\n\nA plain paragraph\nwith a second line.\n\n<Note>\nA unique callout.\n</Note>\n\n```sh\nnode --version\n```\n\nKeep **this formatting** intact.\n'
  const result = renderEditableMarkdown(source)
  expect(result.blocks.map(block => block.text)).toEqual(expect.arrayContaining(['Before you begin', 'A plain paragraph\nwith a second line.', 'A unique callout.', 'node --version']))
  for (const block of result.blocks) expect(source.slice(block.start, block.end)).toBe(block.text)
  expect(result.blocks.some(block => block.text.includes('**'))).toBe(true)
  expect(renderMarkdown(source).html).not.toContain('data-edit-start')
})

test('repeated regions and CRLF keep their own exact offsets', () => {
  for (const source of ['Repeated text.\n\nRepeated text.', 'First line.\r\nwith wrapping.\r\n\r\nNext paragraph.\r\n']) {
    const { blocks } = renderEditableMarkdown(source)
    expect(blocks).toHaveLength(2)
    expect(blocks[0]!.end).toBeLessThan(blocks[1]!.start)
    for (const block of blocks) {
      expect(source.slice(block.start, block.end)).toBe(block.text)
      expect(block.text.endsWith('\r')).toBe(false)
    }
  }
})

test('formatted lists, task text, and table cells are editable without owning their structural syntax', () => {
  const source = '## Features\n\n- **Source-grounded research.** Use [evidence](/evidence "Details") and `code`.\n- **Plan first.** Keep _emphasis_.\n\n1. Ordered **item**.\n\n- [x] Finished **task**.\n\n| Name | Description |\n| --- | --- |\n| API | A **rich** cell. |\n'
  const result = renderEditableMarkdown(source)
  expect(result.blocks.map(block => block.text)).toEqual(['Features', '**Source-grounded research.** Use [evidence](/evidence "Details") and `code`.', '**Plan first.** Keep _emphasis_.', 'Ordered **item**.', 'Finished **task**.', 'Name', 'Description', 'API', 'A **rich** cell.'])
  expect(result.html).toContain('data-md-suffix="](/evidence &quot;Details&quot;)"')
  for (const block of result.blocks) expect(source.slice(block.start, block.end)).toBe(block.text)
})

test('short code and task text do not capture matching syntax', () => {
  const source = '```sh\nsh\n```\n\n- [x] x\n- [ ] x\n'
  const { blocks } = renderEditableMarkdown(source)
  expect(blocks).toEqual([
    { start: 6, end: 8, text: 'sh' },
    { start: source.indexOf('x\n'), end: source.indexOf('x\n') + 1, text: 'x' },
    { start: source.lastIndexOf('x'), end: source.lastIndexOf('x') + 1, text: 'x' },
  ])
})

test('editor preview uses native styling, source offsets after frontmatter, and an isolated bridge', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'doxloop-editor-preview-')); roots.push(directory)
  const root = await scaffoldProject({ directory: join(directory, 'docs'), title: 'Editor', generator: 'doxbrix', sources: [] })
  const content = '---\ntitle: Draft guide\ndescription: A draft description.\n---\n\n## Setup\n\nAn editable paragraph.\n'
  const result = await pageEditorPreview(root, 'index.mdx', content, 'http://127.0.0.1:4321/guide')
  expect(result.html).toContain('dp-root--embedded')
  expect(result.html).toContain('Draft guide')
  expect(result.blocks.map(block => block.text)).toEqual(expect.arrayContaining(['Draft guide', 'A draft description.']))
  expect(result.html).toContain('data-edit-format="yaml"')
  expect(result.html).toContain('plaintext-only')
  expect(result.html).not.toContain('new EventSource(')
  for (const block of result.blocks) expect(content.slice(block.start, block.end)).toBe(block.text)
  await expect(pageEditorPreview(root, '../outside.mdx', content, 'http://127.0.0.1:4321/')).rejects.toThrow()
  await expect(pageEditorPreview(root, 'index.mdx', content, 'https://example.com/')).rejects.toThrow('local preview')
})
