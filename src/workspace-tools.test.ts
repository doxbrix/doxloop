import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { scaffoldProject, loadProject } from './project.js'
import { savePageComment, pageComments, searchPageText, auditDocumentation, backfillEvidence } from './workspace-tools.js'
import { readPageMetadata, updateBulkPageMetadata } from './page-metadata.js'
import { undoDirectEdit } from './direct-edit.js'
import { readEvidenceMap } from './evidence.js'
import { createDocumentationCollection, documentationCollections } from './documentation-collections.js'
import { listPages } from './pages.js'
import { readPageContent, savePageContent } from './page-operations.js'
import { contentLinks } from './content-links.js'
import { checkExternalLinks } from './quality-links.js'
import { validateProject } from './validation.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
async function fixture(generator: 'doxbrix' | 'docusaurus' | 'mkdocs' = 'doxbrix') {
  const parent = await mkdtemp(join(tmpdir(), 'doxloop-followthrough-')); roots.push(parent)
  return scaffoldProject({ directory: join(parent, 'docs'), title: 'Test', sources: [], generator })
}
test('comments persist, resolve independently, and reject invalid scope', async () => {
  const root = await fixture()
  const [comment] = await savePageComment(root, { path: 'index.mdx', text: 'Clarify the setup steps.' })
  expect((await pageComments(root))[0]?.text).toBe('Clarify the setup steps.')
  await savePageComment(root, { path: '', text: '', resolveId: comment!.id })
  expect((await pageComments(root))[0]?.resolvedAt).toBeDefined()
  await expect(savePageComment(root, { path: '../outside.md', text: 'No.' })).rejects.toThrow()
})
test('search returns a matching section and exact source line; audit does not edit prose', async () => {
  const root = await fixture()
  const text = '---\ntitle: Guide\ndescription: A practical guide.\n---\n# Guide\n\n## Recovery\nUse the UNIQUE_RECOVERY_FLAG after a timeout.\n'
  await writeFile(join(root, 'index.mdx'), text)
  expect(await searchPageText(root, 'unique_recovery_flag')).toEqual([expect.objectContaining({ path: 'index.mdx', section: 'Recovery', line: 8 })])
  await auditDocumentation(root)
  await backfillEvidence(root)
  expect(await readFile(join(root, 'index.mdx'), 'utf8')).toBe(text)
  expect((await readEvidenceMap(root))?.pages['index.mdx']?.confidence).toBe('needs-human')
})
test('bulk metadata rolls back earlier writes when a later fingerprint conflicts, and successful batches undo together', async () => {
  const root = await fixture()
  const first = await readPageMetadata(root, 'index.mdx')
  const second = await readPageMetadata(root, 'quickstart.mdx')
  const before = await readFile(join(root, first.path), 'utf8')
  await expect(updateBulkPageMetadata(root, [{ ...first, fields: { icon: 'book' } }, { ...second, fingerprint: 'stale', fields: { icon: 'book' } }])).rejects.toThrow('changed')
  expect(await readFile(join(root, first.path), 'utf8')).toBe(before)
  const result = await updateBulkPageMetadata(root, [first, second].map((item) => ({ ...item, fields: { icon: 'book' } })))
  expect((await readPageMetadata(root, second.path)).fields.icon).toBe('book')
  await undoDirectEdit(root, result.editId)
  expect(await readFile(join(root, first.path), 'utf8')).toBe(before)
  expect((await readPageMetadata(root, second.path)).fields.icon).toBe(second.fields.icon)
})
test('Doxbrix collections separate routes, reset verification, and undo the copied tree', async () => {
  const root = await fixture()
  await replaceStarters(root)
  const original = await readPageContent(root, 'index.mdx')
  const created = await createDocumentationCollection(root, { sourceDirectory: '', version: '1.0', locale: 'fr' })
  expect(created.pages).toContain('editions/1.0/fr/index.mdx')
  expect((await listPages(root)).find((page) => page.path === 'editions/1.0/fr/index.mdx')).toMatchObject({ version: '1.0', locale: 'fr', route: '/editions/1.0/fr' })
  expect((await readEvidenceMap(root))?.pages['editions/1.0/fr/index.mdx']?.confidence).toBe('needs-human')
  expect((await readPageContent(root, 'index.mdx')).content).toBe(original.content)
  await undoDirectEdit(root, created.editId)
  expect(await documentationCollections(root, await loadProject(root))).toHaveLength(1)
  await expect(readFile(join(root, 'editions/1.0/fr/index.mdx'))).rejects.toMatchObject({ code: 'ENOENT' })
})
test('native Docusaurus versions are visible and directly editable without changing current docs', async () => {
  const root = await fixture('docusaurus')
  await replaceStarters(root)
  const project = await loadProject(root)
  const current = (await listPages(root))[0]!
  const before = await readFile(join(root, current.path), 'utf8')
  const created = await createDocumentationCollection(root, { sourceDirectory: project.contentDir, version: '1.0', locale: 'default' })
  const copy = await readPageContent(root, created.pages[0]!)
  await savePageContent(root, { ...copy, content: copy.content + '\nAdditional version-specific context.\n' })
  expect(await readFile(join(root, current.path), 'utf8')).toBe(before)
  expect((await listPages(root)).some((page) => page.version === '1.0')).toBe(true)
})
test('literal HTML, RST and Markdown links are checked while fenced examples are ignored', async () => {
  expect(contentLinks('<a href="https://example.com/a?x=1&amp;y=2">Link</a>\n`RST <https://example.com/b>`_\n.. _ref: https://example.com/c\n```html\n<a href="bad.md">example</a>\n```')).toEqual(['https://example.com/a?x=1&y=2', 'https://example.com/b', 'https://example.com/c'])
  const root = await fixture()
  await writeFile(join(root, 'index.mdx'), (await readFile(join(root, 'index.mdx'), 'utf8')) + '\n<a href="missing.html">Missing</a>\n<a href="https://example.com/broken">Remote</a>\n')
  expect((await validateProject(root)).issues.some((issue) => issue.code === 'broken-link' && issue.message.includes('missing.html'))).toBe(true)
  expect(await checkExternalLinks(root, await loadProject(root), { schemaVersion: 1, links: { retries: 0 } }, { fetch: async () => new Response('', { status: 404 }), resolveHostname: async () => ['93.184.216.34'] })).toEqual([expect.objectContaining({ status: 'fail' })])
})

