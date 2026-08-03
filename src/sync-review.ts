import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DoxloopError } from './errors.js'
import { pathExists } from './fs.js'
import { readPage } from './project.js'
import { unifiedRows } from './review-diff.js'
import { renderedDiff, renderedDiffDocument, type RenderedSide } from './review-render.js'
import { reviewDocument } from './review-ui.js'
import {
  acceptSyncChanges,
  listSyncRuns,
  readSyncRun,
  rejectSyncRun,
  runBeforeRoot,
  runWorkspace,
  type AcceptSelection,
} from './sync-runs.js'
import type { SyncFileChange, SyncRun } from './types.js'

interface ReviewOptions {
  root: string
  host: string
  port: number
  open: boolean
}

const PACKAGE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const DOXBRIX_CSS = resolve(PACKAGE_ROOT, 'assets', 'doxbrix-preview.css')
const BRAND = {
  '/brand/logo.png': resolve(PACKAGE_ROOT, 'assets', 'brand', 'doxloop-logo-light.png'),
  '/brand/favicon.png': resolve(PACKAGE_ROOT, 'assets', 'brand', 'doxloop-favicon.png'),
} as const

/** Screens the single-page application owns; each one serves the shell. */
const APP_ROUTES = /^\/(?:runs\/[a-z0-9-]+(?:\/pages\/\d+|\/files\/change-\d+|\/done)?\/?)?$/

