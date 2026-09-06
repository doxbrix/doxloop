import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { applyDirectEdit } from './direct-edit.js'
import { DoxloopError } from './errors.js'
import { resolveContainedDirectory } from './fs.js'
import type { GeneratorNavigationTreeNode } from './generator-api.js'
import { loadGeneratorAdapter } from './generators.js'
import {
  loadPages,
  loadProject,
  loadSiteConfig,
  pageId,
  readPage,
  relativePath,
  siteConfigPath,
} from './project.js'
import type { DoxbrixNavNode, DoxbrixSpace, DoxloopProject } from './types.js'

/**
 * The navigation editor's model. It is the Doxbrix node shape for every
 * generator: page and group nodes are what MkDocs and the other tree-capable
 * adapters map to, and label, divider, link, and API nodes only appear for
 * Doxbrix. Page nodes carry the project-relative `path` so the editor can join
 * them to the page list; the path is derived and never written back.
 */
export type NavigationNode =
  | { type: 'page'; file: string; path?: string; title?: string; pageTitle?: string; icon?: string; hidden?: boolean }
  | { type: 'group'; label: string; icon?: string; hidden?: boolean; items: NavigationNode[] }
  | { type: 'label'; text: string }
  | { type: 'divider' }
  | { type: 'link'; title: string; href: string; icon?: string }
  | { type: 'api'; title: string; spec: string; icon?: string }

export interface NavigationSpace {
  name: string
  icon?: string
  nav: NavigationNode[]
}

export interface NavigationSupport {
  icons: boolean
  hidden: boolean
  labels: boolean
  links: boolean
  dividers: boolean
  spaces: boolean
}

export interface NavigationTree {
  generator: string
  /** False when the generator keeps its navigation in code Doxloop cannot rewrite. */
  editable: boolean
  reason?: string
  /** Project-relative file the navigation lives in. */
  configFile: string
  fingerprint: string
  /** Whether every page must stay in navigation, which is the Doxbrix rule. */
  requiresEveryPage: boolean
  /** Node types the generator can represent beyond pages and groups. */
  supports: NavigationSupport
  spaces: NavigationSpace[]
  /** Pages that exist on disk but are not referenced by the navigation. */
  orphans: Array<{ file: string; path: string; title: string }>
  /** Icon names the Doxbrix reader can draw. */
  icons: string[]
}

export const DOXBRIX_NAV_ICONS = [
  'book', 'file', 'home', 'rocket', 'bolt', 'zap', 'terminal', 'code', 'braces', 'plug', 'settings',
  'wrench', 'key', 'database', 'server', 'cloud', 'package', 'workflow', 'users', 'compass', 'globe',
  'list', 'link', 'github', 'clock', 'history', 'search', 'sparkle',
]

const MAX_LABEL = 120
const NO_SUPPORT: NavigationSupport = { icons: false, hidden: false, labels: false, links: false, dividers: false, spaces: false }

