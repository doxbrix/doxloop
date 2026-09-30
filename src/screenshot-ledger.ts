/**
 * A durable record of every product screenshot the documentation shows:
 * which page and step it illustrates, the application route it was taken
 * at, its size, and its content hash. The capture manifest stays inside a
 * run's workspace and never reaches the project, so without this record a
 * screenshot could not be re-checked against the running application once
 * the proposal was accepted.
 *
 * `.doxloop/screenshots.json` travels with a proposal like the evidence map.
 * A later run merges its captures in; entries whose image was deleted drop
 * out.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { PNG } from 'pngjs'
import { pathExists } from './fs.js'
import { SCREENSHOT_MANIFEST_FILE } from './screenshot-workflow.js'
import type { DoxloopProject } from './types.js'

export const SCREENSHOT_LEDGER_FILE = join('.doxloop', 'screenshots.json')

export interface ScreenshotRecord {
  /** Project-relative image file. */
  file: string
  /** The guide page the screenshot belongs to (plan page id or path). */
  page: string
  step: string
  action: string
  expectedState: string
  /** Application route the screen was captured at, relative to the application URL. */
  route?: string
  viewport?: { width: number; height: number }
  width: number
  height: number
  sha256: string
  capturedAt: string
}

export interface ScreenshotLedger {
  schemaVersion: 1
  screenshots: ScreenshotRecord[]
}

interface ManifestStep {
  id?: unknown
  action?: unknown
  expectedState?: unknown
  file?: unknown
  route?: unknown
  status?: unknown
}

export async function readScreenshotLedger(root: string): Promise<ScreenshotLedger> {
  try {
    const value = JSON.parse(await readFile(join(root, SCREENSHOT_LEDGER_FILE), 'utf8')) as Partial<ScreenshotLedger>
    if (value.schemaVersion === 1 && Array.isArray(value.screenshots)) {
      return { schemaVersion: 1, screenshots: value.screenshots.filter((item): item is ScreenshotRecord => Boolean(item && typeof item.file === 'string' && typeof item.sha256 === 'string')) }
    }
  } catch {
    // A missing or unreadable ledger starts empty.
  }
  return { schemaVersion: 1, screenshots: [] }
}

export async function writeScreenshotLedger(root: string, ledger: ScreenshotLedger): Promise<void> {
  const path = join(root, SCREENSHOT_LEDGER_FILE)
  await mkdir(dirname(path), { recursive: true })
  const screenshots = [...ledger.screenshots].sort((left, right) => left.file.localeCompare(right.file))
  await writeFile(path, `${JSON.stringify({ schemaVersion: 1, screenshots }, null, 2)}\n`, 'utf8')
}

export async function imageFacts(path: string): Promise<{ sha256: string; width: number; height: number } | undefined> {
  try {
    const bytes = await readFile(path)
    const png = PNG.sync.read(bytes)
    return { sha256: createHash('sha256').update(bytes).digest('hex'), width: png.width, height: png.height }
  } catch {
    return undefined
  }
}

/**
 * Merge a run's verified captures into the workspace's ledger. An image whose
 * bytes did not change keeps its original capture time; entries whose file
 * no longer exists are dropped. Returns how many screenshots are recorded
 * and how many of them can be re-captured without an agent (have a route).
 */
export async function recordScreenshots(workspace: string, project: Pick<DoxloopProject, 'application'>): Promise<{ recorded: number; recapturable: number }> {
  const ledger = await readScreenshotLedger(workspace)
  const byFile = new Map(ledger.screenshots.map((record) => [record.file, record]))
  let manifest: { guides?: Array<{ page?: unknown; steps?: ManifestStep[] }> } = {}
  try { manifest = JSON.parse(await readFile(join(workspace, SCREENSHOT_MANIFEST_FILE), 'utf8')) } catch { manifest = {} }
  const viewport = project.application?.screenshots?.viewport
  const now = new Date().toISOString()
  for (const guide of Array.isArray(manifest.guides) ? manifest.guides : []) {
    if (typeof guide?.page !== 'string' || !Array.isArray(guide.steps)) continue
    for (const step of guide.steps) {
      if (step?.status !== 'verified' || typeof step.file !== 'string' || typeof step.id !== 'string') continue
      const facts = await imageFacts(join(workspace, step.file))
      if (!facts) continue
      const previous = byFile.get(step.file)
      const route = typeof step.route === 'string' && step.route.trim() ? step.route.trim() : previous?.route
      byFile.set(step.file, {
        file: step.file,
        page: guide.page,
        step: step.id,
        action: typeof step.action === 'string' ? step.action : previous?.action ?? '',
        expectedState: typeof step.expectedState === 'string' ? step.expectedState : previous?.expectedState ?? '',
        ...(route ? { route } : {}),
        ...(viewport ? { viewport } : previous?.viewport ? { viewport: previous.viewport } : {}),
        ...facts,
        capturedAt: previous && previous.sha256 === facts.sha256 ? previous.capturedAt : now,
      })
    }
  }
  const kept: ScreenshotRecord[] = []
  for (const record of byFile.values()) if (await pathExists(join(workspace, record.file))) kept.push(record)
  if (kept.length === 0 && ledger.screenshots.length === 0) return { recorded: 0, recapturable: 0 }
  await writeScreenshotLedger(workspace, { schemaVersion: 1, screenshots: kept })
  return { recorded: kept.length, recapturable: kept.filter((record) => record.route).length }
}
