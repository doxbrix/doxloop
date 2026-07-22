import {
  access,
  mkdir,
  readFile,
  readdir,
  realpath,
  stat,
  writeFile,
} from 'node:fs/promises'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from 'node:path'
import matter from 'gray-matter'
import { DoxloopError } from './errors.js'
import {
  listFiles,
  pathExists,
  readJson,
  resolveContainedDirectory,
} from './fs.js'
import {
  generatorCatalogEntry,
  generatorPackageName,
  loadGeneratorAdapter,
} from './generators.js'
import { PACKAGE_NAME, VERSION } from './version.js'
import type {
  ApplicationConfig,
  DocumentationBrief,
  DesignReference,
  DoxloopProject,
  DoxbrixNavNode,
  DoxbrixSiteConfig,
  GeneratorName,
  SourceBinding,
} from './types.js'

export const PROJECT_FILE = join('.doxloop', 'project.json')

export function defaultDocumentationBrief(): DocumentationBrief {
  return {
    locale: 'en-US',
    tone: ['clear', 'direct', 'professional'],
    standardsProfile: 'doxloop-v1',
    styleGuide: 'doxloop',
    terminology: {},
    exclusions: [],
    accessibilityTarget: 'WCAG 2.2 AA',
  }
}

export async function findProjectRoot(start: string): Promise<string> {
  let current = resolve(start)
  while (true) {
    if (await pathExists(join(current, PROJECT_FILE))) return current
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  throw new DoxloopError(
    'No Doxloop project found. Run `doxloop init <directory>` first.',
    2,
  )
}

export async function loadProject(root: string): Promise<DoxloopProject> {
  const project = await readJson<Partial<DoxloopProject>>(join(root, PROJECT_FILE))
  const selectedGenerator = project.generator ?? 'doxbrix'
  const expectedGeneratorPackage = generatorPackageName(selectedGenerator)
  if (
    project.schemaVersion !== 1 ||
    typeof project.title !== 'string' ||
    typeof project.contentDir !== 'string' ||
    !isSafeRelativeDirectory(project.contentDir) ||
    !Array.isArray(project.sources) ||
    (project.designReferences !== undefined &&
      !isDesignReferences(project.designReferences)) ||
    (project.application !== undefined &&
      !isApplicationConfig(project.application, project.sources)) ||
    (project.generator !== undefined &&
      generatorCatalogEntry(project.generator) === undefined) ||
    (project.generatorPackage !== undefined &&
      (typeof project.generatorPackage !== 'string' ||
        project.generatorPackage.trim() === '' ||
        project.generatorPackage !== expectedGeneratorPackage)) ||
    !isSourceBindings(project.sources) ||
    (project.documentation !== undefined &&
      !isDocumentationBrief(project.documentation))
  ) {
    throw new DoxloopError(`${PROJECT_FILE} has an unsupported format.`)
  }
  const generator = selectedGenerator
  return {
    schemaVersion: 1,
    title: project.title,
    contentDir: project.contentDir,
    generator,
    ...(project.generatorPackage
      ? { generatorPackage: project.generatorPackage }
      : {}),
    sources: project.sources,
    designReferences: project.designReferences ?? [],
    ...(project.application ? { application: project.application } : {}),
    documentation: project.documentation ?? defaultDocumentationBrief(),
  }
}

export async function siteConfigPath(
  root: string,
  project?: DoxloopProject,
): Promise<string> {
  const loaded = project ?? (await loadProject(root))
  const contentRoot = await resolveContainedDirectory(
    root,
    loaded.contentDir,
    'Documentation content directory',
  )
  const insideContent = join(contentRoot, 'docs.json')
  if (await pathExists(insideContent)) return insideContent
  return join(root, 'docs.json')
}

export async function loadSiteConfig(
  root: string,
  project?: DoxloopProject,
): Promise<DoxbrixSiteConfig> {
  const loaded = project ?? (await loadProject(root))
  const path = await siteConfigPath(root, loaded)
  const config = await readJson<unknown>(path)
  if (isDoxbrixSiteConfig(config)) return config
  if (isLegacySiteConfig(config)) return convertLegacySiteConfig(config)
  throw new DoxloopError(
    `${relativePath(root, path)} must contain a Doxbrix version and spaces array.`,
  )
}

export function doxbrixPageIds(config: DoxbrixSiteConfig): string[] {
  const output: string[] = []
  const walk = (nodes: DoxbrixNavNode[]): void => {
    for (const node of nodes) {
      if (node.type === 'page') output.push(node.file)
      else if (node.type === 'group') walk(node.items)
    }
  }
  for (const space of config.spaces) walk(space.nav)
  return output
}

export function parseSource(raw: string): SourceBinding {
  const equals = raw.indexOf('=')
  if (equals < 1 || equals === raw.length - 1) {
    throw new DoxloopError(
      `Invalid source "${raw}". Use a name and local path, for example product=../product.`,
      2,
    )
  }
  const name = raw.slice(0, equals).trim()
  const path = raw.slice(equals + 1).trim()
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    throw new DoxloopError(`Invalid source name "${name}".`, 2)
  }
  return { name, path }
}

