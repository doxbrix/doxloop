import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, test } from 'vitest'
import { computeDrift } from './drift.js'
import { writeEvidenceMap } from './evidence.js'
import { createProposalBranch, publishProposalBranch } from './git-delivery.js'
import { loadProject, scaffoldProject } from './project.js'
import { reviewPreferenceGuidance } from './review-learning.js'
import { collectSourceChanges, recordSyncState } from './sync.js'
import {
  acceptSyncChanges,
  archiveSyncRun,
  createSyncRun,
  editSyncRunChange,
  listSyncRuns,
  pruneSyncRuns,
  readSyncRun,
  recoverSyncRun,
  resumeSyncRun,
  reviseSyncRun,
  undoSyncRun,
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
    join(root, 'index.mdx'),
    '---\ntitle: Limits\ndescription: Understand the current product limit.\n---\n\nThe limit is 10.\n',
  )
  await writeFile(
    join(root, 'quickstart.mdx'),
    '---\ntitle: Quickstart\ndescription: Start using the product safely.\n---\n\nFollow the documented setup.\n',
  )
  await writeEvidenceMap(root, {
    schemaVersion: 1,
    pages: {
      'index.mdx': { sources: [{ source: 'product', paths: ['src/limits.ts'] }] },
      'quickstart.mdx': { sources: [{ source: 'product', paths: ['src/limits.ts'] }] },
    },
  })
  await recordSyncState(root, (await loadProject(root)).sources)
  await writeFile(join(product, 'src', 'limits.ts'), 'export const limit = 20\n')
  await git(product, 'commit', '-am', 'raise limit')
  return { root, product }
}

