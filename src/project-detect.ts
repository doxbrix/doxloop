import { readdir, readFile, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { listFiles, pathExists } from './fs.js'
import { ROOT_CONTENT_IGNORED_DIRECTORIES } from './project.js'
import type { GeneratorName } from './types.js'

/**
 * One way the folder could be read. `contentDir` is the directory Doxloop
 * would treat as documentation content, relative to the folder; an empty
 * string means the folder itself, which only Doxbrix allows.
 */
export interface GeneratorCandidate {
  generator: GeneratorName
  contentDir: string
  markers: string[]
  title?: string
}

export interface GeneratorDetection {
  /** Most specific marker first. Empty when nothing recognizable was found. */
  candidates: GeneratorCandidate[]
  recommended?: GeneratorCandidate
}

/**
 * Page extensions per generator when the adapter package cannot be loaded,
 * so a folder can be inspected before anything is installed.
 */
export const DEFAULT_PAGE_EXTENSIONS: Record<GeneratorName, readonly string[]> = {
  doxbrix: ['.md', '.mdx'],
  docusaurus: ['.md', '.mdx'],
  mkdocs: ['.md'],
  sphinx: ['.rst'],
  hugo: ['.md'],
  vitepress: ['.md'],
  markdoc: ['.md'],
  nextra: ['.md', '.mdx'],
  starlight: ['.md', '.mdx'],
  jekyll: ['.md'],
  static: ['.html'],
}

type Detector = (root: string) => Promise<GeneratorCandidate | undefined>

/**
 * Recognize an existing documentation site from the files its generator
 * needs. Detection only reads; it never writes into the folder. Order matters
 * where markers overlap: a Docusaurus or MkDocs site may also carry a Jekyll
 * style `_config.yml`, so the more specific generator is listed first.
 */
export async function detectDocumentationGenerator(root: string): Promise<GeneratorDetection> {
  const absolute = resolve(root)
  const candidates: GeneratorCandidate[] = []
  for (const detector of DETECTORS) {
    const candidate = await detector(absolute)
    if (candidate && !candidates.some((item) => item.generator === candidate.generator)) candidates.push(candidate)
  }
  return { candidates, ...(candidates[0] ? { recommended: candidates[0] } : {}) }
}

/**
 * Project-relative page paths under a content directory, using the
 * generator's default extensions. Missing directories yield no pages instead
 * of an error so an inspection can report "0 pages" for a wrong guess.
 */
export async function listDocumentationPageFiles(root: string, generator: GeneratorName, contentDir: string): Promise<string[]> {
  const absoluteRoot = resolve(root)
  const contentRoot = contentDir ? resolve(absoluteRoot, contentDir) : absoluteRoot
  try {
    if (!(await stat(contentRoot)).isDirectory()) return []
  } catch {
    return []
  }
  const files = await listFiles(contentRoot, new Set(DEFAULT_PAGE_EXTENSIONS[generator]), {
    ignoredDirectories: contentRoot === absoluteRoot ? ROOT_CONTENT_IGNORED_DIRECTORIES : new Set(['node_modules', '.git']),
  })
  return files.map((file) => portable(file.slice(absoluteRoot.length + 1))).sort()
}

const DETECTORS: Detector[] = [
  detectDoxbrix,
  detectDocusaurus,
  detectMkDocs,
  detectStarlight,
  detectVitePress,
  detectNextra,
  detectMarkdoc,
  detectHugo,
  detectSphinx,
  detectJekyll,
]

async function detectDoxbrix(root: string): Promise<GeneratorCandidate | undefined> {
  for (const directory of ['', ...(await firstLevelDirectories(root))]) {
    const marker = join(directory, 'docs.json')
    const config = await readJsonObject(join(root, marker))
    if (!config) continue
    const spaces = Array.isArray(config.spaces)
    const legacy = typeof config.title === 'string' && Array.isArray(config.navigation)
    if (!spaces && !legacy) continue
    const title = typeof config.name === 'string' ? config.name : typeof config.title === 'string' ? config.title : undefined
    return { generator: 'doxbrix', contentDir: portable(directory), markers: [portable(marker)], ...(title ? { title } : {}) }
  }
  return undefined
}

async function detectDocusaurus(root: string): Promise<GeneratorCandidate | undefined> {
  const marker = await firstExisting(root, ['docusaurus.config.js', 'docusaurus.config.ts', 'docusaurus.config.mjs', 'docusaurus.config.cjs'])
  if (!marker) return undefined
  const title = quotedValue(await readText(join(root, marker)), 'title')
  return { generator: 'docusaurus', contentDir: 'docs', markers: [marker], ...(title ? { title } : {}) }
}

async function detectMkDocs(root: string): Promise<GeneratorCandidate | undefined> {
  const marker = await firstExisting(root, ['mkdocs.yml', 'mkdocs.yaml'])
  if (!marker) return undefined
  const config = safeYaml(await readText(join(root, marker)))
  const docsDir = typeof config?.docs_dir === 'string' && isSafeContentDir(config.docs_dir) ? config.docs_dir : 'docs'
  const title = typeof config?.site_name === 'string' ? config.site_name : undefined
  return { generator: 'mkdocs', contentDir: portable(docsDir), markers: [marker], ...(title ? { title } : {}) }
}

async function detectStarlight(root: string): Promise<GeneratorCandidate | undefined> {
  const marker = await firstExisting(root, ['astro.config.mjs', 'astro.config.js', 'astro.config.ts'])
  if (!marker) return undefined
  const content = await readText(join(root, marker))
  if (!content.includes('starlight')) return undefined
  const title = quotedValue(content, 'title')
  return { generator: 'starlight', contentDir: 'src/content/docs', markers: [marker], ...(title ? { title } : {}) }
}

async function detectVitePress(root: string): Promise<GeneratorCandidate | undefined> {
  const directories = ['docs', ...(await firstLevelDirectories(root)).filter((directory) => directory !== 'docs')]
  for (const directory of directories) {
    const marker = await firstExisting(root, ['config.mts', 'config.ts', 'config.js', 'config.mjs'].map((file) => join(directory, '.vitepress', file)))
    if (!marker) continue
    const title = quotedValue(await readText(join(root, marker)), 'title')
    return { generator: 'vitepress', contentDir: portable(directory), markers: [portable(marker)], ...(title ? { title } : {}) }
  }
  return undefined
}

async function detectNextra(root: string): Promise<GeneratorCandidate | undefined> {
  const markers: string[] = []
  const nextConfig = await firstExisting(root, ['next.config.mjs', 'next.config.js', 'next.config.ts'])
  if (nextConfig && (await readText(join(root, nextConfig))).includes('nextra')) markers.push(nextConfig)
  const theme = await firstExisting(root, ['theme.config.tsx', 'theme.config.jsx', 'theme.config.js'])
  if (theme) markers.push(theme)
  if (markers.length === 0) return undefined
  const contentDir = (await firstExisting(root, ['content', 'pages'])) ?? 'content'
  return { generator: 'nextra', contentDir, markers }
}

async function detectMarkdoc(root: string): Promise<GeneratorCandidate | undefined> {
  const marker = await firstExisting(root, ['markdoc.config.mjs', 'markdoc.config.js', 'markdoc.config.ts'])
  if (!marker) return undefined
  return { generator: 'markdoc', contentDir: 'docs', markers: [marker] }
}

async function detectHugo(root: string): Promise<GeneratorCandidate | undefined> {
  const marker = await firstExisting(root, [
    'hugo.toml', 'hugo.yaml', 'hugo.yml', 'hugo.json',
    'config/_default/hugo.toml', 'config/_default/hugo.yaml', 'config/_default/hugo.yml',
    'config/_default/config.toml', 'config/_default/config.yaml', 'config/_default/config.yml',
  ])
  let content = marker ? await readText(join(root, marker)) : ''
  let found = marker
  if (!found) {
    const generic = await firstExisting(root, ['config.toml', 'config.yaml', 'config.yml'])
    if (!generic) return undefined
    content = await readText(join(root, generic))
    if (!/\b(baseURL|baseurl|languageCode|theme)\b/.test(content)) return undefined
    found = generic
  }
  const contentDir = tomlOrYamlValue(content, 'contentDir') ?? 'content'
  const title = tomlOrYamlValue(content, 'title')
  return { generator: 'hugo', contentDir: isSafeContentDir(contentDir) ? portable(contentDir) : 'content', markers: [portable(found!)], ...(title ? { title } : {}) }
}

async function detectSphinx(root: string): Promise<GeneratorCandidate | undefined> {
  for (const directory of ['docs', 'doc', 'source', 'docs/source', 'doc/source']) {
    const marker = join(directory, 'conf.py')
    if (!(await pathExists(join(root, marker)))) continue
    const title = quotedValue(await readText(join(root, marker)), 'project')
    return { generator: 'sphinx', contentDir: directory, markers: [portable(marker)], ...(title ? { title } : {}) }
  }
  return undefined
}

async function detectJekyll(root: string): Promise<GeneratorCandidate | undefined> {
  if (!(await pathExists(join(root, '_config.yml')))) return undefined
  const config = safeYaml(await readText(join(root, '_config.yml')))
  const contentDir = (await firstExisting(root, ['_docs', 'docs'])) ?? '_docs'
  const title = typeof config?.title === 'string' ? config.title : undefined
  return { generator: 'jekyll', contentDir, markers: ['_config.yml'], ...(title ? { title } : {}) }
}

async function firstLevelDirectories(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory() && !ROOT_CONTENT_IGNORED_DIRECTORIES.has(entry.name) && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

async function firstExisting(root: string, paths: string[]): Promise<string | undefined> {
  for (const path of paths) if (await pathExists(join(root, path))) return path
  return undefined
}

async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return ''
  }
}

