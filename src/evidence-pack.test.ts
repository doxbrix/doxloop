import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { citationsFor, writeEvidencePack } from './evidence-pack.js'
import type { DocumentationPlan, DocumentationPlanPage, SourceBinding } from './types.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function page(id: string, evidenceDetails: DocumentationPlanPage['evidenceDetails']): DocumentationPlanPage {
  return { id, title: `Title ${id}`, path: id, type: 'guide', priority: 'now', action: 'create', purpose: '', rationale: '', evidence: [], evidenceDetails } as unknown as DocumentationPlanPage
}

describe('evidence packs', () => {
  test('writes cited excerpts around the cited line and whole docs-site pages that fold into a page', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doxloop-evidence-pack-'))
    roots.push(root)
    const source = join(root, 'product')
    const site = join(root, 'site')
    await mkdir(join(source, 'src'), { recursive: true })
    await mkdir(join(site, 'pages'), { recursive: true })
    await writeFile(join(source, 'src', 'limits.ts'), Array.from({ length: 300 }, (_, index) => `line ${index + 1}${index === 199 ? ' // the limit is 10' : ''}`).join('\n'))
    await writeFile(join(source, 'src', 'big.bin'), Buffer.from([0, 1, 2, 3]))
    await writeFile(join(site, 'pages', 'old-limits.md'), '# Old limits\n\nThe limit used to be 5.\n')
    const sources: SourceBinding[] = [
      { name: 'product', path: source },
      { name: 'docs', path: site, kind: 'docs-site' } as SourceBinding,
    ]
    const plan = {
      existingDocumentation: [{ source: 'docs', summary: '', strengths: [], findings: [], coverage: { gaps: [], obsolete: [], preserved: [], contradicted: [] }, pages: [{ path: 'pages/old-limits.md', title: 'Old limits', disposition: 'rewrite', into: ['limits'], reason: '' }] }],
    } as unknown as DocumentationPlan
    const pages = [
      page('limits', [{ source: 'product', path: 'src/limits.ts', line: 200, label: 'limit constant' }, { source: 'product', path: 'src/big.bin' }, { source: 'missing', path: 'x' }]),
      page('empty', []),
    ]
    const result = await writeEvidencePack(root, { sources }, plan, pages, { batchIndex: 3 })
    expect(result.file).toBe('.doxloop/cache/evidence-pack-batch-3.md')
    expect(result.pages).toBe(1)
    expect(result.excerpts).toBe(2)
    expect(result.missing).toEqual(['product:src/big.bin', 'missing:x'])
    const text = await readFile(join(root, result.file!), 'utf8')
    expect(text).toContain('# Evidence pack — batch 3')
    expect(text).toContain('## limits — Title limits')
    expect(text).toContain('### product: src/limits.ts (lines 180–279) — limit constant')
    expect(text).toContain('line 200 // the limit is 10')
    expect(text).not.toContain('line 100\n')
    expect(text).toContain('### docs: pages/old-limits.md — existing page "Old limits" (rewrite)')
    expect(text).toContain('The limit used to be 5.')
    expect(text).toContain('~~~~ts')
  })

  test('caps excerpts and reports nothing to pack when no citation resolves', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doxloop-evidence-pack-'))
    roots.push(root)
    const source = join(root, 'product')
    await mkdir(source, { recursive: true })
    await writeFile(join(source, 'README.md'), 'x'.repeat(50_000))
    const packed = await writeEvidencePack(root, { sources: [{ name: 'product', path: source }] }, {} as DocumentationPlan, [page('a', [{ source: 'product', path: 'README.md' }])], { limits: { excerptBytes: 2_000 } })
    expect(packed.excerpts).toBe(1)
    expect(packed.bytes).toBeLessThan(3_000)
    expect(await readFile(join(root, packed.file!), 'utf8')).toContain('Excerpt truncated')
    const none = await writeEvidencePack(root, { sources: [] }, {} as DocumentationPlan, [page('a', [{ source: 'gone', path: 'y' }])])
    expect(none.file).toBeUndefined()
    expect(none.missing).toEqual(['gone:y'])
    expect(citationsFor(page('a', []), {} as DocumentationPlan, new Map())).toEqual([])
  })
})

test('resolves a translation key and a source symbol beyond the first 140 lines', async () => {
  const root = await mkdtemp(join(tmpdir(), 'doxloop-evidence-anchor-')); roots.push(root)
  const labels = { unrelated: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`key${i}`, 'noise'])), keyboardShortcuts: { title: 'Keyboard shortcuts' } }
  await writeFile(join(root, 'en.json'), JSON.stringify(labels, null, 2))
  await writeFile(join(root, 'api.ts'), [...Array(200).fill('// unrelated'), 'export function startTask() { return true }'].join('\n'))
  const packed = await writeEvidencePack(root, { sources: [{ name: 'app', path: root }] }, {} as DocumentationPlan, [page('keys', [{ source: 'app', path: 'en.json', label: 'keyboardShortcuts.title' }, { source: 'app', path: 'api.ts', label: 'startTask' }])])
  const text = await readFile(join(root, packed.file!), 'utf8')
  expect(text).toContain('"keyboardShortcuts.title": "Keyboard shortcuts"')
  expect(text).not.toContain('key199')
  expect(text).toContain('export function startTask')
})