async function proposal(root: string, content: string, authoringMode?: 'create' | 'update') {
  const loaded = await loadProject(root)
  const project = { ...loaded, sync: { ...loaded.sync, mode: 'propose' as const } }
  const drift = await computeDrift(root, project)
  const changes = await collectSourceChanges(root, project.sources)
  return createSyncRun({
    root,
    project,
    drift,
    sourceChanges: changes,
    ...(authoringMode ? { authoring: { mode: authoringMode } } : {}),
    author: async (options) => {
      const staged = await loadProject(options.root)
      const stagedSource = staged.sources[0]?.path
      expect(stagedSource).toBeDefined()
      expect(isAbsolute(stagedSource!)).toBe(true)
      expect(options.changeSummary).toContain(stagedSource)
      expect(
        (await run('git', ['rev-parse', '--show-toplevel'], { cwd: options.root })).stdout.trim(),
      ).toBe(await realpath(options.root))
      await writeFile(join(options.root, 'index.mdx'), content)
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
        const site = JSON.parse(await readFile(join(options.root, 'docs.json'), 'utf8'))
        await mkdir(join(options.root, '.doxloop', 'ui-job-logs'), { recursive: true })
        await writeFile(join(options.root, '.doxloop', 'ui-jobs.json'), '{"schemaVersion":1,"jobs":[]}\n')
        await writeFile(join(options.root, '.doxloop', 'ui-job-logs', 'runtime.log'), 'agent output\n')
        await writeFile(
          join(options.root, 'docs.json'),
          `${JSON.stringify({ ...site, name: 'Renamed site' }, null, 2)}\n`,
        )
        await writeFile(
          join(options.root, 'index.mdx'),
          '---\ntitle: Updated\ndescription: The limit changed.\n---\n\nThe limit is now 20.\n',
        )
        await recordSyncState(options.root, staged.sources)
        return 0
      },
    })

    expect(created.status, created.error).toBe('awaiting-review')
    const site = created.changes.find((change) => change.path === 'docs.json')
    const page = created.changes.find((change) => change.path === 'index.mdx')
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

  test('removes plan workflow state from existing proposals and applies the remaining files', async () => {
    const { root } = await fixture()
    const created = await proposal(root, '---\ntitle: Updated\ndescription: Updated docs.\n---\n\nThe limit is now 20.\n')
    const internalPlanChange = {
      ...created.changes[0]!,
      id: 'change-plan-state',
      path: '.doxloop/plans/plan-test/plan.json',
    }
    await writeFile(
      join(root, '.doxloop', 'runs', created.id, 'run.json'),
      `${JSON.stringify({
        ...created,
        status: 'conflicted',
        error: '.doxloop/plans/plan-test/plan.json changed after this proposal was generated. Regenerate or review the conflict; no file was overwritten.',
        changes: [...created.changes, internalPlanChange],
      }, null, 2)}\n`,
    )

    const repaired = await readSyncRun(root, created.id)
    expect(repaired.status).toBe('awaiting-review')
    expect(repaired.error).toBeUndefined()
    expect(repaired.changes).toHaveLength(created.changes.length)
    expect(repaired.changes.some((change) => change.path.startsWith('.doxloop/plans/'))).toBe(false)

    const applied = await acceptSyncChanges(root, repaired.id, repaired.changes.map((change) => ({ changeId: change.id })))
    expect(applied.status).toBe('applied')
    expect(await readFile(join(root, 'index.mdx'), 'utf8')).toContain('limit is now 20')
  }, 20_000)

  test('migrates legacy proposal manifests to the rationale-aware schema', async () => {
    const { root } = await fixture()
    const created = await proposal(root, '---\ntitle: Updated\ndescription: Updated docs.\n---\n\nThe limit is now 20.\n')
    const legacy = {
      ...created,
      schemaVersion: 1,
      changes: created.changes.map(({ rationale: _rationale, ...change }) => change),
    } as Record<string, unknown>
    delete legacy.revisionRequests
    delete legacy.humanEdits
    await writeFile(join(root, '.doxloop', 'runs', created.id, 'run.json'), `${JSON.stringify(legacy, null, 2)}\n`)

    const migrated = await readSyncRun(root, created.id)
    expect(migrated.schemaVersion).toBe(2)
    expect(migrated.revisionRequests).toEqual([])
    expect(migrated.humanEdits).toEqual([])
    expect(migrated.changes[0]?.rationale.assumptions).toContain('Detailed rationale was not recorded for this legacy proposal.')
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
        evidence.pages['index.mdx'].claims = ['Proposal evidence.']
        await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`)
        await writeFile(
          join(options.root, 'index.mdx'),
          '---\ntitle: Updated\ndescription: Updated docs.\n---\n\nThe limit is now 20.\n',
        )
        await recordSyncState(options.root, (await loadProject(options.root)).sources)
        return 0
      },
    })
    const evidencePath = join(root, '.doxloop', 'evidence-map.json')
    const currentEvidence = JSON.parse(await readFile(evidencePath, 'utf8'))
    currentEvidence.pages['quickstart.mdx'].claims = ['Newer accepted evidence.']
    await writeFile(evidencePath, `${JSON.stringify(currentEvidence, null, 2)}\n`)

    const applied = await acceptSyncChanges(
      root,
      created.id,
      created.changes.map((change) => ({ changeId: change.id })),
    )
    const mergedEvidence = JSON.parse(await readFile(evidencePath, 'utf8'))
    expect(applied.status).toBe('applied')
    expect(applied.error).toBeUndefined()
    expect(mergedEvidence.pages['index.mdx'].claims).toEqual(['Proposal evidence.'])
    expect(mergedEvidence.pages['quickstart.mdx'].claims).toEqual(['Newer accepted evidence.'])
    await undoSyncRun(root, created.id)
    const restoredEvidence = JSON.parse(await readFile(evidencePath, 'utf8'))
    expect(restoredEvidence.pages['index.mdx'].claims).toBeUndefined()
    expect(restoredEvidence.pages['quickstart.mdx'].claims).toEqual(['Newer accepted evidence.'])
  }, 15_000)

  test('generates outside the real non-Git documentation and applies only after acceptance', async () => {
    const { root } = await fixture()
    const path = join(root, 'index.mdx')
    const before = await readFile(path, 'utf8')
    const generated = '---\ntitle: Updated limits\ndescription: Understand the updated product limit.\n---\n\nThe limit is now 20.\n'

    const created = await proposal(root, generated)

    expect(created.status, created.error).toBe('awaiting-review')
    expect(created.changes.some((change) => change.path === 'index.mdx')).toBe(true)
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
    const path = join(root, 'index.mdx')
    await writeFile(
      path,
      '---\ntitle: Limits\ndescription: Understand the current product limit.\n---\n\nAlpha is 10.\n\nKeep this section.\n\nOmega is 10.\n',
    )
    const created = await proposal(
      root,
      '---\ntitle: Limits\ndescription: Understand the current product limit.\n---\n\nAlpha is 20.\n\nKeep this section.\n\nOmega is 20.\n',
    )
    const page = created.changes.find((change) => change.path === 'index.mdx')!
    expect(page.hunks).toHaveLength(2)

    const partial = await acceptSyncChanges(root, created.id, [
      { changeId: page.id, hunkIds: [page.hunks[0]!.id] },
    ])

    expect(partial.status).toBe('partially-applied')
    expect(await readFile(path, 'utf8')).toContain('Alpha is 20.')
    expect(await readFile(path, 'utf8')).toContain('Omega is 10.')
    expect((await readSyncRun(root, created.id)).changes[0]?.hunks[0]?.acceptedAt).toBeDefined()
  }, 15_000)

  test('enforces hunk-level revision scope instead of trusting the agent prompt', async () => {
    const { root } = await fixture()
    await writeFile(
      join(root, 'index.mdx'),
      '---\ntitle: Limits\ndescription: Understand limits.\n---\n\nAlpha is 10.\n\nKeep this section.\n\nOmega is 10.\n',
    )
    const created = await proposal(
      root,
      '---\ntitle: Limits\ndescription: Understand limits.\n---\n\nAlpha is 20.\n\nKeep this section.\n\nOmega is 20.\n',
    )
    const page = created.changes.find((change) => change.path === 'index.mdx')!
    const selectedHunk = page.hunks[0]!
    const escaped = await reviseSyncRun(root, created.id, {
      instruction: 'Revise only the first limit.',
      changeIds: [page.id],
      hunkIds: [selectedHunk.id],
      author: async (options) => {
        await writeFile(join(options.root, 'index.mdx'), '---\ntitle: Limits\ndescription: Understand limits.\n---\n\nAlpha is 30.\n\nKeep this section.\n\nOmega is 30.\n')
        return 0
      },
    })
    expect(escaped.status).toBe('failed')
    expect(escaped.error).toContain('outside the selected hunk')
    expect((await readSyncRun(root, created.id)).status).toBe('awaiting-review')

    const scoped = await reviseSyncRun(root, created.id, {
      instruction: 'Revise only the first limit.',
      changeIds: [page.id],
      hunkIds: [selectedHunk.id],
      author: async (options) => {
        await writeFile(join(options.root, 'index.mdx'), '---\ntitle: Limits\ndescription: Understand limits.\n---\n\nAlpha is 30.\n\nKeep this section.\n\nOmega is 20.\n')
        return 0
      },
    })
    expect(scoped.status, scoped.error).toBe('awaiting-review')
  }, 25_000)

  test('detects a local edit made while review is pending and never overwrites it', async () => {
    const { root } = await fixture()
    const path = join(root, 'index.mdx')
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

  test('records a reviewable rationale and preserves human inline edits in the isolated workspace', async () => {
    const { root } = await fixture()
    const path = join(root, 'index.mdx')
    const before = await readFile(path, 'utf8')
    const created = await proposal(root, '---\ntitle: Proposed\ndescription: Updated limit.\n---\n\nThe limit is now 20.\n')
    const page = created.changes.find((change) => change.path === 'index.mdx')!

    expect(created.schemaVersion).toBe(2)
    expect(page.rationale.reason).toContain('Update')
    expect(page.rationale.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'product', path: 'src/limits.ts', available: true }),
    ]))

    const edited = await editSyncRunChange(
      root,
      created.id,
      page.id,
      '---\ntitle: Reviewer version\ndescription: Updated limit.\n---\n\nThe verified limit is 20.\n',
      'needs-review',
    )
    const editedPage = edited.changes.find((change) => change.path === 'index.mdx')!
    expect(await readFile(path, 'utf8')).toBe(before)
    expect(edited.humanEdits).toEqual([
      expect.objectContaining({ path: 'index.mdx', evidenceDisposition: 'needs-review' }),
    ])
    expect(editedPage.rationale.authorship).toBe('human')
    expect(editedPage.rationale.confidence).toBe('needs-human')
  }, 20_000)

  test('revises only the selected proposal file and supersedes the previous proposal', async () => {
    const { root } = await fixture()
    const loaded = await loadProject(root)
    const created = await createSyncRun({
      root,
      project: { ...loaded, sync: { ...loaded.sync, mode: 'propose' as const } },
      drift: await computeDrift(root, loaded),
      sourceChanges: await collectSourceChanges(root, loaded.sources),
      author: async (options) => {
        await writeFile(join(options.root, 'index.mdx'), '---\ntitle: First limits\ndescription: First proposal.\n---\n\nLimit 20.\n')
        await writeFile(join(options.root, 'quickstart.mdx'), '---\ntitle: First quickstart\ndescription: First proposal.\n---\n\nStart here.\n')
        return 0
      },
    })
    const selected = created.changes.find((change) => change.path === 'index.mdx')!
    const firstQuickstart = await readFile(join(root, '.doxloop', 'runs', created.id, 'workspace', 'quickstart.mdx'), 'utf8')
    const revised = await reviseSyncRun(root, created.id, {
      instruction: 'Make the limit statement clearer.',
      changeIds: [selected.id],
      author: async (options) => {
        await writeFile(join(options.root, 'index.mdx'), '---\ntitle: Clear limits\ndescription: Revised proposal.\n---\n\nThe supported limit is 20.\n')
        return 0
      },
    })

    expect(revised.status, revised.error).toBe('awaiting-review')
    expect(revised.revisionOf).toBe(created.id)
    expect(revised.revisionRequests[0]).toMatchObject({ instruction: 'Make the limit statement clearer.', changeIds: [selected.id] })
    expect(await readFile(join(root, '.doxloop', 'runs', revised.id, 'workspace', 'quickstart.mdx'), 'utf8')).toBe(firstQuickstart)
    expect((await readSyncRun(root, created.id)).status).toBe('superseded')
    expect(await reviewPreferenceGuidance(root)).toContain('Make the limit statement clearer.')
  }, 25_000)

  test('keeps a proposal editable and applicable when source evidence changes during review', async () => {
    const { root, product } = await fixture()
    const created = await proposal(root, '---\ntitle: Proposed\ndescription: Updated limit.\n---\n\nLimit 20.\n')
    await writeFile(join(product, 'src', 'limits.ts'), 'export const limit = 30\n')

    const page = created.changes.find((change) => change.path === 'index.mdx')!
    const edited = await editSyncRunChange(
      root,
      created.id,
      page.id,
      '---\ntitle: Reviewer version\ndescription: Updated limit.\n---\n\nThe documented limit is 20.\n',
      'needs-review',
    )
    expect(edited.status).toBe('awaiting-review')
    expect(edited.sourceSnapshot).not.toBe(created.sourceSnapshot)
    expect(edited.advisories).toContainEqual(expect.stringContaining('remains editable and applicable'))

    await writeFile(join(product, 'src', 'limits.ts'), 'export const limit = 40\n')
    const applied = await acceptSyncChanges(
      root,
      created.id,
      edited.changes.map((change) => ({ changeId: change.id })),
    )
    expect(applied.status).toBe('applied')
    expect(applied.sourceSnapshot).not.toBe(edited.sourceSnapshot)
    expect(applied.advisories).toContainEqual(expect.stringContaining('remains editable and applicable'))
    expect(await readFile(join(root, 'index.mdx'), 'utf8')).toContain('documented limit is 20')
  }, 20_000)

  test('restores proposals made stale by the legacy source-evidence guard', async () => {
    const { root, product } = await fixture()
    const created = await proposal(root, '---\ntitle: Proposed\ndescription: Updated limit.\n---\n\nLimit 20.\n')
    await writeFile(join(product, 'src', 'limits.ts'), 'export const limit = 30\n')
    await writeFile(
      join(root, '.doxloop', 'runs', created.id, 'run.json'),
      `${JSON.stringify({
        ...created,
        status: 'stale',
        error: 'Configured source evidence changed after this proposal was generated. Regenerate the proposal before editing or applying it.',
      }, null, 2)}\n`,
    )

    const restored = await readSyncRun(root, created.id)
    expect(restored.status).toBe('awaiting-review')
    expect(restored.error).toBeUndefined()
    expect(restored.advisories).toContainEqual(expect.stringContaining('remains editable and applicable'))
    const applied = await acceptSyncChanges(root, restored.id, restored.changes.map((change) => ({ changeId: change.id })))
    expect(applied.status).toBe('applied')
  }, 20_000)

  test('undoes a complete proposal atomically and refuses to overwrite a later edit', async () => {
    const { root } = await fixture()
    const path = join(root, 'index.mdx')
    const before = await readFile(path, 'utf8')
    const created = await proposal(root, '---\ntitle: Applied\ndescription: Updated limit.\n---\n\nLimit 20.\n')
    const applied = await acceptSyncChanges(root, created.id, created.changes.map((change) => ({ changeId: change.id })))
    expect(applied.undo?.status).toBe('available')

    const undone = await undoSyncRun(root, created.id)
    expect(undone.status).toBe('undone')
    expect(await readFile(path, 'utf8')).toBe(before)

    const second = await proposal(root, '---\ntitle: Applied again\ndescription: Updated limit.\n---\n\nLimit 20.\n')
    await acceptSyncChanges(root, second.id, second.changes.map((change) => ({ changeId: change.id })))
    await writeFile(path, '---\ntitle: Newer edit\ndescription: Keep this.\n---\n\nDo not overwrite.\n')
    await expect(undoSyncRun(root, second.id)).rejects.toThrow('Undo stopped without overwriting')
    expect(await readFile(path, 'utf8')).toContain('Do not overwrite.')
  }, 30_000)

  test('records completed plan-first creation after its proposal is accepted', async () => {
    const { root } = await fixture()
    const created = await proposal(root, '---\ntitle: Created\ndescription: Created documentation.\n---\n\nThe documentation is ready.\n', 'create')

    await acceptSyncChanges(root, created.id, created.changes.map((change) => ({ changeId: change.id })))

    const receipt = JSON.parse(await readFile(join(root, '.doxloop', 'last-run.json'), 'utf8'))
    expect(receipt).toMatchObject({ mode: 'create', proposalId: created.id, validation: { errors: 0 } })
    expect(receipt.completedAt).toBeTruthy()
  }, 20_000)

  test('archives and explicitly cleans up retained proposal workspaces', async () => {
    const { root } = await fixture()
    const created = await proposal(root, '---\ntitle: Proposed\ndescription: Updated limit.\n---\n\nLimit 20.\n')
    const archived = await archiveSyncRun(root, created.id)
    expect(archived.archivedAt).toBeDefined()
    expect(await pruneSyncRuns(root)).toEqual([created.id])
    expect(await listSyncRuns(root)).toEqual([])
  }, 15_000)

  test('prepares a proposal on an isolated pull-request branch without changing the working tree', async () => {
    const { root } = await fixture()
    await git(root, 'init', '--initial-branch=main')
    await git(root, 'add', '.')
    await git(root, 'commit', '-m', 'documentation baseline')
    const created = await proposal(root, '---\ntitle: Updated\ndescription: Updated docs.\n---\n\nThe limit is now 20.\n')
    const delivery = await createProposalBranch(root, created.id, 'doxloop/update-limit')
    expect(delivery).toMatchObject({ branch: 'doxloop/update-limit', baseBranch: 'main' })
    expect(delivery.pullRequestCommand).toBeUndefined()
    expect(await readFile(join(root, '.gitignore'), 'utf8')).toContain('.doxloop/deliveries/')
    expect((await run('git', ['branch', '--show-current'], { cwd: root })).stdout.trim()).toBe('main')
    expect(await readFile(join(root, 'index.mdx'), 'utf8')).toContain('limit is 10')
    expect((await run('git', ['show', 'doxloop/update-limit:index.mdx'], { cwd: root })).stdout).toContain('limit is now 20')
    const remote = join(root, '..', 'delivery-remote.git')
    await git(root, 'init', '--bare', remote)
    await git(root, 'remote', 'add', 'origin', remote)
    const published = await publishProposalBranch(root, created.id, false)
    expect(published.pushedAt).toBeDefined()
    expect((await run('git', ['--git-dir', remote, 'rev-parse', 'refs/heads/doxloop/update-limit'])).stdout.trim()).toBe(delivery.commit)
  }, 30_000)

  test('recovers a failed run with a preserved valid workspace into review', async () => {
    const { root, product } = await fixture()
    const loaded = await loadProject(root)
    const project = { ...loaded, sync: { ...loaded.sync, mode: 'propose' as const } }
    const failed = await createSyncRun({
      root,
      project,
      drift: await computeDrift(root, project),
      sourceChanges: await collectSourceChanges(root, project.sources),
      author: async (options) => {
        // Complete valid authoring, then fail like an agent whose own
        // post-run screenshot validation rejected the manifest.
        await writeFile(
          join(options.root, 'index.mdx'),
          '---\ntitle: Updated\ndescription: The limit changed.\n---\n\nThe limit is now 20.\n',
        )
        await recordSyncState(options.root, (await loadProject(options.root)).sources)
        return 1
      },
    })
    expect(failed.status).toBe('failed')
    expect(failed.error).toContain('exited with status 1')

    const recovered = await recoverSyncRun(root, failed.id)
    expect(recovered.status).toBe('awaiting-review')
    expect(recovered.error).toBeUndefined()
    expect(recovered.changes.map((change) => change.path)).toContain('index.mdx')
    await expect(recoverSyncRun(root, failed.id)).rejects.toThrow('Only a failed or interrupted proposal can be recovered')

    const accepted = await acceptSyncChanges(root, recovered.id, recovered.changes.map((change) => ({ changeId: change.id })))
    expect(accepted.status).toBe('applied')
    expect(await readFile(join(root, 'index.mdx'), 'utf8')).toContain('limit is now 20')

    // A failed run whose evidence changed afterwards is still recovered; the
    // reviewer is told to read it against the current sources instead.
    const failedAgain = await createSyncRun({
      root,
      project,
      drift: await computeDrift(root, project),
      sourceChanges: await collectSourceChanges(root, project.sources),
      author: async (options) => {
        await writeFile(join(options.root, 'quickstart.mdx'), '---\ntitle: Quickstart\ndescription: Updated setup.\n---\n\nFollow the new setup.\n')
        return 1
      },
    })
    expect(failedAgain.status).toBe('failed')
    await writeFile(join(product, 'src', 'limits.ts'), 'export const limit = 30\n')
    await git(product, 'commit', '-am', 'raise limit again')
    const recoveredAgain = await recoverSyncRun(root, failedAgain.id)
    expect(recoveredAgain.status).toBe('awaiting-review')
    expect(recoveredAgain.advisories?.[0]).toContain('sources changed after this run stopped')
    expect(recoveredAgain.sourceSnapshot).not.toBe(failedAgain.sourceSnapshot)
    // The refreshed snapshot lets the reviewer accept it without a stale block.
    const acceptedAgain = await acceptSyncChanges(root, recoveredAgain.id, recoveredAgain.changes.map((change) => ({ changeId: change.id })))
    expect(acceptedAgain.status).toBe('applied')
  }, 30_000)

  test('resumes a failed run in its preserved workspace with a brief of what already exists', async () => {
    const { root } = await fixture()
    const loaded = await loadProject(root)
    const project = { ...loaded, sync: { ...loaded.sync, mode: 'propose' as const } }
    const failed = await createSyncRun({
      root,
      project,
      drift: await computeDrift(root, project),
      sourceChanges: await collectSourceChanges(root, project.sources),
      authoring: { mode: 'update', request: 'Document the raised limit.', screenshots: 'auto' },
      author: async (options) => {
        // Half the work lands, then the agent dies like a timed-out run.
        await writeFile(join(options.root, 'index.mdx'), '---\ntitle: Updated\ndescription: The limit changed.\n---\n\nThe limit is now 20.\n')
        await writeFile(join(options.root, 'notes.txt'), 'partial\n')
        return 1
      },
    })
    expect(failed.status).toBe('failed')
    expect(failed.recovery).toEqual({ resumable: true, ignorable: true })

    let continuation: string | undefined
    let sawPartialWork = false
    const resumed = await resumeSyncRun(root, failed.id, {
      author: async (options) => {
        continuation = options.request
        expect(options.mode).toBe('update')
        expect(options.screenshots).toBe('auto')
        sawPartialWork = (await readFile(join(options.root, 'notes.txt'), 'utf8')) === 'partial\n'
        await writeFile(join(options.root, 'quickstart.mdx'), '---\ntitle: Quickstart\ndescription: Updated setup.\n---\n\nFollow the new setup with limit 20.\n')
        await recordSyncState(options.root, (await loadProject(options.root)).sources)
        return 0
      },
    })
    expect(sawPartialWork).toBe(true)
    expect(continuation).toContain('continues an earlier authoring run')
    expect(continuation).toContain('exited with status 1')
    expect(continuation).toContain('Document the raised limit.')
    expect(continuation).not.toContain('sources changed')
    expect(resumed.id).toBe(failed.id)
    expect(resumed.status).toBe('awaiting-review')
    expect(resumed.resumedAt).toBeDefined()
    expect(resumed.error).toBeUndefined()
    expect(resumed.recovery).toBeUndefined()
    expect(resumed.changes.map((change) => change.path).sort()).toEqual(['index.mdx', 'notes.txt', 'quickstart.mdx'])
    await expect(resumeSyncRun(root, failed.id)).rejects.toThrow('Only a failed or interrupted proposal can be resumed')
  }, 30_000)

  test('recovers a failed run with screenshot problems ignored', async () => {
    const { root } = await fixture()
    const loaded = await loadProject(root)
    const project = { ...loaded, sync: { ...loaded.sync, mode: 'propose' as const } }
    const plan = {
      id: 'plan-test',
      capabilities: [],
      pages: [{
        id: 'quickstart',
        title: 'Quickstart',
        path: 'quickstart',
        type: 'how-to',
        priority: 'must-have',
        action: 'update',
        purpose: 'Start.',
        rationale: 'UI workflow.',
        evidence: [],
        evidenceDetails: [],
        visuals: { mode: 'required', rationale: 'Show the setup screen.', estimatedCaptures: 1, startPath: '/' },
      }],
      target: { generator: 'doxbrix', contentDir: '', contentFormat: 'markdown', pageExtensions: ['.mdx'], navigationFiles: [] },
      execution: { screenshots: 'enabled' },
    } as never
    const failed = await createSyncRun({
      root,
      project,
      plan,
      drift: await computeDrift(root, project),
      sourceChanges: await collectSourceChanges(root, project.sources),
      authoring: { mode: 'update', screenshots: 'enabled' },
      author: async (options) => {
        await writeFile(join(options.root, 'quickstart.mdx'), '---\ntitle: Quickstart\ndescription: Updated setup.\n---\n\nFollow the new setup with limit 20.\n')
        await mkdir(join(options.root, '.doxloop'), { recursive: true })
        await writeFile(join(options.root, '.doxloop', 'documentation-plan.json'), JSON.stringify(plan))
        await writeFile(join(options.root, '.doxloop', 'screenshot-manifest.json'), JSON.stringify({
          schemaVersion: 1,
          guides: [{ page: 'quickstart', steps: [{ id: '01', action: 'Open the application at /.', expectedState: 'The setup screen is visible.', purpose: 'Orient the reader.', capture: true, status: 'planned', sequenceItem: 1 }] }],
        }))
        await recordSyncState(options.root, (await loadProject(options.root)).sources)
        return 0
      },
    })
    expect(failed.status).toBe('failed')
    expect(failed.error).toContain('was never captured')

    await expect(recoverSyncRun(root, failed.id)).rejects.toThrow('was never captured')
    const recovered = await recoverSyncRun(root, failed.id, { ignoreScreenshotProblems: true })
    expect(recovered.status).toBe('awaiting-review')
    expect(recovered.screenshots).toMatchObject({ intent: 'enabled', status: 'skipped', captured: 0, textOnly: 1, ignoredProblems: 1 })
    expect(recovered.screenshots?.message).toContain('ignored')
    expect(recovered.changes.map((change) => change.path)).toContain('quickstart.mdx')
  }, 30_000)
})
