import { documentationCollections, collectionForPath } from './documentation-collections.js'
import { resolvePageRoute } from './page-routes.js'
import { readFile } from 'node:fs/promises'
import { extname, join, relative, resolve, sep } from 'node:path'
import { DoxloopError } from './errors.js'
import { EVIDENCE_MAP_FILE, readEvidenceMap } from './evidence.js'
import { assertInside, pathExists, resolveContainedDirectory } from './fs.js'
import { listPages as listHistoryPages } from './history.js'
import { loadGeneratorAdapter } from './generators.js'
import {
  loadPages,
  loadProject,
  loadSiteConfig,
  pageExtensions,
  pageId,
  readPage,
  relativePath,
  siteConfigPath,
} from './project.js'
import type { RevisionScope } from './sync-runs.js'
import type { DoxloopProject, PageEvidence } from './types.js'
import { readDoxbrixNavigation } from './validation.js'

export interface PageSummary {
  path: string
  title: string
  description?: string
  section?: string
  route: string
  wordCount: number
  updatedAt?: string
  evidence: 'verified' | 'needs-review' | 'none'
  inNavigation: boolean
  version?: string
  locale?: string
}

export async function listPages(root: string): Promise<PageSummary[]> {
  const project = await loadProject(root)
  const contentRoot = await resolveContainedDirectory(root, project.contentDir, 'Documentation content directory', {
    allowRoot: project.generator === 'doxbrix',
  })
  const collections = await documentationCollections(root, project)
  const files = await loadPages(root, project)
  const adapter = project.generator === 'doxbrix' ? undefined : await loadGeneratorAdapter(root, project)
  const navigation = project.generator === 'doxbrix'
    ? readDoxbrixNavigation((await loadSiteConfig(root, project)).spaces)
    : []
  const navigationById = new Map(navigation.map((entry, index) => [entry.path, { ...entry, index }]))
  const evidence = await readEvidenceMap(root)
  const history = new Map((await listHistoryPages(root)).map((page) => [portable(page.path), page]))
  const summaries = await Promise.all(files.map(async (absolute): Promise<PageSummary & { order: number }> => {
    const path = relativePath(root, absolute)
    const id = pageId(contentRoot, absolute)
    const page = adapter?.readPage ? await adapter.readPage(absolute) : await readPage(absolute)
    const nav = navigationById.get(id)
    return {
      path,
      version: collectionForPath(collections, path)?.version ?? 'current',
      locale: collectionForPath(collections, path)?.locale ?? 'default',
      title: page.title || titleFromPath(path),
      ...(page.description ? { description: page.description } : {}),
      ...(nav?.section ? { section: nav.section } : {}),
      route: await resolvePageRoute(root, project, path),
      wordCount: countWords(page.body),
      ...(history.get(path)?.updatedAt ? { updatedAt: history.get(path)!.updatedAt } : {}),
      evidence: evidenceState(evidence?.pages[path], project.sync.maxVerificationAgeDays),
      inNavigation: Boolean(nav) || project.generator !== 'doxbrix',
      order: nav?.index ?? Number.MAX_SAFE_INTEGER,
    }
  }))
  return summaries
    .sort((left, right) => left.order - right.order || left.title.localeCompare(right.title) || left.path.localeCompare(right.path))
    .map(({ order: _order, ...summary }) => summary)
}

/** Map a project-relative page file to the conventional local-preview route. */
export function pageRoute(project: DoxloopProject, path: string): string {
  // External adapters do not currently expose route mapping, so all generators
  // use the same content-relative convention until that API grows one.
  const content = portable(project.contentDir).replace(/^\/+|\/+$/g, '')
  let route = portable(path).replace(/^\/+/, '')
  if (content && (route === content || route.startsWith(`${content}/`))) {
    route = route.slice(content.length).replace(/^\/+/, '')
  }
  route = route.replace(/\.[^./]+$/, '')
  route = route.replace(/(^|\/)index$/, '')
  return `/${route}`.replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/'
}

