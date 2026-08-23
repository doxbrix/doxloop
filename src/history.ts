import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { openHistory, withHistory, type Database } from './db.js'
import { readEvidenceMap } from './evidence.js'
import { pathExists } from './fs.js'
import { loadPages, loadProject } from './project.js'
import { lineHunks } from './text-diff.js'
import type {
  DeploymentRecord,
  DoxloopProject,
  HistoryChangedPage,
  HistoryPage,
  HistoryRequest,
  HistoryRequestPage,
  RequestKind,
  RequestStatus,
  SyncFileChange,
  SyncRun,
  SyncState,
} from './types.js'

/**
 * Recording is deliberately narrow: the request, its outcome, and the pages it
 * touched. Agent transcripts stay in `.doxloop/ui-job-logs`, diffs stay in
 * `.doxloop/runs`, and page content stays in git.
 */

export interface StartRequestInput {
  kind: RequestKind
  trigger?: 'manual' | 'schedule' | 'watch'
  requestText?: string | undefined
  agent?: string | undefined
  model?: string | undefined
  reasoningEffort?: string | undefined
}

export interface FinishRequestInput {
  status: RequestStatus
  validation?: { pages: number; errors: number; warnings: number } | undefined
  pagesChanged?: number
  linesAdded?: number
  linesRemoved?: number
  error?: string | undefined
}

/** Open a request row before the agent starts, so an interrupted run is still visible. */
export async function startRequest(
  root: string,
  input: StartRequestInput,
): Promise<string | undefined> {
  const id = `req-${randomUUID().slice(0, 12)}`
  const recorded = await withHistory(root, (database) => {
    database
      .prepare(
        `INSERT INTO requests (id, created_at, kind, trigger, request_text, agent, model,
           reasoning_effort, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running')`,
      )
      .run(
        id,
        now(),
        input.kind,
        input.trigger ?? 'manual',
        text(input.requestText),
        text(input.agent),
        text(input.model),
        text(input.reasoningEffort),
      )
    return id
  })
  return recorded
}

export async function finishRequest(
  root: string,
  id: string | undefined,
  input: FinishRequestInput,
): Promise<void> {
  if (!id) return
  await withHistory(root, (database) => {
    database
      .prepare(
        `UPDATE requests
            SET finished_at = ?,
                duration_ms = CAST((julianday(?) - julianday(created_at)) * 86400000 AS INTEGER),
                status = ?,
                pages_changed = COALESCE(?, pages_changed),
                lines_added = COALESCE(?, lines_added),
                lines_removed = COALESCE(?, lines_removed),
                validation_pages = ?,
                validation_errors = ?,
                validation_warnings = ?,
                error_message = ?
          WHERE id = ?`,
      )
      .run(
        now(),
        now(),
        input.status,
        input.pagesChanged ?? null,
        input.linesAdded ?? null,
        input.linesRemoved ?? null,
        input.validation?.pages ?? null,
        input.validation?.errors ?? null,
        input.validation?.warnings ?? null,
        text(input.error),
        id,
      )
  })
}

/** Page content as it stood before an agent ran, keyed by project-relative path. */
export type PageSnapshot = ReadonlyMap<string, string>

export interface AuthoredPages {
  /** Paths the agent added, rewrote, or removed. */
  paths: Set<string>
  linesAdded: number
  linesRemoved: number
}

/**
 * Capture page content so a direct authoring run can be measured afterwards.
 * Held in memory rather than read back from the page registry: the UI server
 * backfills that registry on startup, which would otherwise claim the pages a
 * still-running agent is in the middle of writing.
 */
export async function snapshotPages(
  root: string,
  project?: DoxloopProject,
): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>()
  try {
    const resolved = project ?? (await loadProject(root))
    for (const absolute of await loadPages(root, resolved)) {
      snapshot.set(portable(relative(root, absolute)), await readFile(absolute, 'utf8'))
    }
  } catch {
    // A project with no content directory yet simply starts from nothing.
  }
  return snapshot
}

/**
 * Record what an authoring run changed. `create` and `update` write straight to
 * disk instead of producing a proposal, so the diff against the pre-run
 * snapshot is the only account of which pages the request touched.
 */
