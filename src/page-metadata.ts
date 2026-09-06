import { createHash } from 'node:crypto'
import { readFile, writeFile, stat } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import matter from 'gray-matter'
import { applyDirectEdit, safePath } from './direct-edit.js'
import { DoxloopError } from './errors.js'
import { assertInside, pathExists, resolveContainedDirectory } from './fs.js'
import { loadGeneratorAdapter } from './generators.js'
import { resolveEditScope } from './pages.js'
import { loadProject } from './project.js'

/**
 * The frontmatter fields a person edits without an agent: the title and
 * description every generator needs, plus the SEO fields the Doxbrix preview
 * and static build render (`canonical`, `socialImage`) and the sidebar icon.
 * Other frontmatter keys are preserved untouched.
 */
export const PAGE_METADATA_FIELDS = ['title', 'description', 'canonical', 'socialImage', 'icon'] as const
export type PageMetadataField = typeof PAGE_METADATA_FIELDS[number]

export interface PageMetadata {
  path: string
  /** False for reStructuredText and HTML pages, whose metadata has no frontmatter. */
  editable: boolean
  reason?: string
  fingerprint: string
  fields: Partial<Record<PageMetadataField, string>>
  /** Frontmatter keys Doxloop leaves alone. */
  otherKeys: string[]
}

export async function readPageMetadata(root: string, rawPath: unknown): Promise<PageMetadata> {
  const path = requirePath(rawPath)
  const project = await loadProject(root)
  await resolveEditScope(root, project, [path], false)
  const absolute = assertInside(root, resolve(root, path))
  const content = await readFile(absolute, 'utf8')
  const fingerprint = createHash('sha256').update(content).digest('hex')
  const format = project.generator === 'doxbrix' ? 'markdown' : (await loadGeneratorAdapter(root, project)).project.contentFormat ?? 'markdown'
  if (format !== 'markdown') {
    return {
      path,
      editable: false,
      reason: `${format === 'rst' ? 'reStructuredText' : 'HTML'} pages keep their title and description in the page body, so edit them there.`,
      fingerprint,
      fields: {},
      otherKeys: [],
    }
  }
  const parsed = matter(content)
  const fields: Partial<Record<PageMetadataField, string>> = {}
  for (const field of PAGE_METADATA_FIELDS) {
    const value = parsed.data[field]
    if (typeof value === 'string' && value.trim()) fields[field] = value.trim()
  }
  return {
    path,
    editable: true,
    fingerprint,
    fields,
    otherKeys: Object.keys(parsed.data).filter((key) => !(PAGE_METADATA_FIELDS as readonly string[]).includes(key)),
  }
}

export interface PageMetadataWrite {
  path: string
  fingerprint: string
  /** A string sets the field; `null` or an empty string clears it. Title and description cannot be cleared. */
  fields: Partial<Record<PageMetadataField, string | null>>
}

async function preparePageMetadata(root: string, raw: unknown) {
  const input = parseWrite(raw)
  const current = await readPageMetadata(root, input.path)
  if (!current.editable) throw new DoxloopError(current.reason ?? 'This page has no editable metadata.', 2)
  if (current.fingerprint !== input.fingerprint) {
    throw new DoxloopError('The page changed on disk since its metadata was loaded. Reload the page and apply your changes again.')
  }
  const project = await loadProject(root)
  const contentRoot = await resolveContainedDirectory(root, project.contentDir, 'Documentation content directory', {
    allowRoot: project.generator === 'doxbrix',
  })
  const absolute = assertInside(root, resolve(root, input.path))
  const parsed = matter(await readFile(absolute, 'utf8'))
  const data: Record<string, unknown> = { ...parsed.data }
  for (const [field, value] of Object.entries(input.fields) as Array<[PageMetadataField, string | null]>) {
    if (value === null || value.trim() === '') {
      if (field === 'title' || field === 'description') throw new DoxloopError(`${field === 'title' ? 'Title' : 'Description'} cannot be empty.`, 2)
      delete data[field]
      continue
    }
    data[field] = await validateField(field, value.trim(), contentRoot, root, absolute)
  }
  const nextContent = matter.stringify(parsed.content, data)
  return { path: input.path, apply: async () => {
    if (createHash('sha256').update(await readFile(await safePath(root, input.path))).digest('hex') !== input.fingerprint) throw new DoxloopError('The page changed on disk. Reload before saving.')
    await writeFile(await safePath(root, input.path), nextContent, 'utf8')
  } }
}

