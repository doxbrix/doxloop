import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { writeEvidenceMap } from './evidence.js'
import { scaffoldProject } from './project.js'
import { buildSourceIntelligence, formatSourceIntelligence } from './source-intelligence.js'

const parents: string[] = []
afterEach(async () => Promise.all(parents.splice(0).map((path) => rm(path, { recursive: true, force: true }))))

describe('source intelligence', () => {
  test('reports coverage denominators, source groups, and precision suggestions', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'doxloop-coverage-'))
    parents.push(parent)
    const source = join(parent, 'product')
    await mkdir(join(source, 'src'), { recursive: true })
    await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'sample', scripts: { build: 'tsc' }, exports: { '.': './src/index.ts' } }), 'utf8')
    await writeFile(join(source, 'src', 'index.ts'), 'export const createWidget = () => true\n', 'utf8')
    const root = await scaffoldProject({ directory: join(parent, 'docs'), sources: [{ name: 'product', path: '../product', scope: { routePrefix: 'product' } }] })
    await writeEvidenceMap(root, { schemaVersion: 1, pages: { 'product/getting-started.md': { sources: [{ source: 'product' }], confidence: 'inferred' } } })
    const report = await buildSourceIntelligence(root)
    expect(report.coverage.metrics.map((item) => item.id)).toEqual(['commands', 'exports', 'http-operations', 'configuration', 'security', 'errors', 'events-integrations', 'reader-journeys', 'verified-pages'])
    expect(report.coverage.metrics.every((item) => item.denominator.length > 10)).toBe(true)
    expect(report.coverage.metrics.find((item) => item.id === 'http-operations')).toMatchObject({ status: 'unknown', percent: 0 })
    expect(report.coverage.groups[0]).toMatchObject({ source: 'product', scope: { routePrefix: 'product' } })
    expect(report.evidenceDiagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'source-only', page: 'product/getting-started.md' })]))
    expect(formatSourceIntelligence(report)).toContain('Coverage')
    expect(formatSourceIntelligence(report)).toContain('none detected')
    expect(report.coverage.disclaimer).toContain('does not prove')
  })
})

test('unmapped and deleted pages cannot inflate verified coverage', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'doxloop-coverage-pages-')); parents.push(parent)
  const root = await scaffoldProject({ directory: join(parent, 'docs'), sources: [], generator: 'doxbrix' })
  await writeEvidenceMap(root, { schemaVersion: 1, pages: { 'missing.md': { confidence: 'verified', sources: [], verifiedAt: { product: 'abc' } } } })
  const report = await buildSourceIntelligence(root)
  const verified = report.coverage.metrics.find((item) => item.id === 'verified-pages')!
  expect(verified.percent).toBe(0)
  expect(verified.items.map((item) => item.page)).not.toContain('missing.md')
  expect(verified.items.map((item) => item.page)).toContain('index.mdx')
  expect(verified.items.every((item) => item.state !== 'documented')).toBe(true)
})

test('a planned capability contributes no delivered coverage', async () => {
  const { vi } = await import('vitest')
  const plans = await import('./documentation-plan.js')
  const parent = await mkdtemp(join(tmpdir(), 'doxloop-planned-coverage-')); parents.push(parent)
  await mkdir(join(parent, 'product'))
  await writeFile(join(parent, 'product/package.json'), JSON.stringify({ name: 'example', scripts: { build: 'tsc' } }))
  const root = await scaffoldProject({ directory: join(parent, 'docs'), sources: [{ name: 'product', path: '../product' }] })
  const before = await buildSourceIntelligence(root)
  const command = before.coverage.metrics.find((metric) => metric.id === 'commands')!.items[0]!
  const spy = vi.spyOn(plans, 'listDocumentationPlans').mockResolvedValue([{ status: 'approved', outcomes: [], pages: [], capabilities: [{ id: 'build', title: command.label, disposition: 'planned', pageIds: ['future-page'], evidence: [{ source: command.source, path: 'package.json', label: command.label }] }] }] as never)
  try {
    const report = await buildSourceIntelligence(root)
    const commands = report.coverage.metrics.find((metric) => metric.id === 'commands')!
    expect(commands.percent).toBe(0)
    expect(commands.items.find((item) => item.id === command.id)?.state).toBe('planned')
  } finally { spy.mockRestore() }
})