export async function recordAuthoredPages(
  root: string,
  requestId: string | undefined,
  before: PageSnapshot,
  project?: DoxloopProject,
): Promise<AuthoredPages> {
  const result: AuthoredPages = { paths: new Set(), linesAdded: 0, linesRemoved: 0 }
  const after = await snapshotPages(root, project)
  const changes: Array<{
    path: string
    kind: 'added' | 'modified' | 'deleted'
    title: string | null
    added: number
    removed: number
  }> = []

  const paths = new Set([...before.keys(), ...after.keys()])
  for (const path of [...paths].sort()) {
    const previous = before.get(path)
    const current = after.get(path)
    if (previous === current) continue
    let added = 0
    let removed = 0
    for (const hunk of lineHunks(previous ?? '', current ?? '', path)) {
      added += hunk.newLines.length
      removed += hunk.oldLines.length
    }
    result.paths.add(path)
    result.linesAdded += added
    result.linesRemoved += removed
    changes.push({
      path,
      kind: current === undefined ? 'deleted' : previous === undefined ? 'added' : 'modified',
      title: text(frontmatterTitle(current ?? previous ?? '')),
      added,
      removed,
    })
  }

  if (!requestId || changes.length === 0) return result
  await withHistory(root, (database) => {
    const timestamp = now()
    // Authoring writes straight to the working tree, so every page it touched is
    // already in effect — there is no pending decision to make later.
    const upsert = database.prepare(
      `INSERT INTO request_pages (request_id, path, title, change_kind, category, decision,
         decided_at, lines_added, lines_removed)
       VALUES (?, ?, ?, ?, 'page', 'accepted', ?, ?, ?)
       ON CONFLICT (request_id, path) DO UPDATE SET
         title = excluded.title,
         change_kind = excluded.change_kind,
         lines_added = excluded.lines_added,
         lines_removed = excluded.lines_removed`,
    )
    for (const change of changes) {
      upsert.run(
        requestId,
        change.path,
        change.title,
        change.kind,
        timestamp,
        change.added,
        change.removed,
      )
    }
  })
  return result
}

export interface SyncRunContext {
  requestText?: string | undefined
  agent?: string | undefined
  model?: string | undefined
  reasoningEffort?: string | undefined
  runDir?: string | undefined
}

/**
 * Mirror a proposal into history. Called on every status change, so the row
 * survives even when the run directory is later pruned.
 */
export async function recordSyncRun(
  root: string,
  run: SyncRun,
  context: SyncRunContext = {},
): Promise<void> {
  await withHistory(root, (database) => {
    const counts = lineCounts(run.changes)
    const finishedAt = run.appliedAt ?? run.rejectedAt ?? run.completedAt ?? null
    database
      .prepare(
        `INSERT INTO requests (id, created_at, finished_at, duration_ms, kind, trigger,
           request_text, agent, model, reasoning_effort, status, pages_changed, lines_added,
           lines_removed, validation_pages, validation_errors, validation_warnings,
           source_summary, stale_pages_count, error_message, run_dir)
         VALUES (?, ?, ?, ?, 'update', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
           finished_at = excluded.finished_at,
           duration_ms = excluded.duration_ms,
           status = excluded.status,
           pages_changed = excluded.pages_changed,
           lines_added = excluded.lines_added,
           lines_removed = excluded.lines_removed,
           validation_pages = excluded.validation_pages,
           validation_errors = excluded.validation_errors,
           validation_warnings = excluded.validation_warnings,
           source_summary = excluded.source_summary,
           stale_pages_count = excluded.stale_pages_count,
           error_message = excluded.error_message,
           request_text = COALESCE(excluded.request_text, requests.request_text),
           agent = COALESCE(excluded.agent, requests.agent),
           model = COALESCE(excluded.model, requests.model)`,
      )
      .run(
        run.id,
        run.createdAt,
        finishedAt,
        finishedAt ? elapsed(run.createdAt, finishedAt) : null,
        run.trigger,
        text(context.requestText),
        text(context.agent),
        text(context.model),
        text(context.reasoningEffort),
        run.status,
        run.changes.length,
        counts.added,
        counts.removed,
        run.validation?.pages ?? null,
        run.validation?.errors ?? null,
        run.validation?.warnings ?? null,
        text(run.sourceSummary),
        run.stalePages.length,
        text(run.error),
        text(context.runDir),
      )

    const upsertPage = database.prepare(
      `INSERT INTO request_pages (request_id, path, title, change_kind, category, decision,
         decided_at, lines_added, lines_removed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (request_id, path) DO UPDATE SET
         decision = excluded.decision,
         decided_at = excluded.decided_at,
         lines_added = excluded.lines_added,
         lines_removed = excluded.lines_removed`,
    )
    for (const change of run.changes) {
      const decision = changeDecision(change)
      const changeCounts = lineCounts([change])
      upsertPage.run(
        run.id,
        change.path,
        text(change.title),
        change.kind,
        change.category,
        decision.state,
        decision.at,
        changeCounts.added,
        changeCounts.removed,
      )
    }
  })
}

