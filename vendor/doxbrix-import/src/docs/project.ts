import { readFileSync, readdirSync, existsSync, lstatSync } from 'node:fs'
import { join, relative, sep, posix } from 'node:path'
import { parseManifest, isPageFile, type DocsManifest } from './manifest.js'
import { parseFrontmatter } from './frontmatter.js'

const MEDIA_DIRS = ['images', 'assets', 'media', 'img', 'static']
const ASSET_RE = /\.(png|jpe?g|gif|svg|webp|avif|ico|bmp|woff2?|ttf|otf|eot|mp4|webm|mov|mp3|wav|ogg|pdf)$/i
const IGNORED_DIRS = new Set(['.doxbrix', '.agents', '.claude', '.gemini', 'node_modules'])

export interface LocalPageFile {
  /** Path relative to the docs dir, POSIX-separated, with extension. */
  relPath: string
  absPath: string
  frontmatter: Record<string, unknown>
  body: string
  raw: string
}

export interface LocalDocsProject {
  /** Project root (folder containing `.doxbrix`). */
  root: string
  /** Docs directory: `root/basePath`. */
  docsDir: string
  basePath: string
  manifestPath: string | null
  manifest: DocsManifest
  pages: LocalPageFile[]
  /** Media file paths relative to docsDir (POSIX). */
  media: string[]
}

/** List all files under `dir` recursively, returned as POSIX paths relative to `dir`. */
export function listFilesRecursive(dir: string): string[] {
  const out: string[] = []
  const walk = (current: string) => {
    let entries: string[]
    try {
      entries = readdirSync(current)
    } catch {
      return
    }
    for (const name of entries) {
      if (IGNORED_DIRS.has(name) || name.startsWith('.git')) continue
      const abs = join(current, name)
      let stat
      try {
        stat = lstatSync(abs)
      } catch {
        continue
      }
      if (stat.isSymbolicLink()) continue
      if (stat.isDirectory()) walk(abs)
      else out.push(toPosix(relative(dir, abs)))
    }
  }
  walk(dir)
  return out
}

function toPosix(p: string): string {
  return p.split(sep).join(posix.sep)
}

/** Load and parse a local docs project rooted at `root` with `basePath`. */
export function loadLocalProject(root: string, basePath: string): LocalDocsProject {
  const docsDir = basePath ? join(root, basePath) : root
  if (!existsSync(docsDir)) {
    throw new Error(`Docs directory not found: ${docsDir}`)
  }

  const manifestPath = join(docsDir, 'docs.json')
  let manifest: DocsManifest
  let resolvedManifestPath: string | null = null
  if (existsSync(manifestPath)) {
    manifest = parseManifest(readFileSync(manifestPath, 'utf8'))
    resolvedManifestPath = manifestPath
  } else {
    manifest = { version: 1, spaces: [] }
  }

  const allFiles = listFilesRecursive(docsDir)
  const pages: LocalPageFile[] = []
  const media: string[] = []

  for (const rel of allFiles) {
    if (rel === 'docs.json') continue
    if (isPageFile(rel)) {
      const abs = join(docsDir, rel)
      const raw = readFileSync(abs, 'utf8')
      const { data, body } = parseFrontmatter(raw)
      pages.push({ relPath: rel, absPath: abs, frontmatter: data, body, raw })
    } else if (ASSET_RE.test(rel) || MEDIA_DIRS.some((d) => rel.startsWith(`${d}/`))) {
      media.push(rel)
    }
  }

  return { root, docsDir, basePath, manifestPath: resolvedManifestPath, manifest, pages, media }
}