export async function resolveEditScope(
  root: string,
  project: DoxloopProject,
  paths: readonly string[],
  allowRelated: boolean,
): Promise<RevisionScope> {
  const contentRoot = await resolveContainedDirectory(root, project.contentDir, 'Documentation content directory', {
    allowRoot: project.generator === 'doxbrix',
  })
  const pages = new Set((await loadPages(root, project)).map((path) => relativePath(root, path)))
  const extensions = await pageExtensions(root, project)
  const collections = await documentationCollections(root, project)
  const selectedPaths = new Set<string>()
  for (const raw of paths) {
    const path = portable(raw.trim()).replace(/^\.\//, '')
    const absolute = resolve(root, path)
    let insideContent = false
    try {
      const collection = collectionForPath(collections, path)
      const allowedRoot = collection ? resolve(root, collection.directory) : contentRoot
      assertInside(allowedRoot, absolute)
      insideContent = Boolean(collection) && (absolute === allowedRoot || relative(allowedRoot, absolute).split(sep)[0] !== '..')
    } catch {
      insideContent = false
    }
    if (
      !path ||
      path.split('/').some((part) => ['..', '.doxloop', 'node_modules'].includes(part)) ||
      !insideContent ||
      !extensions.has(extname(path).toLowerCase()) ||
      !pages.has(path)
    ) {
      throw new DoxloopError(`"${raw}" is not an existing documentation page inside ${project.contentDir || 'the project root'}.`, 2)
    }
    selectedPaths.add(path)
  }
  if (selectedPaths.size === 0) throw new DoxloopError('Select at least one documentation page to edit.', 2)

  const supportingPaths = new Set<string>([EVIDENCE_MAP_FILE])
  const supportingPrefixes = new Set<string>()
  if (allowRelated) {
    if (project.generator === 'doxbrix') {
      supportingPaths.add(relativePath(root, await siteConfigPath(root, project)))
    } else {
      const adapter = await loadGeneratorAdapter(root, project)
      for (const path of adapter.planning?.navigationFiles ?? []) supportingPaths.add(portable(path))
    }
    for (const path of selectedPaths) {
      const raw = await readFile(join(root, path), 'utf8')
      for (const reference of assetReferences(raw)) {
        const resolved = await resolveReferencedAsset(root, contentRoot, path, reference, project)
        if (resolved) supportingPaths.add(resolved)
      }
      const slug = path.split('/').at(-1)!.replace(/\.[^.]+$/, '')
      for (const base of ['assets', 'public/assets', 'static/assets', portable(join(project.contentDir, 'assets'))]) {
        const normalized = base.replace(/^\/+|\/+$/g, '')
        if (normalized) supportingPrefixes.add(`${normalized}/${slug}`)
      }
    }
  }
  return {
    selectedPaths,
    supportingPaths,
    supportingPrefixes,
    pageExtensions: extensions,
    wholeProposal: false,
    hunkRanges: new Map(),
  }
}

function evidenceState(entry: PageEvidence | undefined, maxAgeDays: number | undefined): PageSummary['evidence'] {
  if (!entry) return 'none'
  if (entry.confidence === 'needs-human' || entry.confidence === 'inferred' || Object.values(entry.claimVerification ?? {}).some((state) => state !== 'verified')) {
    return 'needs-review'
  }
  const verificationDates = Object.values(entry.verifiedOn ?? {}).map(Date.parse).filter(Number.isFinite)
  const hasVerification = Object.keys(entry.claimVerification ?? {}).length > 0 || Object.keys(entry.verifiedAt ?? {}).length > 0
  if (!hasVerification) return 'needs-review'
  if (maxAgeDays && verificationDates.length > 0 && verificationDates.every((date) => Date.now() - date > maxAgeDays * 86_400_000)) {
    return 'needs-review'
  }
  return 'verified'
}

function countWords(value: string): number {
  return value.replace(/```[\s\S]*?```/g, ' ').replace(/<[^>]+>/g, ' ').match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)?.length ?? 0
}

function titleFromPath(path: string): string {
  return path.split('/').at(-1)!.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function assetReferences(raw: string): string[] {
  const references = new Set<string>()
  for (const pattern of [/!\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)/g, /\b(?:src|href)=["']([^"']+)["']/g]) {
    for (const match of raw.matchAll(pattern)) {
      const reference = match[1]?.trim()
      if (reference && !/^(?:https?:|data:|#)/i.test(reference)) references.add(reference)
    }
  }
  return [...references]
}

async function resolveReferencedAsset(root: string, contentRoot: string, pagePath: string, reference: string, project: DoxloopProject): Promise<string | undefined> {
  const adapter = project.generator === 'doxbrix' ? undefined : await loadGeneratorAdapter(root, project)
  const candidates = [
    adapter?.resolveLocalAsset?.({ root, contentRoot, pagePath: join(root, pagePath), reference }),
    reference.startsWith('/') ? resolve(root, reference.slice(1)) : resolve(join(root, pagePath, '..'), reference),
    reference.startsWith('/') ? resolve(contentRoot, reference.slice(1)) : undefined,
  ].filter((value): value is string => Boolean(value))
  for (const candidate of candidates) {
    try {
      const safe = assertInside(root, candidate)
      if (await pathExists(safe)) return relativePath(root, safe)
    } catch {
      // External URLs and assets outside the documentation project are not editable support files.
    }
  }
  return undefined
}

function portable(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/')
}