export async function readNavigation(root: string): Promise<NavigationTree> {
  const project = await loadProject(root)
  const contentRoot = await contentDirectory(root, project)
  const files = await loadPages(root, project)
  const known = new Map<string, { path: string; title: string }>()
  for (const absolute of files) {
    const page = await readPage(absolute)
    const path = relativePath(root, absolute)
    const entry = { path, title: page.title || labelFromFile(path) }
    known.set(pageId(contentRoot, absolute), entry)
    known.set(relativePath(contentRoot, absolute), entry)
  }

  if (project.generator === 'doxbrix') {
    const configPath = await siteConfigPath(root, project)
    const site = await loadSiteConfig(root, project)
    const raw = await readFile(configPath, 'utf8')
    const referenced = new Set<string>()
    const spaces = site.spaces.map((space) => ({
      name: space.name,
      ...(space.icon ? { icon: space.icon } : {}),
      nav: decorate(space.nav as NavigationNode[], known, referenced),
    }))
    return {
      generator: 'doxbrix',
      editable: true,
      configFile: relativePath(root, configPath),
      fingerprint: fingerprint(raw),
      requiresEveryPage: true,
      supports: { icons: true, hidden: true, labels: true, links: true, dividers: true, spaces: true },
      spaces,
      orphans: orphans(files, root, known, referenced, (absolute) => pageId(contentRoot, absolute)),
      icons: DOXBRIX_NAV_ICONS,
    }
  }

  const adapter = await loadGeneratorAdapter(root, project)
  const configFile = adapter.planning?.navigationFiles[0] ?? ''
  const base = { generator: project.generator, configFile, requiresEveryPage: false, supports: NO_SUPPORT, icons: [] }
  if (!adapter.readNavigationTree || !adapter.writeNavigationTree) {
    return {
      ...base,
      editable: false,
      reason: configFile
        ? `${adapter.displayName} keeps its navigation in ${configFile}. Doxloop cannot rewrite that file safely, so edit it directly or ask the agent to change the navigation.`
        : `${adapter.displayName} derives its navigation from the file system, so there is nothing to reorder here.`,
      fingerprint: '',
      spaces: [],
      orphans: [],
    }
  }
  const tree = await adapter.readNavigationTree({ root, contentRoot, project })
  const referenced = new Set<string>()
  const nav = decorate(fromGeneratorTree(tree.nodes), known, referenced)
  const configText = configFile ? await readFile(join(root, configFile), 'utf8').catch(() => '') : ''
  return {
    ...base,
    editable: true,
    fingerprint: fingerprint(configText || JSON.stringify(tree)),
    spaces: [{ name: project.title, nav }],
    orphans: orphans(files, root, known, referenced, (absolute) => relativePath(contentRoot, absolute)),
  }
}

export interface NavigationWrite {
  fingerprint: string
  spaces: Array<{ name: string; nav: unknown }>
}

export async function writeNavigation(root: string, raw: unknown): Promise<NavigationTree> {
  const input = parseWrite(raw)
  const current = await readNavigation(root)
  if (!current.editable) throw new DoxloopError(current.reason ?? 'This navigation cannot be edited from Doxloop.', 2)
  if (input.fingerprint !== current.fingerprint) {
    throw new DoxloopError('The navigation changed on disk since it was loaded. Reload the navigation and apply your changes again.')
  }
  const project = await loadProject(root)
  const contentRoot = await contentDirectory(root, project)
  const files = await loadPages(root, project)
  const knownFiles = new Set(files.map((absolute) => (
    project.generator === 'doxbrix' ? pageId(contentRoot, absolute) : relativePath(contentRoot, absolute)
  )))
  const spaces = input.spaces.map((space, index) => ({
    name: requireLabel(space.name, `Space ${index + 1} name`),
    nav: sanitizeNodes(space.nav, knownFiles, new Set<string>(), current.supports, `space "${space.name}"`),
  }))
  if (spaces.length === 0) throw new DoxloopError('Navigation needs at least one space.', 2)
  if (!current.supports.spaces && spaces.length > 1) throw new DoxloopError(`${project.generator} navigation is a single tree.`, 2)

  await applyDirectEdit(root, {
    kind: 'navigation',
    requestText: 'Reorganized the navigation',
    files: current.configFile ? [current.configFile] : [],
    apply: async () => {
      if ((await readNavigation(root)).fingerprint !== input.fingerprint) throw new DoxloopError('Navigation changed before saving. Reload and try again.')
      if (project.generator === 'doxbrix') {
        await writeDoxbrixNavigation(root, project, spaces)
        return
      }
      const adapter = await loadGeneratorAdapter(root, project)
      await adapter.writeNavigationTree!({ root, contentRoot, project, tree: { nodes: toGeneratorTree(spaces[0]!.nav) } })
    },
  })
  return readNavigation(root)
}

/**
 * Add one page to the Doxbrix navigation, used by generated content such as
 * the glossary. The page joins the named group when it exists, otherwise the
 * end of the first space. Other generators go through the adapter's
 * `writeNavigation` hook.
 */
