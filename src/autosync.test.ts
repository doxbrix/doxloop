import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { PassThrough } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, test } from 'vitest'
import {
  applySyncConfig,
  disableSync,
  formatSyncStatus,
  parseSyncMode,
  parseTriggerList,
  replaySyncSetupCommand,
  runSyncNow,
  runSyncSetupWizard,
} from './autosync.js'
import { writeEvidenceMap } from './evidence.js'
import { loadProject, scaffoldProject } from './project.js'
import type { PromptIo } from './prompts.js'
import { readSyncLog } from './schedule.js'
import { recordSyncState } from './sync.js'
import { listSyncRuns } from './sync-runs.js'
import type { DoxloopProject, SyncConfig } from './types.js'

const run = promisify(execFile)
const parents: string[] = []

afterEach(async () => {
  await Promise.all(
    parents.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

async function git(cwd: string, ...args: string[]): Promise<void> {
  await run(
    'git',
    ['-c', 'user.name=Doxloop Test', '-c', 'user.email=test@example.com', ...args],
    { cwd },
  )
}

interface Fixture {
  root: string
  product: string
  project: DoxloopProject
}

async function makeFixture(): Promise<Fixture> {
  const parent = await mkdtemp(join(tmpdir(), 'doxloop-autosync-'))
  parents.push(parent)
  const product = join(parent, 'product')
  await mkdir(join(product, 'src'), { recursive: true })
  await writeFile(join(product, 'src', 'auth.ts'), 'export const ttl = 3600\n', 'utf8')
  await writeFile(join(product, 'src', 'quickstart.ts'), 'export const command = "start"\n', 'utf8')
  await git(product, 'init', '--initial-branch=main')
  await git(product, 'add', '.')
  await git(product, 'commit', '-m', 'initial')

  const root = await scaffoldProject({
    directory: join(parent, 'product-docs'),
    sources: [{ name: 'product', path: '../product' }],
  })
  await writeFile(
    join(root, 'docs', 'index.mdx'),
    '---\ntitle: Authentication\ndescription: Understand the current authentication lifetime.\n---\n\nTokens last 3600 seconds.\n',
  )
  await writeFile(
    join(root, 'docs', 'quickstart.mdx'),
    '---\ntitle: Quickstart\ndescription: Start the product with its supported command.\n---\n\nRun the start command.\n',
  )
  await writeEvidenceMap(root, {
    schemaVersion: 1,
    pages: {
      'docs/index.mdx': { sources: [{ source: 'product', paths: ['src/auth.ts'] }] },
      'docs/quickstart.mdx': {
        sources: [{ source: 'product', paths: ['src/quickstart.ts'] }],
      },
    },
  })
  const project = await loadProject(root)
  await recordSyncState(root, project.sources)
  return { root, product, project }
}

async function changeSource(product: string): Promise<void> {
  await writeFile(join(product, 'src', 'auth.ts'), 'export const ttl = 900\n', 'utf8')
  await git(product, 'commit', '-am', 'shorten token lifetime')
}

const checkManual: SyncConfig = {
  mode: 'check',
  branch: 'main',
  on: [],
  watch: [],
  ignore: [],
}

describe('option parsing', () => {
  test('accepts every supported trigger form', () => {
    expect(parseTriggerList('every@15m')).toEqual(['every@15m'])
    expect(parseTriggerList('manual')).toEqual([])
    expect(parseTriggerList('every@2h')).toEqual(['every@2h'])
    expect(parseTriggerList('weekdays@09:00')).toEqual(['weekdays@09:00'])
    expect(parseTriggerList('weekly@fri@16:30')).toEqual(['weekly@fri@16:30'])
    expect(parseTriggerList('monthly@15@08:00')).toEqual(['monthly@15@08:00'])
  })

  test('rejects an unusable trigger', () => {
    expect(() => parseTriggerList('hourly')).toThrow('Invalid --on value')
    expect(() => parseTriggerList('daily@9:00')).toThrow('Invalid --on value')
  })

  test('accepts the three modes and rejects others', () => {
    expect(parseSyncMode('propose')).toBe('propose')
    expect(() => parseSyncMode('yolo')).toThrow('--mode must be')
  })

  test('replays a configuration as a runnable command', () => {
    expect(replaySyncSetupCommand({ ...checkManual, on: ['every@15m'] })).toBe(
      'doxloop sync setup --mode check --branch main --on every@15m',
    )
    expect(replaySyncSetupCommand(checkManual)).toContain('--on manual')
  })
})

describe('applySyncConfig', () => {
  test('persists a manual configuration without touching the source repository', async () => {
    const { root, project } = await makeFixture()

    const lines = await applySyncConfig(root, project, checkManual)

    expect(lines.join('\n')).toContain('Settings saved')
    expect((await loadProject(root)).sync).toMatchObject({ mode: 'check', on: [] })
  })

  test('refuses scheduled polling until a read-only provider remote is configured', async () => {
    const { root, project } = await makeFixture()
    await expect(
      applySyncConfig(root, project, { ...checkManual, on: ['every@15m'] }),
    ).rejects.toThrow('read-only remote')
  })

  test('keeps the provider branch aligned with the followed branch', async () => {
    const { root, project } = await makeFixture()
    const sources = project.sources.map((source) => ({
      ...source,
      remote: {
        provider: 'github' as const,
        repository: 'acme/product',
        branch: 'main',
      },
    }))
    await applySyncConfig(root, { ...project, sources }, {
      ...checkManual,
      branch: 'release',
    })

    expect((await loadProject(root)).sources[0]?.remote?.branch).toBe('release')
  })
})

describe('runSyncNow', () => {
  test('records a quiet no-op when documentation is current', async () => {
    const { root, project } = await makeFixture()

    expect(await runSyncNow({ root, project, quiet: true })).toBe(0)
    expect((await readSyncLog(root)).at(-1)).toContain('no reader-visible changes')
  })

  test('manual workspace updates create a review proposal even when automatic sync is check-only', async () => {
    const { root, project } = await makeFixture()
    const path = join(root, 'docs', 'quickstart.mdx')
    const before = await readFile(path, 'utf8')

    const exitCode = await runSyncNow({
      root,
      project,
      quiet: true,
      authoring: {
        request: 'Clarify the quickstart.',
        agent: 'codex',
        model: 'gpt-5.6-sol',
        reasoning: 'high',
        screenshots: 'disabled',
      },
      author: async (options) => {
        expect(options).toMatchObject({
          request: 'Clarify the quickstart.',
          agent: 'codex',
          model: 'gpt-5.6-sol',
          reasoning: 'high',
          screenshots: 'disabled',
        })
        await writeFile(
          join(options.root, 'docs', 'quickstart.mdx'),
          '---\ntitle: Quickstart\ndescription: Start the product with a clearer supported command.\n---\n\nRun the supported start command, then verify the service is ready.\n',
        )
        return 0
      },
    })

    expect(exitCode).toBe(0)
    expect(await readFile(path, 'utf8')).toBe(before)
    expect((await listSyncRuns(root))[0]).toMatchObject({
      status: 'awaiting-review',
      trigger: 'manual',
    })
  }, 15_000)

  test('reports drift without starting an agent in check mode', async () => {
    const { root, product, project } = await makeFixture()
    await changeSource(product)

    expect(await runSyncNow({ root, project, quiet: true })).toBe(1)
    expect((await readSyncLog(root)).at(-1)).toContain('1 stale page, reporting only')
  })

  test('refuses to author once the daily budget is spent', async () => {
    const { root, product, project } = await makeFixture()
    await changeSource(product)
    const proposing = {
      ...project,
      sync: {
        ...checkManual,
        mode: 'propose' as const,
        budget: { maxRunsPerDay: 1 },
      },
    }
    const today = new Date().toISOString()
    await writeFile(
      join(root, '.doxloop', 'sync.log'),
      `${today}  update: starting for 1 stale page\n`,
      'utf8',
    )

    expect(await runSyncNow({ root, project: proposing, quiet: true })).toBe(1)
    expect((await readSyncLog(root)).at(-1)).toContain('budget of 1 run per day is spent')
  })

  test('auto mode creates a review run without changing the real documentation', async () => {
    const { root, product, project } = await makeFixture()
    await changeSource(product)
    const automatic = { ...project, sync: { ...checkManual, mode: 'auto' as const } }
    const path = join(root, 'docs', 'index.mdx')
    const before = await readFile(path, 'utf8')

    const exitCode = await runSyncNow({
      root,
      project: automatic,
      quiet: true,
      author: async (options) => {
        await writeFile(
          join(options.root, 'docs', 'index.mdx'),
          '---\ntitle: Updated\ndescription: Understand the updated authentication lifetime.\n---\n\nTokens last 900 seconds.\n',
        )
        const staged = await loadProject(options.root)
        await recordSyncState(options.root, staged.sources)
        return 0
      },
    })

    expect(exitCode).toBe(0)
    expect(await readFile(path, 'utf8')).toBe(before)
    expect((await listSyncRuns(root))[0]).toMatchObject({
      mode: 'auto',
      status: 'awaiting-review',
    })
    expect((await readSyncLog(root)).at(-1)).toContain('ready for review')
  }, 15_000)

  test('propose mode records the trigger and creates an isolated review', async () => {
    const { root, product, project } = await makeFixture()
    await changeSource(product)
    const proposing = { ...project, sync: { ...checkManual, mode: 'propose' as const } }

    const exitCode = await runSyncNow({
      root,
      project: proposing,
      quiet: true,
      trigger: 'schedule',
      author: async (options) => {
        await writeFile(
          join(options.root, 'docs', 'index.mdx'),
          '---\ntitle: Proposed\ndescription: Review the proposed authentication lifetime.\n---\n\nTokens last 900 seconds.\n',
        )
        const staged = await loadProject(options.root)
        await recordSyncState(options.root, staged.sources)
        return 0
      },
    })

    expect(exitCode).toBe(0)
    expect((await listSyncRuns(root))[0]).toMatchObject({
      mode: 'propose',
      trigger: 'schedule',
      status: 'awaiting-review',
    })
  }, 15_000)

  test('proposal generation preserves pre-existing local documentation edits', async () => {
    const { root, product, project } = await makeFixture()
    await changeSource(product)
    const settings = join(root, '.doxloop', 'project.json')
    const userEdit = `${await readFile(settings, 'utf8')}\n`
    await writeFile(settings, userEdit)
    const automatic = { ...project, sync: { ...checkManual, mode: 'auto' as const } }

    expect(
      await runSyncNow({
        root,
        project: automatic,
        quiet: true,
        author: async (options) => {
          await writeFile(
            join(options.root, 'docs', 'index.mdx'),
            '---\ntitle: Safe\ndescription: Review a safe authentication update.\n---\n\nTokens last 900 seconds.\n',
          )
          const staged = await loadProject(options.root)
          await recordSyncState(options.root, staged.sources)
          return 0
        },
      }),
    ).toBe(0)

    expect(await readFile(settings, 'utf8')).toBe(userEdit)
    expect((await listSyncRuns(root))[0]?.changes.map((change) => change.path)).not.toContain(
      '.doxloop/project.json',
    )
  }, 15_000)
})

describe('formatSyncStatus', () => {
  test('shows a disabled project and how to enable it', async () => {
    const { root, project } = await makeFixture()

    const status = await formatSyncStatus(root, project)

    expect(status).toContain('Automatic sync: OFF')
    expect(status).toContain('Enable it with: doxloop sync setup')
  })

})

describe('disableSync', () => {
  test('removes every trigger and keeps the saved settings', async () => {
    const { root, project } = await makeFixture()
    await applySyncConfig(root, project, checkManual)

    const lines = await disableSync(root, await loadProject(root))

    expect(lines.join('\n')).toContain('Settings kept')
    const saved = await loadProject(root)
    expect(saved.sync.on).toEqual([])
    expect(saved.sync.mode).toBe('check')
    expect(saved.sync.branch).toBe('main')
  })
})

function fakeIo(answers: string[]): PromptIo & { rendered: () => string } {
  const input = new PassThrough()
  const output = new PassThrough()
  const queue = [...answers]
  let rendered = ''
  // Each prompt builds its own reader, so answer only when one asks. Writing
  // every line up front would let the first reader swallow the whole script.
  output.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8')
    rendered += text
    if (!/Choose 1-\d+|\(Y\/n\)|\(y\/N\)/.test(text)) return
    const next = queue.shift()
    if (next !== undefined) setImmediate(() => input.write(`${next}\n`))
  })
  return { input, output, rendered: () => rendered }
}

describe('runSyncSetupWizard', () => {
  test('asks three questions and summarizes before changing anything', async () => {
    const { root, project } = await makeFixture()
    const io = fakeIo(['1', '2', '2', 'y'])

    const sync = await runSyncSetupWizard({ root, project, io })

    expect(io.rendered()).toContain('Which branch should documentation follow?')
    expect(io.rendered()).toContain('When should Doxloop look for drift?')
    expect(io.rendered()).toContain('Documentation is stale. What should happen?')
    expect(io.rendered()).toContain('Automatic sync')
    expect(sync).toMatchObject({ on: ['every@1h'], mode: 'propose' })
  })

  test('offers any branch when no remote is configured', async () => {
    const { root, project } = await makeFixture()
    const io = fakeIo(['1', '1', '1', 'n'])

    await runSyncSetupWizard({ root, project, io })

    expect(io.rendered()).toContain('Any branch')
  })

  test('changes nothing when the summary is declined', async () => {
    const { root, project } = await makeFixture()

    const sync = await runSyncSetupWizard({
      root,
      project,
      io: fakeIo(['1', '1', '1', 'n']),
    })

    expect(sync).toBeUndefined()
    expect((await loadProject(root)).sync.on).toEqual([])
  })

  test('states that check mode never starts an agent', async () => {
    const { root, project } = await makeFixture()
    const io = fakeIo(['1', '1', '1', 'y'])

    await runSyncSetupWizard({ root, project, io })

    expect(io.rendered()).toContain('starts an agent, deploys, or writes documentation')
  })
})
