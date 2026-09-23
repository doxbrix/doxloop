import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { attributeReadsToSources, createLock, mergeBatchArtifacts, normalizeCaptureManifest, normalizeCaptureSteps, pathsInToolCall, reconcileEvidenceSlice, runPool, writeBatchArtifacts } from './batch-artifacts.js'
import { PNG } from 'pngjs'
import { readEvidenceMap, writeEvidenceMap } from './evidence.js'
import { SCREENSHOT_MANIFEST_FILE } from './screenshot-workflow.js'
import type { DocumentationPlan } from './types.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const plan = { id: 'plan', pages: [] } as unknown as DocumentationPlan
const pageOf = (id: string) => ({ id, path: id, title: id }) as DocumentationPlan['pages'][number]

describe('batch artifacts', () => {
  test('slices the manifest and evidence for a batch and merges the filled slices back', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doxloop-batch-artifacts-'))
    roots.push(root)
    await mkdir(join(root, '.doxloop'), { recursive: true })
    const step = { id: '01', action: 'Open the application at /a.', expectedState: 'The a screen is visible.', purpose: 'Orient the reader.', capture: true, status: 'planned', sequenceItem: 1 }
    await writeFile(join(root, SCREENSHOT_MANIFEST_FILE), JSON.stringify({ schemaVersion: 1, guides: [{ page: 'a', steps: [step] }, { page: 'b', steps: [step] }] }))
    await writeEvidenceMap(root, { schemaVersion: 1, pages: { 'a.mdx': { sources: [{ source: 's', paths: ['x'] }] }, 'z.mdx': { sources: [{ source: 's' }] } } })

    const batch = { index: 2, total: 3, pages: [pageOf('a')], captures: 1 }
    const artifacts = await writeBatchArtifacts(root, plan, batch, { batch: 2 }, ['a.mdx'])
    expect(artifacts).toEqual({ slice: '.doxloop/cache/authoring-batch-2.json', manifest: '.doxloop/cache/screenshot-manifest-batch-2.json', evidence: '.doxloop/cache/evidence-batch-2.json' })
    const manifestSlice = JSON.parse(await readFile(join(root, artifacts.manifest!), 'utf8'))
    expect(manifestSlice.guides.map((guide: { page: string }) => guide.page)).toEqual(['a'])
    const evidenceSlice = JSON.parse(await readFile(join(root, artifacts.evidence), 'utf8'))
    expect(Object.keys(evidenceSlice.pages)).toEqual(['a.mdx'])

    // The agent fills its slices in.
    await writeFile(join(root, artifacts.manifest!), JSON.stringify({ schemaVersion: 1, guides: [{ page: 'a', steps: [{ ...step, status: 'verified', file: 'assets/guides/a/01-a.png', target: 'a', alt: 'a', checks: { expectedStateConfirmed: true, privacyReviewed: true, legibilityReviewed: true, meaningful: true } }] }] }))
    await writeFile(join(root, artifacts.evidence), JSON.stringify({ schemaVersion: 1, pages: { 'a.mdx': { sources: [{ source: 's', paths: ['x', 'y'] }], claims: ['A does X.'] }, 'bad.mdx': { nope: true } } }))
    const merged = await mergeBatchArtifacts(root, artifacts)
    expect(merged).toMatchObject({ guides: 1, evidencePages: 1, problems: [] })
    const manifest = JSON.parse(await readFile(join(root, SCREENSHOT_MANIFEST_FILE), 'utf8'))
    expect(manifest.guides.map((guide: { page: string; steps: Array<{ status: string }> }) => [guide.page, guide.steps[0]!.status])).toEqual([['a', 'verified'], ['b', 'planned']])
    const evidence = await readEvidenceMap(root)
    expect(evidence?.pages['a.mdx']).toMatchObject({ sources: [{ source: 's', paths: ['x', 'y'] }], claims: ['A does X.'] })
    expect(evidence?.pages['z.mdx']).toBeDefined()
    expect(evidence?.pages['bad.mdx']).toBeUndefined()
  })

  test('omits the manifest slice when the batch has no guides and tolerates a missing evidence map', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doxloop-batch-artifacts-'))
    roots.push(root)
    await mkdir(join(root, '.doxloop'), { recursive: true })
    const artifacts = await writeBatchArtifacts(root, plan, { index: 1, total: 1, pages: [pageOf('a')], captures: 0 }, {}, ['a.mdx'])
    expect(artifacts.manifest).toBeUndefined()
    await writeFile(join(root, artifacts.evidence), JSON.stringify({ schemaVersion: 1, pages: { 'a.mdx': { sources: [{ source: 's' }] } } }))
    expect(await mergeBatchArtifacts(root, artifacts)).toMatchObject({ guides: 0, evidencePages: 1 })
    expect((await readEvidenceMap(root))?.pages['a.mdx']).toBeDefined()
  })

  test('seeds a Doxbrix page not written yet under .mdx even when the target lists .md first', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doxloop-batch-artifacts-'))
    roots.push(root)
    await mkdir(join(root, '.doxloop'), { recursive: true })
    const doxbrix = { id: 'plan', pages: [], target: { generator: 'doxbrix', contentDir: '', contentFormat: 'markdown', pageExtensions: ['.md', '.mdx'], navigationFiles: ['docs.json'] } } as unknown as DocumentationPlan
    const artifacts = await writeBatchArtifacts(root, doxbrix, { index: 8, total: 16, pages: [pageOf('guides/inbox')], captures: 0 }, {})
    expect(Object.keys(JSON.parse(await readFile(join(root, artifacts.evidence), 'utf8')).pages)).toEqual(['guides/inbox.mdx'])
    const vitepress = { ...doxbrix, target: { ...doxbrix.target, generator: 'vitepress', pageExtensions: ['.md'] } } as unknown as DocumentationPlan
    const other = await writeBatchArtifacts(root, vitepress, { index: 9, total: 16, pages: [pageOf('guides/inbox')], captures: 0 }, {})
    expect(Object.keys(JSON.parse(await readFile(join(root, other.evidence), 'utf8')).pages)).toEqual(['guides/inbox.md'])
  })

  test('runs a pool with bounded concurrency and a stop check, and the lock serializes tasks', async () => {
    let running = 0
    let peak = 0
    const seen: number[] = []
    await runPool([1, 2, 3, 4, 5], 2, async (item) => {
      running += 1
      peak = Math.max(peak, running)
      await new Promise((resolve) => setTimeout(resolve, 5))
      seen.push(item)
      running -= 1
    })
    expect(peak).toBe(2)
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5])
    const stopped: number[] = []
    await runPool([1, 2, 3, 4], 2, async (item) => { stopped.push(item) }, () => stopped.length >= 2)
    expect(stopped.length).toBeLessThanOrEqual(3)

    const lock = createLock()
    const order: string[] = []
    await Promise.all([
      lock(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); order.push('first') }),
      lock(async () => { order.push('second') }),
    ])
    expect(order).toEqual(['first', 'second'])
    await expect(lock(async () => { throw new Error('boom') })).rejects.toThrow('boom')
    await expect(lock(async () => 'after')).resolves.toBe('after')
  })
})

