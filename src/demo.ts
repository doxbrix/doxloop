import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { closeHistory, withHistory, type Database } from './db.js'
import { DoxloopError } from './errors.js'
import { forgetProject } from './project-registry.js'
import { listSyncRuns } from './sync-runs.js'
import { validateProject } from './validation.js'
import type { ValidationResult } from './types.js'

/** Written by scripts/build-demo-fixture.mjs from a real Doxloop run. */
const FIXTURE_PATH = fileURLToPath(new URL('../assets/demo/pet-store.json.gz', import.meta.url))
const ROOT_PLACEHOLDER = '{{DOXLOOP_DEMO_ROOT}}'
/** The newest recorded activity lands this long before the demo opens. */
const DEMO_RECENCY_MS = 12 * 60_000
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/
/** Copies of page files inside a run; their text must stay byte-identical to the diff. */
const RUN_SNAPSHOT = /\/\.doxloop\/runs\/[^/]+\/(workspace|before|applied|acceptance-before|operational-before)\//

interface DemoBundle {
  schemaVersion: 1
  capturedAt: string
  product: string
  project: string
  files: Array<[path: string, encoding: 'utf8' | 'base64', content: string]>
}

export interface DemoWorkspace {
  /** The temporary folder that holds the product and the documentation project. */
  parent: string
  /** The documentation project the control center opens. */
  root: string
  /** The sample product whose OpenAPI specification the documentation describes. */
  product: string
  validation: ValidationResult
  /** The update Monitoring drafted after the specification changed. */
  pendingProposal?: { id: string; files: number; summary: string; /** The page change with the most edits, which the tour opens first. */ focusChange?: string }
  cleanup(): Promise<void>
}

/**
 * Unpack the bundled Pet Store workspace into an isolated temporary folder.
 *
 * The fixture is a real project: Claude Code planned and wrote its pages from
 * the Pet Store OpenAPI specification, the proposal was accepted, and after
 * the specification moved to 1.1.0 Monitoring drafted the update that waits
 * in Review. Unpacking calls no agent and no network service.
 */
export async function createDemoWorkspace(options: { now?: Date } = {}): Promise<DemoWorkspace> {
  const bundle = await readBundle()
  const parent = await mkdtemp(join(tmpdir(), 'doxloop-demo-'))
  const root = join(parent, bundle.project)
  const product = join(parent, bundle.product)
  const cleanup = async () => {
    await forgetProject(root).catch(() => undefined)
    await rm(parent, { recursive: true, force: true })
  }
  try {
    const shift = (options.now ?? new Date()).getTime() - DEMO_RECENCY_MS - Date.parse(bundle.capturedAt)
    for (const [path, encoding, content] of bundle.files) {
      if (path.split('/').some((segment) => segment === '..' || segment === '')) throw new DoxloopError(`The demo fixture holds an unsafe path: ${path}`)
      const target = join(parent, ...path.split('/'))
      await mkdir(dirname(target), { recursive: true })
      if (encoding === 'base64') {
        await writeFile(target, Buffer.from(content, 'base64'))
        continue
      }
      const text = content.split(ROOT_PLACEHOLDER).join(parent)
      await writeFile(target, isShiftableState(path) ? shiftJsonTimestamps(text, shift) : text, 'utf8')
    }
    await withHistory(root, (database) => shiftDatabaseTimestamps(database, shift))
    closeHistory(root)
    await chmod(join(root, '.doxloop', 'doxloop.db'), 0o600).catch(() => undefined)

    const validation = await validateProject(root)
    if (validation.errors > 0) throw new DoxloopError(`The bundled demo failed its own validation with ${validation.errors} errors.`)
    const pending = (await listSyncRuns(root)).find((run) => ['awaiting-review', 'partially-applied'].includes(run.status))
    return {
      parent,
      root,
      product,
      validation,
      ...(pending ? { pendingProposal: { id: pending.id, files: pending.changes.length, summary: pending.summary, ...focusChange(pending.changes) } } : {}),
      cleanup,
    }
  } catch (error) {
    await cleanup()
    throw error
  }
}

function focusChange(changes: Array<{ id: string; category: string; hunks: unknown[] }>): { focusChange?: string } {
  const page = changes.filter((change) => change.category === 'page').sort((left, right) => right.hunks.length - left.hunks.length)[0]
  return page ? { focusChange: page.id } : {}
}

async function readBundle(): Promise<DemoBundle> {
  let packed: Buffer
  try { packed = await readFile(FIXTURE_PATH) } catch {
    throw new DoxloopError('The bundled demo is missing from this installation. Reinstall @doxbrix/doxloop and try again.')
  }
  const bundle = JSON.parse(gunzipSync(packed).toString('utf8')) as DemoBundle
  if (bundle.schemaVersion !== 1 || !Array.isArray(bundle.files)) throw new DoxloopError('The bundled demo uses an unsupported format.')
  return bundle
}

function isShiftableState(path: string): boolean {
  return path.endsWith('.json') && path.includes('/.doxloop/') && !RUN_SNAPSHOT.test(path)
}

/** Move every recorded moment by the same amount, so the story happened today. */
export function shiftJsonTimestamps(text: string, shiftMs: number): string {
  if (shiftMs === 0) return text
  const shifted = JSON.stringify(shiftValue(JSON.parse(text), shiftMs), null, 2)
  return text.endsWith('\n') ? `${shifted}\n` : shifted
}

function shiftValue(value: unknown, shiftMs: number): unknown {
  if (typeof value === 'string') return shiftTimestamp(value, shiftMs)
  if (Array.isArray(value)) return value.map((item) => shiftValue(item, shiftMs))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shiftValue(item, shiftMs)]))
  return value
}

function shiftTimestamp(value: string, shiftMs: number): string {
  return ISO_TIMESTAMP.test(value) ? new Date(Date.parse(value) + shiftMs).toISOString() : value
}

/** History is optional (Node without SQLite); when it is present its timestamps move with the rest. */
function shiftDatabaseTimestamps(database: Database, shiftMs: number): void {
  const tables = database.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all() as Array<{ name: string }>
  for (const { name } of tables) {
    const columns = (database.prepare(`PRAGMA table_info("${name}")`).all() as Array<{ name: string }>).map((column) => column.name).filter((column) => column.endsWith('_at'))
    if (columns.length === 0) continue
    const rows = database.prepare(`SELECT rowid AS row_id, ${columns.map((column) => `"${column}"`).join(', ')} FROM "${name}"`).all() as Array<Record<string, unknown>>
    const update = database.prepare(`UPDATE "${name}" SET ${columns.map((column) => `"${column}" = ?`).join(', ')} WHERE rowid = ?`)
    for (const row of rows) {
      update.run(...columns.map((column) => typeof row[column] === 'string' ? shiftTimestamp(row[column] as string, shiftMs) : row[column] ?? null), row.row_id)
    }
  }
}

/** The first free local port from `preferred` upward, so a control center that is already running is left alone. */
export async function availableDemoPort(preferred: number): Promise<number> {
  for (let port = preferred; port < preferred + 50; port += 1) {
    if (await portIsFree(port)) return port
  }
  throw new DoxloopError(`No free local port was found from ${preferred} to ${preferred + 49}. Pass --port to choose one.`)
}

function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolvePort) => {
    const server = createServer()
    server.once('error', () => resolvePort(false))
    server.listen(port, '127.0.0.1', () => server.close(() => resolvePort(true)))
  })
}