export async function resolveSeparateProjectLayout(options: {
  cwd: string
  source: string
  output: string
}): Promise<{
  sourceRoot: string
  projectRoot: string
  sourceBinding: SourceBinding
}> {
  const sourceRoot = resolve(options.cwd, options.source)
  const projectRoot = resolve(options.cwd, options.output)
  await assertSourceDirectory(sourceRoot)
  await assertSeparateDirectories(sourceRoot, projectRoot)

  if (await pathExists(projectRoot)) {
    const projectStats = await stat(projectRoot)
    if (!projectStats.isDirectory()) {
      throw new DoxloopError(
        `The documentation output is not a directory: ${projectRoot}`,
        2,
      )
    }
    if ((await readdir(projectRoot)).length > 0) {
      throw new DoxloopError(
        `The documentation output is not empty: ${projectRoot}\nChoose a new directory, or run \`doxloop create\` inside an existing Doxloop project.`,
        2,
      )
    }
  }

  return {
    sourceRoot,
    projectRoot,
    sourceBinding: {
      name: 'product',
      path: relative(projectRoot, sourceRoot).split('\\').join('/'),
    },
  }
}

export async function validateProjectSourceBoundaries(
  projectRoot: string,
  sources: SourceBinding[],
): Promise<void> {
  for (const source of sources) {
    const sourceRoot = resolve(projectRoot, source.path)
    await assertSourceDirectory(sourceRoot)
    await assertSeparateDirectories(sourceRoot, projectRoot)
  }
}

async function assertSourceDirectory(sourceRoot: string): Promise<void> {
  let sourceStats
  try {
    sourceStats = await stat(sourceRoot)
  } catch {
    throw new DoxloopError(
      `The product source does not exist: ${sourceRoot}\nChoose an existing product directory and try again.`,
      2,
    )
  }
  if (!sourceStats.isDirectory()) {
    throw new DoxloopError(
      `The product source is not a directory: ${sourceRoot}`,
      2,
    )
  }
}

async function assertSeparateDirectories(
  sourceRoot: string,
  projectRoot: string,
): Promise<void> {
  const canonicalSource = await realpath(sourceRoot)
  const canonicalProject = await canonicalizeProspectivePath(projectRoot)
  if (
    isSameOrInside(canonicalSource, canonicalProject) ||
    isSameOrInside(canonicalProject, canonicalSource)
  ) {
    throw new DoxloopError(
      `The product source and documentation project must be separate directories.\n\nProduct source:\n  ${sourceRoot}\n\nDocumentation project:\n  ${projectRoot}\n\nCreate them as sibling projects so product code is never written to or included in documentation deployment.`,
      2,
    )
  }
}

async function canonicalizeProspectivePath(path: string): Promise<string> {
  let existing = resolve(path)
  const suffix: string[] = []
  while (!(await pathExists(existing))) {
    const parent = dirname(existing)
    if (parent === existing) return resolve(path)
    suffix.unshift(basename(existing))
    existing = parent
  }
  return resolve(await realpath(existing), ...suffix)
}