describe('evidence seeding and capture status', () => {
  test('seeds an evidence entry for a page not written yet, keyed by its planned file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doxloop-batch-seed-'))
    roots.push(root)
    await mkdir(join(root, '.doxloop'), { recursive: true })
    const seeded = { ...pageOf('guides/new'), evidenceDetails: [{ source: 's', path: 'src/new.ts', kind: 'export', label: 'run' }] } as DocumentationPlan['pages'][number]
    const withTarget = { ...plan, target: { generator: 'doxbrix', contentDir: '', contentFormat: 'markdown', pageExtensions: ['.mdx'], navigationFiles: [] } } as unknown as DocumentationPlan
    const artifacts = await writeBatchArtifacts(root, withTarget, { index: 1, total: 1, pages: [seeded], captures: 0 }, {}, [])
    const slice = JSON.parse(await readFile(join(root, artifacts.evidence), 'utf8'))
    expect(slice.pages['guides/new.mdx']).toEqual({ sources: [{ source: 's', paths: ['src/new.ts'] }], confidence: 'inferred' })
  })

  test('decides step status from the image on disk, never from the agent\'s word', () => {
    const guides = [{ page: 'g', steps: [
      { id: '01', status: 'captured', file: 'ok.png' },
      { id: '02', status: 'done', file: 'small.png' },
      { id: '03', status: 'verified' },
      { id: '04', status: 'captured' },
      { id: '05', status: 'text-only', textOnlyReason: 'needs a paid plan' },
      { id: '06', status: 'planned' },
      { id: '07', status: 'verified', file: 'blank.png', checks: { privacyReviewed: false } },
    ] }]
    const images: Record<string, { width: number; height: number; blank: boolean }> = { 'ok.png': { width: 1440, height: 900, blank: false }, 'small.png': { width: 200, height: 100, blank: false }, 'blank.png': { width: 1440, height: 900, blank: true } }
    const result = normalizeCaptureSteps(guides, (file) => images[file])
    expect(result.verified).toEqual(['g/01'])
    expect(result.reset.map((item) => item.step)).toEqual(['g/02', 'g/03', 'g/04', 'g/07'])
    const status = guides[0]!.steps.map((step) => (step as { status: string }).status)
    expect(status).toEqual(['verified', 'planned', 'planned', 'planned', 'text-only', 'planned', 'planned'])
    expect(guides[0]!.steps[0]).toMatchObject({ capture: true, target: 'ok.png', checks: { expectedStateConfirmed: true, privacyReviewed: true, legibilityReviewed: true, meaningful: true } })
    expect((guides[0]!.steps[1] as { file?: string }).file).toBeUndefined()
  })

  test('normalizes a manifest file against real PNGs and relativizes absolute paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doxloop-batch-normalize-'))
    roots.push(root)
    await mkdir(join(root, '.doxloop/cache'), { recursive: true })
    await mkdir(join(root, 'assets/guides/g'), { recursive: true })
    const png = new PNG({ width: 400, height: 240 })
    for (let i = 0; i < png.data.length; i++) png.data[i] = i % 251
    await writeFile(join(root, 'assets/guides/g/01.png'), PNG.sync.write(png))
    const file = '.doxloop/cache/capture-1.json'
    await writeFile(join(root, file), JSON.stringify({ schemaVersion: 1, guides: [{ page: 'g', steps: [
      { id: '01', action: 'Open /g', expectedState: 'The g screen', purpose: 'Orient', status: 'captured', file: join(root, 'assets/guides/g/01.png') },
      { id: '02', action: 'Open /h', expectedState: 'The h screen', purpose: 'Orient', status: 'captured', file: 'assets/guides/g/02.png' },
      { id: '03', action: 'Open /x', expectedState: 'The x screen', purpose: 'Orient', status: 'captured', file: '../../etc/passwd' },
    ] }] }))
    const result = await normalizeCaptureManifest(root, file)
    expect(result.verified).toEqual(['g/01'])
    expect(result.reset.map((item) => item.step)).toEqual(['g/02', 'g/03'])
    const saved = JSON.parse(await readFile(join(root, file), 'utf8'))
    expect(saved.guides[0].steps[0]).toMatchObject({ status: 'verified', file: 'assets/guides/g/01.png', alt: 'The g screen' })
    expect(saved.guides[0].steps[1]).toMatchObject({ status: 'planned' })
    expect(await normalizeCaptureManifest(root, '.doxloop/cache/nope.json')).toEqual({ verified: [], reset: [] })
  })
})

