import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { basename, join, relative, resolve } from 'node:path'
import { PNG } from 'pngjs'
import { GUIDE_ASSET_ROOTS, SCREENSHOT_MANIFEST_FILE, dominantColorShare } from './screenshot-workflow.js'
import type { DocumentationPlan } from './types.js'

export async function preparePlanningCaptures(root: string, planId: string): Promise<string> {
  if (!/^[\w-]+$/.test(planId)) throw new Error('Invalid capture plan ID')
  const directory = join(root, '.doxloop', 'plans', planId, 'captures')
  await mkdir(directory, { recursive: true })
  return directory
}

export interface PlanningCaptureReuse {
  reused: number
  /** Capture IDs the plan references that no saved image could be found for. */
  missing: string[]
}

/**
 * Reuse only explicitly selected, reviewed images belonging to this plan's
 * research.
 *
 * The browser tool saves an auto-named file into the capture directory but
 * resolves a caller-supplied filename against its client workspace, so an
 * agent that names its images (as the prompt asks) leaves them at the
 * project root. Those are adopted from there and moved into the plan's
 * capture directory, where the plan's evidence stays together.
 */
export async function reusePlanningCaptures(root: string, workspace: string, plan: DocumentationPlan, generator: string): Promise<number> {
  return (await adoptPlanningCaptures(root, workspace, plan, generator)).reused
}

export async function adoptPlanningCaptures(root: string, workspace: string, plan: DocumentationPlan, generator: string): Promise<PlanningCaptureReuse> {
  const directory = await preparePlanningCaptures(root, plan.id)
  const missing: string[] = []
  let brief: { content?: { screens?: Array<{ captures?: Capture[]; visible?: string; route?: string }> } }
  try { brief = JSON.parse(await readFile(join(root, '.doxloop', 'plans', plan.id, 'research', 'application.json'), 'utf8')) } catch { return { reused: 0, missing } }
  const captures = new Map<string, Capture>()
  const duplicate = new Set<string>()
  for (const screen of Array.isArray(brief.content?.screens) ? brief.content.screens : []) {
    for (const capture of Array.isArray(screen?.captures) ? screen.captures : []) {
      if (!capture || typeof capture.id !== 'string') continue
      if (captures.has(capture.id)) duplicate.add(capture.id)
      captures.set(capture.id, { ...capture, route: screen.route, labels: screen.visible })
    }
  }
  let manifest: { guides: Array<{ page: string; steps: Array<Record<string, unknown>> }> }
  try { manifest = JSON.parse(await readFile(join(workspace, SCREENSHOT_MANIFEST_FILE), 'utf8')) } catch { return { reused: 0, missing } }
  let reused = 0
  const catalog: Capture[] = []
  for (const guide of Array.isArray(manifest.guides) ? manifest.guides : []) {
    if (!Array.isArray(guide?.steps)) continue
    const page = plan.pages.find((page) => page.id === guide.page || page.path === guide.page)
    for (const [index, step] of guide.steps.entries()) {
      const sequenceIndex = typeof step.sequenceItem === 'number' ? step.sequenceItem - 1 : index
      const capture = captures.get(page?.visuals?.captureIds?.[sequenceIndex] ?? '')
      if (!capture || duplicate.has(capture.id)) continue
      if (step.status === 'verified' && typeof step.file === 'string') {
        try { await readFile(join(workspace, step.file)); continue } catch { step.status = 'planned' }
      }
      if (!capture.file || !capture.alt || !capture.state || !['expectedStateConfirmed', 'privacyReviewed', 'legibilityReviewed', 'meaningful'].every((key) => capture.checks?.[key] === true)) continue
      try {
        const source = await locateCapture(directory, root, capture.file)
        if (!source) { missing.push(capture.id); continue }
        const bytes = await readFile(source)
        if (bytes.length > 20_000_000) continue
        const png = PNG.sync.read(bytes)
        if (png.width < 320 || png.height < 180 || dominantColorShare(png) > 0.995) continue
        const assetRoot = join(plan.target?.contentDir ?? '', GUIDE_ASSET_ROOTS[generator] ?? GUIDE_ASSET_ROOTS.doxbrix!)
        const file = join(assetRoot, 'planning', `${plan.id}-${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}.png`).replaceAll('\\', '/')
        await mkdir(join(workspace, assetRoot, 'planning'), { recursive: true })
        await copyFile(source, join(workspace, file))
        Object.assign(step, { file, alt: capture.alt, status: 'verified', target: typeof step.action === 'string' && step.action ? step.action : capture.action, checks: capture.checks, observedState: capture.state, observedLabels: capture.labels })
        catalog.push({ ...capture, file })
        reused += 1
      } catch { /* Missing or corrupt images remain planned for the capture stage. */ }
    }
  }
  await writeFile(join(workspace, SCREENSHOT_MANIFEST_FILE), JSON.stringify(manifest, null, 2))
  await mkdir(join(workspace, '.doxloop', 'cache'), { recursive: true })
  if (catalog.length > 0) await writeFile(join(workspace, '.doxloop', 'cache', 'planning-captures.json'), JSON.stringify(catalog, null, 2))
  return { reused, missing: [...new Set(missing)] }
}

/**
 * The saved image for a capture: in the plan's capture directory, or by its
 * base name at the project root where the browser tool put it, in which case
 * it is moved into the capture directory first. Nothing outside those two
 * places is ever read.
 */
async function locateCapture(directory: string, root: string, file: string): Promise<string | undefined> {
  const inDirectory = await safeChild(directory, file)
  if (inDirectory) return inDirectory
  const name = basename(file)
  if (!/^[\w.-]+\.png$/i.test(name)) return undefined
  const stray = await safeChild(root, name)
  if (!stray) return undefined
  const moved = join(directory, name)
  try {
    await rename(stray, moved)
    return moved
  } catch {
    return stray
  }
}

/** The real path of `file` when it is an existing file directly inside `parent`. */
async function safeChild(parent: string, file: string): Promise<string | undefined> {
  try {
    const target = await realpath(resolve(parent, file))
    const inside = relative(await realpath(parent), target)
    if (!inside || inside.startsWith('..') || inside.startsWith('/')) return undefined
    return target
  } catch {
    return undefined
  }
}

interface Capture {
  id: string
  file: string
  action: string
  state: string
  alt: string
  checks: Record<string, boolean>
  route?: string | undefined
  labels?: string | undefined
}