/** Append the baselines a run was written against. Ignores repeats. */
export async function recordSourceSyncs(
  root: string,
  state: SyncState | undefined,
  requestId?: string,
): Promise<void> {
  if (!state) return
  await withHistory(root, (database) => {
    const insert = database.prepare(
      `INSERT OR IGNORE INTO source_syncs (source_name, commit_hash, fingerprint, recorded_at,
         request_id)
       VALUES (?, ?, ?, ?, ?)`,
    )
    for (const [name, record] of Object.entries(state.sources)) {
      insert.run(
        name,
        record.commit ?? '',
        record.contentFingerprint ?? '',
        record.recordedAt,
        text(requestId),
      )
    }
  })
}

export interface DeploymentInput {
  target: string
  status: 'succeeded' | 'failed'
  startedAt: string
  name?: string | undefined
  slug?: string | undefined
  visibility?: string | undefined
  url?: string | undefined
  pagesCount?: number | undefined
  mediaCount?: number | undefined
  bytes?: number | undefined
  pagesCreated?: number | undefined
  pagesUpdated?: number | undefined
  pagesDeleted?: number | undefined
  error?: string | undefined
}

export async function recordDeployment(root: string, input: DeploymentInput): Promise<void> {
  await withHistory(root, (database) => {
    const finishedAt = now()
    database
      .prepare(
        `INSERT INTO deployments (started_at, finished_at, duration_ms, target, name, slug,
           visibility, url, status, pages_count, media_count, bytes, pages_created,
           pages_updated, pages_deleted, error_message)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.startedAt,
        finishedAt,
        elapsed(input.startedAt, finishedAt),
        input.target,
        text(input.name),
        text(input.slug),
        text(input.visibility),
        text(input.url),
        input.status,
        input.pagesCount ?? null,
        input.mediaCount ?? null,
        input.bytes ?? null,
        input.pagesCreated ?? null,
        input.pagesUpdated ?? null,
        input.pagesDeleted ?? null,
        text(input.error),
      )
  })
}

/**
 * Reconcile the page registry with what is on disk. Content hashes make edits
 * that bypassed Doxloop visible instead of silently absent from history.
 */
export async function syncPageRegistry(
  root: string,
  project?: DoxloopProject,
  requestId?: string,
  authored?: ReadonlySet<string>,
): Promise<void> {
  const database = await openHistory(root)
  if (!database) return
  try {
    const resolved = project ?? (await loadProject(root))
    const contentRoot = join(root, resolved.contentDir)
    const absolutePaths = await loadPages(root, resolved)
    const evidence = await readEvidenceMap(root)
    const seen = new Set<string>()
    const timestamp = now()

    for (const absolute of absolutePaths) {
      const path = portable(relative(root, absolute))
      seen.add(path)
      const content = await readFile(absolute, 'utf8')
      const hash = createHash('sha256').update(content).digest('hex')
      const title = frontmatterTitle(content) ?? portable(relative(contentRoot, absolute))
      const confidence = evidence?.pages[path]?.confidence
      const existing = database
        .prepare('SELECT content_hash FROM pages WHERE path = ?')
        .get(path) as { content_hash?: string } | undefined
      if (existing?.content_hash === hash) {
        database
          .prepare('UPDATE pages SET title = ?, evidence_confidence = ?, status = ? WHERE path = ?')
          .run(title, text(confidence), 'active', path)
        // A registry refresh may have recorded this content first — the UI server
        // backfills on startup, mid-run. The hash then matches even though this
        // request is what wrote the page, so attribution has to be set explicitly.
        if (requestId && authored?.has(path)) {
          database
            .prepare('UPDATE pages SET last_request_id = ? WHERE path = ?')
            .run(requestId, path)
        }
        continue
      }
      database
        .prepare(
          `INSERT INTO pages (path, title, created_at, updated_at, last_request_id, content_hash,
             change_count, evidence_confidence, status)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?, 'active')
           ON CONFLICT (path) DO UPDATE SET
             title = excluded.title,
             updated_at = excluded.updated_at,
             last_request_id = excluded.last_request_id,
             content_hash = excluded.content_hash,
             change_count = pages.change_count + 1,
             evidence_confidence = excluded.evidence_confidence,
             status = 'active'`,
        )
        .run(path, title, timestamp, timestamp, text(requestId), hash, text(confidence))
    }

    const known = database.prepare("SELECT path FROM pages WHERE status = 'active'").all() as Array<{
      path: string
    }>
    for (const row of known) {
      if (seen.has(row.path)) continue
      database
        .prepare("UPDATE pages SET status = 'deleted', updated_at = ?, last_request_id = ? WHERE path = ?")
        .run(timestamp, text(requestId), row.path)
    }
  } catch {
    // A registry refresh is best effort; documentation commands must not fail on it.
  }
}

export async function listRequests(root: string, limit = 20): Promise<HistoryRequest[]> {
  const rows = await withHistory(root, (database) =>
    database
      .prepare(
        `SELECT id, created_at, finished_at, duration_ms, kind, trigger, request_text, agent,
                model, status, pages_changed, lines_added, lines_removed, validation_errors,
                validation_warnings, source_summary, error_message
           FROM requests
          ORDER BY created_at DESC
          LIMIT ?`,
      )
      .all(limit),
  )
  return (rows ?? []).map(toRequest)
}

/**
 * The pages each request touched, keyed by request id. Attached to a request
 * list so the workspace can show what changed without a second round trip.
 */
export async function requestPages(
  root: string,
  requestIds: readonly string[],
): Promise<Record<string, HistoryChangedPage[]>> {
  if (requestIds.length === 0) return {}
  const rows = await withHistory(root, (database) =>
    database
      .prepare(
        `SELECT request_id, path, title, change_kind, decision, lines_added, lines_removed
           FROM request_pages
          WHERE request_id IN (${requestIds.map(() => '?').join(', ')})
          ORDER BY path`,
      )
      .all(...requestIds),
  )
  const grouped: Record<string, HistoryChangedPage[]> = {}
  for (const row of rows ?? []) {
    const record = row as Record<string, unknown>
    const id = String(record.request_id)
    const pages = grouped[id] ?? (grouped[id] = [])
    pages.push({
      path: String(record.path),
      title: optional(record.title),
      changeKind: String(record.change_kind) as HistoryChangedPage['changeKind'],
      decision: String(record.decision) as HistoryChangedPage['decision'],
      linesAdded: Number(record.lines_added ?? 0),
      linesRemoved: Number(record.lines_removed ?? 0),
    })
  }
  return grouped
}

export async function pageHistory(
  root: string,
  path: string,
  limit = 20,
): Promise<HistoryRequestPage[]> {
  const rows = await withHistory(root, (database) =>
    database
      .prepare(
        `SELECT rp.request_id, rp.path, rp.title, rp.change_kind, rp.decision, rp.decided_at,
                rp.lines_added, rp.lines_removed, r.created_at, r.request_text, r.agent, r.status
           FROM request_pages rp
           JOIN requests r ON r.id = rp.request_id
          WHERE rp.path = ?
          ORDER BY r.created_at DESC
          LIMIT ?`,
      )
      .all(path, limit),
  )
  return (rows ?? []).map((row) => {
    const record = row as Record<string, unknown>
    return {
      requestId: String(record.request_id),
      path: String(record.path),
      title: optional(record.title),
      changeKind: String(record.change_kind) as HistoryRequestPage['changeKind'],
      decision: String(record.decision) as HistoryRequestPage['decision'],
      decidedAt: optional(record.decided_at),
      linesAdded: Number(record.lines_added ?? 0),
      linesRemoved: Number(record.lines_removed ?? 0),
      requestedAt: String(record.created_at),
      requestText: optional(record.request_text),
      agent: optional(record.agent),
      requestStatus: String(record.status) as RequestStatus,
    }
  })
}

export async function listPages(root: string): Promise<HistoryPage[]> {
  const rows = await withHistory(root, (database) =>
    database
      .prepare(
        `SELECT path, title, created_at, updated_at, change_count, evidence_confidence, status
           FROM pages
          ORDER BY updated_at DESC`,
      )
      .all(),
  )
  return (rows ?? []).map((row) => {
    const record = row as Record<string, unknown>
    return {
      path: String(record.path),
      title: optional(record.title),
      createdAt: String(record.created_at),
      updatedAt: String(record.updated_at),
      changeCount: Number(record.change_count ?? 0),
      evidenceConfidence: optional(record.evidence_confidence),
      status: String(record.status) as HistoryPage['status'],
    }
  })
}

export async function listDeployments(root: string, limit = 20): Promise<DeploymentRecord[]> {
  const rows = await withHistory(root, (database) =>
    database
      .prepare(
        `SELECT started_at, finished_at, duration_ms, target, name, slug, visibility, url, status,
                pages_count, pages_created, pages_updated, pages_deleted, error_message
           FROM deployments
          ORDER BY started_at DESC
          LIMIT ?`,
      )
      .all(limit),
  )
  return (rows ?? []).map((row) => {
    const record = row as Record<string, unknown>
    return {
      startedAt: String(record.started_at),
      finishedAt: optional(record.finished_at),
      durationMs: record.duration_ms === null ? undefined : Number(record.duration_ms),
      target: String(record.target),
      name: optional(record.name),
      slug: optional(record.slug),
      visibility: optional(record.visibility),
      url: optional(record.url),
      status: String(record.status) as DeploymentRecord['status'],
      pagesCount: record.pages_count === null ? undefined : Number(record.pages_count),
      pagesCreated: record.pages_created === null ? undefined : Number(record.pages_created),
      pagesUpdated: record.pages_updated === null ? undefined : Number(record.pages_updated),
      pagesDeleted: record.pages_deleted === null ? undefined : Number(record.pages_deleted),
      error: optional(record.error_message),
    }
  })
}

/**
 * Import the JSON state written before history existed, so an upgraded project
 * does not start empty. Runs once; the marker keeps later commands cheap.
 */
export async function backfillHistory(root: string, force = false): Promise<number> {
  const database = await openHistory(root)
  if (!database) return 0
  try {
    if (!force) {
      const marker = database.prepare("SELECT value FROM meta WHERE key = 'backfilled_at'").get()
      if (marker) return 0
    }
    let imported = 0
    const runsRoot = join(root, '.doxloop', 'runs')
    if (await pathExists(runsRoot)) {
      const { readdir } = await import('node:fs/promises')
      const entries = await readdir(runsRoot, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const manifest = join(runsRoot, entry.name, 'run.json')
        if (!(await pathExists(manifest))) continue
        try {
          const run = JSON.parse(await readFile(manifest, 'utf8')) as SyncRun
          if (run.schemaVersion !== 1 || !Array.isArray(run.changes)) continue
          await recordSyncRun(root, run, { runDir: join('.doxloop', 'runs', entry.name) })
          imported += 1
        } catch {
          // An interrupted run directory is not history worth importing.
        }
      }
    }

    const syncState = join(root, '.doxloop', 'sync-state.json')
    if (await pathExists(syncState)) {
      try {
        await recordSourceSyncs(root, JSON.parse(await readFile(syncState, 'utf8')) as SyncState)
      } catch {
        // A malformed baseline file simply contributes nothing.
      }
    }

    await syncPageRegistry(root)
    database
      .prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('backfilled_at', ?)")
      .run(now())
    return imported
  } catch {
    return 0
  }
}

export function formatRequestHistory(requests: readonly HistoryRequest[]): string {
  if (requests.length === 0) {
    return 'No documentation history recorded yet.'
  }
  const lines = requests.map((request) => {
    const when = request.createdAt.replace('T', ' ').slice(0, 16)
    const changes =
      request.pagesChanged > 0
        ? `${request.pagesChanged} page${request.pagesChanged === 1 ? '' : 's'} (+${request.linesAdded}/-${request.linesRemoved})`
        : 'no changes'
    const detail = request.requestText
      ? `\n      "${truncate(request.requestText, 96)}"`
      : request.sourceSummary
        ? `\n      ${truncate(request.sourceSummary, 96)}`
        : ''
    return `  ${statusMark(request.status)} ${when}  ${request.kind.padEnd(6)} ${changes}${request.agent ? ` · ${request.agent}` : ''}${detail}`
  })
  return `Documentation history (${requests.length} most recent)\n${lines.join('\n')}`
}

function statusMark(status: RequestStatus): string {
  if (status === 'applied') return '✓'
  if (status === 'rejected') return '✗'
  if (status === 'failed') return '!'
  if (status === 'running' || status === 'generating') return '·'
  return '○'
}

function toRequest(row: unknown): HistoryRequest {
  const record = row as Record<string, unknown>
  return {
    id: String(record.id),
    createdAt: String(record.created_at),
    finishedAt: optional(record.finished_at),
    durationMs: record.duration_ms === null ? undefined : Number(record.duration_ms),
    kind: String(record.kind) as RequestKind,
    trigger: String(record.trigger) as HistoryRequest['trigger'],
    requestText: optional(record.request_text),
    agent: optional(record.agent),
    model: optional(record.model),
    status: String(record.status) as RequestStatus,
    pagesChanged: Number(record.pages_changed ?? 0),
    linesAdded: Number(record.lines_added ?? 0),
    linesRemoved: Number(record.lines_removed ?? 0),
    validationErrors:
      record.validation_errors === null ? undefined : Number(record.validation_errors),
    validationWarnings:
      record.validation_warnings === null ? undefined : Number(record.validation_warnings),
    sourceSummary: optional(record.source_summary),
    error: optional(record.error_message),
  }
}

function changeDecision(change: SyncFileChange): { state: string; at: string | null } {
  const decided = change.hunks.filter((hunk) => hunk.acceptedAt || hunk.rejectedAt)
  if (decided.length === 0) return { state: 'pending', at: null }
  const accepted = change.hunks.filter((hunk) => hunk.acceptedAt)
  const at =
    decided
      .map((hunk) => hunk.acceptedAt ?? hunk.rejectedAt ?? '')
      .sort()
      .at(-1) ?? null
  if (accepted.length === change.hunks.length) return { state: 'accepted', at }
  if (accepted.length === 0 && decided.length === change.hunks.length) {
    return { state: 'rejected', at }
  }
  return { state: 'partial', at }
}

function lineCounts(changes: readonly SyncFileChange[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const change of changes) {
    for (const hunk of change.hunks) {
      added += hunk.newLines.length
      removed += hunk.oldLines.length
    }
  }
  return { added, removed }
}

function frontmatterTitle(content: string): string | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)
  if (!match) return undefined
  const title = /^title:\s*(.+)$/m.exec(match[1] ?? '')
  return title?.[1]?.trim().replace(/^["']|["']$/g, '') || undefined
}

function elapsed(from: string, to: string): number | null {
  const start = Date.parse(from)
  const end = Date.parse(to)
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null
}

function truncate(value: string, length: number): string {
  const single = value.replace(/\s+/g, ' ').trim()
  return single.length > length ? `${single.slice(0, length - 1)}…` : single
}

function portable(path: string): string {
  return path.split('\\').join('/')
}

function optional(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function text(value: string | undefined): string | null {
  return value === undefined || value === '' ? null : value
}

function now(): string {
  return new Date().toISOString()
}

export type { Database }