export async function startSyncReview(options: ReviewOptions): Promise<void> {
  const token = randomBytes(24).toString('hex')
  const readerCss = await readFile(DOXBRIX_CSS, 'utf8')
  const server = createServer((request, response) => {
    void handle(request, response, options, token, readerCss)
  })

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(options.port, options.host, resolveListen)
  })
  const url = `http://${shownHost(options.host)}:${options.port}`
  process.stdout.write(
    `Doxloop review center: ${url}\nThe actual documentation changes only after you accept a proposal.\nPress Ctrl+C to stop.\n`,
  )
  if (options.open) openBrowser(url)

  let stopping = false
  const stop = async (): Promise<void> => {
    if (stopping) return
    stopping = true
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
  }
  process.once('SIGINT', () => void stop())
  process.once('SIGTERM', () => void stop())
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  options: ReviewOptions,
  token: string,
  readerCss: string,
): Promise<void> {
  try {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`)
    if (request.method === 'GET' && APP_ROUTES.test(url.pathname)) {
      send(response, 200, 'text/html; charset=utf-8', reviewDocument(token))
      return
    }
    if (request.method === 'GET' && url.pathname === '/reader.css') {
      send(response, 200, 'text/css; charset=utf-8', readerCss)
      return
    }
    const brand = BRAND[url.pathname as keyof typeof BRAND]
    if (request.method === 'GET' && brand) {
      sendBinary(response, 200, 'image/png', await readFile(brand))
      return
    }
    if (request.method === 'GET' && url.pathname === '/api/runs') {
      sendJson(response, 200, await listSyncRuns(options.root))
      return
    }
    const diff = /^\/api\/runs\/([a-z0-9-]+)\/changes\/(change-\d+)\/diff$/.exec(url.pathname)
    if (request.method === 'GET' && diff) {
      const run = await readSyncRun(options.root, diff[1]!)
      sendJson(response, 200, await syncReviewSourceDiff(options.root, run, requireSyncReviewChange(run, diff[2]!)))
      return
    }
    const apiRun = /^\/api\/runs\/([a-z0-9-]+)$/.exec(url.pathname)
    if (request.method === 'GET' && apiRun) {
      sendJson(response, 200, await readSyncRun(options.root, apiRun[1]!))
      return
    }
    const preview = /^\/preview\/([a-z0-9-]+)\/(change-\d+)$/.exec(url.pathname)
    if (request.method === 'GET' && preview) {
      const run = await readSyncRun(options.root, preview[1]!)
      send(
        response,
        200,
        'text/html; charset=utf-8',
        await syncReviewComparisonDocument(options.root, run, requireSyncReviewChange(run, preview[2]!), {
          layout: url.searchParams.get('layout') === 'unified' ? 'unified' : 'split',
          onlyChanges: url.searchParams.get('only') === '1',
        }),
      )
      return
    }
    const action = /^\/api\/runs\/([a-z0-9-]+)\/(accept|reject)$/.exec(url.pathname)
    if (request.method === 'POST' && action) {
      requireToken(request, token)
      if (action[2] === 'reject') {
        sendJson(response, 200, await rejectSyncRun(options.root, action[1]!))
        return
      }
      const body = await readBody(request)
      const run = await readSyncRun(options.root, action[1]!)
      const selections = syncReviewSelectionsFromBody(run, body)
      sendJson(response, 200, await acceptSyncChanges(options.root, run.id, selections))
      return
    }
    sendJson(response, 404, { error: 'Not found' })
  } catch (error) {
    sendJson(response, error instanceof DoxloopError ? 409 : 500, {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

export function requireSyncReviewChange(run: SyncRun, id: string): SyncFileChange {
  const change = run.changes.find((candidate) => candidate.id === id)
  if (!change) throw new DoxloopError('The requested documentation change does not exist.')
  return change
}

export function syncReviewSelectionsFromBody(run: SyncRun, body: unknown): AcceptSelection[] {
  if (!body || typeof body !== 'object') throw new DoxloopError('Invalid review action.')
  const value = body as { scope?: unknown; changeId?: unknown; hunkId?: unknown }
  if (value.scope === 'all') {
    return run.changes.map((change) => ({ changeId: change.id }))
  }
  if (typeof value.changeId !== 'string') {
    throw new DoxloopError('Select a documentation page or change.')
  }
  if (value.scope === 'page') return [{ changeId: value.changeId }]
  if (value.scope === 'hunk' && typeof value.hunkId === 'string') {
    return [{ changeId: value.changeId, hunkIds: [value.hunkId] }]
  }
  throw new DoxloopError('Invalid review selection.')
}

/** Unified diff of the proposal against the file as it stood when it was generated. */
export async function syncReviewSourceDiff(
  root: string,
  run: SyncRun,
  change: SyncFileChange,
): Promise<{ binary: boolean; rows: unknown[]; added: number; removed: number }> {
  if (change.binary) return { binary: true, rows: [], added: 0, removed: 0 }
  const beforePath = join(runBeforeRoot(root, run.id), change.path)
  const before = (await pathExists(beforePath)) ? await readFile(beforePath, 'utf8') : ''
  const diff = unifiedRows(before, change.hunks)
  return { binary: false, rows: diff.rows, added: diff.added, removed: diff.removed }
}

/** Rendered before/after comparison for the preview frame. */
export async function syncReviewComparisonDocument(
  root: string,
  run: SyncRun,
  change: SyncFileChange,
  view: { layout: 'split' | 'unified'; onlyChanges: boolean },
): Promise<string> {
  const beforePath = join(runBeforeRoot(root, run.id), change.path)
  const afterPath = join(runWorkspace(root, run.id), change.path)
  const before = await readSide(beforePath, change)
  const after = await readSide(afterPath, change)
  const notice =
    change.category === 'page' && !change.binary
      ? undefined
      : 'This file has no rendered form. The source diff shows it line by line.'
  return renderedDiffDocument({
    diff: renderedDiff({ before, after }),
    layout: view.layout,
    onlyChanges: view.onlyChanges,
    ...(notice ? { notice } : {}),
  })
}

async function readSide(path: string, change: SyncFileChange): Promise<RenderedSide> {
  if (!(await pathExists(path))) {
    return { title: change.title, description: '', body: '', exists: false }
  }
  if (change.binary) {
    return {
      title: change.title,
      description: '',
      body: `_Binary file \`${change.path}\` — accept the file to apply it._`,
      exists: true,
    }
  }
  if (change.category !== 'page') {
    // Configuration and evidence files have no rendered form; an indented code
    // block shows them verbatim without colliding with fences in the content.
    const text = await readFile(path, 'utf8')
    return {
      title: change.title,
      description: change.path,
      body: text.split('\n').map((line) => `    ${line}`).join('\n'),
      exists: true,
    }
  }
  try {
    const page = await readPage(path)
    return {
      title: page.title || change.title,
      description: page.description ?? '',
      body: page.body,
      exists: true,
    }
  } catch {
    return {
      title: change.title,
      description: '',
      body: await readFile(path, 'utf8').catch(() => ''),
      exists: true,
    }
  }
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += value.length
    if (size > 1_000_000) throw new DoxloopError('Review request is too large.')
    chunks.push(value)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown
  } catch {
    throw new DoxloopError('Review request is not valid JSON.')
  }
}

function requireToken(request: IncomingMessage, token: string): void {
  if (request.headers['x-doxloop-review-token'] !== token) {
    throw new DoxloopError('Invalid local review token.')
  }
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  send(response, status, 'application/json; charset=utf-8', JSON.stringify(value))
}

function send(response: ServerResponse, status: number, type: string, body: string): void {
  response.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  })
  response.end(body)
}

function sendBinary(response: ServerResponse, status: number, type: string, body: Buffer): void {
  response.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  })
  response.end(body)
}

function shownHost(host: string): string {
  return host === '0.0.0.0' ? 'localhost' : host
}

function openBrowser(url: string): void {
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  const child = spawn(command, args, { detached: true, stdio: 'ignore' })
  child.unref()
}
