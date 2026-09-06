import { mkdir, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { installSkill } from './agents.js'
import { DoxloopError } from './errors.js'
import { EVIDENCE_MAP_FILE, readEvidenceMap, writeEvidenceMap } from './evidence.js'
import { ensureGitignoreEntries, pathExists, resolveContainedDirectory } from './fs.js'
import { generatorCatalogEntry, generatorPackageName, loadGeneratorAdapter, resolveGeneratorPackage } from './generators.js'
import {
  PROJECT_FILE,
  PROJECT_GITIGNORE_ENTRIES,
  defaultDocumentationBrief,
  defaultSyncConfig,
  loadPages,
  loadProject,
  relativePath,
  titleFromDirectory,
} from './project.js'
import { detectDocumentationGenerator, listDocumentationPageFiles, type GeneratorDetection } from './project-detect.js'
import { discoverDocumentationSources } from './source-discovery.js'
import type { AgentName, DoxloopProject, EvidenceMap, GeneratorName } from './types.js'

const INSPECTION_PAGE_SAMPLE = 25

export interface ExistingDocumentationInspection {
  root: string
  /** `.doxloop/project.json` already exists here; open it instead of importing. */
  alreadyProject: boolean
  detection: GeneratorDetection
  generator?: GeneratorName
  contentDir?: string
  title: string
  markers: string[]
  pageCount: number
  /** The first pages, project-relative, so the person can confirm the folder is the right one. */
  pages: string[]
  generatorInstalled: boolean
  generatorPackage?: string
}

export interface ImportExistingDocumentationOptions {
  directory: string
  generator?: GeneratorName
  contentDir?: string
  title?: string
  agent?: AgentName
}

export interface ImportExistingDocumentationResult {
  root: string
  title: string
  generator: GeneratorName
  contentDir: string
  pageCount: number
  skills: Array<{ path: string; action: 'installed' | 'updated' | 'unchanged' }>
  warnings: string[]
}

/**
 * Read-only look at a folder: what generator it uses, where its pages are,
 * and how many there are. Explicit choices override detection so the person
 * can correct a wrong guess before anything is written.
 */
export async function inspectExistingDocumentation(
  directory: string,
  overrides: { generator?: GeneratorName; contentDir?: string } = {},
): Promise<ExistingDocumentationInspection> {
  const root = await resolveImportDirectory(directory)
  const alreadyProject = await pathExists(join(root, PROJECT_FILE))
  const detection = await detectDocumentationGenerator(root)
  const detected = overrides.generator
    ? detection.candidates.find((candidate) => candidate.generator === overrides.generator)
    : detection.recommended
  const generator = overrides.generator ?? detected?.generator
  const contentDir = overrides.contentDir !== undefined
    ? normalizeContentDir(overrides.contentDir)
    : detected?.contentDir ?? (generator ? defaultContentDir(generator) : undefined)
  const pages = generator && contentDir !== undefined ? await listDocumentationPageFiles(root, generator, contentDir) : []
  const generatorPackage = generator ? generatorPackageName(generator) : undefined
  return {
    root,
    alreadyProject,
    detection,
    ...(generator ? { generator } : {}),
    ...(contentDir !== undefined ? { contentDir } : {}),
    title: detected?.title ?? titleFromDirectory(root),
    markers: detected?.markers ?? [],
    pageCount: pages.length,
    pages: pages.slice(0, INSPECTION_PAGE_SAMPLE),
    generatorInstalled: !generatorPackage || resolveGeneratorPackage(root, generatorPackage) !== undefined,
    ...(generatorPackage ? { generatorPackage } : {}),
  }
}

/**
 * Adopt an existing documentation folder as a Doxloop project. Import writes
 * only Doxloop's own files (`.doxloop/project.json`, an evidence map that
 * marks every page as unverified, `.gitignore` entries, and the agent
 * skills) and runs a read-only discovery pass. It never modifies a page.
 */
export async function importExistingDocumentation(
  options: ImportExistingDocumentationOptions,
): Promise<ImportExistingDocumentationResult> {
  const root = await resolveImportDirectory(options.directory)
  if (await pathExists(join(root, PROJECT_FILE))) {
    throw new DoxloopError(`${root} is already a Doxloop project. Open it instead of importing it.`, 2)
  }
  const inspection = await inspectExistingDocumentation(root, {
    ...(options.generator ? { generator: options.generator } : {}),
    ...(options.contentDir !== undefined ? { contentDir: options.contentDir } : {}),
  })
  const generator = inspection.generator
  if (!generator) {
    throw new DoxloopError(
      `Could not recognize the documentation generator in ${root}.\nChoose one explicitly with --generator, or start a new project instead.`,
      2,
    )
  }
  const contentDir = inspection.contentDir ?? defaultContentDir(generator)
  if (contentDir === '' && generator !== 'doxbrix') {
    throw new DoxloopError(`${generatorCatalogEntry(generator)?.displayName ?? generator} keeps its pages in a subdirectory. Choose the content directory explicitly.`, 2)
  }
  await resolveContainedDirectory(root, contentDir, 'Documentation content directory', { allowRoot: generator === 'doxbrix' })
  const configuredPackage = generatorPackageName(generator)
  if (configuredPackage && !resolveGeneratorPackage(root, configuredPackage)) {
    throw new DoxloopError(
      `The ${generatorCatalogEntry(generator)?.displayName ?? generator} generator package is not installed.\nInstall it in the documentation folder with:\n  doxloop generator add ${generator} --cwd ${root}`,
      2,
    )
  }
  const adapter = generator === 'doxbrix' ? undefined : await loadGeneratorAdapter(root, generator, configuredPackage)

  const title = options.title?.trim() || inspection.title
  const project: DoxloopProject = {
    schemaVersion: 1,
    title,
    contentDir,
    generator,
    ...(configuredPackage ? { generatorPackage: configuredPackage } : {}),
    sources: [],
    designReferences: [],
    documentation: defaultDocumentationBrief(),
    sync: defaultSyncConfig(),
  }
  await mkdir(join(root, '.doxloop'), { recursive: true })
  await writeFile(join(root, PROJECT_FILE), `${JSON.stringify(project, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
  const loaded = await loadProject(root)

  const warnings: string[] = []
  const pages = (await loadPages(root, loaded)).map((path) => relativePath(root, path))
  await seedEvidenceMap(root, pages)
  await ensureGitignoreEntries(root, [...PROJECT_GITIGNORE_ENTRIES, ...(adapter?.project.gitignore ?? [])])
  const skills = await installSkill({ root, ...(options.agent ? { agent: options.agent } : {}) })
  try {
    await discoverDocumentationSources(root)
  } catch (error) {
    warnings.push(`Discovery could not run yet: ${error instanceof Error ? error.message : String(error)}`)
  }
  return { root, title, generator, contentDir, pageCount: pages.length, skills, warnings }
}

/**
 * Every existing page starts as unverified: no source produced it, so the
 * first update run has to attach evidence before drift detection can trust
 * it. An evidence map that is already present is kept as it is.
 */
async function seedEvidenceMap(root: string, pages: string[]): Promise<void> {
  if (await pathExists(join(root, EVIDENCE_MAP_FILE))) {
    await readEvidenceMap(root)
    return
  }
  const map: EvidenceMap = { schemaVersion: 1, pages: {} }
  for (const page of pages) map.pages[page] = { sources: [], confidence: 'needs-human' }
  await writeEvidenceMap(root, map)
}

async function resolveImportDirectory(directory: string): Promise<string> {
  const root = resolve(directory)
  let stats
  try {
    stats = await stat(root)
  } catch {
    throw new DoxloopError(`The documentation folder does not exist: ${root}`, 2)
  }
  if (!stats.isDirectory()) throw new DoxloopError(`The documentation folder is not a directory: ${root}`, 2)
  if (root === resolve(homedir()) || dirname(root) === root) {
    throw new DoxloopError('Choose the folder that holds the documentation site, not your home directory or the filesystem root.', 2)
  }
  return root
}

function normalizeContentDir(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/^\/+|\/+$/g, '')
}

function defaultContentDir(generator: GeneratorName): string {
  const defaults: Record<GeneratorName, string> = {
    doxbrix: '',
    docusaurus: 'docs',
    mkdocs: 'docs',
    sphinx: 'docs',
    hugo: 'content',
    vitepress: 'docs',
    markdoc: 'docs',
    nextra: 'content',
    starlight: 'src/content/docs',
    jekyll: '_docs',
    static: 'site',
  }
  return defaults[generator]
}
