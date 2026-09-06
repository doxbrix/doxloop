import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, test } from 'vitest'
import { scaffoldProject } from './project.js'
import { changePageLifecycle, previewPageContent, readPageContent, readRedirects, savePageContent } from './page-operations.js'
import { undoDirectEdit } from './direct-edit.js'
import { readEvidenceMap, writeEvidenceMap } from './evidence.js'
import { listPages } from './pages.js'
import { uploadAsset } from './assets.js'
import { readPageMetadata, updatePageMetadata } from './page-metadata.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
async function fixture(generator: 'doxbrix' | 'docusaurus' | 'mkdocs' = 'doxbrix') {
  const parent = await mkdtemp(join(tmpdir(), 'doxloop-page-operations-'))
  roots.push(parent)
  return scaffoldProject({ directory: join(parent, 'docs'), title: 'Pages', sources: [], generator })
}
const prose = '---\ntitle: Guide\ndescription: A complete guide to the workflow.\n---\n\n# Guide\n\nUse this guide to understand the documented workflow.\n'

test('direct edits protect newer text, invalidate changed claims, and support durable undo', async () => {
  const root = await fixture()
  await writeEvidenceMap(root, { schemaVersion: 1, pages: { 'index.mdx': { sources: [], confidence: 'verified', verifiedAt: { product: 'abc' } } } })
  const before = await readPageContent(root, 'index.mdx')
  await expect(savePageContent(root, { ...before, fingerprint: 'stale', content: prose })).rejects.toThrow('draft is kept')
  expect((await readPageContent(root, 'index.mdx')).content).toBe(before.content)
  const result = await savePageContent(root, { ...before, content: prose })
  expect((await readEvidenceMap(root))?.pages['index.mdx']).toEqual({ sources: [], confidence: 'needs-human' })
  await undoDirectEdit(root, result.editId)
  expect((await readPageContent(root, 'index.mdx')).content).toBe(before.content)
})

test('create, move with links and redirect, and undo restore the complete page graph', async () => {
  const root = await fixture()
  await changePageLifecycle(root, { action: 'create', path: 'guide.md', content: prose })
  const home = await readPageContent(root, 'index.mdx')
  await savePageContent(root, { ...home, content: `${home.content}\n[Guide](guide.md#steps)\n` })
  const before = await readPageContent(root, 'guide.md')
  const moved = await changePageLifecycle(root, { action: 'rename', ...before, to: 'guides/start.md' })
  await expect(readFile(join(root, 'guide.md'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(join(root, 'index.mdx'), 'utf8')).toContain('(guides/start.md#steps)')
  expect(await readRedirects(root)).toEqual({ '/guide': '/guides/start' })
  expect((await readEvidenceMap(root))?.pages['guides/start.md']).toBeDefined()
  await undoDirectEdit(root, moved.editId)
  expect((await readPageContent(root, 'guide.md')).content).toBe(prose)
  expect(await readRedirects(root)).toEqual({})
  expect(await readFile(join(root, 'index.mdx'), 'utf8')).toContain('(guide.md#steps)')
  await expect(changePageLifecycle(root, { action: 'delete', ...before })).rejects.toThrow('Choose a replacement')
  await expect(changePageLifecycle(root, { action: 'create', path: '../outside.md', content: prose })).rejects.toThrow()
})

test('Docusaurus custom slugs, base paths and uploaded social images are resolved natively', async () => {
  const root = await fixture('docusaurus')
  const configPath = join(root, 'docusaurus.config.js')
  await writeFile(configPath, (await readFile(configPath, 'utf8')).replace("baseUrl: '/'", "baseUrl: '/manual/'"))
  await writeFile(join(root, 'docs/quickstart.md'), prose.replace('title: Guide', 'title: Guide\nslug: /start-here'))
  expect((await listPages(root)).find((page) => page.path === 'docs/quickstart.md')?.route).toBe('/manual/start-here')
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]).toString('base64')
  await uploadAsset(root, { name: 'social.png', data: png })
  const meta = await readPageMetadata(root, 'docs/quickstart.md')
  await updatePageMetadata(root, { path: meta.path, fingerprint: meta.fingerprint, fields: { socialImage: '/img/social.png' } })
  const before = await readPageContent(root, 'docs/quickstart.md')
  await changePageLifecycle(root, { action: 'rename', ...before, to: 'docs/guides/start.md' })
  expect((await listPages(root)).find((page) => page.path === 'docs/guides/start.md')?.route).toBe('/manual/start-here')
})

test('draft preview renders Markdown rather than serializing its render result', () => {
  expect(previewPageContent("# Draft\n\nPreview this sentence.").html).toMatch(/<p[^>]*>Preview this sentence[.]<\/p>/)
  expect(previewPageContent("# Draft").html).not.toContain("[object Object]")
})