function isSameOrInside(parent: string, candidate: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}${sep}`)
}

export function parseDesignReference(raw: string): DesignReference {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new DoxloopError(
      `Invalid design reference "${raw}". Use an absolute HTTP or HTTPS URL.`,
      2,
    )
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new DoxloopError(
      `Invalid design reference "${raw}". Use an HTTP or HTTPS URL without embedded credentials.`,
      2,
    )
  }
  url.hash = ''
  return { url: url.toString() }
}

export async function addDesignReferences(
  root: string,
  references: DesignReference[],
): Promise<void> {
  if (references.length === 0) return
  const path = join(root, PROJECT_FILE)
  const raw = await readJson<Record<string, unknown>>(path)
  const project = await loadProject(root)
  const urls = new Set(project.designReferences.map((reference) => reference.url))
  for (const reference of references) urls.add(reference.url)
  await writeJson(path, {
    ...raw,
    designReferences: [...urls].map((url) => ({ url })),
  })
}

export async function scaffoldProject(options: {
  directory: string
  title?: string
  sources: SourceBinding[]
  designReferences?: DesignReference[]
  generator?: GeneratorName
}): Promise<string> {
  const root = resolve(options.directory)
  if (await pathExists(join(root, PROJECT_FILE))) {
    throw new DoxloopError(`A Doxloop project already exists at ${root}.`)
  }

  const title = options.title?.trim() || titleFromDirectory(root)
  const generator = options.generator ?? 'doxbrix'
  const configuredPackage = generatorPackageName(generator)
  const adapter =
    generator === 'doxbrix'
      ? undefined
      : await loadGeneratorAdapter(root, generator, configuredPackage)
  const contentDir = adapter?.project.defaultContentDir ?? 'docs'
  await mkdir(join(root, '.doxloop'), { recursive: true })
  await mkdir(join(root, contentDir), { recursive: true })

  const project: DoxloopProject = {
    schemaVersion: 1,
    title,
    contentDir,
    generator,
    ...(configuredPackage ? { generatorPackage: configuredPackage } : {}),
    sources: options.sources,
    designReferences: options.designReferences ?? [],
    documentation: defaultDocumentationBrief(),
  }
  await writeJson(join(root, PROJECT_FILE), project)
  if (adapter) {
    await adapter.scaffold({
      root,
      title,
      contentDir,
      corePackage: { name: PACKAGE_NAME, version: VERSION },
      generatorPackage: {
        name: adapter.packageName,
        version: adapter.packageVersion,
      },
    })
  } else {
    await scaffoldDoxbrix(root, title)
  }
  await mergeGitignore(root, [
    '.doxloop/cache/',
    '.doxloop/last-run.json',
    ...(adapter?.project.gitignore ?? []),
  ])
  return root
}

export async function loadPages(root: string, project: DoxloopProject): Promise<string[]> {
  const contentRoot = await resolveContainedDirectory(
    root,
    project.contentDir,
    'Documentation content directory',
  )
  await access(contentRoot)
  const extensions =
    project.generator === 'doxbrix'
      ? ['.md', '.mdx']
      : (await loadGeneratorAdapter(root, project)).project.pageExtensions
  return listFiles(contentRoot, new Set(extensions))
}

function isSafeRelativeDirectory(value: string): boolean {
  if (value.trim() === '' || isAbsolute(value)) return false
  const normalized = normalize(value)
  return (
    normalized !== '.' &&
    normalized !== '..' &&
    !normalized.startsWith(`..${sep}`)
  )
}

export async function readPage(path: string): Promise<{
  title: string
  description?: string
  body: string
}> {
  const parsed = matter(await readFile(path, 'utf8'))
  const title = typeof parsed.data.title === 'string' ? parsed.data.title.trim() : ''
  const description =
    typeof parsed.data.description === 'string' ? parsed.data.description.trim() : undefined
  return description === undefined
    ? { title, body: parsed.content }
    : { title, description, body: parsed.content }
}

export function pageId(contentRoot: string, path: string): string {
  return relativePath(contentRoot, path).replace(/\.[^.\/]+$/i, '')
}

export function relativePath(root: string, path: string): string {
  return path.slice(resolve(root).length + 1).split('\\').join('/')
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function mergeGitignore(root: string, entries: string[]): Promise<void> {
  const path = join(root, '.gitignore')
  const existing = (await pathExists(path)) ? await readFile(path, 'utf8') : ''
  const lines = existing.split(/\r?\n/).filter(Boolean)
  const seen = new Set(lines)
  for (const entry of entries) {
    if (!seen.has(entry)) {
      lines.push(entry)
      seen.add(entry)
    }
  }
  await writeFile(path, `${lines.join('\n')}\n`, 'utf8')
}

function titleFromDirectory(directory: string): string {
  return basename(directory)
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => `${word[0]?.toUpperCase() ?? ''}${word.slice(1)}`)
    .join(' ')
}

async function scaffoldDoxbrix(root: string, title: string): Promise<void> {
  const site: DoxbrixSiteConfig = {
    version: 1,
    name: title,
    description: `Documentation for ${title}.`,
    spaces: [
      {
        name: 'Documentation',
        slug: 'docs',
        icon: 'book',
        nav: [
          {
            type: 'group',
            label: 'Get started',
            icon: 'rocket',
            items: [
              {
                type: 'page',
                file: 'index',
                title: 'Overview',
                icon: 'compass',
              },
              {
                type: 'page',
                file: 'quickstart',
                title: 'Quickstart',
                icon: 'bolt',
              },
            ],
          },
        ],
      },
    ],
    theme: {
      primaryColor: '#6366f1',
      mode: 'system',
      font: 'Inter',
      headingFont: 'Inter',
      codeFont: 'ui-monospace',
    },
  }
  await writeJson(join(root, 'docs', 'docs.json'), site)
  await writeFile(
    join(root, 'docs', 'index.mdx'),
    `---\ntitle: ${JSON.stringify(title)}\ndescription: "Understand what ${title} helps you accomplish and choose your first workflow."\nicon: compass\n---\n\n# ${title}\n\n<!-- doxloop:starter-page -->\n\n<Info>The authoring agent will replace this starter with an evidence-backed product overview.</Info>\n\n<CardGroup cols="2">\n<Card title="Quickstart" icon="🚀" href="/quickstart">Reach your first successful result.</Card>\n<Card title="Explore the product" icon="🧭">Discover the workflows supported by the configured source.</Card>\n</CardGroup>\n`,
    { encoding: 'utf8', flag: 'wx' },
  )
  await writeFile(
    join(root, 'docs', 'quickstart.mdx'),
    `---\ntitle: "Quickstart"\ndescription: "Reach your first successful result with verified product instructions."\nicon: bolt\n---\n\n# Quickstart\n\n<!-- doxloop:starter-page -->\n\n<Steps>\n<Step title="Confirm the prerequisites">Use the authoring agent to identify supported requirements from source.</Step>\n<Step title="Complete the first workflow">Replace this starter with commands or code verified against the product.</Step>\n<Step title="Verify success">Show the observable result a reader should expect.</Step>\n</Steps>\n`,
    { encoding: 'utf8', flag: 'wx' },
  )
}

