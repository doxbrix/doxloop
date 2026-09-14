import { copyFileSync, readFileSync, writeFileSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { join, dirname, posix } from 'node:path'
import { listFilesRecursive } from './project.js'
import { stringifyManifest, withPageExtension, type DocsManifest } from './manifest.js'
import { assertSafeWriteParent, resolveWithin } from '../safe-path.js'
import { hasStarterPageContent } from './starter.js'

/** Text extensions / filenames worth uploading for dialect detection + conversion. */
const TEXT_EXTS = ['.md', '.mdx', '.markdown', '.json', '.yaml', '.yml', '.txt', '.css']
const TEXT_NAMES = ['summary', 'mint.json', 'docs.json', '.gitbook.yaml', '.gitbook.yml', 'readme']
const MAX_FILES = 4000
const MAX_BYTES = 2 * 1024 * 1024 // per file

/** Assets that can be rendered or are referenced by imported documentation. */
const ASSET_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.ico', '.avif', '.bmp',
  '.mp4', '.webm', '.mov', '.mp3', '.wav', '.ogg', '.pdf',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.json', '.yaml', '.yml',
])
const SOURCE_CONFIGS = new Set(['docs.json', 'mint.json', '.gitbook.yaml', '.gitbook.yml'])
const SOURCE_TOOLING_FILES = new Set([
  'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb',
  'tsconfig.json', 'jsconfig.json', 'biome.json', 'deno.json', 'deno.jsonc',
])

export interface SourceFile {
  path: string
  content: string
}

/** Collect non-page assets before conversion writes into its output directory. */
export function collectSourceAssets(dir: string): string[] {
  const assets: string[] = []
  for (const rel of listFilesRecursive(dir)) {
    const normalized = rel.replace(/\\/g, '/')
    const base = normalized.split('/').pop()?.toLowerCase() ?? ''
    if (/^(?:\.git|\.github|\.gitlab|node_modules|scripts|bin)\//.test(normalized)) continue
    if (SOURCE_TOOLING_FILES.has(base) || /^tsconfig\..*\.json$/.test(base)) continue
    const dot = base.lastIndexOf('.')
    const ext = dot >= 0 ? base.slice(dot) : ''
    if (!ASSET_EXTS.has(ext) || SOURCE_CONFIGS.has(base)) continue
    assets.push(normalized)
  }
  return assets
}

/** Copy imported images, fonts, media, styles, and API specs without flattening paths. */
export function copySourceAssets(sourceDir: string, docsDir: string, assets: string[]): number {
  let copied = 0
  for (const rel of assets) {
    const source = resolveWithin(sourceDir, rel)
    const destination = resolveWithin(docsDir, rel)
    // Root-level imports already have assets in place. Never copy a file onto itself.
    if (source === destination) continue
    try {
      assertSafeWriteParent(docsDir, destination)
      mkdirSync(dirname(destination), { recursive: true })
      copyFileSync(source, destination)
      copied += 1
    } catch {
      // Keep migration resilient; the command reports the number successfully copied.
    }
  }
  return copied
}

/** Collect text source files under `dir` (skips binaries/large/media). */
export function collectSourceFiles(dir: string): SourceFile[] {
  const listed = listFilesRecursive(dir).map((rel) => rel.replace(/\\/g, '/'))
  const available = new Set(listed)
  const files: SourceFile[] = []
  const collected = new Set<string>()

  const add = (rel: string): void => {
    if (files.length >= MAX_FILES) return
    const lower = rel.toLowerCase()
    const base = lower.split('/').pop() ?? ''
    const isText = TEXT_EXTS.some((e) => lower.endsWith(e)) || TEXT_NAMES.some((n) => base === n || base.startsWith(n + '.'))
    if (!isText || collected.has(rel)) return
    const abs = join(dir, rel)
    try {
      if (statSync(abs).size > MAX_BYTES) return
      files.push({ path: rel, content: readFileSync(abs, 'utf8') })
      collected.add(rel)
    } catch {
      // unreadable — skip
    }
  }

  for (const rel of listed) {
    if (files.length >= MAX_FILES) break
    add(rel)
  }

  // React SVG icons and other non-executing snippets are sometimes stored in
  // .js/.jsx/.ts/.tsx modules. Follow only modules explicitly imported by a
  // collected documentation file; never scan arbitrary application source.
  for (let index = 0; index < files.length && files.length < MAX_FILES; index += 1) {
    const sourceFile = files[index]!
    for (const match of sourceFile.content.matchAll(/\bfrom\s*["']([^"']+\.(?:js|jsx|ts|tsx))["']/g)) {
      const specifier = match[1]!
      const target = posix.normalize(
        specifier.startsWith('/')
          ? specifier.slice(1)
          : posix.join(posix.dirname(sourceFile.path), specifier),
      )
      if (target === '..' || target.startsWith('../') || !available.has(target) || collected.has(target)) continue
      const abs = join(dir, target)
      try {
        if (statSync(abs).size > MAX_BYTES) continue
        files.push({ path: target, content: readFileSync(abs, 'utf8') })
        collected.add(target)
      } catch {
        // unreadable — skip
      }
    }
  }
  return files
}

/** Write a converted manifest + page files into `docsDir`. */
export function writeConvertResult(
  docsDir: string,
  result: { manifest: unknown; pages: { path: string; markdown: string }[] },
): { manifestPath: string; pageCount: number } {
  mkdirSync(docsDir, { recursive: true })
  const generatedPages = new Set(result.pages.map((page) => withPageExtension(page.path)))
  // `dxb init` creates two useful starter pages. A repository import replaces
  // those only when the source does not contain the same routes; never remove
  // user-authored pages or any path produced by this conversion.
  for (const rel of listFilesRecursive(docsDir)) {
    if (!/\.(?:md|mdx)$/i.test(rel) || generatedPages.has(rel)) continue
    const absolute = resolveWithin(docsDir, rel)
    try {
      if (hasStarterPageContent(readFileSync(absolute, 'utf8'))) rmSync(absolute)
    } catch {
      // A concurrent or unreadable file is preserved rather than risking data loss.
    }
  }
  const manifestPath = join(docsDir, 'docs.json')
  writeFileSync(manifestPath, stringifyManifest(result.manifest as DocsManifest))
  for (const page of result.pages) {
    const abs = resolveWithin(docsDir, withPageExtension(page.path))
    assertSafeWriteParent(docsDir, abs)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, page.markdown)
  }
  return { manifestPath, pageCount: result.pages.length }
}