export async function appendDoxbrixNavigationPage(
  root: string,
  project: DoxloopProject,
  page: { file: string; title: string; icon?: string; section?: string },
): Promise<void> {
  const configPath = await siteConfigPath(root, project)
  const site = await loadSiteConfig(root, project)
  const space = site.spaces[0]
  if (!space) throw new DoxloopError('docs.json has no space to add the page to.')
  const existing = new Set<string>()
  const walk = (nodes: DoxbrixNavNode[]): void => {
    for (const node of nodes) {
      if (node.type === 'page') existing.add(node.file)
      else if (node.type === 'group') walk(node.items)
    }
  }
  for (const entry of site.spaces) walk(entry.nav)
  if (existing.has(page.file)) return
  const node: DoxbrixNavNode = { type: 'page', file: page.file, title: page.title, ...(page.icon ? { icon: page.icon } : {}) }
  const group = page.section
    ? space.nav.find((entry): entry is Extract<DoxbrixNavNode, { type: 'group' }> => entry.type === 'group' && entry.label === page.section)
    : undefined
  if (group) group.items.push(node)
  else space.nav.push(node)
  await writeFile(configPath, `${JSON.stringify(site, null, 2)}\n`, 'utf8')
}

async function writeDoxbrixNavigation(root: string, project: DoxloopProject, spaces: NavigationSpace[]): Promise<void> {
  const configPath = await siteConfigPath(root, project)
  const site = await loadSiteConfig(root, project)
  const existing = new Map(site.spaces.map((space) => [space.name, space]))
  const next: DoxbrixSpace[] = spaces.map((space, index) => {
    const previous = existing.get(space.name) ?? site.spaces[index]
    return { ...(previous ?? {}), name: space.name, nav: space.nav as DoxbrixNavNode[] }
  })
  await writeFile(configPath, `${JSON.stringify({ ...site, spaces: next }, null, 2)}\n`, 'utf8')
}

function parseWrite(raw: unknown): NavigationWrite {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new DoxloopError('A navigation write needs spaces and a fingerprint.', 2)
  const body = raw as Record<string, unknown>
  if (typeof body.fingerprint !== 'string') throw new DoxloopError('A navigation write needs the fingerprint it was loaded with.', 2)
  if (!Array.isArray(body.spaces)) throw new DoxloopError('A navigation write needs a spaces array.', 2)
  return {
    fingerprint: body.fingerprint,
    spaces: body.spaces.map((space) => {
      const entry = (space && typeof space === 'object' ? space : {}) as Record<string, unknown>
      return { name: typeof entry.name === 'string' ? entry.name : '', nav: entry.nav }
    }),
  }
}