async function replaceStarters(root: string) {
  for (const page of await listPages(root)) await writeFile(join(root, page.path), `---\ntitle: ${page.title}\ndescription: Understand and use the supported workflow.\n---\n# ${page.title}\n\nUse this documentation to complete the supported workflow and check the result.\n`)
}

test('deployment dry run preserves an existing build folder', async () => {
  const root = await fixture()
  await replaceStarters(root)
  await mkdir(join(root, 'build'))
  await writeFile(join(root, 'build/keep.txt'), 'previous build')
  const { deploy } = await import('./deploy.js')
  await deploy({ root, dryRun: true })
  expect(await readFile(join(root, 'build/keep.txt'), 'utf8')).toBe('previous build')
})

test('empty rendered output reports both accessibility failure and skipped visual comparison', async () => {
  const root = await fixture()
  await rm(join(root, 'index.mdx'))
  await rm(join(root, 'quickstart.mdx'))
  const { checkRenderedQuality } = await import('./quality-rendered.js')
  const result = await checkRenderedQuality(root, await loadProject(root), { schemaVersion: 1, rendered: { enabled: true } }, false)
  expect(result.checks).toEqual([expect.objectContaining({ category: 'accessibility', status: 'fail' }), expect.objectContaining({ category: 'visual', status: 'skipped' })])
})
