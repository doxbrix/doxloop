import { extname, relative } from 'node:path'
import chokidar from 'chokidar'
import { EVIDENCE_MAP_FILE } from './evidence.js'
import { loadGeneratorAdapter } from './generators.js'
import { emitWorkflowStage, type WorkflowStageProgress, type WorkflowStageStatus } from './job-events.js'
import { relativePath, siteConfigPath } from './project.js'
import { SCREENSHOT_MANIFEST_FILE } from './screenshot-workflow.js'
import type { DocumentationPlan, DoxloopProject } from './types.js'

/**
 * Stage identifiers shared by the plan pipeline and the authoring run, so the
 * pipeline can announce the stages up front and the run can advance them as
 * the agent actually writes files.
 */
export const AUTHORING_STAGE = {
  authoring: 'authoring-pages',
  navigation: 'updating-navigation',
  evidence: 'recording-evidence',
  screenshots: 'capturing-screenshots',
  validating: 'validating',
} as const

export type AuthoringActivityKind = 'page' | 'navigation' | 'evidence' | 'screenshot' | 'validation'

export interface AuthoringActivity {
  kind: AuthoringActivityKind
  /** Workspace-relative path when the activity is a file the agent wrote. */
  path?: string
}

export interface WorkspaceLayout {
  /** Content directory relative to the workspace root, '' for the root itself. */
  contentDir: string
  pageExtensions: readonly string[]
  /** Workspace-relative navigation and theme files. */
  navigationFiles: readonly string[]
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif'])
const IGNORED_SEGMENTS = new Set(['.git', 'node_modules', '.doxloop-sources'])
const CAPTURE_OUTPUT_PREFIX = '.doxloop/capture-output/'

export function portableWorkspacePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//, '').replace(/^\/+/, '')
}

/** Decide what a file the agent wrote says about the run's progress. */
export function classifyWorkspaceFile(rawPath: string, layout: WorkspaceLayout): AuthoringActivity | undefined {
  const path = portableWorkspacePath(rawPath)
  if (!path || path.split('/').some((segment) => IGNORED_SEGMENTS.has(segment))) return undefined
  if (path === portableWorkspacePath(EVIDENCE_MAP_FILE)) return { kind: 'evidence', path }
  if (path === portableWorkspacePath(SCREENSHOT_MANIFEST_FILE)) return { kind: 'screenshot' }
  if (path.startsWith(CAPTURE_OUTPUT_PREFIX)) return { kind: 'screenshot', path }
  if (path.startsWith('.doxloop/')) return undefined
  const extension = extname(path).toLowerCase()
  if (IMAGE_EXTENSIONS.has(extension)) return { kind: 'screenshot', path }
  const navigation = new Set(layout.navigationFiles.map(portableWorkspacePath))
  if (navigation.has(path)) return { kind: 'navigation', path }
  const content = portableWorkspacePath(layout.contentDir).replace(/\/+$/, '')
  const insideContent = !content || path === content || path.startsWith(`${content}/`)
  if (insideContent && layout.pageExtensions.some((candidate) => candidate.toLowerCase() === extension)) {
    return { kind: 'page', path }
  }
  return undefined
}

/**
 * Turn an agent tool call into an activity the file watcher cannot see: a
 * screenshot request to the capture server, or a validation command. Every
 * agent's log formatter reports calls in Claude's vocabulary (`Bash` with a
 * `command`, `mcp__<server>__<tool>`); Gemini exposes MCP tools by their bare
 * name, so a tool whose own name says "screenshot" counts as well.
 */
export function classifyAgentToolCall(
  tool: string,
  input: Record<string, unknown>,
  options: { captureServer?: string } = {},
): AuthoringActivity | undefined {
  const capturePrefix = options.captureServer ? `mcp__${options.captureServer}__` : undefined
  if (capturePrefix && tool.startsWith(capturePrefix)) {
    return /screenshot|snapshot|capture/i.test(tool.slice(capturePrefix.length)) ? { kind: 'screenshot' } : undefined
  }
  if (!tool.startsWith('mcp__') && /screenshot/i.test(tool)) return { kind: 'screenshot' }
  if (tool === 'Bash') {
    const command = typeof input.command === 'string' ? input.command : ''
    if (/\bdoxloop\s+(test|quality)\b/.test(command)) return { kind: 'validation' }
  }
  return undefined
}

export async function workspaceLayout(root: string, project: DoxloopProject): Promise<WorkspaceLayout> {
  if (project.generator === 'doxbrix') {
    let navigationFiles: string[] = ['docs.json']
    try {
      navigationFiles = [portableWorkspacePath(relativePath(root, await siteConfigPath(root, project)))]
    } catch {
      // A workspace without a site configuration yet still has pages to count.
    }
    return { contentDir: project.contentDir, pageExtensions: ['.md', '.mdx'], navigationFiles }
  }
  try {
    const adapter = await loadGeneratorAdapter(root, project)
    return {
      contentDir: project.contentDir,
      pageExtensions: adapter.project.pageExtensions,
      navigationFiles: adapter.planning?.navigationFiles ?? [],
    }
  } catch {
    return { contentDir: project.contentDir, pageExtensions: ['.md', '.mdx'], navigationFiles: [] }
  }
}

/** Pages an approved plan asks the agent to write or rewrite. */
export function plannedPageCount(plan: Pick<DocumentationPlan, 'pages'> | undefined): number | undefined {
  if (!plan) return undefined
  const count = plan.pages.filter((page) => page.action === 'create' || page.action === 'update').length
  return count > 0 ? count : undefined
}

export interface AuthoringStageEmitter {
  (id: string, label: string, status: WorkflowStageStatus, progress?: WorkflowStageProgress): void
}

