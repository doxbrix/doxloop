/**
 * Dependency-free HTML to Markdown conversion for crawled documentation pages.
 *
 * The converter is intentionally tolerant: documentation sites ship imperfect
 * HTML, and the output feeds an agent that reads Markdown for context rather
 * than a renderer that needs exact fidelity. Navigation chrome, scripts,
 * styles, and hidden elements are dropped before conversion.
 */

export interface HtmlNode {
  type: 'element' | 'text'
  name?: string
  attributes: Record<string, string>
  children: HtmlNode[]
  text?: string
}

export interface HtmlDocumentSummary {
  title?: string
  description?: string
  canonical?: string
  generator?: string
  language?: string
  /** Absolute or relative link targets found in the main content and navigation. */
  links: string[]
  /** Image sources found in the main content. */
  images: string[]
  headings: Array<{ level: number; text: string }>
  markdown: string
  /** Approximate word count of the converted main content. */
  words: number
}

const VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'])
const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'canvas', 'textarea'])
const DROPPED_ELEMENTS = new Set([...RAW_TEXT_ELEMENTS, 'head', 'nav', 'header', 'footer', 'aside', 'button', 'form', 'select', 'dialog'])
const BLOCK_ELEMENTS = new Set(['address', 'article', 'blockquote', 'details', 'div', 'dl', 'dd', 'dt', 'fieldset', 'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'li', 'main', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul', 'body', 'html'])
const CHROME_PATTERN = /(^|[\s_-])(nav|navbar|sidebar|toc|table-of-contents|breadcrumbs?|footer|header|banner|cookie|announcement|skip-link|edit-page|pagination|prev-next|feedback|search)([\s_-]|$)/i

/** Block elements whose start tag implicitly closes an open paragraph. */
const P_CLOSERS = new Set(['address', 'article', 'aside', 'blockquote', 'details', 'div', 'dl', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'main', 'menu', 'nav', 'ol', 'pre', 'section', 'table', 'ul'])

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', trade: '™', hellip: '…',
  mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', middot: '·', bull: '•', rarr: '→', larr: '←',
}

export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const code = entity[1]?.toLowerCase() === 'x' ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match
    }
    return ENTITIES[entity.toLowerCase()] ?? match
  })
}

/** Parse tolerant HTML into a lightweight tree. */
export function parseHtml(html: string): HtmlNode {
  const root: HtmlNode = { type: 'element', name: '#root', attributes: {}, children: [] }
  const stack: HtmlNode[] = [root]
  let index = 0
  const length = html.length
  while (index < length) {
    const open = html.indexOf('<', index)
    if (open === -1) {
      appendText(stack[stack.length - 1]!, html.slice(index))
      break
    }
    if (open > index) appendText(stack[stack.length - 1]!, html.slice(index, open))
    if (html.startsWith('<!--', open)) {
      const close = html.indexOf('-->', open + 4)
      index = close === -1 ? length : close + 3
      continue
    }
    if (html.startsWith('<!', open) || html.startsWith('<?', open)) {
      const close = html.indexOf('>', open)
      index = close === -1 ? length : close + 1
      continue
    }
    const close = findTagEnd(html, open)
    if (close === -1) {
      appendText(stack[stack.length - 1]!, html.slice(open))
      break
    }
    const rawTag = html.slice(open + 1, close)
    index = close + 1
    if (rawTag.startsWith('/')) {
      const name = rawTag.slice(1).trim().toLowerCase()
      for (let depth = stack.length - 1; depth > 0; depth -= 1) {
        if (stack[depth]!.name === name) {
          stack.length = depth
          break
        }
      }
      continue
    }
    const { name, attributes, selfClosing } = parseTag(rawTag)
    if (!name) continue
    const node: HtmlNode = { type: 'element', name, attributes, children: [] }
    closeImplied(stack, name)
    stack[stack.length - 1]!.children.push(node)
    if (selfClosing || VOID_ELEMENTS.has(name)) continue
    if (RAW_TEXT_ELEMENTS.has(name)) {
      const end = findClosingTag(html, index, name)
      node.children.push({ type: 'text', attributes: {}, children: [], text: html.slice(index, end.start) })
      index = end.end
      continue
    }
    stack.push(node)
  }
  return root
}

