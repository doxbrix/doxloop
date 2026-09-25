import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { assignSectionSpaces } from './plan-navigation.js'
import matter from 'gray-matter'
import { contentLinks } from './content-links.js'
import { isStarterContent } from './validation.js'
import { removeImageReference } from './screenshot-workflow.js'
import { EVIDENCE_MAP_FILE, readEvidenceMap, writeEvidenceMap } from './evidence.js'
import { pathExists, resolveContainedDirectory } from './fs.js'
import { readNavigation } from './navigation.js'
import { ROOT_CONTENT_IGNORED_DIRECTORIES, loadPages, loadSiteConfig, pageId, relativePath, siteConfigPath } from './project.js'
import { preferredPageExtension } from './page-extension.js'
import type {
  ValidationIssue,
  DocumentationPlan,
  DocumentationPlanPage,
  DoxbrixNavNode,
  DoxbrixSiteConfig,
  DoxbrixSpace,
  DoxloopProject,
  EvidenceMap,
  PageEvidence,
} from './types.js'

/**
 * Deterministic bookkeeping repairs that run after each authoring batch,
 * before validation. Agents write good prose and then miss the mechanical
 * parts: frontmatter fields, navigation entries, link paths that assume a
 * folder the page does not live in, and evidence-map entries. Each repair
 * here is idempotent, stays inside the workspace, and never rewrites prose.
 */
export interface PostPassInput {
  workspace: string
  project: DoxloopProject
  plan: DocumentationPlan
  /** The pages of the batch that just finished; other planned pages are only used as link targets. */
  pages: DocumentationPlanPage[]
  /**
   * Turn a local link that resolves to no page, planned or existing, into
   * plain text. Only the end-of-run pass sets this: a broken link is a
   * validation error that blocks the whole proposal, and a page that mentions
   * a topic without linking it is still a usable page.
   */
  unlinkUnresolved?: boolean
  /**
   * Remove spaces no page landed in. Only the end-of-run pass sets this: the
   * first batch of a new site creates the spaces later batches slot pages
   * into, and pruning them between batches sends every later page to the
   * first space.
   */
  pruneEmptySpaces?: boolean
}

export interface PostPassReport {
  repairs: string[]
  problems: string[]
}

const MAX_DESCRIPTION = 160
const PAGE_EXTENSIONS = ['.md', '.mdx']
const LINK_EXTENSIONS = ['.md', '.mdx', '.rst', '.html', '.htm']

interface ExistingPage {
  page: DocumentationPlanPage
  /** The page's id as written: the normalized plan path, or the starter file it replaced. */
  id: string
  /** Normalized plan path without extension, relative to the content root. */
  planId: string
  absolute: string
  /** Project-relative file path, the evidence-map key. */
  file: string
}

export async function applyAuthoringPostPass(input: PostPassInput): Promise<PostPassReport> {
  const report: PostPassReport = { repairs: [], problems: [] }
  const root = resolve(input.workspace)
  const doxbrix = isDoxbrix(input.project)
  const contentRoot = await resolveContainedDirectory(root, input.project.contentDir, 'Documentation content directory', {
    allowRoot: doxbrix,
  })
  const extensions = pageExtensionsFor(input.plan)
  if (doxbrix) await unifyPageExtensions(root, contentRoot, input, report)

  const existing: ExistingPage[] = []
  const missing: Array<{ page: DocumentationPlanPage; id: string }> = []
  let workspacePages: string[] | undefined
  for (const page of input.pages) {
    const id = normalizePlanPath(page.path)
    if (!id || !isInside(contentRoot, resolve(contentRoot, id))) {
      report.problems.push(`${page.id}: planned path "${page.path}" is not inside the content directory, so it was skipped.`)
      continue
    }
    let absolute = await findPageFile(contentRoot, id, extensions)
    let actualId = id
    if (!absolute) {
      // The writer was told to write this page over a generated starter file
      // (the landing page keeps the site's index; a starter quickstart keeps
      // its name), so that file is the page.
      workspacePages ??= (await loadPages(root, input.project).catch(() => [])).map((absolute) => pageId(contentRoot, absolute))
      const replacement = starterReplacementId(id, workspacePages)
      if (replacement) {
        absolute = await findPageFile(contentRoot, replacement, extensions)
        if (absolute) actualId = replacement
      }
    }
    if (absolute) existing.push({ page, id: actualId, planId: id, absolute, file: relativePath(root, absolute) })
    else missing.push({ page, id })
  }

  await repairFrontmatter(existing, report)
  await repairCodeFences(existing, report)
  if (doxbrix) await repairDoxbrixNavigation(root, input.project, input.plan, existing, missing, report, input.pruneEmptySpaces === true)
  else await noteUnnavigatedPages(root, existing, report)
  await repairLinks(root, contentRoot, input.project, input.plan, existing, report, input.unlinkUnresolved === true)
  await repairEvidenceMap(root, contentRoot, input.plan, existing, extensions, report)
  return report
}

/**
 * The starter file a planned page was written over, mirroring the contract
 * `starterReplacements` gives the writer: a landing page (index, overview,
 * home, start-here) is the site's index; any other page replaces the starter
 * whose file name matches its last path segment.
 */
export function starterReplacementId(planId: string, workspacePages: readonly string[]): string | undefined {
  const stems = workspacePages.map((path) => normalizePlanPath(path.replace(/\.[^./]+$/, '')))
  if (stems.includes(planId)) return undefined
  const last = planId.split('/').at(-1) ?? planId
  if (/^(?:index|overview|home|start-here)$/i.test(last) && stems.includes('index')) return 'index'
  return stems.find((stem) => stem.split('/').at(-1) === last)
}

// ---------------------------------------------------------------------------
// Page extensions

const NON_CONTENT_STEMS = /^(?:readme|changelog|license|contributing|security|code_of_conduct)$/i

/**
 * Rename new pages written as `.md` to `.mdx` in a Doxbrix site. Doxbrix
 * reads both, but a real run wrote 12 of 62 pages as `.md` (the writer
 * followed a seeded evidence key) and the proposal read as two conventions.
 * Only pages this run created are renamed: every planned `create` page, and
 * in a create-mode run's end-of-run pass any other content page, since the
 * whole site is new. An existing page in an update keeps its file name, and a
 * page with an `.mdx` twin is left for a human to reconcile. Navigation
 * entries are extensionless and keep resolving; an entry or evidence-map key
 * that spells the old file is updated with it.
 */
