import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, test } from 'vitest'
import { closeHistory, historyAvailable, openHistory } from './db.js'
import { computeDrift } from './drift.js'
import { writeEvidenceMap } from './evidence.js'
import {
  backfillHistory,
  finishRequest,
  listDeployments,
  listPages,
  listRequests,
  pageHistory,
  recordAuthoredPages,
  recordDeployment,
  recordSourceSyncs,
  recordSyncRun,
  requestPages,
  snapshotPages,
  startRequest,
  syncPageRegistry,
} from './history.js'
import { loadProject, scaffoldProject } from './project.js'
import { collectSourceChanges, recordSyncState } from './sync.js'
import { acceptSyncChanges, createSyncRun, rejectSyncRun } from './sync-runs.js'
import type { SyncRun } from './types.js'

const run = promisify(execFile)
const roots: string[] = []
const available = await historyAvailable()
const withSqlite = available ? describe : describe.skip

afterEach(async () => {
  closeHistory()
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
  const parent = await mkdtemp(join(tmpdir(), 'doxloop-history-'))
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
      'index.mdx': {
        sources: [{ source: 'product', paths: ['src/limits.ts'] }],
        confidence: 'verified',
      },
      'quickstart.mdx': { sources: [{ source: 'product', paths: ['src/limits.ts'] }] },
    },
  })
  await recordSyncState(root, (await loadProject(root)).sources)
  await writeFile(join(product, 'src', 'limits.ts'), 'export const limit = 20\n')
  await git(product, 'commit', '-am', 'raise limit')
  return { root, product }
}

async function proposal(root: string, request?: string, mode?: 'create' | 'update', historyRequest?: string): Promise<SyncRun> {
  const loaded = await loadProject(root)
  const project = { ...loaded, sync: { ...loaded.sync, mode: 'propose' as const } }
  return createSyncRun({
    root,
    project,
    drift: await computeDrift(root, project),
    sourceChanges: await collectSourceChanges(root, project.sources),
    ...(request || mode || historyRequest ? { authoring: {
      ...(request ? { request } : {}),
      ...(mode ? { mode } : {}),
      ...(historyRequest ? { historyRequest } : {}),
      agent: 'codex' as const,
    } } : {}),
    author: async (options) => {
      await writeFile(
        join(options.root, 'index.mdx'),
        '---\ntitle: Limits\ndescription: Understand the current product limit.\n---\n\nThe limit is now 20.\n',
      )
      await recordSyncState(options.root, (await loadProject(options.root)).sources)
      return 0
    },
  })
}

async function indexPage(root: string) {
  return (await listPages(root)).find((page) => page.path === 'index.mdx')
}