function findTagEnd(html: string, open: number): number {
  let quote: string | undefined
  for (let index = open + 1; index < html.length; index += 1) {
    const char = html[index]!
    if (quote) {
      if (char === quote) quote = undefined
      continue
    }
    if (char === '"' || char === "'") quote = char
    else if (char === '>') return index
  }
  return -1
}

function findClosingTag(html: string, from: number, name: string): { start: number; end: number } {
  const pattern = new RegExp(`</${name}\\s*>`, 'ig')
  pattern.lastIndex = from
  const match = pattern.exec(html)
  if (!match) return { start: html.length, end: html.length }
  return { start: match.index, end: match.index + match[0].length }
}

function parseTag(raw: string): { name: string; attributes: Record<string, string>; selfClosing: boolean } {
  const selfClosing = raw.trimEnd().endsWith('/')
  const body = selfClosing ? raw.trimEnd().slice(0, -1) : raw
  const nameMatch = /^\s*([a-zA-Z][\w:-]*)/.exec(body)
  if (!nameMatch) return { name: '', attributes: {}, selfClosing }
  const name = nameMatch[1]!.toLowerCase()
  const attributes: Record<string, string> = {}
  const attributePattern = /([^\s=/"'<>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g
  attributePattern.lastIndex = nameMatch[0].length
  let match: RegExpExecArray | null
  while ((match = attributePattern.exec(body))) {
    const key = match[1]!.toLowerCase()
    attributes[key] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '')
  }
  return { name, attributes, selfClosing }
}

function closeImplied(stack: HtmlNode[], incoming: string): void {
  const current = stack[stack.length - 1]?.name
  if (!current) return
  if (incoming === 'li' && current === 'li') stack.pop()
  else if (current === 'p' && (incoming === 'p' || P_CLOSERS.has(incoming))) stack.pop()
  else if ((incoming === 'dt' || incoming === 'dd') && (current === 'dt' || current === 'dd')) stack.pop()
  else if (incoming === 'tr' && (current === 'td' || current === 'th')) { stack.pop(); if (stack[stack.length - 1]?.name === 'tr') stack.pop() }
  else if (incoming === 'tr' && current === 'tr') stack.pop()
  else if ((incoming === 'td' || incoming === 'th') && (current === 'td' || current === 'th')) stack.pop()
  else if (incoming === 'option' && current === 'option') stack.pop()
}

function appendText(parent: HtmlNode, text: string): void {
  if (text.length === 0) return
  parent.children.push({ type: 'text', attributes: {}, children: [], text })
}

/** Convert an HTML document into a Markdown summary of its main content. */
export function summarizeHtmlDocument(html: string): HtmlDocumentSummary {
  const root = parseHtml(html)
  const head = findFirst(root, (node) => node.name === 'head')
  const title = textOf(findFirst(head ?? root, (node) => node.name === 'title')).trim() || undefined
  const metas = collect(head ?? root, (node) => node.name === 'meta')
  const meta = (key: string): string | undefined => {
    const hit = metas.find((node) => (node.attributes.name ?? node.attributes.property ?? '').toLowerCase() === key)
    return hit?.attributes.content?.trim() || undefined
  }
  const canonical = collect(head ?? root, (node) => node.name === 'link').find((node) => (node.attributes.rel ?? '').toLowerCase().split(/\s+/).includes('canonical'))?.attributes.href
  const htmlElement = findFirst(root, (node) => node.name === 'html')
  const body = findFirst(root, (node) => node.name === 'body') ?? root
  const links = collect(body, (node) => node.name === 'a').map((node) => node.attributes.href ?? '').filter(Boolean)
  const main = selectMainContent(body)
  const markdown = renderMarkdown(main).split('\n').map((line) => (line.trim() === '' ? '' : line.replace(/\s+$/g, ''))).join('\n').replace(/\n{3,}/g, '\n\n').trim()
  const headings = collect(main, (node) => /^h[1-6]$/.test(node.name ?? '')).map((node) => ({ level: Number(node.name!.slice(1)), text: inlineText(node).trim() })).filter((item) => item.text)
  const images = collect(main, (node) => node.name === 'img').map((node) => node.attributes.src ?? node.attributes['data-src'] ?? '').filter(Boolean)
  const description = meta('description') ?? meta('og:description')
  const generator = meta('generator')
  const language = htmlElement?.attributes.lang
  return {
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    ...(canonical ? { canonical } : {}),
    ...(generator ? { generator } : {}),
    ...(language ? { language } : {}),
    links: unique(links),
    images: unique(images),
    headings,
    markdown,
    words: markdown.split(/\s+/).filter((token) => /[\p{L}\p{N}]/u.test(token)).length,
  }
}

function selectMainContent(body: HtmlNode): HtmlNode {
  const candidates = [
    findFirst(body, (node) => node.name === 'main'),
    findFirst(body, (node) => node.attributes.role === 'main'),
    findFirst(body, (node) => node.name === 'article'),
    findFirst(body, (node) => /(^|\s)(content|markdown-body|theme-doc-markdown|docs-content|md-content|document|prose)(\s|$)/i.test(node.attributes.class ?? '') || /^(content|main-content|docs-content)$/i.test(node.attributes.id ?? '')),
  ].filter((node): node is HtmlNode => Boolean(node))
  return candidates[0] ?? body
}

function isDropped(node: HtmlNode): boolean {
  if (node.type !== 'element') return false
  if (DROPPED_ELEMENTS.has(node.name!)) return true
  if (node.attributes.hidden !== undefined || node.attributes['aria-hidden'] === 'true') return true
  if (/display\s*:\s*none/i.test(node.attributes.style ?? '')) return true
  const role = (node.attributes.role ?? '').toLowerCase()
  if (['navigation', 'banner', 'contentinfo', 'complementary', 'search', 'menu', 'menubar', 'toolbar'].includes(role)) return true
  const marker = `${node.attributes.class ?? ''} ${node.attributes.id ?? ''}`
  return CHROME_PATTERN.test(marker)
}

function renderMarkdown(node: HtmlNode): string {
  return renderChildren(node, { listDepth: 0 })
}

interface RenderContext { listDepth: number; ordered?: boolean; preformatted?: boolean }

function renderChildren(node: HtmlNode, context: RenderContext): string {
  return node.children.map((child) => renderNode(child, context)).join('')
}

function renderNode(node: HtmlNode, context: RenderContext): string {
  if (node.type === 'text') {
    if (context.preformatted) return decodeEntities(node.text ?? '')
    return decodeEntities(node.text ?? '').replace(/\s+/g, ' ')
  }
  if (isDropped(node)) return ''
  const name = node.name!
  switch (name) {
    case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
      const text = inlineText(node).trim()
      return text ? `\n\n${'#'.repeat(Number(name.slice(1)))} ${text}\n\n` : ''
    }
    case 'p': case 'div': case 'section': case 'article': case 'main': case 'figure': case 'figcaption': case 'details': case 'summary': case 'address': case 'dl': case 'fieldset': case 'body': case 'html': {
      const inner = renderChildren(node, context)
      return BLOCK_ELEMENTS.has(name) && name !== 'div' ? `\n\n${inner.trim()}\n\n` : `\n${inner}\n`
    }
    case 'br': return '  \n'
    case 'hr': return '\n\n---\n\n'
    case 'strong': case 'b': { const text = renderChildren(node, context).trim(); return text ? `**${text}**` : '' }
    case 'em': case 'i': { const text = renderChildren(node, context).trim(); return text ? `*${text}*` : '' }
    case 'del': case 's': { const text = renderChildren(node, context).trim(); return text ? `~~${text}~~` : '' }
    case 'code': case 'kbd': case 'samp': {
      if (context.preformatted) return renderChildren(node, context)
      const text = textOf(node).replace(/\s+/g, ' ').trim()
      return text ? `\`${text}\`` : ''
    }
    case 'pre': {
      const codeChild = node.children.find((child) => child.type === 'element' && child.name === 'code')
      const language = detectLanguage(node) ?? (codeChild ? detectLanguage(codeChild) : undefined) ?? ''
      const text = renderChildren(node, { ...context, preformatted: true }).replace(/^\n+|\n+$/g, '')
      return `\n\n\`\`\`${language}\n${text}\n\`\`\`\n\n`
    }
    case 'a': {
      const text = renderChildren(node, context).trim()
      const href = node.attributes.href?.trim()
      if (!href || href.startsWith('#') || href.startsWith('javascript:')) return text
      return text ? `[${text}](${href})` : ''
    }
    case 'img': {
      const source = node.attributes.src ?? node.attributes['data-src']
      if (!source) return ''
      return `![${(node.attributes.alt ?? '').trim()}](${source})`
    }
    case 'ul': case 'ol': {
      const ordered = name === 'ol'
      const items = node.children.filter((child) => child.type === 'element' && child.name === 'li' && !isDropped(child))
      const indent = '  '.repeat(context.listDepth)
      const lines = items.map((item, position) => {
        const marker = ordered ? `${position + 1}.` : '-'
        const content = renderChildren(item, { listDepth: context.listDepth + 1, ordered }).trim().replace(/\n{2,}/g, '\n').split('\n').map((line, index) => (index === 0 || /^\s*(?:[-*]|\d+\.)\s/.test(line) ? line : `${indent}  ${line}`)).join('\n')
        return `${indent}${marker} ${content}`
      })
      return context.listDepth === 0 ? `\n\n${lines.join('\n')}\n\n` : `\n${lines.join('\n')}`
    }
    case 'li': return renderChildren(node, context)
    case 'dt': return `\n\n**${inlineText(node).trim()}**\n`
    case 'dd': return `\n: ${renderChildren(node, context).trim()}\n`
    case 'blockquote': {
      const inner = renderChildren(node, context).trim()
      return inner ? `\n\n${inner.split('\n').map((line) => `> ${line}`).join('\n')}\n\n` : ''
    }
    case 'table': return `\n\n${renderTable(node)}\n\n`
    case 'span': case 'label': case 'small': case 'sup': case 'sub': case 'mark': case 'abbr': case 'cite': case 'q': case 'time': case 'u': case 'font': case 'center':
      return renderChildren(node, context)
    default:
      return renderChildren(node, context)
  }
}

