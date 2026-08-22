import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, test } from 'vitest'
import { computeDrift } from './drift.js'
import { writeEvidenceMap } from './evidence.js'
import { loadProject, scaffoldProject } from './project.js'
import { collectSourceChanges, recordSyncState } from './sync.js'
import {
  acceptSyncChanges,
  createSyncRun,
  listSyncRuns,
  readSyncRun,
} from './sync-runs.js'

const run = promisify(execFile)
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function git(cwd: string, ...args: string[]): Promise<void> {
  await run(
    'git',
    ['-c', 'user.name=Doxloop Test', '-c', 'user.email=test@example.com', ...args],
    { cwd },
  )
}

async function fixture(): Promise<{ root: string; product: string }> {
  const parent = await mkdtemp(join(tmpdir(), 'doxloop-review-'))
  roots.push(parent)
  const product = join(parent, 'product')
  await mkdir(join(product, 'src'), { recursive: true })
  await writeFile(join(product, 'src', 'limits.ts'), 'export const limit = 10\n')
  await git(product, 'init', '--initial-branch=main')
  await git(product, 'add', '.')
  await git(product, 'commit', '-m', 'initial')
  const root = await scaffoldProject({
    directory: join(parent, 'docs'),
    sources: [{ name: 'product', path: '../product' }],
  })
  await writeFile(
    join(root, 'docs', 'index.mdx'),
    '---\ntitle: Limits\ndescription: Understand the current product limit.\n---\n\nThe limit is 10.\n',
  )
  await writeFile(
    join(root, 'docs', 'quickstart.mdx'),
    '---\ntitle: Quickstart\ndescription: Start using the product safely.\n---\n\nFollow the documented setup.\n',
  )
  await writeEvidenceMap(root, {
    schemaVersion: 1,
    pages: {
      'docs/index.mdx': { sources: [{ source: 'product', paths: ['src/limits.ts'] }] },
      'docs/quickstart.mdx': { sources: [{ source: 'product', paths: ['src/limits.ts'] }] },
    },
  })
  await recordSyncState(root, (await loadProject(root)).sources)
  await writeFile(join(product, 'src', 'limits.ts'), 'export const limit = 20\n')
  await git(product, 'commit', '-am', 'raise limit')
  return { root, product }
}

async function proposal(root: string, content: string) {
  const loaded = await loadProject(root)
  const project = { ...loaded, sync: { ...loaded.sync, mode: 'propose' as const } }
  const drift = await computeDrift(root, project)
  const changes = await collectSourceChanges(root, project.sources)
  return createSyncRun({
    root,
    project,
    drift,
    sourceChanges: changes,
    author: async (options) => {
      const staged = await loadProject(options.root)
      const stagedSource = staged.sources[0]?.path
      expect(stagedSource).toBeDefined()
      expect(isAbsolute(stagedSource!)).toBe(true)
      expect(options.changeSummary).toContain(stagedSource)
      expect(
        (await run('git', ['rev-parse', '--show-toplevel'], { cwd: options.root })).stdout.trim(),
      ).toBe(await realpath(options.root))
      await writeFile(join(options.root, 'docs', 'index.mdx'), content)
      await recordSyncState(options.root, staged.sources)
      return 0
    },
  })
}