function sanitizeNodes(
  raw: unknown,
  knownFiles: Set<string>,
  seen: Set<string>,
  supports: NavigationSupport,
  location: string,
): NavigationNode[] {
  if (!Array.isArray(raw)) throw new DoxloopError(`${location} needs a list of navigation items.`, 2)
  return raw.map((item, index): NavigationNode => {
    const node = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>
    const where = `${location} item ${index + 1}`
    const icon = supports.icons ? optionalIcon(node.icon, where) : undefined
    const hidden = supports.hidden && node.hidden === true
    switch (node.type) {
      case 'page': {
        const file = typeof node.file === 'string' ? node.file.trim().replace(/^\.?\//, '') : ''
        if (!file || !knownFiles.has(file)) throw new DoxloopError(`${where} points at "${file || '?'}", which is not a page in this project.`, 2)
        if (seen.has(file)) throw new DoxloopError(`"${file}" appears more than once in the navigation.`, 2)
        seen.add(file)
        const title = optionalLabel(node.title, `${where} title`)
        return { type: 'page', file, ...(title ? { title } : {}), ...(icon ? { icon } : {}), ...(hidden ? { hidden } : {}) }
      }
      case 'group': {
        const label = requireLabel(node.label, `${where} group label`)
        return {
          type: 'group',
          label,
          ...(icon ? { icon } : {}),
          ...(hidden ? { hidden } : {}),
          items: sanitizeNodes(node.items ?? [], knownFiles, seen, supports, `group "${label}"`),
        }
      }
      case 'label':
        if (!supports.labels) throw new DoxloopError(`${where}: this generator has no section labels.`, 2)
        return { type: 'label', text: requireLabel(node.text, `${where} label text`) }
      case 'divider':
        if (!supports.dividers) throw new DoxloopError(`${where}: this generator has no dividers.`, 2)
        return { type: 'divider' }
      case 'link': {
        if (!supports.links) throw new DoxloopError(`${where}: this generator has no navigation links.`, 2)
        const href = typeof node.href === 'string' ? node.href.trim() : ''
        if (!/^(?:https:\/\/|\/(?!\/))/i.test(href)) throw new DoxloopError(`${where} link needs an HTTPS or root-relative address.`, 2)
        return { type: 'link', title: requireLabel(node.title, `${where} link title`), href, ...(icon ? { icon } : {}) }
      }
      case 'api': {
        if (!supports.links) throw new DoxloopError(`${where}: this generator has no API entries.`, 2)
        const spec = typeof node.spec === 'string' ? node.spec.trim() : ''
        if (!spec) throw new DoxloopError(`${where} API entry needs a specification path.`, 2)
        return { type: 'api', title: requireLabel(node.title, `${where} API title`), spec, ...(icon ? { icon } : {}) }
      }
      default:
        throw new DoxloopError(`${where} has an unsupported type.`, 2)
    }
  })
}

function requireLabel(value: unknown, label: string): string {
  const text = optionalLabel(value, label)
  if (!text) throw new DoxloopError(`${label} is required.`, 2)
  return text
}

function optionalLabel(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw new DoxloopError(`${label} must be text.`, 2)
  const text = value.trim().replace(/\s+/g, ' ')
  if (text.length > MAX_LABEL) throw new DoxloopError(`${label} must be ${MAX_LABEL} characters or fewer.`, 2)
  return text || undefined
}

function optionalIcon(value: unknown, where: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(value)) throw new DoxloopError(`${where} icon must be an icon name.`, 2)
  return value
}

function decorate(
  nodes: NavigationNode[],
  known: Map<string, { path: string; title: string }>,
  referenced: Set<string>,
): NavigationNode[] {
  return nodes.map((node) => {
    if (node.type === 'page') {
      const file = node.file.replace(/^\.?\//, '')
      const page = known.get(file)
      if (page) referenced.add(page.path)
      return { ...node, file, ...(page ? { path: page.path, pageTitle: page.title } : {}) }
    }
    if (node.type === 'group') return { ...node, items: decorate(node.items ?? [], known, referenced) }
    return node
  })
}

function orphans(
  files: string[],
  root: string,
  known: Map<string, { path: string; title: string }>,
  referenced: Set<string>,
  fileOf: (absolute: string) => string,
): NavigationTree['orphans'] {
  return files
    .map((absolute) => ({ file: fileOf(absolute), path: relativePath(root, absolute) }))
    .filter((entry) => !referenced.has(entry.path))
    .map((entry) => ({ ...entry, title: known.get(entry.file)?.title ?? labelFromFile(entry.path) }))
}

function fromGeneratorTree(nodes: GeneratorNavigationTreeNode[]): NavigationNode[] {
  return nodes.map((node) => (node.type === 'group'
    ? { type: 'group', label: node.label, items: fromGeneratorTree(node.items) }
    : { type: 'page', file: node.file, ...(node.title ? { title: node.title } : {}) }))
}

function toGeneratorTree(nodes: NavigationNode[]): GeneratorNavigationTreeNode[] {
  const output: GeneratorNavigationTreeNode[] = []
  for (const node of nodes) {
    if (node.type === 'page') output.push({ type: 'page', file: node.file, ...(node.title ? { title: node.title } : {}) })
    else if (node.type === 'group') output.push({ type: 'group', label: node.label, items: toGeneratorTree(node.items) })
  }
  return output
}

function fingerprint(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

async function contentDirectory(root: string, project: DoxloopProject): Promise<string> {
  return resolveContainedDirectory(root, project.contentDir, 'Documentation content directory', {
    allowRoot: project.generator === 'doxbrix',
  })
}

function labelFromFile(path: string): string {
  return path.split('/').at(-1)!.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
}