function detectLanguage(node: HtmlNode): string | undefined {
  const marker = `${node.attributes.class ?? ''} ${node.attributes['data-language'] ?? ''} ${node.attributes['data-lang'] ?? ''}`
  const match = /(?:language|lang)-([\w+#-]+)/i.exec(marker) ?? /(?:^|\s)(bash|shell|sh|zsh|json|yaml|yml|ts|typescript|js|javascript|python|py|go|rust|java|ruby|php|sql|toml|xml|html|css|graphql|http|dockerfile|csharp|kotlin|swift)(?:\s|$)/i.exec(marker)
  return match?.[1]?.toLowerCase()
}

function renderTable(table: HtmlNode): string {
  const rows = collect(table, (node) => node.name === 'tr').map((row) => row.children.filter((cell) => cell.type === 'element' && (cell.name === 'td' || cell.name === 'th')).map((cell) => renderChildren(cell, { listDepth: 0 }).replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim()))
  const populated = rows.filter((row) => row.length > 0)
  if (populated.length === 0) return ''
  const width = Math.max(...populated.map((row) => row.length))
  const pad = (row: string[]): string[] => [...row, ...Array.from({ length: width - row.length }, () => '')]
  const [header, ...body] = populated
  const lines = [`| ${pad(header!).join(' | ')} |`, `| ${Array.from({ length: width }, () => '---').join(' | ')} |`, ...body.map((row) => `| ${pad(row).join(' | ')} |`)]
  return lines.join('\n')
}

function inlineText(node: HtmlNode): string {
  return renderChildren(node, { listDepth: 0 }).replace(/\s+/g, ' ').trim()
}

function textOf(node: HtmlNode | undefined): string {
  if (!node) return ''
  if (node.type === 'text') return decodeEntities(node.text ?? '')
  return node.children.map(textOf).join('')
}

function findFirst(node: HtmlNode, predicate: (node: HtmlNode) => boolean): HtmlNode | undefined {
  for (const child of node.children) {
    if (child.type !== 'element') continue
    if (predicate(child)) return child
    const nested = findFirst(child, predicate)
    if (nested) return nested
  }
  return undefined
}

function collect(node: HtmlNode, predicate: (node: HtmlNode) => boolean, results: HtmlNode[] = []): HtmlNode[] {
  for (const child of node.children) {
    if (child.type !== 'element') continue
    if (predicate(child)) results.push(child)
    collect(child, predicate, results)
  }
  return results
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

/**
 * The same summary for a page served as Markdown. Mintlify, GitBook, and
 * other client-rendered docs sites send an empty HTML shell to a crawler but
 * serve each page's source at `<page>.md` (and list those URLs in llms.txt).
 * Their own "documentation index" preamble is dropped.
 */
export function summarizeMarkdownDocument(source: string): HtmlDocumentSummary {
  let text = source.replace(/\r\n/g, '\n')
  let frontmatterTitle: string | undefined
  let frontmatterDescription: string | undefined
  const frontmatter = /^---\n([\s\S]*?)\n---\n?/.exec(text)
  if (frontmatter) {
    frontmatterTitle = /^title:\s*["']?(.+?)["']?\s*$/m.exec(frontmatter[1]!)?.[1]
    frontmatterDescription = /^description:\s*["']?(.+?)["']?\s*$/m.exec(frontmatter[1]!)?.[1]
    text = text.slice(frontmatter[0].length)
  }
  // Mintlify prefixes every page with a quoted pointer to llms.txt.
  text = text.replace(/^(?:>[^\n]*\n)+\n*/, (block) => /llms\.txt|documentation index/i.test(block) ? '' : block).trim()
  const withoutCode = text.replace(/```[\s\S]*?```/g, ' ')
  const headings = [...withoutCode.matchAll(/^(#{1,6})\s+(.+?)\s*#*\s*$/gm)].map((match) => ({ level: match[1]!.length, text: match[2]!.replace(/[*_`]/g, '').trim() })).filter((item) => item.text)
  const images = [...text.matchAll(/!\[[^\]]*\]\(\s*<?([^)\s>]+)>?[^)]*\)/g)].map((match) => match[1]!)
  const links = [...text.matchAll(/(?<!!)\[[^\]]*\]\(\s*<?([^)\s>]+)>?[^)]*\)/g)].map((match) => match[1]!)
  const description = frontmatterDescription ?? /^#\s+.+\n+>\s*(.+)$/m.exec(text)?.[1]?.trim()
  const words = withoutCode.replace(/!\[[^\]]*\]\([^)]*\)|\]\([^)]*\)|[#>*_`|[\]-]/g, ' ').split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length
  return {
    ...(frontmatterTitle ?? headings.find((heading) => heading.level === 1)?.text ? { title: frontmatterTitle ?? headings.find((heading) => heading.level === 1)!.text } : {}),
    ...(description ? { description } : {}),
    links,
    images,
    headings,
    markdown: text,
    words,
  }
}