describe('sync review runs', () => {
  test('classifies site data inside the content directory as navigation, not a page', async () => {
    const { root } = await fixture()
    const created = await createSyncRun({
      root,
      project: {
        ...(await loadProject(root)),
        sync: { ...(await loadProject(root)).sync, mode: 'propose' as const },
      },
      drift: await computeDrift(root, await loadProject(root)),
      sourceChanges: await collectSourceChanges(root, (await loadProject(root)).sources),
      author: async (options) => {
        const staged = await loadProject(options.root)
        const site = JSON.parse(await readFile(join(options.root, 'docs', 'docs.json'), 'utf8'))
        await mkdir(join(options.root, '.doxloop', 'ui-job-logs'), { recursive: true })
        await writeFile(join(options.root, '.doxloop', 'ui-jobs.json'), '{"schemaVersion":1,"jobs":[]}\n')
        await writeFile(join(options.root, '.doxloop', 'ui-job-logs', 'runtime.log'), 'agent output\n')
        await writeFile(
          join(options.root, 'docs', 'docs.json'),
          `${JSON.stringify({ ...site, name: 'Renamed site' }, null, 2)}\n`,
        )
        await writeFile(
          join(options.root, 'docs', 'index.mdx'),
          '---\ntitle: Updated\ndescription: The limit changed.\n---\n\nThe limit is now 20.\n',
        )
        await recordSyncState(options.root, staged.sources)
        return 0
      },
    })

    expect(created.status, created.error).toBe('awaiting-review')
    const site = created.changes.find((change) => change.path === 'docs/docs.json')
    const page = created.changes.find((change) => change.path === 'docs/index.mdx')
    expect(site?.category).toBe('navigation')
    expect(page?.category).toBe('page')
    expect(created.changes.some((change) => change.path.includes('ui-job'))).toBe(false)
  })

  test('repairs a legacy runtime-file conflict when reading a proposal', async () => {
    const { root } = await fixture()
    const created = await proposal(root, '---\ntitle: Updated\ndescription: Updated docs.\n---\n\nThe limit is now 20.\n')
    const runtimeChange = {
      ...created.changes[0]!,
      id: 'change-runtime',
      path: '.doxloop/ui-job-logs/runtime.log',
    }
    await writeFile(
      join(root, '.doxloop', 'runs', created.id, 'run.json'),
      `${JSON.stringify({
        ...created,
        status: 'conflicted',
        error: '.doxloop/ui-job-logs/runtime.log changed after this proposal was generated. Regenerate or review the conflict; no file was overwritten.',
        changes: [...created.changes, runtimeChange],
      }, null, 2)}\n`,
    )

    const repaired = await readSyncRun(root, created.id)
    expect(repaired.status).toBe('awaiting-review')
    expect(repaired.error).toBeUndefined()
    expect(repaired.changes).toHaveLength(created.changes.length)
    expect(repaired.changes.some((change) => change.path.includes('ui-job'))).toBe(false)
  }, 15_000)

  test('merges non-overlapping concurrent evidence-map updates during acceptance', async () => {
    const { root } = await fixture()
    const loaded = await loadProject(root)
    const created = await createSyncRun({
      root,
      project: { ...loaded, sync: { ...loaded.sync, mode: 'propose' as const } },
      drift: await computeDrift(root, loaded),
      sourceChanges: await collectSourceChanges(root, loaded.sources),
      author: async (options) => {
        const evidencePath = join(options.root, '.doxloop', 'evidence-map.json')
        const evidence = JSON.parse(await readFile(evidencePath, 'utf8'))
        evidence.pages['docs/index.mdx'].claims = ['Proposal evidence.']
        await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`)
        await writeFile(
          join(options.root, 'docs', 'index.mdx'),
          '---\ntitle: Updated\ndescription: Updated docs.\n---\n\nThe limit is now 20.\n',
        )
        await recordSyncState(options.root, (await loadProject(options.root)).sources)
        return 0
      },
    })
    const evidencePath = join(root, '.doxloop', 'evidence-map.json')
    const currentEvidence = JSON.parse(await readFile(evidencePath, 'utf8'))
    currentEvidence.pages['docs/quickstart.mdx'].claims = ['Newer accepted evidence.']
    await writeFile(evidencePath, `${JSON.stringify(currentEvidence, null, 2)}\n`)

    const applied = await acceptSyncChanges(
      root,
      created.id,
      created.changes.map((change) => ({ changeId: change.id })),
    )
    const mergedEvidence = JSON.parse(await readFile(evidencePath, 'utf8'))
    expect(applied.status).toBe('applied')
    expect(applied.error).toBeUndefined()
    expect(mergedEvidence.pages['docs/index.mdx'].claims).toEqual(['Proposal evidence.'])
    expect(mergedEvidence.pages['docs/quickstart.mdx'].claims).toEqual(['Newer accepted evidence.'])
  }, 15_000)

  test('generates outside the real non-Git documentation and applies only after acceptance', async () => {
    const { root } = await fixture()
    const path = join(root, 'docs', 'index.mdx')
    const before = await readFile(path, 'utf8')
    const generated = '---\ntitle: Updated limits\ndescription: Understand the updated product limit.\n---\n\nThe limit is now 20.\n'

    const created = await proposal(root, generated)

    expect(created.status, created.error).toBe('awaiting-review')
    expect(created.changes.some((change) => change.path === 'docs/index.mdx')).toBe(true)
    expect(await readFile(path, 'utf8')).toBe(before)
    expect(await listSyncRuns(root)).toHaveLength(1)

    const applied = await acceptSyncChanges(
      root,
      created.id,
      created.changes.map((change) => ({ changeId: change.id })),
    )

    expect(applied.status).toBe('applied')
    expect(await readFile(path, 'utf8')).toBe(generated)
    expect((await computeDrift(root, await loadProject(root))).status).toBe('current')
  }, 15_000)

  test('accepts one highlighted hunk without applying the other', async () => {
    const { root } = await fixture()
    const path = join(root, 'docs', 'index.mdx')
    await writeFile(
      path,
      '---\ntitle: Limits\ndescription: Understand the current product limit.\n---\n\nAlpha is 10.\n\nKeep this section.\n\nOmega is 10.\n',
    )
    const created = await proposal(
      root,
      '---\ntitle: Limits\ndescription: Understand the current product limit.\n---\n\nAlpha is 20.\n\nKeep this section.\n\nOmega is 20.\n',
    )
    const page = created.changes.find((change) => change.path === 'docs/index.mdx')!
    expect(page.hunks).toHaveLength(2)

    const partial = await acceptSyncChanges(root, created.id, [
      { changeId: page.id, hunkIds: [page.hunks[0]!.id] },
    ])

    expect(partial.status).toBe('partially-applied')
    expect(await readFile(path, 'utf8')).toContain('Alpha is 20.')
    expect(await readFile(path, 'utf8')).toContain('Omega is 10.')
    expect((await readSyncRun(root, created.id)).changes[0]?.hunks[0]?.acceptedAt).toBeDefined()
  }, 15_000)

  test('detects a local edit made while review is pending and never overwrites it', async () => {
    const { root } = await fixture()
    const path = join(root, 'docs', 'index.mdx')
    const created = await proposal(root, '---\ntitle: Proposed\ndescription: Understand the proposed product limit.\n---\n\nLimit 20.\n')
    await writeFile(path, '---\ntitle: User edit\ndescription: Preserve a local documentation edit.\n---\n\nKeep me.\n')

    await expect(
      acceptSyncChanges(
        root,
        created.id,
        created.changes.map((change) => ({ changeId: change.id })),
      ),
    ).rejects.toThrow('changed after this proposal was generated')

    expect(await readFile(path, 'utf8')).toContain('Keep me.')
    expect((await readSyncRun(root, created.id)).status).toBe('conflicted')
  }, 15_000)
})