async function unifyPageExtensions(root: string, contentRoot: string, input: PostPassInput, report: PostPassReport): Promise<void> {
  if (preferredPageExtension(input.plan.target ?? { generator: input.project.generator }) !== '.mdx') return
  const candidates = new Set<string>()
  for (const page of input.pages) {
    if (page.action !== 'create') continue
    const id = normalizePlanPath(page.path)
    if (!id) continue
    for (const file of [resolve(contentRoot, `${id}.md`), resolve(contentRoot, id, 'index.md')]) {
      if (isInside(contentRoot, file)) candidates.add(file)
    }
  }
  const endOfRun = input.pruneEmptySpaces === true || input.unlinkUnresolved === true
  if (endOfRun && input.plan.mode === 'create') {
    try {
      for (const absolute of await loadPages(root, input.project)) candidates.add(absolute)
    } catch {
      // The planned pages are still checked.
    }
  }
  const renamed: Array<{ from: string; to: string }> = []
  for (const absolute of candidates) {
    if (extname(absolute).toLowerCase() !== '.md') continue
    const file = relativePath(root, absolute)
    const segments = file.split('/')
    if (segments.some((segment) => ROOT_CONTENT_IGNORED_DIRECTORIES.has(segment))) continue
    if (NON_CONTENT_STEMS.test(segments.at(-1)!.replace(/\.md$/i, ''))) continue
    if (!(await pathExists(absolute))) continue
    const target = absolute.replace(/\.md$/i, '.mdx')
    if (await pathExists(target)) {
      report.problems.push(`${file}: both ${file} and ${relativePath(root, target)} exist; keep one of them.`)
      continue
    }
    await rename(absolute, target)
    renamed.push({ from: file, to: relativePath(root, target) })
    report.repairs.push(`${file}: renamed to ${relativePath(root, target)} so every page uses the .mdx extension.`)
  }
  if (renamed.length === 0) return

  try {
    const map = await readEvidenceMap(root)
    if (map) {
      let changed = false
      for (const { from, to } of renamed) {
        if (!map.pages[from]) continue
        if (!map.pages[to]) map.pages[to] = map.pages[from]!
        delete map.pages[from]
        changed = true
      }
      if (changed) await writeEvidenceMap(root, map)
    }
  } catch {
    // A malformed evidence map is rebuilt by the evidence repair below.
  }

  try {
    const configPath = await siteConfigPath(root, input.project)
    const site = await loadSiteConfig(root, input.project)
    const spelled = new Set(renamed.map(({ from }) => relative(contentRoot, resolve(root, from)).replaceAll('\\', '/')))
    let changed = false
    const visit = (nodes: DoxbrixNavNode[]): void => {
      for (const node of nodes) {
        if (node.type === 'page') {
          const bare = node.file.trim().replace(/^(?:\.\/)+/, '').replace(/^\/+/, '')
          if (spelled.has(bare)) {
            node.file = normalizePlanPath(node.file)
            changed = true
          }
        } else if (node.type === 'group') visit(node.items ?? [])
      }
    }
    for (const space of site.spaces) visit(space.nav)
    if (changed) await writeFile(configPath, `${JSON.stringify(site, null, 2)}\n`, 'utf8')
  } catch {
    // Navigation is repaired, or reported, by the navigation pass.
  }
}

// ---------------------------------------------------------------------------
// Frontmatter

async function repairFrontmatter(pages: ExistingPage[], report: PostPassReport): Promise<void> {
  for (const entry of pages) {
    const content = await readFile(entry.absolute, 'utf8')
    let data: Record<string, unknown>
    try {
      data = matter(content).data as Record<string, unknown>
    } catch (error) {
      report.problems.push(`${entry.file}: frontmatter could not be parsed (${errorMessage(error)}), so title and description were not checked.`)
      continue
    }
    const fields: Array<[string, string]> = []
    if (!isText(data.title)) fields.push(['title', entry.page.title.trim() || labelFromId(entry.id)])
    if (!isText(data.description)) fields.push(['description', descriptionFor(entry.page)])
    if (fields.length === 0) continue
    const next = insertFrontmatterFields(content, fields)
    if (next === content) continue
    await writeFile(entry.absolute, next, 'utf8')
    report.repairs.push(`${entry.file}: added frontmatter ${fields.map(([key]) => key).join(' and ')}.`)
  }
}

// ---------------------------------------------------------------------------
// Code fences

/**
 * Give an unlabeled opening fence the `text` language. The validator warns on
 * every bare fence and a real run spent two fix sessions adding `ini` and
 * `text` by hand; `text` renders the block exactly as written, so it is never
 * wrong, and a writer that knows better still labels its blocks itself.
 */
