import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { resolveCoverageItem } from './coverage-actions.js'
import { readEvidenceMap, writeEvidenceMap } from './evidence.js'
import { loadProject, saveProjectSettings, scaffoldProject } from './project.js'
import { buildSourceIntelligence } from './source-intelligence.js'

const parents: string[] = []
afterEach(async () => Promise.all(parents.splice(0).map((path) => rm(path, { recursive: true, force: true }))))

describe('coverage recovery actions', () => {
  test('links, excludes, and removes individual coverage gaps', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'doxloop-coverage-actions-'))
    parents.push(parent)
    const source = join(parent, 'product')
    await mkdir(source, { recursive: true })
    await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'sample', exports: { '.': './index.js', './internal': './internal.js' } }), 'utf8')
    await writeFile(join(source, 'index.js'), 'module.exports = true\n', 'utf8')
    await writeFile(join(source, 'internal.js'), 'module.exports = false\n', 'utf8')
    const root = await scaffoldProject({ directory: join(parent, 'docs'), sources: [{ name: 'product', path: '../product' }] })
    const project = await loadProject(root)
    await saveProjectSettings(root, { documentation: { ...project.documentation, priorityOutcomes: ['Install the SDK', 'Send the first request'] } })
    await mkdir(join(root, 'guides'), { recursive: true })
    await writeFile(join(root, 'guides/quickstart.md'), '# Quickstart\n\nInstall the SDK.\n')
    await writeEvidenceMap(root, { schemaVersion: 1, pages: { 'guides/quickstart.md': { sources: [], confidence: 'inferred' } } })

    const initial = await buildSourceIntelligence(root)
    const exports = initial.coverage.metrics.find((metric) => metric.id === 'exports')!
    const journeys = initial.coverage.metrics.find((metric) => metric.id === 'reader-journeys')!
    expect(exports.items).toHaveLength(2)
    expect(journeys).toMatchObject({ documented: 0, total: 2 })

    await resolveCoverageItem(root, { id: exports.items[0]!.id, action: 'link', page: 'guides/quickstart.md' })
    await resolveCoverageItem(root, { id: exports.items[1]!.id, action: 'exclude', reason: 'Internal package entry point' })
    await resolveCoverageItem(root, { id: journeys.items[0]!.id, action: 'link', page: 'guides/quickstart.md' })
    await resolveCoverageItem(root, { id: journeys.items[1]!.id, action: 'remove-priority' })

    const recovered = await buildSourceIntelligence(root)
    expect(recovered.coverage.metrics.find((metric) => metric.id === 'exports')).toMatchObject({ documented: 1, total: 1, excluded: 1, percent: 100 })
    expect(recovered.coverage.metrics.find((metric) => metric.id === 'reader-journeys')).toMatchObject({ documented: 1, total: 1, percent: 100 })
    expect((await loadProject(root)).documentation.priorityOutcomes).toEqual(['Install the SDK'])
    expect((await readEvidenceMap(root))?.pages['guides/quickstart.md']?.sources[0]).toMatchObject({ source: 'product', operations: ['.'] })
  })
})
