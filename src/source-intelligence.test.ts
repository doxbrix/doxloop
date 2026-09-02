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