export function labelBareCodeFences(content: string): string {
  let inside = false
  let fenceMarker = ''
  return content.split(/(\r?\n)/).map((part) => {
    const match = /^(\s*)(`{3,}|~{3,})(.*)$/.exec(part)
    if (!match) return part
    const [, indent, marker, rest] = match as unknown as [string, string, string, string]
    if (inside) {
      if (marker[0] === fenceMarker[0] && marker.length >= fenceMarker.length && rest.trim() === '') inside = false
      return part
    }
    inside = true
    fenceMarker = marker
    return rest.trim() === '' ? `${indent}${marker}text` : part
  }).join('')
}

async function repairCodeFences(pages: ExistingPage[], report: PostPassReport): Promise<void> {
  for (const entry of pages) {
    const content = await readFile(entry.absolute, 'utf8')
    const next = labelBareCodeFences(content)
    if (next === content) continue
    await writeFile(entry.absolute, next, 'utf8')
    report.repairs.push(`${entry.file}: labeled unlabeled code fences as text.`)
  }
}

/**
 * Insert or replace top-level frontmatter keys while leaving every other byte
 * of the file alone. A blank existing key (`title:`) is replaced in place so
 * the YAML never gains a duplicate mapping key.
 */
export function insertFrontmatterFields(content: string, fields: Array<[string, string]>): string {
  const eol = content.includes('\r\n') ? '\r\n' : '\n'
  const block = locateFrontmatter(content)
  if (!block) {
    const lines = fields.map(([key, value]) => `${key}: ${yamlString(value)}`)
    return `---${eol}${lines.join(eol)}${eol}---${eol}${eol}${content}`
  }
  let body = content.slice(block.bodyStart, block.bodyEnd)
  const additions: string[] = []
  for (const [key, value] of fields) {
    const line = `${key}: ${yamlString(value)}`
    const existingLine = new RegExp(`^${key}\\s*:.*$`, 'm')
    if (existingLine.test(body)) body = body.replace(existingLine, line)
    else additions.push(line)
  }
  if (additions.length > 0) body = body === '' ? `${additions.join(eol)}${eol}` : `${body}${eol}${additions.join(eol)}`
  return `${content.slice(0, block.bodyStart)}${body}${content.slice(block.bodyEnd)}`
}

/** Byte offsets of the YAML between the opening and closing `---` lines. */
function locateFrontmatter(content: string): { bodyStart: number; bodyEnd: number } | undefined {
  const open = content.match(/^\uFEFF?---[ \t]*(\r?\n)/)
  if (!open) return undefined
  const bodyStart = open[0].length
  const closing = /^---[ \t]*(?:\r?\n|$)/m
  const rest = content.slice(bodyStart)
  const close = closing.exec(rest)
  if (!close) return undefined
  let bodyEnd = bodyStart + close.index
  // The body excludes the newline that ends its last line, so inserted lines
  // can be appended with the file's own line ending.
  if (bodyEnd > bodyStart && content[bodyEnd - 1] === '\n') {
    bodyEnd -= content[bodyEnd - 2] === '\r' ? 2 : 1
  }
  return { bodyStart, bodyEnd }
}

function yamlString(value: string): string {
  return JSON.stringify(value)
}

function descriptionFor(page: DocumentationPlanPage): string {
  const purpose = page.purpose.replace(/\s+/g, ' ').trim()
  const text = purpose || `Learn about ${page.title.trim() || labelFromId(normalizePlanPath(page.path))}.`
  return trimAtWordBoundary(text, MAX_DESCRIPTION)
}

export function trimAtWordBoundary(text: string, limit: number): string {
  if (text.length <= limit) return text
  const cut = text.slice(0, limit)
  const boundary = cut.lastIndexOf(' ')
  const trimmed = (boundary > 0 ? cut.slice(0, boundary) : cut).replace(/[\s,;:(\-–—]+$/u, '')
  return trimmed || cut.trimEnd()
}

// ---------------------------------------------------------------------------
// Navigation

async function repairDoxbrixNavigation(
  root: string,
  project: DoxloopProject,
  plan: DocumentationPlan,
  existing: ExistingPage[],
  missing: Array<{ page: DocumentationPlanPage; id: string }>,
  report: PostPassReport,
  pruneEmptySpaces = false,
): Promise<void> {
  let configPath: string
  let site: DoxbrixSiteConfig
  try {
    configPath = await siteConfigPath(root, project)
    site = await loadSiteConfig(root, project)
  } catch (error) {
    report.problems.push(`Navigation could not be repaired: ${errorMessage(error)}`)
    return
  }
  const configFile = relativePath(root, configPath)
  if (!site.spaces[0]) {
    report.problems.push(`${configFile}: docs.json has no space, so pages could not be added to navigation.`)
    return
  }
  let changed = false
  const key = (value: string | undefined): string => (value ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  const spaceNamed = (label: string | undefined): DoxbrixSpace | undefined =>
    label ? site.spaces.find((candidate) => key(candidate.name) === key(label) || (candidate.slug !== undefined && key(candidate.slug) === key(label))) : undefined
  /**
   * The space a page belongs to: the one its plan section names, else the one
   * whose slug or name is the page's first path segment, else the first. A
   * planner that promotes "Self-hosting" to a space puts self-hosting pages
   * there, not in whichever space happens to be listed first.
   */
  const spaceFor = (entry: ExistingPage, sectionTitle: string | undefined): DoxbrixSpace => {
    const bySection = spaceNamed(sectionTitle)
    if (bySection) return bySection
    const first = entry.id.includes('/') ? entry.id.split('/')[0] : undefined
    // "api/webhooks" belongs in an "API & integrations" space the plan lists.
    const prefixed = first ? site.spaces.find((candidate) => {
      const slug = key(candidate.slug ?? candidate.name)
      return slug.startsWith(`${key(first)}-`) && (plan.navigation?.top ?? []).some((name) => key(name) === slug)
    }) : undefined
    return spaceNamed(first) ?? prefixed ?? site.spaces[0]!
  }

  promotePlannedAreas()

  /**
   * Batches write pages without seeing the whole plan, and the first batch
   * usually lays the plan's top-level areas out as groups inside the one
   * starter space. A multi-area plan is meant to open as spaces (the switcher
   * above the sidebar), so while the site still has a single space, each area
   * group becomes its own space in the plan's order. A site that already has
   * several spaces was arranged on purpose and is left alone.
   */
  function promotePlannedAreas(): void {
    const areas = (plan.navigation?.top ?? []).filter((name) => key(name))
    if (areas.length < 2 || site.spaces.length !== 1) return
    const original = site.spaces[0]!
    if (original.version || original.locale) return
    const areaGroups = areas
      .map((name) => ({ name, index: original.nav.findIndex((node) => node.type === 'group' && key(node.label) === key(name)) }))
      .filter((entry) => entry.index >= 0)
    if (areaGroups.length < 2) return
    const byArea = new Map<string, DoxbrixSpace>()
    for (const { name } of areaGroups) {
      const index = original.nav.findIndex((node) => node.type === 'group' && key(node.label) === key(name))
      if (index < 0) continue
      const [group] = original.nav.splice(index, 1) as [DoxbrixGroup]
      byArea.set(key(name), { name, slug: key(name), ...(group.icon ? { icon: group.icon } : {}), nav: group.items ?? [] })
    }
    // What the writer left outside an area group (the landing page, starter
    // groups) opens the first area that has no group of its own, else joins
    // the first area, so no stray "Documentation" space stays beside them.
    const leftovers = original.nav
    let placed = leftovers.length === 0
    const promoted: DoxbrixSpace[] = []
    for (const name of areas) {
      const space = byArea.get(key(name))
      if (space) promoted.push(space)
      else if (!placed && promoted.length === 0) {
        promoted.push({ name, slug: key(name), ...(original.icon ? { icon: original.icon } : {}), nav: leftovers })
        placed = true
      }
    }
    if (!placed) promoted[0]!.nav.unshift(...leftovers)
    site.spaces.splice(0, 1, ...promoted)
    report.repairs.push(`${configFile}: split the navigation into ${promoted.length} spaces from the plan (${promoted.map((space) => space.name).join(', ')}).`)
    changed = true
  }

  const referenced = new Set<string>()
  const collect = (nodes: DoxbrixNavNode[]): void => {
    for (const node of nodes) {
      if (node.type === 'page') referenced.add(navFileId(node.file))
      else if (node.type === 'group') collect(node.items ?? [])
    }
  }
  for (const entry of site.spaces) collect(entry.nav)

  const sectionTitles = new Map<string, string>()
  const sectionSpaces = new Map<string, string>()
  // Plans saved before sections named their space get one from the same rule
  // the planner's normalization uses.
  const plannedSections = assignSectionSpaces(plan.navigation?.top ?? [], plan.navigation?.sections ?? [])
  for (const section of plannedSections) {
    for (const pageIdentifier of section.pageIds) {
      if (!sectionTitles.has(pageIdentifier)) sectionTitles.set(pageIdentifier, section.title)
      if (section.space && !sectionSpaces.has(pageIdentifier)) sectionSpaces.set(pageIdentifier, section.space)
    }
  }
  // A space the plan does not name (the starter "Documentation" space) that
  // still holds planned pages at the end of the run: release those pages so
  // the placement below files each into its planned space and section group.
  // The emptied starter groups and space are then pruned.
  if (pruneEmptySpaces && (plan.navigation?.top ?? []).filter((name) => key(name)).length >= 2) {
    const plannedKeys = new Set((plan.navigation?.top ?? []).map(key))
    for (const candidate of site.spaces) {
      if (candidate.version || candidate.locale) continue
      if (plannedKeys.has(key(candidate.name)) || plannedKeys.has(key(candidate.slug ?? ''))) continue
      for (const entry of existing) {
        if (!referenced.has(entry.id) || !sectionSpaces.has(entry.page.id)) continue
        const result = dropPageNodes(candidate.nav, entry.id)
        if (result.removed === 0) continue
        candidate.nav = result.nodes
        referenced.delete(entry.id)
        changed = true
        report.repairs.push(`${configFile}: moved "${entry.id}" out of space "${candidate.name}", which the plan does not name, to its planned space.`)
      }
    }
  }

  /**
   * The space the plan assigned a page's section to, created in the plan's
   * `top` order when the writer has not made it yet. Batches write pages
   * without seeing the whole plan, so this is what gives a multi-space plan
   * its spaces.
   */
  const plannedSpace = (planPageId: string): DoxbrixSpace | undefined => ensurePlannedSpace(sectionSpaces.get(planPageId))
  function ensurePlannedSpace(name: string | undefined): DoxbrixSpace | undefined {
    if (!name) return undefined
    const found = spaceNamed(name)
    if (found) return found
    const order = (plan.navigation?.top ?? []).map(key)
    if (!order.includes(key(name))) return undefined
    // The writer laid this area out as a group inside a space: keep that
    // layout (the section nests under the area group) instead of a new space.
    if (site.spaces.some((candidate) => candidate.nav.some((node) => node.type === 'group' && key(node.label) === key(name)))) return undefined
    const created: DoxbrixSpace = { name, slug: key(name), nav: [] }
    const rank = order.indexOf(key(name))
    const before = site.spaces.findIndex((candidate) => {
      const candidateRank = order.indexOf(key(candidate.name))
      return candidateRank > rank
    })
    if (before === -1) site.spaces.push(created)
    else site.spaces.splice(before, 0, created)
    report.repairs.push(`${configFile}: created space "${name}" from the plan's navigation.`)
    changed = true
    return created
  }

  /**
   * The top-level group a page's section belongs under, when the writer laid
   * the plan's top-level areas out as groups inside one space rather than as
   * spaces: "self-hosting/docker" belongs under a "Self-hosting" group, and
   * "api/webhooks" under "API & integrations" when the plan lists that area.
   * Without this the section group lands beside the area group, which stays
   * an empty header the reader clicks into for nothing.
   */
  const topAreas = (plan.navigation?.top ?? []).map(key).filter(Boolean)
  const parentGroupFor = (entry: ExistingPage, space: DoxbrixSpace): DoxbrixGroup | undefined => {
    const segment = entry.id.includes('/') ? key(entry.id.split('/')[0]) : ''
    if (!segment) return undefined
    return space.nav.find((node): node is DoxbrixGroup => {
      if (node.type !== 'group') return false
      const groupKey = key(node.label)
      return groupKey === segment || (groupKey.startsWith(`${segment}-`) && topAreas.includes(groupKey))
    })
  }

  // A plan section's pages, as navigation ids, for finding the space that
  // already holds most of them.
  const navIdByPlanId = new Map(plan.pages.map((page) => [page.id, normalizePlanPath(page.path)]))
  for (const entry of existing) navIdByPlanId.set(entry.page.id, entry.id)
  const sectionNavIds = new Map<string, Set<string>>()
  for (const section of plan.navigation?.sections ?? []) {
    const ids = sectionNavIds.get(section.title) ?? new Set<string>()
    for (const pageIdentifier of section.pageIds) {
      const navId = navIdByPlanId.get(pageIdentifier)
      if (navId) ids.add(navId)
    }
    sectionNavIds.set(section.title, ids)
  }
  /**
   * Where a section's group lives when the page's own space has none: the
   * existing group of that name holding the most pages, else the space that
   * already holds most of the section's pages. A plan section is one group;
   * a page whose path starts with another space's slug ("administration/
   * oauth-sso" in "Getting started") joins it rather than opening a
   * one-page duplicate in that other space.
   */
  const sectionHome = (label: string): { space: DoxbrixSpace; group?: DoxbrixGroup } | undefined => {
    let best: { space: DoxbrixSpace; group: DoxbrixGroup; pages: number } | undefined
    for (const candidate of site.spaces) {
      const found = findGroup(candidate, label)
      if (!found) continue
      const pages = countPageNodes(found.items ?? [])
      if (!best || pages > best.pages) best = { space: candidate, group: found, pages }
    }
    if (best) return { space: best.space, group: best.group }
    const ids = sectionNavIds.get(label)
    if (!ids || ids.size === 0) return undefined
    let bySpace: { space: DoxbrixSpace; pages: number } | undefined
    for (const candidate of site.spaces) {
      const pages = countMatchingPages(candidate.nav, ids)
      if (pages > 0 && (!bySpace || pages > bySpace.pages)) bySpace = { space: candidate, pages }
    }
    return bySpace ? { space: bySpace.space } : undefined
  }

  for (const entry of existing) {
    if (referenced.has(entry.id)) continue
    const node: DoxbrixNavNode = { type: 'page', file: entry.id, title: entry.page.title }
    const label = sectionTitles.get(entry.page.id)
    // The plan places a section in a space: the space it names for the
    // section, or a space the section is named after.
    const explicit = plannedSpace(entry.page.id) ?? spaceNamed(label)
    let space = explicit ?? spaceFor(entry, label)
    // A section that is the space itself needs no group of the same name.
    const groupLabel = label && key(label) !== key(space.name) && key(label) !== key(space.slug) ? label : undefined
    let group = groupLabel ? findGroup(space, groupLabel) : undefined
    if (groupLabel && !group && !explicit) {
      const home = sectionHome(groupLabel)
      if (home) {
        space = home.space
        group = home.group
      }
    }
    if (groupLabel && !group) {
      group = { type: 'group', label: groupLabel, items: [] }
      const parent = parentGroupFor(entry, space)
      if (parent) {
        parent.items.push(group)
        report.repairs.push(`${configFile}: created navigation group "${groupLabel}" under "${parent.label}" in space "${space.name}".`)
      } else {
        // Keep the plan's section order: a section planned before existing groups goes before them.
        const order = (plan.navigation?.sections ?? []).map((section) => key(section.title))
        const rank = order.indexOf(key(groupLabel))
        const before = rank < 0 ? -1 : space.nav.findIndex((node) => node.type === 'group' && order.indexOf(key(node.label)) > rank)
        if (before === -1) space.nav.push(group)
        else space.nav.splice(before, 0, group)
        report.repairs.push(`${configFile}: created navigation group "${groupLabel}" in space "${space.name}".`)
      }
    } else if (!group) {
      const parent = parentGroupFor(entry, space)
      if (parent) group = parent
    }
    if (group) group.items.push(node)
    else space.nav.push(node)
    referenced.add(entry.id)
    changed = true
    report.repairs.push(`${configFile}: added "${entry.id}" to ${group ? `group "${group.label}"` : `space "${space.name}"`}.`)
  }

  // The end-of-run pass also places pages the plan did not name: a starter
  // the writer rewrote into a real page, a page it added on its own. The
  // validator demands they be navigable, and a page the reviewer can see in
  // the sidebar beats a proposal that cannot be applied.
  if (pruneEmptySpaces) {
    let workspacePages: string[] = []
    try {
      const contentRoot = await resolveContainedDirectory(root, project.contentDir, 'Documentation content directory', { allowRoot: true })
      workspacePages = (await loadPages(root, project)).map((absolute) => pageId(contentRoot, absolute))
    } catch {
      workspacePages = []
    }
    // Navigation entries for pages that no longer exist (a starter the run
    // removed, a page the writer renamed) are the validator's "missing page".
    const present = new Set(workspacePages)
    if (workspacePages.length > 0) {
      for (const each of site.spaces) {
        for (const id of [...referenced]) {
          if (present.has(id)) continue
          const result = dropPageNodes(each.nav, id)
          if (result.removed > 0) {
            each.nav = result.nodes
            changed = true
            report.repairs.push(`${configFile}: removed "${id}" from navigation because no such page exists.`)
          }
        }
      }
      for (const id of [...referenced]) if (!present.has(id)) referenced.delete(id)
    }
    for (const id of workspacePages) {
      if (referenced.has(id) || plan.pages.some((page) => page.action === 'remove' && normalizePlanPath(page.path) === id)) continue
      // A starter page the plan superseded is removed by the final check, not navigated.
      const file = await findPageFile(await resolveContainedDirectory(root, project.contentDir, 'Documentation content directory', { allowRoot: true }), id, PAGE_EXTENSIONS)
      if (file && isStarterContent(await readFile(file, 'utf8').catch(() => ''))) continue
      const space = spaceNamed(id.includes('/') ? id.split('/')[0] : undefined) ?? site.spaces[0]!
      space.nav.push({ type: 'page', file: id, title: labelFromId(id) })
      referenced.add(id)
      changed = true
      report.repairs.push(`${configFile}: added unplanned page "${id}" to space "${space.name}" so it is reachable.`)
    }
  }

  for (const entry of missing) {
    if (entry.page.action !== 'remove' || !referenced.has(entry.id)) continue
    let removed = 0
    for (const each of site.spaces) {
      const result = dropPageNodes(each.nav, entry.id)
      each.nav = result.nodes
      removed += result.removed
    }
    if (removed > 0) {
      changed = true
      report.repairs.push(`${configFile}: removed "${entry.id}" from navigation because the plan deletes it.`)
    }
  }

  // One plan section is one group, in the space the plan gives it. A section
  // split across spaces (a writer's docs.json, or an older run's repair, put
  // one of its pages under a same-named group elsewhere) is merged into the
  // copy in its planned space, else into the copy holding most pages; a
  // section that sits only in another space moves to its planned space.
  if (pruneEmptySpaces) {
    for (const section of plannedSections) {
      if (spaceNamed(section.title)) continue
      const copies: Array<{ space: DoxbrixSpace; group: DoxbrixGroup; pages: number }> = []
      for (const candidate of site.spaces) {
        for (const found of findGroups(candidate.nav, section.title)) copies.push({ space: candidate, group: found, pages: countPageNodes(found.items ?? []) })
      }
      if (copies.length === 0) continue
      const target = ensurePlannedSpace(section.space)
      let keep = target ? copies.find((copy) => copy.space === target) : undefined
      if (!keep && target) {
        const group: DoxbrixGroup = { type: 'group', label: copies[0]!.group.label, ...(copies[0]!.group.icon ? { icon: copies[0]!.group.icon } : {}), items: [] }
        target.nav.push(group)
        keep = { space: target, group, pages: 0 }
        copies.push(keep)
        report.repairs.push(`${configFile}: moved navigation group "${group.label}" to space "${target.name}", where the plan puts it.`)
      }
      if (!keep) {
        if (copies.length < 2) continue
        keep = copies.reduce((best, copy) => (copy.pages > best.pages ? copy : best))
      }
      for (const copy of copies) {
        if (copy === keep) continue
        const moved = copy.group.items ?? []
        keep.group.items = [...(keep.group.items ?? []), ...moved]
        copy.group.items = []
        changed = true
        report.repairs.push(`${configFile}: merged navigation group "${copy.group.label}" (${copy.pages} page${copy.pages === 1 ? '' : 's'}) from space "${copy.space.name}" into the one in space "${keep.space.name}".`)
      }
    }
  }

  // Batches finish out of order, so section groups land in whatever order the
  // writers reached them. At the end of the run, each space lists the plan's
  // sections in the plan's order; anything the plan does not name keeps its place.
  if (pruneEmptySpaces) {
    const order = (plan.navigation?.sections ?? []).map((section) => key(section.title))
    for (const space of site.spaces) {
      const ranked = space.nav.map((node, index) => ({ node, index, rank: node.type === 'group' ? order.indexOf(key(node.label)) : -1 }))
      const slots = ranked.filter((entry) => entry.rank >= 0)
      const sorted = [...slots].sort((left, right) => left.rank - right.rank)
      if (sorted.every((entry, position) => entry === slots[position])) continue
      const nav = [...space.nav]
      slots.forEach((slot, position) => { nav[slot.index] = sorted[position]!.node })
      space.nav = nav
      changed = true
      report.repairs.push(`${configFile}: ordered the sections in space "${space.name}" as the plan lists them.`)
    }
  }

  // A group the writer opened for an area but never filled — one it created
  // from the plan's top-level list, or one every page was moved out of — is
  // a header the reader clicks into for nothing. Between batches it stays: a
  // later batch may still fill it.
  if (pruneEmptySpaces) {
    for (const space of site.spaces) {
      const result = dropEmptyGroups(space.nav)
      if (result.removed.length === 0) continue
      space.nav = result.nodes
      changed = true
      for (const label of result.removed) report.repairs.push(`${configFile}: removed empty navigation group "${label}" from space "${space.name}".`)
    }
  }

  // A space the plan promised pages for but nothing landed in is an empty
  // header entry; the validator flags it and readers click into nothing.
  if (pruneEmptySpaces && site.spaces.length > 1) {
    const kept = site.spaces.filter((space) => countPageNodes(space.nav) > 0)
    if (kept.length > 0 && kept.length < site.spaces.length) {
      for (const space of site.spaces) {
        if (!kept.includes(space)) report.repairs.push(`${configFile}: removed space "${space.name}" because no page was written for it.`)
      }
      site.spaces = kept
      changed = true
    }
  }

  if (changed) await writeFile(configPath, `${JSON.stringify(site, null, 2)}\n`, 'utf8')
}

type DoxbrixGroup = Extract<DoxbrixNavNode, { type: 'group' }>

function countPageNodes(nodes: DoxbrixNavNode[]): number {
  let count = 0
  for (const node of nodes) {
    if (node.type === 'page') count += 1
    else if (node.type === 'group') count += countPageNodes(node.items ?? [])
  }
  return count
}

/** Groups with no page anywhere beneath them, removed depth-first so a parent emptied by the removal goes too. */
function dropEmptyGroups(nodes: DoxbrixNavNode[]): { nodes: DoxbrixNavNode[]; removed: string[] } {
  const removed: string[] = []
  const kept: DoxbrixNavNode[] = []
  for (const node of nodes) {
    if (node.type !== 'group') {
      kept.push(node)
      continue
    }
    const inner = dropEmptyGroups(node.items ?? [])
    removed.push(...inner.removed)
    if (countPageNodes(inner.nodes) === 0 && !inner.nodes.some((child) => child.type !== 'group')) {
      removed.push(node.label)
      continue
    }
    kept.push(inner.removed.length > 0 ? { ...node, items: inner.nodes } : node)
  }
  return { nodes: kept, removed }
}

function countMatchingPages(nodes: DoxbrixNavNode[], ids: Set<string>): number {
  let count = 0
  for (const node of nodes) {
    if (node.type === 'page' && ids.has(navFileId(node.file))) count += 1
    else if (node.type === 'group') count += countMatchingPages(node.items ?? [], ids)
  }
  return count
}

/** Every group with this label, at any depth. */
function findGroups(nodes: DoxbrixNavNode[], label: string): DoxbrixGroup[] {
  const wanted = label.trim().toLowerCase()
  const found: DoxbrixGroup[] = []
  for (const node of nodes) {
    if (node.type !== 'group') continue
    if (node.label.trim().toLowerCase() === wanted) found.push(node)
    else found.push(...findGroups(node.items ?? [], label))
  }
  return found
}

function findGroup(space: DoxbrixSpace, label: string): DoxbrixGroup | undefined {
  const wanted = label.trim().toLowerCase()
  const search = (nodes: DoxbrixNavNode[]): DoxbrixGroup | undefined => {
    for (const node of nodes) {
      if (node.type !== 'group') continue
      if (node.label.trim().toLowerCase() === wanted) return node
      const nested = search(node.items ?? [])
      if (nested) return nested
    }
    return undefined
  }
  return search(space.nav)
}

function dropPageNodes(nodes: DoxbrixNavNode[], id: string): { nodes: DoxbrixNavNode[]; removed: number } {
  let removed = 0
  const kept: DoxbrixNavNode[] = []
  for (const node of nodes) {
    if (node.type === 'page' && navFileId(node.file) === id) {
      removed += 1
      continue
    }
    if (node.type === 'group') {
      const inner = dropPageNodes(node.items ?? [], id)
      removed += inner.removed
      kept.push(inner.removed > 0 ? { ...node, items: inner.nodes } : node)
      continue
    }
    kept.push(node)
  }
  return { nodes: kept, removed }
}

/** Doxbrix `file` references are page ids; tolerate `./`, `/`, and an extension. */
function navFileId(file: string): string {
  return normalizePlanPath(file)
}

async function noteUnnavigatedPages(root: string, existing: ExistingPage[], report: PostPassReport): Promise<void> {
  if (existing.length === 0) return
  let orphans: Set<string>
  try {
    const tree = await readNavigation(root)
    if (!tree.editable) return
    orphans = new Set(tree.orphans.map((orphan) => orphan.path))
  } catch {
    return
  }
  for (const entry of existing) {
    if (orphans.has(entry.file)) {
      report.problems.push(`${entry.file}: page is not in the navigation; validation will report it until it is added.`)
    }
  }
}

// ---------------------------------------------------------------------------
// Links

async function repairLinks(
  root: string,
  contentRoot: string,
  project: DoxloopProject,
  plan: DocumentationPlan,
  existing: ExistingPage[],
  report: PostPassReport,
  unlinkUnresolved = false,
): Promise<void> {
  if (existing.length === 0) return
  const canonical = new Set<string>()
  try {
    for (const absolute of await loadPages(root, project)) canonical.add(pageId(contentRoot, absolute))
  } catch {
    for (const entry of existing) canonical.add(entry.id)
  }
  // A planned path that was written over a starter file (the landing page
  // as the site's index) is linked by the file that exists, never by the
  // planned path, which would be a broken link.
  const aliases = new Map<string, string>()
  for (const entry of existing) {
    if (entry.planId !== entry.id) aliases.set(entry.planId, entry.id)
  }
  for (const page of plan.pages) {
    if (page.action === 'remove') continue
    const id = normalizePlanPath(page.path)
    if (id) canonical.add(aliases.get(id) ?? id)
  }
  const bySegment = new Map<string, string[]>()
  const register = (segment: string, id: string): void => {
    const known = bySegment.get(segment) ?? []
    if (!known.includes(id)) bySegment.set(segment, [...known, id])
  }
  for (const id of canonical) register(id.split('/').at(-1)!, id)
  for (const [planId, id] of aliases) register(planId.split('/').at(-1)!, id)
  const hrefFor = (id: string, suffix: string): string => (id === 'index' ? `/${suffix}` : `/${id}${suffix}`)

  // The end-of-run sweep repairs every page in the workspace, not only the
  // planned ones: a starter page the writer updated on its own carries the
  // same broken links, and one of them blocks the whole proposal.
  const targets: Array<Pick<ExistingPage, 'absolute' | 'file'>> = [...existing]
  if (unlinkUnresolved) {
    const seen = new Set(existing.map((entry) => entry.absolute))
    try {
      for (const absolute of await loadPages(root, project)) {
        if (!seen.has(absolute) && PAGE_EXTENSIONS.includes(extname(absolute).toLowerCase())) targets.push({ absolute, file: relativePath(root, absolute) })
      }
    } catch {
      // The planned pages are still repaired.
    }
  }

  if (unlinkUnresolved) await removeMissingImages(root, contentRoot, targets, report)
  for (const entry of targets) {
    const content = await readFile(entry.absolute, 'utf8')
    const rewrites = new Map<string, string>()
    const unlinks = new Set<string>()
    for (const href of contentLinks(content)) {
      if (!isLocalPageLink(href)) continue
      const [target, suffix] = splitSuffix(href)
      let decoded: string
      try {
        decoded = decodeURIComponent(target)
      } catch {
        continue
      }
      if (decoded === '' || isAssetPath(decoded)) continue
      if (await linkResolves(decoded, entry.absolute, contentRoot)) continue
      const normalizedTarget = normalizePlanPath(decoded)
      const aliased = aliases.get(normalizedTarget)
      const segment = decoded.replace(/\/+$/, '').split('/').at(-1)!.replace(/\.(?:md|mdx|html?)$/i, '')
      const candidates = aliased ? [aliased] : bySegment.get(segment) ?? []
      if (candidates.length === 1) {
        const replacement = hrefFor(candidates[0]!, suffix)
        if (replacement !== href) rewrites.set(href, replacement)
        else if (unlinkUnresolved) unlinks.add(href)
      } else if (unlinkUnresolved) {
        unlinks.add(href)
      } else if (candidates.length === 0) {
        report.problems.push(`${entry.file}: link "${href}" does not resolve and no planned or existing page is named "${segment}".`)
      } else {
        report.problems.push(`${entry.file}: link "${href}" does not resolve and could mean any of ${candidates.map((id) => `/${id}`).join(', ')}.`)
      }
    }
    if (rewrites.size === 0 && unlinks.size === 0) continue
    let next = content
    for (const [from, to] of rewrites) next = rewriteLink(next, from, to)
    for (const href of unlinks) next = unlinkTarget(next, href)
    if (next === content) continue
    await writeFile(entry.absolute, next, 'utf8')
    for (const [from, to] of rewrites) report.repairs.push(`${entry.file}: rewrote link ${from} -> ${to}.`)
    for (const href of unlinks) report.repairs.push(`${entry.file}: turned the link ${href} into plain text because no page exists for it.`)
  }
}

/**
 * Replace every Markdown link to `href` with its link text, leaving fenced
 * code and comments untouched. Reference definitions and HTML attributes are
 * left alone: a definition is harmless, and an `href` inside a component is
 * the author's to fix.
 */
export function unlinkTarget(content: string, href: string): string {
  const escaped = href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const markdown = new RegExp(`\\[([^\\]]*)\\]\\(<?${escaped}>?(?:\\s+["'][^"']*["'])?\\)`, 'g')
  const protectedBlocks = /```[^\n]*\n[\s\S]*?```|~~~[^\n]*\n[\s\S]*?~~~|<!--[\s\S]*?-->|`[^`\n]*`/g
  let output = ''
  let cursor = 0
  for (const match of content.matchAll(protectedBlocks)) {
    output += content.slice(cursor, match.index).replace(markdown, '$1')
    output += match[0]
    cursor = match.index + match[0].length
  }
  output += content.slice(cursor).replace(markdown, '$1')
  return output
}

function isLocalPageLink(href: string): boolean {
  return !(href.startsWith('#') || href.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(href))
}

function splitSuffix(href: string): [string, string] {
  const index = href.search(/[?#]/)
  return index === -1 ? [href, ''] : [href.slice(0, index), href.slice(index)]
}

function isAssetPath(path: string): boolean {
  const extension = extname(path).toLowerCase()
  return extension !== '' && !LINK_EXTENSIONS.includes(extension)
}

/** Mirrors the candidate list validation uses for local links. */
async function linkResolves(decoded: string, pagePath: string, contentRoot: string): Promise<boolean> {
  const base = decoded.startsWith('/') ? resolve(contentRoot, `.${decoded}`) : resolve(dirname(pagePath), decoded)
  const candidates = extname(base) === ''
    ? [base, ...['md', 'mdx', 'rst', 'html', 'htm'].flatMap((extension) => [`${base}.${extension}`, join(base, `index.${extension}`)])]
    : /\.html?$/.test(base)
      ? [base, base.replace(/\.html?$/, '.rst'), base.replace(/\.html?$/, '.md'), base.replace(/\.html?$/, '.mdx')]
      : [base]
  for (const candidate of candidates) {
    if (!isInside(contentRoot, candidate)) continue
    try {
      await access(candidate)
      return true
    } catch {
      // Try the next supported form.
    }
  }
  return false
}

/**
 * Replace one link target everywhere it appears as a Markdown destination, a
 * reference definition, or an `href`/`src` attribute, leaving fenced code and
 * comments untouched so examples keep their literal text.
 */
export function rewriteLink(content: string, from: string, to: string): string {
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const markdown = new RegExp(`(\\]\\(<?)${escaped}(>?(?:\\s+["'][^"']*["'])?\\))`, 'g')
  const reference = new RegExp(`(^\\s{0,3}\\[[^\\]]+\\]:\\s*<?)${escaped}(>?)(?=\\s|$)`, 'gm')
  const attribute = new RegExp(`(\\b(?:href|src)\\s*=\\s*)(["'])${escaped}\\2`, 'gi')
  const protectedBlocks = /```[^\n]*\n[\s\S]*?```|~~~[^\n]*\n[\s\S]*?~~~|<!--[\s\S]*?-->/g
  let output = ''
  let cursor = 0
  const apply = (segment: string): string => segment
    .replace(markdown, (_match, open: string, close: string) => `${open}${to}${close}`)
    .replace(reference, (_match, open: string, close: string) => `${open}${to}${close}`)
    .replace(attribute, (_match, prefix: string, quote: string) => `${prefix}${quote}${to}${quote}`)
  for (const match of content.matchAll(protectedBlocks)) {
    output += apply(content.slice(cursor, match.index))
    output += match[0]
    cursor = match.index + match[0].length
  }
  output += apply(content.slice(cursor))
  return output
}

// ---------------------------------------------------------------------------
// Evidence map

async function repairEvidenceMap(
  root: string,
  contentRoot: string,
  plan: DocumentationPlan,
  existing: ExistingPage[],
  extensions: string[],
  report: PostPassReport,
): Promise<void> {
  let map: EvidenceMap | undefined
  let rebuilt = false
  try {
    map = await readEvidenceMap(root)
  } catch (error) {
    const invalidFile = join('.doxloop', 'evidence-map.invalid.json')
    await rename(join(root, EVIDENCE_MAP_FILE), join(root, invalidFile))
    map = { schemaVersion: 1, pages: {} }
    rebuilt = true
    for (const page of plan.pages) {
      const id = normalizePlanPath(page.path)
      if (!id || !isInside(contentRoot, resolve(contentRoot, id))) continue
      const absolute = await findPageFile(contentRoot, id, extensions)
      if (absolute) map.pages[relativePath(root, absolute)] = seedEvidence(page)
    }
    report.problems.push(`${EVIDENCE_MAP_FILE} was malformed (${errorMessage(error)}); it was moved to ${invalidFile} and rebuilt from the plan with inferred confidence. Review the rebuilt entries.`)
  }
  if (existing.length === 0 && !rebuilt) return
  const next: EvidenceMap = map ?? { schemaVersion: 1, pages: {} }
  const added: string[] = []
  for (const entry of existing) {
    if (next.pages[entry.file]) continue
    next.pages[entry.file] = seedEvidence(entry.page)
    added.push(entry.file)
    if (entry.page.evidenceDetails.length === 0) {
      report.problems.push(`${entry.file}: the plan lists no evidence for this page, so its evidence-map entry has no sources and cannot go stale.`)
    }
  }
  if (added.length === 0 && !rebuilt) return
  await writeEvidenceMap(root, next)
  for (const file of added) report.repairs.push(`${EVIDENCE_MAP_FILE}: seeded an inferred entry for ${file} from the plan.`)
}

export function seedEvidence(page: DocumentationPlanPage): PageEvidence {
  const grouped = new Map<string, Set<string>>()
  for (const detail of page.evidenceDetails ?? []) {
    const source = detail.source?.trim()
    if (!source) continue
    const paths = grouped.get(source) ?? new Set<string>()
    const path = detail.path?.trim()
    if (path) paths.add(path)
    grouped.set(source, paths)
  }
  return {
    sources: [...grouped].map(([source, paths]) => (paths.size > 0 ? { source, paths: [...paths] } : { source })),
    confidence: 'inferred',
  }
}

// ---------------------------------------------------------------------------
// Shared helpers

function isDoxbrix(project: DoxloopProject): boolean {
  return project.generator === 'doxbrix' || project.generator === undefined
}

function pageExtensionsFor(plan: DocumentationPlan): string[] {
  const configured = (plan.target?.pageExtensions ?? [])
    .map((extension) => (extension.startsWith('.') ? extension : `.${extension}`).toLowerCase())
    .filter((extension) => PAGE_EXTENSIONS.includes(extension))
  return configured.length > 0 ? [...new Set(configured)] : [...PAGE_EXTENSIONS]
}

/** Strip `./`, a leading slash, and a page extension so plan paths compare to page ids. */
export function normalizePlanPath(path: string): string {
  return path
    .trim()
    .replace(/\\/g, '/')
    .replace(/^(?:\.\/)+/, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.(?:md|mdx)$/i, '')
}

async function findPageFile(contentRoot: string, id: string, extensions: string[]): Promise<string | undefined> {
  const candidates = [
    ...extensions.map((extension) => resolve(contentRoot, `${id}${extension}`)),
    ...extensions.map((extension) => resolve(contentRoot, id, `index${extension}`)),
  ]
  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate
  }
  return undefined
}