test('reuses planning findings and resolves displayed labels from the discovery catalog', async () => {
  const root = await mkdtemp(join(tmpdir(), 'doxloop-evidence-reuse-')); roots.push(root)
  await mkdir(join(root, '.doxloop/plans/plan-test/research'), { recursive: true })
  await mkdir(join(root, '.doxloop/cache/discovery'), { recursive: true })
  await writeFile(join(root, 'view.vue'), `<button>{{ t('tasks.create') }}</button>`)
  await writeFile(join(root, 'en.json'), JSON.stringify({ tasks: { create: 'Create task' } }))
  await writeFile(join(root, '.doxloop/cache/discovery/key.json'), JSON.stringify({ sources: [{ name: 'app', uiLabelCatalogs: ['en.json'] }] }))
  await writeFile(join(root, '.doxloop/plans/plan-test/research/product.json'), JSON.stringify({ content: { capabilities: [{ id: 'tasks', summary: 'Tasks belong to a project.', evidence: [{ source: 'app', path: 'view.vue' }] }] } }))
  const result = await writeEvidencePack(root, { sources: [{ name: 'app', path: root }] }, {} as DocumentationPlan, [page('tasks', [])], { researchRoot: root, planId: 'plan-test', discoveryCacheKey: 'key' })
  const text = await readFile(join(root, result.file!), 'utf8')
  expect(text).toContain('Tasks belong to a project.')
  expect(text).toContain('"tasks.create":"Create task"')
})

test('anchors a quoted label fragment and picks catalog entries about the page instead of the file head', async () => {
  const root = await mkdtemp(join(tmpdir(), 'doxloop-evidence-catalog-')); roots.push(root)
  const labels = { home: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`welcome${i}`, `Good night ${i}`])), task: { repeat: { everyDay: 'Every Day', everyWeek: 'Every Week', mode: 'Repeat mode' }, reminder: { title: 'Reminders' } } }
  await writeFile(join(root, 'en.json'), JSON.stringify(labels, null, 2))
  await writeFile(join(root, 'Repeat.vue'), [...Array(180).fill('<!-- filler -->'), '<select v-model="repeatMode">', '  <option>{{ $t("task.repeat.everyDay") }}</option>'].join('\n'))
  const recurring = { ...page('recurring-tasks-and-reminders', [{ source: 'app', path: 'en.json', label: '"everyDay": "Every Day"' }, { source: 'app', path: 'Repeat.vue', label: 'repeat mode select' }]), title: 'Recurring tasks and reminders', purpose: 'Configure repeat intervals and reminders' }
  const packed = await writeEvidencePack(root, { sources: [{ name: 'app', path: root }] }, {} as DocumentationPlan, [recurring])
  const text = await readFile(join(root, packed.file!), 'utf8')
  expect(text).toContain('"task.repeat.everyDay": "Every Day"')
  expect(text).toContain('"task.reminder.title": "Reminders"')
  expect(text).not.toContain('welcome199')
  expect(text).toContain('<select v-model="repeatMode">')
})

test('links a page to research findings through the plan capabilities that name it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'doxloop-evidence-capabilities-')); roots.push(root)
  await mkdir(join(root, '.doxloop/plans/plan-test/research'), { recursive: true })
  await writeFile(join(root, 'labels.go'), 'func CreateLabel() {}')
  await writeFile(join(root, '.doxloop/plans/plan-test/research/product.json'), JSON.stringify({ content: { capabilities: [
    { id: 'label-management', title: 'Create and manage labels', summary: 'Labels are created from the Labels page and attached to tasks.', notes: 'A label belongs to its creator.', evidence: [{ source: 'app', path: 'labels.go', label: 'CreateLabel' }] },
    { id: 'unrelated', title: 'Webhooks', summary: 'Nope.' },
  ] } }))
  const documentationPlan = { capabilities: [{ id: 'labels-cap', title: 'Labels', kind: 'workflow', evidence: [], pageIds: ['labels'], disposition: 'planned' }] } as unknown as DocumentationPlan
  const labels = { ...page('labels', []), title: 'Labels', purpose: 'Create and manage labels' }
  const packed = await writeEvidencePack(root, { sources: [{ name: 'app', path: root }] }, documentationPlan, [labels], { researchRoot: root, planId: 'plan-test' })
  const text = await readFile(join(root, packed.file!), 'utf8')
  expect(text).toContain('Labels are created from the Labels page')
  expect(text).toContain('func CreateLabel')
  expect(text).not.toContain('Nope.')

})

test('packs the cited operation of an API contract with the schemas it references', async () => {
  const root = await mkdtemp(join(tmpdir(), 'doxloop-evidence-pack-'))
  roots.push(root)
  await mkdir(join(root, 'product', 'specs'), { recursive: true })
  const spec = ['openapi: 3.1.0', 'info: { title: Conduit, version: 1.0.0 }', 'components:', '  schemas:', '    User: { type: object, properties: { email: { type: string } } }', 'paths:', '  /users/login:', '    post:', '      summary: Existing user login', '      requestBody: { content: { application/json: { schema: { $ref: "#/components/schemas/User" } } } }', '      responses: { "200": { description: OK } }', '  /tags:', '    get:', '      summary: Get tags', '      responses: { "200": { description: OK } }', ''].join('\n')
  await writeFile(join(root, 'product', 'specs', 'openapi.yml'), spec)
  await writeFile(join(root, 'api.yaml'), spec)
  const sources: SourceBinding[] = [
    { name: 'product', path: join(root, 'product') },
    { name: 'api', path: join(root, 'api.yaml'), kind: 'openapi' } as SourceBinding,
  ]
  const pages = [
    page('login', [{ source: 'product', path: 'specs/openapi.yml', kind: 'operation', label: 'POST /users/login' }]),
    page('overview', [{ source: 'api', path: 'api.yaml' }]),
  ]
  const result = await writeEvidencePack(root, { sources }, {} as DocumentationPlan, pages)
  expect(result.missing).toEqual([])
  const text = await readFile(join(root, result.file!), 'utf8')
  expect(text).toContain('POST /users/login')
  expect(text).toContain('#/components/schemas/User')
  expect(text).toContain('Referenced components')
  expect(text).toContain('GET /tags: Get tags')
})