export async function updatePageMetadata(root: string, raw: unknown): Promise<PageMetadata> {
  const prepared = await preparePageMetadata(root, raw)
  await applyDirectEdit(root, { kind: 'metadata', requestText: `Updated metadata for ${prepared.path}`, files: [prepared.path], pagesChanged: 1, apply: prepared.apply })
  return readPageMetadata(root, prepared.path)
}

export async function updateBulkPageMetadata(root: string, writes: unknown[]) {
  if (!Array.isArray(writes) || writes.length < 1 || writes.length > 500) throw new DoxloopError('Select between 1 and 500 pages.')
  const prepared = await Promise.all(writes.map((write) => preparePageMetadata(root, write)))
  if (new Set(prepared.map((item) => item.path)).size !== prepared.length) throw new DoxloopError('Select each page once.')
  return applyDirectEdit(root, { kind: 'metadata', requestText: `Updated metadata for ${prepared.length} selected pages`, files: prepared.map((item) => item.path), pagesChanged: prepared.length, apply: async () => { for (const item of prepared) await item.apply() } })
}

async function validateField(field: PageMetadataField, value: string, contentRoot: string, root: string, pagePath: string): Promise<string> {
  switch (field) {
    case 'title':
      if (value.length > 160) throw new DoxloopError('Title must be 160 characters or fewer.', 2)
      return value
    case 'description':
      if (value.length > 320) throw new DoxloopError('Description must be 320 characters or fewer.', 2)
      return value
    case 'canonical': {
      let url: URL
      try { url = new URL(value) } catch { throw new DoxloopError('Canonical URL must be a complete HTTPS address.', 2) }
      if (url.protocol !== 'https:' || url.username || url.password) throw new DoxloopError('Canonical URL must be an HTTPS address without credentials.', 2)
      return url.toString()
    }
    case 'socialImage': {
      if (/^https:\/\//i.test(value)) return value
      if (!value.startsWith('/') || value.startsWith('//') || value.split('/').some((part) => part === '..')) {
        throw new DoxloopError('Social image must be an HTTPS address or a root-relative path such as /assets/social.png.', 2)
      }
      const project = await loadProject(root)
      const adapter = project.generator === 'doxbrix' ? undefined : await loadGeneratorAdapter(root, project)
      const local = adapter?.resolveLocalAsset?.({ root, contentRoot, pagePath, reference: value }) ?? join(contentRoot, value.slice(1))
      assertInside(root, local)
      await safePath(root, local.slice(root.length + 1))
      if (!(await pathExists(local)) || !(await stat(local)).isFile()) throw new DoxloopError(`Social image "${value}" is not a file in the documentation folder.`, 2)
      if (!['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(extname(local).toLowerCase())) {
        throw new DoxloopError('Social image must be a PNG, JPEG, WebP, or GIF file.', 2)
      }
      return value
    }
    case 'icon':
      if (!/^[\p{L}\p{N}\p{Emoji}_-]{1,40}$/u.test(value)) throw new DoxloopError('Icon must be an icon name or a single emoji.', 2)
      return value
  }
}

function parseWrite(raw: unknown): PageMetadataWrite {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new DoxloopError('A metadata write needs a path, fingerprint, and fields.', 2)
  const body = raw as Record<string, unknown>
  if (typeof body.fingerprint !== 'string') throw new DoxloopError('A metadata write needs the fingerprint it was loaded with.', 2)
  const fields: PageMetadataWrite['fields'] = {}
  const rawFields = body.fields && typeof body.fields === 'object' && !Array.isArray(body.fields) ? (body.fields as Record<string, unknown>) : {}
  for (const [key, value] of Object.entries(rawFields)) {
    if (!(PAGE_METADATA_FIELDS as readonly string[]).includes(key)) throw new DoxloopError(`"${key}" is not an editable metadata field.`, 2)
    if (value !== null && typeof value !== 'string') throw new DoxloopError(`${key} must be text.`, 2)
    fields[key as PageMetadataField] = value
  }
  if (Object.keys(fields).length === 0) throw new DoxloopError('Change at least one metadata field.', 2)
  return { path: requirePath(body.path), fingerprint: body.fingerprint, fields }
}

function requirePath(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new DoxloopError('A page metadata request needs a path.', 2)
  return value.trim()
}