withSqlite('history storage', () => {
  test('records the request text, not the agent transcript', async () => {
    const { root } = await fixture()
    const created = await proposal(root, 'Document the new limit of 20')
    expect(created.status, created.error).toBe('awaiting-review')

    const [request] = await listRequests(root)
    expect(request?.id).toBe(created.id)
    expect(request?.requestText).toBe('Document the new limit of 20')
    expect(request?.kind).toBe('update')
    expect(request?.agent).toBe('codex')
    expect(request?.status).toBe('awaiting-review')
    expect(request?.pagesChanged).toBeGreaterThan(0)
    expect(request?.linesAdded).toBeGreaterThan(0)
  })

  test('records create proposals as create actions', async () => {
    const { root } = await fixture()
    await proposal(root, 'Internal implementation prompt', 'create', 'Create the initial documentation')

    const [request] = await listRequests(root)
    expect(request?.kind).toBe('create')
    expect(request?.requestText).toBe('Create the initial documentation')
  })

  test('round-trips edit requests and their selected pages', async () => {
    const { root } = await fixture()
    const createdAt = new Date().toISOString()
    await recordSyncRun(root, {
      schemaVersion: 2,
      id: 'run-history-edit',
      status: 'failed',
      mode: 'propose',
      trigger: 'edit',
      createdAt,
      completedAt: createdAt,
      summary: 'Editing Limits',
      sourceSummary: 'No source changes',
      stalePages: [],
      changes: [],
      editRequest: {
        instruction: 'Clarify the supported limit.',
        paths: ['index.mdx'],
        allowRelated: false,
        followUps: [],
      },
      retentionUntil: createdAt,
      revisionRequests: [],
      humanEdits: [],
      error: 'The agent did not change this page. Nothing was applied.',
    }, { runDir: '.doxloop/runs/run-history-edit' })

    expect((await listRequests(root))[0]).toMatchObject({
      id: 'run-history-edit',
      kind: 'edit',
      trigger: 'edit',
      requestText: 'Clarify the supported limit.',
    })
    expect((await requestPages(root, ['run-history-edit']))['run-history-edit']).toEqual([
      expect.objectContaining({ path: 'index.mdx' }),
    ])
  })

  test('follows a proposal through to applied and records the page decision', async () => {
    const { root } = await fixture()
    const created = await proposal(root)
    const change = created.changes.find((entry) => entry.path === 'index.mdx')
    expect(change).toBeDefined()

    await acceptSyncChanges(root, created.id, [{ changeId: change!.id }])

    const [request] = await listRequests(root)
    expect(request?.status).toBe('applied')
    expect(request?.finishedAt).toBeDefined()

    const entries = await pageHistory(root, 'index.mdx')
    expect(entries).toHaveLength(1)
    expect(entries[0]?.decision).toBe('accepted')
    expect(entries[0]?.changeKind).toBe('modified')
    expect(entries[0]?.decidedAt).toBeDefined()
  })

  test('groups the changed pages by request for the workspace table', async () => {
    const { root } = await fixture()
    const created = await proposal(root, 'Document the new limit')
    const change = created.changes.find((entry) => entry.path === 'index.mdx')
    await acceptSyncChanges(root, created.id, [{ changeId: change!.id }])

    const grouped = await requestPages(root, [created.id])
    const pages = grouped[created.id] ?? []
    expect(pages.length).toBeGreaterThan(0)
    const index = pages.find((page) => page.path === 'index.mdx')
    expect(index?.decision).toBe('accepted')
    expect(index?.changeKind).toBe('modified')
    expect(index?.linesAdded).toBeGreaterThan(0)
  })

  test('returns nothing for an empty request list', async () => {
    const { root } = await fixture()
    expect(await requestPages(root, [])).toEqual({})
  })

  test('records a rejected proposal without touching documentation', async () => {
    const { root } = await fixture()
    const created = await proposal(root)
    const before = await readFile(join(root, 'index.mdx'), 'utf8')

    await rejectSyncRun(root, created.id)

    const [request] = await listRequests(root)
    expect(request?.status).toBe('rejected')
    expect((await pageHistory(root, 'index.mdx'))[0]?.decision).toBe('rejected')
    expect(await readFile(join(root, 'index.mdx'), 'utf8')).toBe(before)
  })

  test('keeps history after the run directory is pruned', async () => {
    const { root } = await fixture()
    const created = await proposal(root, 'Keep this request')
    await rm(join(root, '.doxloop', 'runs', created.id), { recursive: true, force: true })

    const [request] = await listRequests(root)
    expect(request?.id).toBe(created.id)
    expect(request?.requestText).toBe('Keep this request')
  })

  test('detects a page edited outside Doxloop', async () => {
    const { root } = await fixture()
    await syncPageRegistry(root)
    const initial = await indexPage(root)
    expect(initial?.evidenceConfidence).toBe('verified')
    expect(initial?.changeCount).toBe(1)

    await writeFile(
      join(root, 'index.mdx'),
      '---\ntitle: Limits\ndescription: Understand the current product limit.\n---\n\nEdited by hand.\n',
    )
    await syncPageRegistry(root)

    expect((await indexPage(root))?.changeCount).toBe(2)
  })

  test('leaves the registry alone when content is unchanged', async () => {
    const { root } = await fixture()
    await syncPageRegistry(root)
    await syncPageRegistry(root)
    expect((await indexPage(root))?.changeCount).toBe(1)
  })

  test('marks a removed page as deleted instead of forgetting it', async () => {
    const { root } = await fixture()
    await syncPageRegistry(root)
    await rm(join(root, 'index.mdx'))
    await syncPageRegistry(root)

    const page = (await listPages(root)).find((entry) => entry.path === 'index.mdx')
    expect(page?.status).toBe('deleted')
  })

  test('records deployments and their failures', async () => {
    const { root } = await fixture()
    await recordDeployment(root, {
      target: 'doxbrix',
      status: 'succeeded',
      startedAt: new Date(Date.now() - 1000).toISOString(),
      slug: 'my-docs',
      pagesCount: 4,
      pagesCreated: 4,
    })
    await recordDeployment(root, {
      target: 'doxbrix',
      status: 'failed',
      startedAt: new Date().toISOString(),
      slug: 'my-docs',
      error: 'Not signed in.',
    })

    const deployments = await listDeployments(root)
    expect(deployments).toHaveLength(2)
    expect(deployments[0]?.status).toBe('failed')
    expect(deployments[0]?.error).toBe('Not signed in.')
    expect(deployments[1]?.pagesCount).toBe(4)
    expect(deployments[1]?.durationMs).toBeGreaterThan(0)
  })

  test('appends source baselines and ignores repeats', async () => {
    const { root } = await fixture()
    const state = {
      schemaVersion: 1 as const,
      sources: { product: { commit: 'abc123', recordedAt: new Date().toISOString() } },
    }
    await recordSourceSyncs(root, state)
    await recordSourceSyncs(root, state)

    const database = await openHistory(root)
    const rows = database?.prepare('SELECT commit_hash FROM source_syncs').all() ?? []
    expect(rows).toHaveLength(1)
  })

  test('closes a request that was opened before the agent started', async () => {
    const { root } = await fixture()
    const id = await startRequest(root, { kind: 'create', requestText: 'Document the API' })
    expect(id).toBeDefined()
    expect((await listRequests(root))[0]?.status).toBe('running')

    await finishRequest(root, id, {
      status: 'completed',
      validation: { pages: 3, errors: 0, warnings: 1 },
    })

    const [request] = await listRequests(root)
    expect(request?.status).toBe('completed')
    expect(request?.validationWarnings).toBe(1)
    expect(request?.durationMs).toBeGreaterThanOrEqual(0)
  })

  test('records the pages an authoring run wrote straight to disk', async () => {
    const { root } = await fixture()
    const id = await startRequest(root, { kind: 'create', requestText: 'Document the limits' })
    const before = await snapshotPages(root)

    await writeFile(
      join(root, 'limits.mdx'),
      '---\ntitle: Limits\ndescription: The documented limit.\n---\n\nThe limit is 20.\n',
    )
    await writeFile(
      join(root, 'index.mdx'),
      '---\ntitle: Limits\ndescription: Understand the current product limit.\n---\n\nThe limit is now 20.\n',
    )
    await rm(join(root, 'quickstart.mdx'))

    const authored = await recordAuthoredPages(root, id, before)
    expect(authored.paths).toEqual(
      new Set(['index.mdx', 'limits.mdx', 'quickstart.mdx']),
    )
    expect(authored.linesAdded).toBeGreaterThan(0)
    expect(authored.linesRemoved).toBeGreaterThan(0)

    await finishRequest(root, id, {
      status: 'completed',
      pagesChanged: authored.paths.size,
      linesAdded: authored.linesAdded,
      linesRemoved: authored.linesRemoved,
    })

    const [request] = await listRequests(root)
    expect(request?.pagesChanged).toBe(3)
    expect(request?.linesAdded).toBe(authored.linesAdded)

    const pages = (await requestPages(root, [id!]))[id!] ?? []
    expect(pages.find((page) => page.path === 'limits.mdx')?.changeKind).toBe('added')
    expect(pages.find((page) => page.path === 'index.mdx')?.changeKind).toBe('modified')
    expect(pages.find((page) => page.path === 'quickstart.mdx')?.changeKind).toBe('deleted')

    const entry = (await pageHistory(root, 'limits.mdx'))[0]
    expect(entry?.decision).toBe('accepted')
    expect(entry?.requestText).toBe('Document the limits')
    expect(entry?.linesAdded).toBeGreaterThan(0)
  })

  test('records nothing for an authoring run that changed no pages', async () => {
    const { root } = await fixture()
    const id = await startRequest(root, { kind: 'update' })
    const before = await snapshotPages(root)

    const authored = await recordAuthoredPages(root, id, before)
    expect(authored.paths.size).toBe(0)
    expect(await requestPages(root, [id!])).toEqual({})
  })

  test('attributes pages a registry refresh recorded mid-run', async () => {
    const { root } = await fixture()
    const id = await startRequest(root, { kind: 'create' })
    const before = await snapshotPages(root)
    await writeFile(
      join(root, 'limits.mdx'),
      '---\ntitle: Limits\ndescription: The documented limit.\n---\n\nThe limit is 20.\n',
    )
    // The workspace server backfills history on startup, which can land between
    // the agent writing a page and the run finishing.
    await syncPageRegistry(root)

    const authored = await recordAuthoredPages(root, id, before)
    await syncPageRegistry(root, undefined, id, authored.paths)

    const database = await openHistory(root)
    const rows =
      (database
        ?.prepare('SELECT path, last_request_id FROM pages ORDER BY path')
        .all() as Array<{ path: string; last_request_id: string | null }>) ?? []
    const written = rows.find((row) => row.path === 'limits.mdx')
    expect(written?.last_request_id).toBe(id)
    // A page the run never touched keeps its own attribution.
    expect(rows.find((row) => row.path === 'quickstart.mdx')?.last_request_id).toBeNull()
  })

  test('imports existing run manifests once', async () => {
    const { root } = await fixture()
    const created = await proposal(root)
    // Simulate a project upgraded from a release without history.
    await rm(join(root, '.doxloop', 'doxloop.db'), { force: true })
    closeHistory()

    const imported = await backfillHistory(root)
    expect(imported).toBe(1)
    expect((await listRequests(root))[0]?.id).toBe(created.id)
    expect(await backfillHistory(root)).toBe(0)
  })

  test('ignores the database when building a proposal', async () => {
    const { root } = await fixture()
    const created = await proposal(root)
    expect(created.changes.some((change) => change.path.includes('doxloop.db'))).toBe(false)
  })

  test('adds the database to .gitignore', async () => {
    const { root } = await fixture()
    await openHistory(root)
    const ignored = await readFile(join(root, '.gitignore'), 'utf8')
    expect(ignored).toContain('.doxloop/doxloop.db')
    expect(ignored).toContain('.doxloop/doxloop.db-wal')
  })

  test('never fails a command when a run cannot be recorded', async () => {
    const { root } = await fixture()
    const broken = {
      schemaVersion: 1,
      id: 'run-invalid',
      status: 'applied',
      createdAt: 'not-a-date',
      changes: [{ hunks: undefined }],
    } as unknown as SyncRun
    await expect(recordSyncRun(root, broken)).resolves.toBeUndefined()
  })
})

describe('history availability', () => {
  test('reports whether the runtime can store history', async () => {
    expect(typeof (await historyAvailable())).toBe('boolean')
  })

  test('records nothing when history is disabled', async () => {
    const { root } = await fixture()
    process.env.DOXLOOP_NO_HISTORY = '1'
    try {
      closeHistory()
      expect(await startRequest(root, { kind: 'create' })).toBeUndefined()
      expect(await listRequests(root)).toEqual([])
    } finally {
      delete process.env.DOXLOOP_NO_HISTORY
      closeHistory()
    }
  })
})