describe('evidence ownership', () => {
  test('finds the files a tool call names and attributes them to configured sources', () => {
    expect(pathsInToolCall('Read', { file_path: '/src/app/a.ts' })).toEqual(['/src/app/a.ts'])
    expect(pathsInToolCall('Grep', { pattern: 'x', path: '/src/app' })).toEqual(['/src/app'])
    expect(pathsInToolCall('Bash', { command: 'grep -n "foo" /src/app/b.vue | head; cat ./c.md; echo $D/skip' })).toEqual(['/src/app/b.vue', './c.md'])
    const reads = attributeReadsToSources(['/src/app/a.ts', '/src/app/sub/b.vue', '/elsewhere/x.ts', '/ws/guides/page.mdx'], [{ name: 'app', path: '/src/app' }], '/ws')
    expect([...reads.get('app')!].sort()).toEqual(['a.ts', 'sub/b.vue'])
    expect(reads.size).toBe(1)
  })

  test('reconciles an agent-written evidence slice: keeps claims, checks paths, always carries the plan citations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doxloop-evidence-own-'))
    roots.push(root)
    await mkdir(join(root, 'src'), { recursive: true })
    await mkdir(join(root, '.doxloop/cache'), { recursive: true })
    await writeFile(join(root, 'src/real.ts'), 'export const x = 1')
    await writeFile(join(root, 'src/cited.ts'), 'export const y = 2')
    const slice = '.doxloop/cache/evidence-batch-1.json'
    await writeFile(join(root, slice), JSON.stringify({ schemaVersion: 1, pages: {
      'guides/a.mdx': { sources: [{ source: 'app', paths: ['src/real.ts', 'src/made-up.ts', '../../etc/passwd'] }, { source: 'ghost', paths: ['x'] }], confidence: 'verified', claims: ['A does X.', ''], claimVerification: { 'A does X.': 'verified', 'other': 'verified' } },
      'guides/b.mdx': { sources: [], confidence: 'verified', claims: ['B does Y.'] },
    } }))
    const withTarget = { ...plan, target: { generator: 'doxbrix', contentDir: '', contentFormat: 'markdown', pageExtensions: ['.mdx'], navigationFiles: [] } } as unknown as DocumentationPlan
    const pages = [
      { ...pageOf('guides/a'), evidenceDetails: [{ source: 'app', path: 'src/cited.ts', kind: 'export', label: 'y' }] },
      { ...pageOf('guides/b'), evidenceDetails: [] },
      { ...pageOf('guides/c'), evidenceDetails: [] },
    ] as DocumentationPlan['pages']
    const reads = new Map([['app', new Set(['src/read-in-session.ts'])]])
    const result = await reconcileEvidenceSlice(root, slice, withTarget, pages, [{ name: 'app', path: root }], reads)
    expect(result).toEqual({ pages: 3, droppedPaths: 2 })
    const saved = JSON.parse(await readFile(join(root, slice), 'utf8'))
    expect(saved.pages['guides/a.mdx']).toEqual({ sources: [{ source: 'app', paths: ['src/cited.ts', 'src/real.ts'] }], confidence: 'verified', claims: ['A does X.'], claimVerification: { 'A does X.': 'verified' } })
    // No plan citation and nothing the agent named: what the session read stands in, at inferred confidence.
    expect(saved.pages['guides/b.mdx']).toEqual({ sources: [{ source: 'app', paths: ['src/read-in-session.ts'] }], confidence: 'inferred', claims: ['B does Y.'] })
    expect(saved.pages['guides/c.mdx']).toEqual({ sources: [{ source: 'app', paths: ['src/read-in-session.ts'] }], confidence: 'inferred' })
  })
})