function isDoxbrixSiteConfig(value: unknown): value is DoxbrixSiteConfig {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<DoxbrixSiteConfig>
  return candidate.version === 1 && Array.isArray(candidate.spaces)
}

interface LegacySiteConfig {
  title: string
  description?: string
  navigation: Array<{ label: string; pages: string[] }>
}

function isLegacySiteConfig(value: unknown): value is LegacySiteConfig {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<LegacySiteConfig>
  return typeof candidate.title === 'string' && Array.isArray(candidate.navigation)
}

function convertLegacySiteConfig(config: LegacySiteConfig): DoxbrixSiteConfig {
  return {
    version: 1,
    name: config.title,
    ...(config.description ? { description: config.description } : {}),
    spaces: [
      {
        name: 'Documentation',
        slug: 'docs',
        nav: config.navigation.map((group) => ({
          type: 'group',
          label: group.label,
          items: group.pages.map((file) => ({ type: 'page', file })),
        })),
      },
    ],
  }
}

function isSourceBindings(value: unknown): value is SourceBinding[] {
  return (
    Array.isArray(value) &&
    value.every(
      (source) =>
        source !== null &&
        typeof source === 'object' &&
        typeof (source as Partial<SourceBinding>).name === 'string' &&
        typeof (source as Partial<SourceBinding>).path === 'string',
    )
  )
}

