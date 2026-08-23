import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Local history storage.
 *
 * Doxloop ships without a native database dependency: history uses `node:sqlite`,
 * which is built into modern Node runtimes. Older runtimes simply record no
 * history — every call in this module degrades to a no-op rather than failing a
 * command. Documentation stays in git; this database is a derived audit index
 * that can be deleted and rebuilt at any time.
 */

export const DATABASE_FILE = join('.doxloop', 'doxloop.db')

/** The subset of `node:sqlite` this module relies on. */
export interface Statement {
  run(...params: unknown[]): unknown
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
}

export interface Database {
  exec(sql: string): void
  prepare(sql: string): Statement
  close(): void
}

interface SqliteModule {
  DatabaseSync: new (path: string) => Database
}

const SCHEMA: readonly string[] = [
  // 1 — requests, the pages they touched, the page registry, deployments, baselines.
  `
  CREATE TABLE requests (
    id                  TEXT PRIMARY KEY,
    created_at          TEXT NOT NULL,
    finished_at         TEXT,
    duration_ms         INTEGER,
    kind                TEXT NOT NULL,
    trigger             TEXT NOT NULL,
    request_text        TEXT,
    agent               TEXT,
    model               TEXT,
    reasoning_effort    TEXT,
    status              TEXT NOT NULL,
    pages_changed       INTEGER NOT NULL DEFAULT 0,
    lines_added         INTEGER NOT NULL DEFAULT 0,
    lines_removed       INTEGER NOT NULL DEFAULT 0,
    validation_pages    INTEGER,
    validation_errors   INTEGER,
    validation_warnings INTEGER,
    source_summary      TEXT,
    stale_pages_count   INTEGER NOT NULL DEFAULT 0,
    error_message       TEXT,
    run_dir             TEXT
  );
  CREATE INDEX requests_created_at ON requests (created_at DESC);
  CREATE INDEX requests_status ON requests (status);

  CREATE TABLE request_pages (
    request_id    TEXT NOT NULL REFERENCES requests (id) ON DELETE CASCADE,
    path          TEXT NOT NULL,
    title         TEXT,
    change_kind   TEXT NOT NULL,
    category      TEXT NOT NULL,
    decision      TEXT NOT NULL DEFAULT 'pending',
    decided_at    TEXT,
    lines_added   INTEGER NOT NULL DEFAULT 0,
    lines_removed INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (request_id, path)
  );
  CREATE INDEX request_pages_path ON request_pages (path, request_id);

  CREATE TABLE pages (
    path                TEXT PRIMARY KEY,
    title               TEXT,
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL,
    last_request_id     TEXT,
    content_hash        TEXT,
    change_count        INTEGER NOT NULL DEFAULT 0,
    evidence_confidence TEXT,
    status              TEXT NOT NULL DEFAULT 'active'
  );

  CREATE TABLE deployments (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at    TEXT NOT NULL,
    finished_at   TEXT,
    duration_ms   INTEGER,
    target        TEXT NOT NULL,
    name          TEXT,
    slug          TEXT,
    visibility    TEXT,
    url           TEXT,
    status        TEXT NOT NULL,
    pages_count   INTEGER,
    media_count   INTEGER,
    bytes         INTEGER,
    pages_created INTEGER,
    pages_updated INTEGER,
    pages_deleted INTEGER,
    git_commit    TEXT,
    error_message TEXT
  );
  CREATE INDEX deployments_started_at ON deployments (started_at DESC);

  CREATE TABLE source_syncs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    source_name  TEXT NOT NULL,
    -- SQLite treats NULLs as distinct in a UNIQUE constraint, so a source with
    -- no fingerprint would append a duplicate row on every run. Empty strings
    -- keep "already recorded" comparable.
    commit_hash  TEXT NOT NULL DEFAULT '',
    fingerprint  TEXT NOT NULL DEFAULT '',
    recorded_at  TEXT NOT NULL,
    request_id   TEXT,
    UNIQUE (source_name, commit_hash, fingerprint)
  );
  CREATE INDEX source_syncs_name ON source_syncs (source_name, recorded_at DESC);

  CREATE TABLE meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
]

let sqlite: SqliteModule | null | undefined
const connections = new Map<string, Database | null>()

/**
 * Node prints an experimental warning the first time `node:sqlite` loads. The
 * filter is narrow so every other warning still reaches the user, and it stays
 * installed because `process.emitWarning` defers to the next tick.
 */
function silenceSqliteWarning(): void {
  const emit = process.emit.bind(process) as (name: string, ...rest: unknown[]) => boolean
  const filtered = (name: string, ...rest: unknown[]): boolean => {
    const warning = rest[0]
    if (
      name === 'warning' &&
      warning instanceof Error &&
      warning.name === 'ExperimentalWarning' &&
      warning.message.includes('SQLite')
    ) {
      return false
    }
    return emit(name, ...rest)
  }
  process.emit = filtered as unknown as NodeJS.Process['emit']
}

async function loadSqlite(): Promise<SqliteModule | null> {
  if (sqlite !== undefined) return sqlite
  try {
    silenceSqliteWarning()
    sqlite = (await import('node:sqlite')) as unknown as SqliteModule
  } catch {
    // Node 20 and early Node 22 have no built-in SQLite. History is optional.
    sqlite = null
  }
  return sqlite
}

/**
 * Open (and migrate) the history database for a project. Returns `undefined`
 * when history is unavailable, which callers must treat as "skip recording".
 */
export async function openHistory(root: string): Promise<Database | undefined> {
  if (process.env.DOXLOOP_NO_HISTORY === '1') return undefined
  const cached = connections.get(root)
  if (cached !== undefined) return cached ?? undefined

  const loaded = await loadSqlite()
  if (!loaded) {
    connections.set(root, null)
    return undefined
  }
  try {
    const path = join(root, DATABASE_FILE)
    mkdirSync(join(root, '.doxloop'), { recursive: true })
    ensureIgnored(root)
    const database = new loaded.DatabaseSync(path)
    configure(database)
    migrate(database)
    try {
      // History can contain source paths and request text. Keep it owner-only.
      chmodSync(path, 0o600)
    } catch {
      // Windows and some network filesystems do not support POSIX modes.
    }
    connections.set(root, database)
    return database
  } catch (error) {
    debug('open', error)
    connections.set(root, null)
    return undefined
  }
}

/**
 * Projects created before history existed have no ignore rule for it. The
 * database is machine-local and must never reach a commit.
 */
function ensureIgnored(root: string): void {
  const entries = [
    '.doxloop/doxloop.db',
    '.doxloop/doxloop.db-wal',
    '.doxloop/doxloop.db-shm',
  ]
  try {
    const path = join(root, '.gitignore')
    const existing = existsSync(path) ? readFileSync(path, 'utf8') : ''
    const lines = existing.split(/\r?\n/)
    const missing = entries.filter((entry) => !lines.includes(entry))
    if (missing.length === 0) return
    const prefix = existing && !existing.endsWith('\n') ? '\n' : ''
    writeFileSync(path, `${existing}${prefix}${missing.join('\n')}\n`, 'utf8')
  } catch {
    // A read-only checkout still gets history; it just cannot self-ignore.
  }
}

function configure(database: Database): void {
  // WAL lets the UI server read while a CLI job writes; the timeout absorbs the
  // brief lock contention that remains.
  database.exec('PRAGMA journal_mode = WAL')
  database.exec('PRAGMA busy_timeout = 5000')
  database.exec('PRAGMA foreign_keys = ON')
  database.exec('PRAGMA synchronous = NORMAL')
}

function migrate(database: Database): void {
  const row = database.prepare('PRAGMA user_version').get() as
    | { user_version?: number }
    | undefined
  const current = Number(row?.user_version ?? 0)
  if (current >= SCHEMA.length) return
  for (let version = current; version < SCHEMA.length; version += 1) {
    database.exec('BEGIN')
    try {
      database.exec(SCHEMA[version] as string)
      database.exec(`PRAGMA user_version = ${version + 1}`)
      database.exec('COMMIT')
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }
}

/** Run a write against the history database, never failing the caller. */
export async function withHistory<T>(
  root: string,
  action: (database: Database) => T,
): Promise<T | undefined> {
  const database = await openHistory(root)
  if (!database) return undefined
  try {
    return action(database)
  } catch (error) {
    debug('write', error)
    return undefined
  }
}

export function closeHistory(root?: string): void {
  for (const [key, database] of connections) {
    if (root !== undefined && key !== root) continue
    try {
      database?.close()
    } catch {
      // A database closed twice is not worth reporting.
    }
    connections.delete(key)
  }
}

/** True when the runtime can store history at all. */
export async function historyAvailable(): Promise<boolean> {
  return (await loadSqlite()) !== null
}

function debug(stage: string, error: unknown): void {
  if (process.env.DOXLOOP_DEBUG !== '1') return
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`doxloop: history ${stage} failed: ${message}\n`)
}