export interface AuthoringProgressOptions {
  /** Number of pages the run is expected to write, shown as "N of M". */
  plannedPages?: number | undefined
  /** Whether the run may capture application screenshots. */
  screenshots: boolean
  /** Copy for the page stage; edits and generation read differently. */
  pageLabel?: string
  emit?: AuthoringStageEmitter
}

interface StageState {
  id: string
  label: string
  idleLabel: string
  status: WorkflowStageStatus
}

/**
 * Advance the workflow stages from what the agent really does: a page write
 * starts the authoring stage and counts towards the planned total, a
 * navigation write starts the navigation stage, and so on. Every stage is
 * announced as pending first so the reader sees the whole path at once.
 */
export class AuthoringProgressTracker {
  private readonly stages: StageState[]
  private readonly pages = new Set<string>()
  private readonly emit: AuthoringStageEmitter
  private readonly plannedPages: number | undefined
  private finished = false

  constructor(options: AuthoringProgressOptions) {
    this.emit = options.emit ?? emitWorkflowStage
    this.plannedPages = options.plannedPages
    const pageLabel = options.pageLabel ?? 'Authoring approved pages'
    this.stages = [
      { id: AUTHORING_STAGE.authoring, label: pageLabel, idleLabel: 'No pages were written', status: 'pending' },
      { id: AUTHORING_STAGE.navigation, label: 'Updating navigation and theme', idleLabel: 'Navigation and theme unchanged', status: 'pending' },
      { id: AUTHORING_STAGE.evidence, label: 'Recording page evidence', idleLabel: 'Page evidence unchanged', status: 'pending' },
      ...(options.screenshots
        ? [{ id: AUTHORING_STAGE.screenshots, label: 'Capturing application screenshots', idleLabel: 'No application screenshots captured', status: 'pending' as const }]
        : []),
      { id: AUTHORING_STAGE.validating, label: 'Validating generated documentation', idleLabel: 'Validating generated documentation', status: 'pending' },
    ]
  }

  /** Announce every stage before the agent starts. */
  begin(): void {
    for (const stage of this.stages) this.emit(stage.id, stage.label, 'pending', this.progressFor(stage.id))
  }

  record(activity: AuthoringActivity): void {
    if (this.finished) return
    switch (activity.kind) {
      case 'page': {
        if (!activity.path || this.pages.has(activity.path)) return
        this.pages.add(activity.path)
        this.start(AUTHORING_STAGE.authoring, true)
        return
      }
      case 'navigation':
        this.start(AUTHORING_STAGE.navigation)
        return
      case 'evidence':
        this.start(AUTHORING_STAGE.evidence)
        return
      case 'screenshot':
        this.start(AUTHORING_STAGE.screenshots)
        return
      case 'validation':
        this.start(AUTHORING_STAGE.validating)
        return
      default:
        return
    }
  }

  /** The agent exited: Doxloop now validates what it left behind. */
  validating(): void {
    this.start(AUTHORING_STAGE.validating)
  }

  /**
   * Settle the agent's stages after a successful run. Stages that never saw
   * activity say so instead of pretending the work happened.
   */
  finish(): void {
    if (this.finished) return
    this.finished = true
    for (const stage of this.stages) {
      if (stage.id === AUTHORING_STAGE.validating) continue
      if (stage.status === 'running') {
        stage.status = 'completed'
        this.emit(stage.id, stage.label, 'completed', this.progressFor(stage.id))
      } else if (stage.status === 'pending') {
        stage.status = 'completed'
        this.emit(stage.id, stage.idleLabel, 'completed', this.progressFor(stage.id))
      }
    }
  }

  pagesWritten(): number {
    return this.pages.size
  }

  private start(id: string, reemit = false): void {
    const stage = this.stages.find((candidate) => candidate.id === id)
    if (!stage) return
    if (stage.status === 'running' && !reemit) return
    if (stage.status !== 'running' && stage.status !== 'pending') return
    stage.status = 'running'
    this.emit(stage.id, stage.label, 'running', this.progressFor(stage.id))
  }

  private progressFor(id: string): WorkflowStageProgress | undefined {
    if (id !== AUTHORING_STAGE.authoring) return undefined
    if (this.pages.size === 0 && this.plannedPages === undefined) return undefined
    return { done: this.pages.size, ...(this.plannedPages !== undefined ? { total: this.plannedPages } : {}) }
  }
}

/**
 * Watch the run workspace so progress is derived from files for every agent,
 * including the ones whose output Doxloop does not parse. Resolves once the
 * watcher is armed; the returned function stops it.
 */
export async function watchWorkspaceActivity(
  workspace: string,
  layout: WorkspaceLayout,
  onActivity: (activity: AuthoringActivity) => void,
): Promise<() => Promise<void>> {
  const watcher = chokidar.watch(workspace, {
    ignoreInitial: true,
    persistent: true,
    ignored: (path: string) => {
      const rel = portableWorkspacePath(relative(workspace, path))
      return rel.split('/').some((segment) => IGNORED_SEGMENTS.has(segment))
    },
  })
  const report = (path: string): void => {
    const activity = classifyWorkspaceFile(relative(workspace, path), layout)
    if (activity) onActivity(activity)
  }
  watcher.on('add', report)
  watcher.on('change', report)
  watcher.on('error', () => undefined)
  await new Promise<void>((resolveReady) => {
    const timer = setTimeout(resolveReady, 5_000)
    timer.unref?.()
    watcher.once('ready', () => {
      clearTimeout(timer)
      resolveReady()
    })
  })
  return async () => {
    try {
      await watcher.close()
    } catch {
      // A watcher that already stopped has nothing left to release.
    }
  }
}