function isDesignReferences(value: unknown): value is DesignReference[] {
  return (
    Array.isArray(value) &&
    value.every(
      (reference) =>
        reference !== null &&
        typeof reference === 'object' &&
        typeof (reference as Partial<DesignReference>).url === 'string' &&
        isAllowedDesignReferenceUrl(
          (reference as Partial<DesignReference>).url ?? '',
        ),
    )
  )
}

function isAllowedDesignReferenceUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      url.username === '' &&
      url.password === ''
    )
  } catch {
    return false
  }
}

function isApplicationConfig(
  value: unknown,
  sources: SourceBinding[],
): value is ApplicationConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const application = value as Partial<ApplicationConfig>
  if (!isApplicationBaseUrl(application.baseUrl)) return false
  if (
    application.source !== undefined &&
    (typeof application.source !== 'string' ||
      !sources.some((source) => source.name === application.source))
  ) {
    return false
  }
  if (
    application.startCommand !== undefined &&
    (typeof application.startCommand !== 'string' ||
      application.startCommand.trim() === '')
  ) {
    return false
  }
  if (application.startCommand !== undefined && application.source === undefined) {
    return false
  }
  if (
    application.readyPath !== undefined &&
    (typeof application.readyPath !== 'string' ||
      !application.readyPath.startsWith('/') ||
      application.readyPath.startsWith('//'))
  ) {
    return false
  }
  const screenshots = application.screenshots
  if (screenshots === undefined) return true
  if (!screenshots || typeof screenshots !== 'object' || Array.isArray(screenshots)) {
    return false
  }
  if (!['requested', 'auto', 'off'].includes(screenshots.policy)) return false
  if (screenshots.highlight !== undefined && typeof screenshots.highlight !== 'boolean') {
    return false
  }
  if (screenshots.viewport === undefined) return true
  return (
    Number.isInteger(screenshots.viewport.width) &&
    screenshots.viewport.width >= 320 &&
    screenshots.viewport.width <= 3840 &&
    Number.isInteger(screenshots.viewport.height) &&
    screenshots.viewport.height >= 320 &&
    screenshots.viewport.height <= 2160
  )
}

function isApplicationBaseUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === ''
    )
  } catch {
    return false
  }
}

function isDocumentationBrief(value: unknown): value is DocumentationBrief {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const brief = value as Partial<DocumentationBrief>
  const optionalText = (candidate: unknown): boolean =>
    candidate === undefined ||
    (typeof candidate === 'string' && candidate.trim() !== '')
  const textList = (candidate: unknown): candidate is string[] =>
    Array.isArray(candidate) &&
    candidate.every((item) => typeof item === 'string' && item.trim() !== '')
  const terminology =
    brief.terminology !== null &&
    typeof brief.terminology === 'object' &&
    !Array.isArray(brief.terminology) &&
    Object.entries(brief.terminology).every(
      ([term, preferred]) =>
        term.trim() !== '' &&
        typeof preferred === 'string' &&
        preferred.trim() !== '',
    )
  return (
    optionalText(brief.primaryAudience) &&
    (brief.experienceLevel === undefined ||
      ['beginner', 'intermediate', 'advanced', 'mixed'].includes(
        brief.experienceLevel,
      )) &&
    (brief.priorityOutcomes === undefined ||
      textList(brief.priorityOutcomes)) &&
    typeof brief.locale === 'string' &&
    brief.locale.trim() !== '' &&
    textList(brief.tone) &&
    typeof brief.styleGuide === 'string' &&
    brief.styleGuide.trim() !== '' &&
    typeof brief.standardsProfile === 'string' &&
    brief.standardsProfile.trim() !== '' &&
    terminology &&
    textList(brief.exclusions) &&
    typeof brief.accessibilityTarget === 'string' &&
    brief.accessibilityTarget.trim() !== ''
  )
}
