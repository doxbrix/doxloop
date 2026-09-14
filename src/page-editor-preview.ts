import { readFile } from 'node:fs/promises'
import matter from 'gray-matter'
import { renderEditableMarkdown } from './doxbrix-markdown.js'
import { loadProject, loadSiteConfig } from './project.js'
import { readPageContent } from './page-operations.js'
import { doxbrixDocument } from './preview.js'
import { DoxloopError } from './errors.js'
import { installPageEditorBridge } from './page-editor-bridge.js'

/** A sandboxed native rendering of a draft; this endpoint never writes a file. */
export async function pageEditorPreview(root: string, path: string, content: string, base: string) {
  await readPageContent(root, path)
  const project = await loadProject(root)
  if (project.generator !== 'doxbrix') throw new DoxloopError('Use source editing for this generator, then check the native preview.')
  if (Buffer.byteLength(content) > 2_000_000) throw new DoxloopError('The page is too large for visual editing. Use source editing.')
  const url = new URL(base)
  if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password) throw new DoxloopError('Visual editing requires a local preview URL.')
  const parsed = matter(content)
  const offset = content.length - parsed.content.length
  const rendered = renderEditableMarkdown(parsed.content)
  const blocks = rendered.blocks.map((block) => ({ ...block, start: block.start + offset, end: block.end + offset }))
  rendered.html = rendered.html.replace(/data-edit-start="(\d+)" data-edit-end="(\d+)"/g, (_, start: string, end: string) => `data-edit-start="${Number(start) + offset}" data-edit-end="${Number(end) + offset}"`)
  const site = await loadSiteConfig(root, project)
  let html = doxbrixDocument({ site, title: String(parsed.data.title ?? path.split('/').at(-1)), ...(typeof parsed.data.description === 'string' ? { description: parsed.data.description } : {}), current: url.pathname.replace(/^\/+|\/+$/g, ''), rendered, embedded: true, liveReload: false })
  // Header fields are rendered outside the Markdown body. Edit their YAML values
  // as quoted scalars so punctuation such as colons cannot change the document shape.
  const frontmatter = content.slice(0, offset)
  for (const [field, className] of [['title', 'dp-page-title'], ['description', 'dxb-atlas-description']]) {
    if (typeof parsed.data[field!] !== 'string') continue
    const match = new RegExp(`^${field}:[ \t]*([^\\r\\n]+)`, 'm').exec(frontmatter)
    if (!match || /^[>|]/.test(match[1]!.trim())) continue
    const text = match[1]!
    const start = match.index + match[0].length - text.length
    // Only scalar values that round-trip to the displayed field may be replaced.
    if (matter(`---\nvalue: ${text}\n---\n`).data.value !== parsed.data[field!]) continue
    blocks.push({ start, end: start + text.length, text })
    const source = text.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
    html = html.replace(`class="${className}"`, `class="${className}" data-edit-start="${start}" data-edit-end="${start + text.length}" data-edit-format="yaml" data-edit-source="${source}"`)
  }
  const css = await readFile(new URL('../assets/doxbrix-preview.css', import.meta.url), 'utf8')
  html = html.replace('<head>', `<head><base href="${url.href.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}">`)
    .replace('<link rel="stylesheet" href="/__doxloop/doxbrix.css">', `<style>${css}</style>`)
    .replace('</body>', `<style>
      [data-edit-start]{outline:1px dashed var(--project-primary);outline-offset:4px;border-radius:3px;cursor:text;white-space:pre-wrap}
      [data-edit-start]:focus{outline:2px solid var(--project-primary)}
      .dp-edit-page{display:none}
    </style><script>(${installPageEditorBridge.toString()})()</script></body>`)
  return { html, blocks }
}