function isInside(root: string, candidate: string): boolean {
  const relation = relative(root, candidate)
  return relation === '' || (!relation.startsWith('..') && !relation.startsWith('/'))
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function labelFromId(id: string): string {
  const segment = id.split('/').filter(Boolean).at(-1) ?? id
  return segment.replace(/[-_]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ---------------------------------------------------------------------------
// Missing images and superseded starters

const IMAGE_REFERENCE = /!\[[^\]]*\]\(\s*([^)\s]+)[^)]*\)|<img\b[^>]*\bsrc=["']([^"']+)["']/g

/**
 * An image a page embeds but the workspace no longer holds (a capture the
 * screenshot check downgraded, an asset the agent named but never saved) is
 * a broken link that blocks the whole proposal. The end-of-run pass drops
 * the embed, with its <Frame> wrapper, so the page stays applicable.
 */
async function removeMissingImages(root: string, contentRoot: string, targets: Array<Pick<ExistingPage, 'absolute' | 'file'>>, report: PostPassReport): Promise<void> {
  for (const entry of targets) {
    let content: string
    try { content = await readFile(entry.absolute, 'utf8') } catch { continue }
    let next = content
    const removed: string[] = []
    for (const match of content.matchAll(IMAGE_REFERENCE)) {
      const raw = (match[1] ?? match[2] ?? '').trim()
      if (!raw || /^[a-z]+:/i.test(raw) || raw.startsWith('//') || raw.startsWith('data:')) continue
      const target = raw.split(/[?#]/)[0]!
      let decoded: string
      try { decoded = decodeURIComponent(target) } catch { continue }
      const absolute = decoded.startsWith('/') ? resolve(contentRoot, `.${decoded}`) : resolve(dirname(entry.absolute), decoded)
      if (relative(root, absolute).startsWith('..')) continue
      if (await pathExists(absolute)) continue
      next = removeImageReference(next, decoded)
      removed.push(decoded)
    }
    if (next !== content) {
      await writeFile(entry.absolute, next, 'utf8')
      report.repairs.push(`${entry.file}: removed ${removed.length} image embed${removed.length === 1 ? '' : 's'} whose file does not exist (${removed.join(', ')}).`)
    }
  }
}

/**
 * Delete the generated starter pages behind unplanned-page errors when they
 * still carry the starter marker. A plan that keeps no page at a starter's
 * path superseded it; handing it to a fix session produced a rewritten page
 * that was still in no navigation.
 */
export async function removeSupersededStarterPages(root: string, issues: ValidationIssue[], report?: PostPassReport): Promise<string[]> {
  const removed: string[] = []
  for (const file of new Set(issues.filter((issue) => (issue.code === 'unnavigated-page' || issue.code === 'thin-page' || issue.code === 'starter-content') && issue.file).map((issue) => issue.file!))) {
    if (!/^[\w./-]+\.(mdx?|rst)$/.test(file) || file.split('/').includes('..')) continue
    const absolute = join(root, file)
    let content: string
    try { content = await readFile(absolute, 'utf8') } catch { continue }
    if (!isStarterContent(content)) continue
    await rm(absolute, { force: true })
    removed.push(file)
    report?.repairs.push(`${file}: removed the starter page the plan superseded.`)
  }
  return removed
}