async function readJsonObject(path: string): Promise<Record<string, unknown> | undefined> {
  const text = await readText(path)
  if (!text.trim()) return undefined
  try {
    const parsed = JSON.parse(text) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

function safeYaml(text: string): Record<string, unknown> | undefined {
  if (!text.trim()) return undefined
  try {
    const parsed = parseYaml(text) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined
  } catch {
    // Configuration files with custom tags or template syntax still identify
    // the generator; only their values become unavailable.
    return undefined
  }
}

/** The first `key: 'value'` or `key = "value"` pair in a JavaScript, Python, or TOML file. */
function quotedValue(text: string, key: string): string | undefined {
  const match = new RegExp(`(?:^|[\\s{,])${key}\\s*[:=]\\s*(['"])([^'"\\n]+)\\1`, 'm').exec(text)
  return match?.[2]?.trim() || undefined
}

function tomlOrYamlValue(text: string, key: string): string | undefined {
  const quoted = quotedValue(text, key)
  if (quoted) return quoted
  const bare = new RegExp(`^\\s*${key}\\s*[:=]\\s*([^\\s#"']+)\\s*$`, 'mi').exec(text)
  return bare?.[1]?.trim() || undefined
}

function isSafeContentDir(value: string): boolean {
  const trimmed = value.trim()
  return trimmed !== '' && !trimmed.startsWith('/') && !/^[a-zA-Z]:/.test(trimmed) && !trimmed.split(/[\\/]/).includes('..')
}

function portable(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/')
}
