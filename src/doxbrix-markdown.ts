/**
 * MDX -> HTML renderer for `dxb dev`. Emits the same `dp-`/`df-` class structure
 * the published reader site uses (see apps/web BlockRenderer + DocumentationSite),
 * so that — paired with the bundled reader stylesheet (preview.css) — the local
 * preview renders the way the cloud site does. Plain Markdown and the Doxbrix
 * component blocks (callouts, Steps, Tabs, Accordion, Card/CardGroup, Columns,
 * CodeGroup, Terminal, Frame, Video, Embed, File, ApiEndpoint, Badge, Icon,
 * Update, Mermaid, Math, ...) are all supported.
 */

import hljs from 'highlight.js/lib/common'

type Props = Record<string, string | boolean>

interface ElNode {
  type: 'el'
  name: string
  props: Props
  inner: string
}
interface MdNode {
  type: 'md'
  text: string
}
type Node = ElNode | MdNode

export interface TocEntry {
  id: string
  level: 2 | 3 | 4
  title: string
}

export interface RenderResult {
  html: string
  toc: TocEntry[]
}

// Sentinels (private-use code points) that shield inline-component HTML from the
// Markdown escaper. Built from char codes so the source stays pure ASCII.
const TOK_OPEN = String.fromCharCode(0xe000)
const TOK_CLOSE = String.fromCharCode(0xe001)

let uidCounter = 0
const uid = (): string => `t${(uidCounter++).toString(36)}`

// TOC collection state (only top-level headings are recorded).
let tocEntries: TocEntry[] = []
const slugCounts = new Map<string, string>()
let renderDepth = 0

export function renderMarkdown(md: string): RenderResult {
  uidCounter = 0
  tocEntries = []
  slugCounts.clear()
  renderDepth = 0
  // The page title is rendered in the article header, so drop a single leading
  // H1 from the body (matching the reader, where the title is a separate field).
  const body = stripLeadingH1(md.replace(/\r\n/g, '\n'))
  const html = renderNodes(body, true)
  return { html, toc: tocEntries }
}

function stripLeadingH1(md: string): string {
  const lines = md.split('\n')
  let i = 0
  while (i < lines.length && !lines[i]!.trim()) i++
  if (i < lines.length && /^#\s+/.test(lines[i]!)) {
    lines.splice(0, i + 1)
    return lines.join('\n').replace(/^\n+/, '')
  }
  return md
}

/** Split a source string into component/markdown nodes and render each. */
function renderNodes(src: string, top = false): string {
  renderDepth++
  if (renderDepth > 40) {
    renderDepth--
    process.stderr.write('\x1b[33m[dxb] Parser: component nesting too deep — truncated\x1b[0m\n')
    return renderParseError('Component nesting too deep — preview truncated here.')
  }
  try {
    return extractNodes(src)
      .map((n) => (n.type === 'md' ? renderMarkdownChunk(n.text, top) : safeRenderElement(n)))
      .join('\n')
  } finally {
    renderDepth--
  }
}

function safeRenderElement(node: ElNode): string {
  try {
    return renderElement(node)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`\x1b[31m[dxb] Render error in <${node.name}>: ${msg}\x1b[0m\n`)
    return renderParseError(`Error rendering <${node.name}>: ${msg}`)
  }
}

function renderParseError(msg: string): string {
  return `<div class="dp-callout callout-warning" style="font-family:monospace"><span class="dp-callout-icon">⚠️</span><span class="dp-callout-body"><strong>Preview parse error</strong><br>${esc(msg)}</span></div>`
}

// ---------------------------------------------------------------------------
// Tokenizer: split a source into top-level component elements and markdown runs.
// ---------------------------------------------------------------------------

function extractNodes(src: string): Node[] {
  const lines = src.split('\n')
  const nodes: Node[] = []
  let md: string[] = []
  const flush = (): void => {
    const text = md.join('\n')
    if (text.trim()) nodes.push({ type: 'md', text })
    md = []
  }

  let i = 0
  let guard = 0
  while (i < lines.length) {
    if (++guard > 100_000) {
      process.stderr.write('\x1b[31m[dxb] Parser: extractNodes iteration limit — content may be malformed\x1b[0m\n')
      break
    }
    const line = lines[i]!

    // Fenced code block - keep verbatim and don't scan it for component tags.
    if (/^\s*(```|~~~)/.test(line)) {
      md.push(line)
      i++
      let fenceGuard = 0
      while (i < lines.length && !/^\s*(```|~~~)/.test(lines[i]!)) {
        if (++fenceGuard > 50_000) break
        md.push(lines[i++]!)
      }
      if (i < lines.length) md.push(lines[i++]!)
      continue
    }

    // Block-level component element: a capitalized tag at the start of a line.
    if (/^\s*<[A-Z][A-Za-z0-9]*(\s|\/|>|$)/.test(line)) {
      const el = parseElement(lines, i)
      if (el) {
        flush()
        nodes.push(el.node)
        i = el.next
        continue
      }
    }

    md.push(line)
    i++
  }

  flush()
  return nodes
}

function parseElement(lines: string[], start: number): { node: ElNode; next: number } | null {
  const rest = lines.slice(start).join('\n')
  const open = readOpenTag(rest)
  if (!open) return null
  if ('error' in open) {
    const consumedLines = countNewlines(rest.slice(0, open.errorAt))
    return {
      node: {
        type: 'el',
        name: 'ParseError',
        props: { message: open.error },
        inner: '',
      },
      next: Math.max(start + 1, start + consumedLines),
    }
  }

  if (open.selfClosed) {
    return {
      node: { type: 'el', name: open.name, props: open.props, inner: '' },
      next: start + countNewlines(rest.slice(0, open.tagEnd)) + 1,
    }
  }

  const close = findClose(rest, open.name, open.tagEnd)
  if (!close) {
    return {
      node: { type: 'el', name: open.name, props: open.props, inner: rest.slice(open.tagEnd) },
      next: lines.length,
    }
  }

  return {
    node: { type: 'el', name: open.name, props: open.props, inner: dedent(rest.slice(open.tagEnd, close.innerEnd)) },
    next: start + countNewlines(rest.slice(0, close.closeEnd)) + 1,
  }
}

function readOpenTag(s: string):
  | { name: string; props: Props; selfClosed: boolean; tagEnd: number }
  | { error: string; errorAt: number }
  | null {
  const m = /^\s*<([A-Z][A-Za-z0-9]*)/.exec(s)
  if (!m) return null
  const name = m[1]!

  let i = m[0].length
  let quote: string | null = null
  let brace = 0
  for (; i < s.length; i++) {
    const c = s[i]!
    if (c === '\n') {
      return {
        error: `<${name}> opening tag must end with ">" on the same line for Doxbrix ingestion.`,
        errorAt: i,
      }
    }
    if (quote) {
      if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'") quote = c
    else if (c === '{') brace++
    else if (c === '}') brace--
    else if (brace === 0 && c === '<') {
      return {
        error: `<${name}> opening tag is missing ">" before the next component.`,
        errorAt: i,
      }
    }
    else if (brace === 0 && c === '>') break
  }
  if (i >= s.length) {
    return {
      error: `<${name}> opening tag is missing ">".`,
      errorAt: s.length,
    }
  }

  const inside = s.slice(m[0].length, i)
  const selfClosed = /\/\s*$/.test(inside)
  return { name, props: parseProps(inside.replace(/\/\s*$/, '')), selfClosed, tagEnd: i + 1 }
}

function parseProps(attrStr: string): Props {
  const props: Props = {}
  const re = /([A-Za-z_][\w-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|\{([^}]*)\}))?/g
  let m: RegExpExecArray | null
  while ((m = re.exec(attrStr))) {
    const key = m[1]!
    if (m[2] !== undefined) props[key] = m[2]
    else if (m[3] !== undefined) props[key] = m[3]
    else if (m[4] !== undefined) props[key] = m[4].trim().replace(/^['"]|['"]$/g, '')
    else props[key] = true
  }
  return props
}

function findClose(s: string, name: string, from: number): { innerEnd: number; closeEnd: number } | null {
  const openTag = '<' + name
  const closeTag = '</' + name
  let i = from
  let depth = 1
  let inFence = false
  let guard = 0

  while (i < s.length) {
    if (++guard > 500_000) {
      process.stderr.write(`\x1b[31m[dxb] Parser: findClose iteration limit for <${name}> — treating as unclosed tag\x1b[0m\n`)
      return null
    }
    if (i === from || s[i - 1] === '\n') {
      let j = i
      while (s[j] === ' ' || s[j] === '\t') j++
      if (s.startsWith('```', j) || s.startsWith('~~~', j)) inFence = !inFence
    }

    if (!inFence && s[i] === '<') {
      if (s.startsWith(closeTag, i) && isTagBoundary(s[i + closeTag.length])) {
        const gt = s.indexOf('>', i)
        if (gt === -1) return null
        depth--
        if (depth === 0) return { innerEnd: i, closeEnd: gt + 1 }
        i = gt + 1
        continue
      }
      if (s.startsWith(openTag, i) && isTagBoundary(s[i + openTag.length])) {
        const gt = s.indexOf('>', i)
        if (gt === -1) return null
        if (s[gt - 1] !== '/') depth++
        i = gt + 1
        continue
      }
    }
    i++
  }
  return null
}

function isTagBoundary(c: string | undefined): boolean {
  return c === undefined || c === ' ' || c === '\t' || c === '\n' || c === '>' || c === '/'
}

// ---------------------------------------------------------------------------
// Component renderers (emit reader `dp-` classes).
// ---------------------------------------------------------------------------

const CALLOUTS: Record<string, { icon: string; cls: string }> = {
  Info: { icon: 'ℹ️', cls: 'callout-info' },
  Note: { icon: '📝', cls: 'callout-note' },
  Tip: { icon: '💡', cls: 'callout-tip' },
  Check: { icon: '✅', cls: 'callout-check' },
  Warning: { icon: '⚠️', cls: 'callout-warning' },
  Danger: { icon: '🚫', cls: 'callout-danger' },
}

function renderElement(node: ElNode): string {
  const { name, props, inner } = node
  if (name === 'ParseError') {
    return renderParseError(str(props.message) || 'Malformed component tag.')
  }
  const callout = CALLOUTS[name]
  if (callout) {
    return `<div class="dp-callout ${callout.cls}"><span class="dp-callout-icon">${callout.icon}</span><span class="dp-callout-body">${stripBlockWrap(renderNodes(inner))}</span></div>`
  }

  switch (name) {
    case 'Steps':
      return steps(inner)
    case 'Tabs':
      return tabset(childElements(inner, 'Tab').map((t) => ({
        label: str(t.props.title) || str(t.props.label),
        html: renderNodes(t.inner),
      })))
    case 'Accordion':
    case 'AccordionGroup':
      return accordion(inner)
    case 'AccordionItem':
      return accordionItem(props, inner)
    case 'Expandable':
      return `<div class="dp-expandable"><details><summary class="dp-expandable-trigger">${esc(str(props.title) || 'Details')}</summary><div class="dp-expandable-body">${renderNodes(inner)}</div></details></div>`
    case 'CardGroup':
      return `<div class="dp-card-group cols-${clampCols(num(props.cols, 2), 3)}">${renderNodes(inner)}</div>`
    case 'Card':
      return card(props, inner)
    case 'Columns':
      return `<div class="dp-columns" style="grid-template-columns:repeat(${clampCols(num(props.cols, 2), 4)},minmax(0,1fr))">${renderNodes(inner)}</div>`
    case 'Column':
      return `<div class="dp-column">${renderNodes(inner)}</div>`
    case 'CodeGroup':
      return codeGroup(inner)
    case 'Terminal':
      return `<div class="dp-terminal"><div class="dp-terminal-header"><span class="dp-terminal-dot" style="background:#ff5f57"></span><span class="dp-terminal-dot" style="background:#febc2e"></span><span class="dp-terminal-dot" style="background:#28c840"></span></div><pre class="dp-terminal-pre"><code>${esc(textOf(inner))}</code></pre></div>`
    case 'Frame':
      return frame(props, inner)
    case 'Image':
      return image(props)
    case 'Video':
      return video(props)
    case 'Embed':
      return `<div class="dp-frame"><iframe src="${escAttr(str(props.src) || str(props.url))}" loading="lazy" allowfullscreen title="${escAttr(str(props.title) || 'Embedded content')}"></iframe></div>`
    case 'File':
      return `<a class="dp-file" href="${escAttr(str(props.url) || str(props.src))}" download><span class="dp-file-name">${esc(str(props.name) || str(props.url) || str(props.src) || 'Download')}</span></a>`
    case 'ApiEndpoint':
      return apiEndpoint(props, inner)
    case 'Badge':
      return badge(props, inner)
    case 'Icon':
      return `<span class="dp-inline-badge">${esc(str(props.emoji) || iconGlyph(str(props.name)))}${inner.trim() ? ` ${inline(textOf(inner))}` : ''}</span>`
    case 'Update':
      return update(props, inner)
    case 'ParameterTable':
      return parameterTable(props, inner)
    case 'ResponseExample':
      return responseExample(props, inner)
    case 'Mermaid':
      return `<div class="dp-diagram-wrap"><pre class="mermaid">${esc(textOf(inner))}</pre></div>`
    case 'Math':
      return `<div class="dp-math-wrap"><div class="dp-math-display">${esc(textOf(inner))}</div></div>`
    case 'Excalidraw':
      return `<div class="dp-excalidraw-wrap dp-diagram-error">Excalidraw diagram (preview unavailable)</div>`
    default:
      return inner.trim() ? renderNodes(inner) : ''
  }
}

/** Drop a single wrapping <p class="dp-p">…</p> (callouts render inline bodies). */
function stripBlockWrap(html: string): string {
  const m = /^<p class="dp-p">([\s\S]*)<\/p>$/.exec(html.trim())
  return m ? m[1]! : html
}

function steps(inner: string): string {
  const items = childElements(inner, 'Step')
  const body = items
    .map((s, i) => {
      const connector = i < items.length - 1 ? '<div class="dp-step-connector"></div>' : ''
      const stepBody = s.inner.trim() ? `<div class="dp-step-body">${renderNodes(s.inner)}</div>` : ''
      return `<div class="dp-step"><div class="dp-step-left"><div class="dp-step-num">${i + 1}</div>${connector}</div><div class="dp-step-content"><div class="dp-step-title">${inline(str(s.props.title) || `Step ${i + 1}`)}</div>${stepBody}</div></div>`
    })
    .join('')
  return `<div class="dp-steps">${body}</div>`
}

function tabset(tabs: { label: string; html: string }[]): string {
  if (!tabs.length) return ''
  const id = uid()
  const bar = tabs
    .map((t, k) => `<button class="dp-code-group-tab${k === 0 ? ' active' : ''}" data-tab="${id}-${k}">${esc(t.label || `Tab ${k + 1}`)}</button>`)
    .join('')
  const panels = tabs
    .map((t, k) => `<div class="dp-tab-panel${k === 0 ? ' active' : ''}" id="${id}-${k}">${t.html}</div>`)
    .join('')
  return `<div class="dp-tabs"><div class="dp-code-group-tabs">${bar}</div>${panels}</div>`
}

function accordion(inner: string): string {
  const items = childElements(inner, 'AccordionItem')
  const body = items.length ? items.map((it) => accordionItem(it.props, it.inner)).join('') : renderNodes(inner)
  return `<div class="dp-accordion">${body}</div>`
}

function accordionItem(props: Props, inner: string): string {
  return `<details class="dp-accordion-item"><summary class="dp-accordion-trigger">${esc(str(props.title) || 'Details')}</summary><div class="dp-accordion-body">${renderNodes(inner)}</div></details>`
}

function card(props: Props, inner: string): string {
  const icon = props.icon ? `<div class="dp-card-icon">${esc(iconGlyph(str(props.icon)))}</div>` : ''
  const title = `<div class="dp-card-title">${inline(str(props.title) || 'Card')}</div>`
  const descText = inner.trim() ? stripBlockWrap(renderNodes(inner)) : str(props.description)
  const desc = descText ? `<div class="dp-card-desc">${descText}</div>` : ''
  const content = `${icon}${title}${desc}`
  return props.href
    ? `<a class="dp-card" href="${escAttr(str(props.href))}">${content}</a>`
    : `<div class="dp-card">${content}</div>`
}

function codeGroup(inner: string): string {
  const blocks = parseFences(inner)
  if (!blocks.length) return `<div class="dp-code-group">${renderNodes(inner)}</div>`
  const id = uid()
  const bar = blocks
    .map((b, k) => `<button class="dp-code-group-tab${k === 0 ? ' active' : ''}" data-tab="${id}-${k}">${esc(b.label || b.lang || `Tab ${k + 1}`)}</button>`)
    .join('')
  const panels = blocks
    .map((b, k) => `<div class="dp-tab-panel${k === 0 ? ' active' : ''}" id="${id}-${k}">${codeBlock(b.code, b.lang)}</div>`)
    .join('')
  return `<div class="dp-code-group"><div class="dp-code-group-tabs">${bar}</div>${panels}</div>`
}

function codeBlock(code: string, lang: string): string {
  const requested = (lang || 'plaintext').toLowerCase()
  const aliases: Record<string, string> = { ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', shellscript: 'bash', shell: 'bash', sh: 'bash', py: 'python', yml: 'yaml', text: 'plaintext' }
  const language = aliases[requested] ?? requested
  let highlighted: string
  try {
    highlighted = hljs.getLanguage(language)
      ? hljs.highlight(code, { language, ignoreIllegals: true }).value
      : esc(code)
  } catch {
    highlighted = esc(code)
  }
  return `<div class="dp-code-block dp-code-theme-auto dp-code-theme-light"><div class="dp-code-header"><span class="dp-code-lang">${esc(lang || 'plaintext')}</span><button class="dp-code-copy-btn" type="button" aria-label="Copy code">${copyIcon()}<span>Copy</span></button></div><pre class="dp-code-pre dp-hl-auto dp-hl-light"><code>${highlighted}</code></pre></div>`
}

function copyIcon(): string {
  return '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>'
}

function frame(props: Props, inner: string): string {
  // A Frame wrapping an image renders as a captioned image (matches the reader).
  const img = /!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/.exec(inner)
  if (img) {
    const caption = str(props.caption)
    const cap = caption ? `<div class="dp-image-caption">${inline(caption)}</div>` : ''
    return `<div class="dp-image-wrap align-center"><img alt="${escAttr(img[1] ?? '')}" src="${escAttr(img[2] ?? '')}" />${cap}</div>`
  }
  const url = str(props.url) || str(props.src)
  if (url) {
    return `<div class="dp-frame"><iframe src="${escAttr(url)}" loading="lazy" title="${escAttr(str(props.title) || 'Framed content')}"></iframe></div>`
  }
  return `<div class="dp-frame">${renderNodes(inner)}</div>`
}

function image(props: Props): string {
  const src = str(props.src) || str(props.url)
  const caption = str(props.caption)
  const cap = caption ? `<div class="dp-image-caption">${inline(caption)}</div>` : ''
  return `<div class="dp-image-wrap align-center"><img alt="${escAttr(str(props.alt))}" src="${escAttr(src)}" />${cap}</div>`
}

function video(props: Props): string {
  const src = str(props.url) || str(props.src)
  const embed = /youtu\.?be|youtube|vimeo|loom|wistia/i.test(src) ? toEmbedUrl(src) : src
  return `<div class="dp-video"><iframe src="${escAttr(embed)}" loading="lazy" allowfullscreen title="Video"></iframe></div>`
}

function apiEndpoint(props: Props, inner: string): string {
  const method = (str(props.method) || 'GET').toUpperCase()
  const path = str(props.path) || '/'
  const baseUrl = str(props.baseUrl).replace(/\/+$/, '')
  const description = str(props.description)
  const params = childElements(inner, 'Param')
  const responses = childElements(inner, 'Response')
  const requestId = uid()
  const responseGroupId = uid()
  const curl = apiCurlExample(method, path, baseUrl, params)

  const parameterSection = (
    title: string,
    location: string,
    color: string,
  ): string => {
    const matching = params.filter(
      (param) => (str(param.props.in) || 'query') === location,
    )
    if (matching.length === 0) return ''
    const rows = matching
      .map((param) => {
        const type = str(param.props.type)
        const where = str(param.props.in) || 'query'
        const body = stripBlockWrap(renderNodes(param.inner))
        return `<div class="dp-api-param-item"><div class="dp-api-param-meta"><span class="dp-api-param-name" style="color:${color}">${esc(str(param.props.name))}</span>${type ? `<span class="dp-api-badge">${esc(type)}</span>` : ''}<span class="dp-api-badge">${esc(where)}</span>${param.props.required ? '<span class="dp-api-param-required">required</span>' : ''}</div>${body ? `<div class="dp-api-param-desc">${body}</div>` : ''}</div>`
      })
      .join('')
    return `<div class="dp-api-section"><button class="dp-api-section-btn" type="button" aria-expanded="true"><span aria-hidden="true">⌄</span><span>${title}</span></button><div class="dp-api-section-body">${rows}</div></div>`
  }

  const responseRows = responses
    .map((response) => {
      const status = str(response.props.status) || '200'
      const tone = apiStatusTone(status)
      const responseDescription = str(response.props.description)
      return `<div class="dp-api-resp-row"><span class="dp-api-resp-status${tone ? ` ${tone}` : ''}">${esc(status)}</span>${responseDescription ? `<span class="dp-api-resp-desc">${esc(responseDescription)}</span>` : ''}</div>`
    })
    .join('')
  const responseSection = responseRows
    ? `<div class="dp-api-section dp-api-section--response"><div class="dp-api-section-btn dp-api-section-btn--static"><span>Response</span></div><div class="dp-api-section-body">${responseRows}</div></div>`
    : ''

  const responseTabs = responses
    .map((response, index) => {
      const status = str(response.props.status) || '200'
      const tone = apiStatusTone(status)
      return `<button class="dp-api-resp-tab${tone ? ` ${tone}` : ''}${index === 0 ? ' active' : ''}" type="button" data-api-response-tab="${responseGroupId}-${index}">${esc(status)}</button>`
    })
    .join('')
  const responsePanels = responses
    .map((response, index) => {
      const example = apiExample(response.inner)
      return `<pre class="dp-api-resp-body" id="${responseGroupId}-${index}" data-api-response-panel${index === 0 ? '' : ' hidden'}>${esc(example || '{}')}</pre>`
    })
    .join('')
  const responseCard =
    responses.length > 0
      ? `<div class="dp-api-resp-card"><div class="dp-api-resp-header"><div class="dp-api-resp-tabs">${responseTabs}</div><button class="dp-api-light-copy" type="button">Copy</button></div>${responsePanels}</div>`
      : ''

  return `<div class="dp-api-ref">${description ? `<p class="dp-api-ref-desc">${inline(description)}</p>` : ''}<div class="dp-api-ref-body"><div class="dp-api-ref-left"><div class="dp-api-ref-url-row"><span class="dp-api-method-badge ${method}">${esc(method)}</span><code class="dp-api-ref-path">${esc(path)}</code><button class="dp-api-try-btn" type="button" disabled title="Interactive Try it is available in published Doxbrix">Try it ▶</button></div>${parameterSection('Authorizations', 'header', '#059669')}${parameterSection('Path Parameters', 'path', '#d97706')}${parameterSection('Query Parameters', 'query', '#2563eb')}${parameterSection('Body Parameters', 'body', '#7c3aed')}${responseSection}</div><div class="dp-api-ref-right"><div class="dp-api-code-card"><div class="dp-api-code-card-header"><span class="dp-api-code-card-lang">cURL</span><div class="dp-api-code-card-actions"><span class="dp-api-code-copy">cURL⌄</span><button class="dp-api-code-copy" type="button">Copy</button></div></div><pre class="dp-api-code-body" id="${requestId}">${esc(curl)}</pre></div>${responseCard}</div></div></div>`
}

function apiCurlExample(
  method: string,
  path: string,
  baseUrl: string,
  params: ElNode[],
): string {
  let resolvedPath = path
  for (const param of params.filter((item) => str(item.props.in) === 'path')) {
    const name = str(param.props.name)
    const example = str(param.props.example) || `{${name}}`
    if (name) resolvedPath = resolvedPath.replaceAll(`{${name}}`, example)
  }

  const query = params
    .filter((param) => str(param.props.in) === 'query')
    .map((param) => {
      const name = str(param.props.name)
      const example = str(param.props.example) || `{${name}}`
      return `${encodeURIComponent(name)}=${encodeURIComponent(example)}`
    })
  const url = `${baseUrl}${resolvedPath}${query.length ? `?${query.join('&')}` : ''}`
  const lines = [`curl --request ${method} \\`, `  --url '${url || resolvedPath}'`]

  for (const param of params.filter((item) => str(item.props.in) === 'header')) {
    const name = str(param.props.name)
    const example =
      str(param.props.example) ||
      (name.toLowerCase() === 'authorization'
        ? 'Bearer YOUR_API_KEY'
        : `{${name}}`)
    lines[lines.length - 1] += ' \\'
    lines.push(`  --header '${name}: ${example}'`)
  }

  const bodyParams = params.filter((item) => str(item.props.in) === 'body')
  if (bodyParams.length > 0) {
    const body: Record<string, unknown> = {}
    for (const param of bodyParams) {
      const name = str(param.props.name)
      if (!name) continue
      setApiBodyValue(body, name.split('.'), apiBodyExample(param))
    }
    lines[lines.length - 1] += ' \\'
    lines.push(`  --header 'Content-Type: application/json' \\`)
    lines.push(`  --data '${JSON.stringify(body, null, 2)}'`)
  }
  return lines.join('\n')
}

function apiBodyExample(param: ElNode): unknown {
  const name = str(param.props.name)
  const example = str(param.props.example)
  if (!example) return `{${name}}`

  switch (str(param.props.type).toLowerCase()) {
    case 'integer': {
      const value = Number(example)
      return Number.isInteger(value) ? value : example
    }
    case 'number': {
      const value = Number(example)
      return Number.isFinite(value) ? value : example
    }
    case 'boolean':
      if (example === 'true') return true
      if (example === 'false') return false
      return example
    case 'array':
    case 'object':
      try {
        return JSON.parse(example) as unknown
      } catch {
        return example
      }
    default:
      return example
  }
}

function setApiBodyValue(
  body: Record<string, unknown>,
  path: string[],
  value: unknown,
): void {
  const key = path[0]
  if (!key) return
  if (path.length === 1) {
    body[key] = value
    return
  }

  const existing = body[key]
  const child =
    existing !== null &&
    typeof existing === 'object' &&
    !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {}
  body[key] = child
  setApiBodyValue(child, path.slice(1), value)
}

function apiStatusTone(status: string): string {
  if (/^2/.test(status)) return 'success'
  if (/^[45]/.test(status)) return 'error'
  return ''
}

function apiExample(inner: string): string {
  const body = textOf(inner).trim()
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/i.exec(body)
  return fenced?.[1]?.trim() ?? body
}

function badge(props: Props, inner: string): string {
  const text = str(props.text) || textOf(inner)
  const color = /^(blue|green|yellow|red|purple|gray|orange)$/.test(str(props.color))
    ? ` ${str(props.color)}`
    : ''
  return `<span class="dp-inline-badge${color}">${esc(text)}</span>`
}

function update(props: Props, inner: string): string {
  const labelText =
    str(props.label) ||
    [str(props.type), str(props.version)].filter(Boolean).join(' · ')
  const descriptionText = str(props.description) || str(props.date)
  const label = labelText ? `<div class="dp-update-label">${esc(labelText)}</div>` : ''
  const desc = descriptionText ? `<div class="dp-update-desc">${esc(descriptionText)}</div>` : ''
  return `<div class="dp-update"><div class="dp-update-head">${label}${desc}</div><div class="dp-update-body">${renderNodes(inner)}</div></div>`
}

function parameterTable(props: Props, inner: string): string {
  const params = childElements(inner, 'Param')
  const title = str(props.title)
  const rows = params
    .map(
      (param) =>
        `<div class="dp-param-row"><span class="dp-param-name">${esc(str(param.props.name))}</span><span class="dp-param-type-tag">${esc(str(param.props.type))}</span>${param.props.required ? '<span class="dp-param-required-tag">required</span>' : ''}<span class="dp-param-desc-text">${stripBlockWrap(renderNodes(param.inner))}</span></div>`,
    )
    .join('')
  return `<div class="dp-api-endpoint"><div class="dp-api-endpoint-body">${title ? `<div class="dp-param-section-title">${esc(title)}</div>` : ''}${rows || renderNodes(inner)}</div></div>`
}

function responseExample(_props: Props, inner: string): string {
  const responses = childElements(inner, 'Response')
  if (responses.length === 0) return `<div class="dp-api-resp-card">${renderNodes(inner)}</div>`
  return responses
    .map(
      (response) =>
        `<div class="dp-api-resp-card"><div class="dp-api-resp-header"><span class="dp-api-resp-status">${esc(str(response.props.status))}</span>${response.props.description ? `<span class="dp-api-resp-desc">${esc(str(response.props.description))}</span>` : ''}</div><div class="dp-api-resp-body">${renderNodes(response.inner)}</div></div>`,
    )
    .join('')
}

// ---------------------------------------------------------------------------
// Markdown chunk renderer.
// ---------------------------------------------------------------------------

function renderMarkdownChunk(md: string, top: boolean): string {
  const lines = md.split('\n')
  const out: string[] = []
  let i = 0
  let guard = 0

  while (i < lines.length) {
    if (++guard > 100_000) {
      process.stderr.write('\x1b[31m[dxb] Parser: renderMarkdownChunk iteration limit — content truncated\x1b[0m\n')
      break
    }
    const line = lines[i]!

    const fence = /^\s*(```|~~~)(\w*)\s*$/.exec(line)
    if (fence) {
      const lang = fence[2] ?? ''
      const body: string[] = []
      i++
      while (i < lines.length && !/^\s*(```|~~~)\s*$/.test(lines[i]!)) body.push(lines[i++]!)
      i++ // closing fence
      out.push(codeBlock(body.join('\n'), lang))
      continue
    }

    if (!line.trim()) {
      i++
      continue
    }

    // HTML comment - skip (matches the reader, which hides it).
    if (/^\s*<!--/.test(line)) {
      while (i < lines.length && !/-->/.test(lines[i]!)) i++
      i++
      continue
    }

    // Stray closing tag - drop it rather than leak it.
    if (/^\s*<\/[A-Za-z]/.test(line)) {
      i++
      continue
    }

    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) {
      out.push(heading(h[1]!.length, h[2]!, top))
      i++
      continue
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push('<hr class="dp-hr" />')
      i++
      continue
    }

    if (/^\s*>\s?/.test(line)) {
      const body: string[] = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i]!)) body.push(lines[i++]!.replace(/^\s*>\s?/, ''))
      out.push(`<blockquote class="dp-blockquote">${renderMarkdownChunk(body.join('\n'), false)}</blockquote>`)
      continue
    }

    if (/\|/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]!)) {
      const header = splitRow(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && /\|/.test(lines[i]!) && lines[i]!.trim()) rows.push(splitRow(lines[i++]!))
      out.push(renderTable(header, rows))
      continue
    }

    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line)
      const items: string[] = []
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i]!)) {
        items.push(lines[i++]!.replace(/^\s*([-*+]|\d+\.)\s+/, ''))
      }
      out.push(renderList(items, ordered))
      continue
    }

    // Lone-image paragraph -> block image (matches the reader's image block).
    const loneImg = /^\s*!\[([^\]]*)\]\(([^)\s]+)[^)]*\)\s*$/.exec(line)
    if (loneImg) {
      out.push(`<div class="dp-image-wrap align-center"><img alt="${escAttr(loneImg[1] ?? '')}" src="${escAttr(loneImg[2] ?? '')}" /></div>`)
      i++
      continue
    }

    const para: string[] = []
    while (
      i < lines.length &&
      lines[i]!.trim() &&
      !/^\s*(#{1,6}\s|>\s?|```|~~~|<!--|<\/[A-Za-z]|([-*+]|\d+\.)\s+)/.test(lines[i]!)
    ) {
      para.push(lines[i++]!)
    }
    if (para.length) out.push(`<p class="dp-p">${inline(para.join(' '))}</p>`)
  }

  return out.join('\n')
}

function heading(level: number, text: string, top: boolean): string {
  const lvl = Math.min(6, Math.max(2, level === 1 ? 2 : level))
  const id = slugify(stripInline(text))
  if (top && (lvl === 2 || lvl === 3 || lvl === 4)) {
    tocEntries.push({ id, level: lvl as 2 | 3 | 4, title: stripInline(text) })
  }
  return `<h${lvl} id="${escAttr(id)}" class="dp-h${lvl}">${inline(text)}</h${lvl}>`
}

function renderList(items: string[], ordered: boolean): string {
  const isTask = items.some((it) => /^\[[ xX]\]\s+/.test(it))
  if (isTask) {
    const lis = items
      .map((it) => {
        const m = /^\[([ xX])\]\s+(.*)$/.exec(it)
        const checked = m && m[1] !== ' '
        const icon = `<span class="dp-task-check-icon${checked ? ' checked' : ''}"></span>`
        const txt = m ? m[2]! : it
        const style = checked ? ' style="text-decoration:line-through;color:#9ca3af"' : ''
        return `<li class="dp-task-item">${icon}<span${style}>${inline(txt)}</span></li>`
      })
      .join('')
    return `<ul class="dp-task-list">${lis}</ul>`
  }
  const tag = ordered ? 'ol' : 'ul'
  const cls = ordered ? 'dp-ol' : 'dp-ul'
  const lis = items.map((it) => `<li>${inline(it)}</li>`).join('')
  return `<${tag} class="${cls}">${lis}</${tag}>`
}

function renderTable(header: string[], rows: string[][]): string {
  const head = `<tr>${header.map((c) => `<th>${inline(c)}</th>`).join('')}</tr>`
  const body = rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')
  return `<div class="dp-table-wrap"><table class="dp-table"><thead>${head}</thead><tbody>${body}</tbody></table></div>`
}

// ---------------------------------------------------------------------------
// Inline marks (+ inline components). Mirrors apps/web inline-format.tsx.
// ---------------------------------------------------------------------------

function inline(text: string): string {
  const tokens: string[] = []
  let s = text.replace(/<(Badge|Icon)\b([^>]*?)\/?>(?:([\s\S]*?)<\/\1>)?/g, (_m, tag: string, attrs: string, body?: string) => {
    const props = parseProps(attrs)
    const html =
      tag === 'Badge'
        ? `<span class="dp-inline-badge">${esc(str(props.text) || (body ?? '').trim())}</span>`
        : `<span class="dp-inline-badge">${esc(iconGlyph(str(props.name)))}</span>`
    tokens.push(html)
    return `${TOK_OPEN}${tokens.length - 1}${TOK_CLOSE}`
  })

  s = esc(s)
  s = s.replace(/`([^`\n]+)`/g, (_m, c) => `<code class="df-inline-code">${c}</code>`)
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (_m, alt, src) => `<img alt="${escAttr(alt)}" src="${escAttr(src)}" />`)
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (_m, t, href) => `<a class="df-inline-link" href="${escAttr(href)}">${t}</a>`)
  s = s.replace(/<u>([\s\S]+?)<\/u>/gi, '<u>$1</u>')
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/~~([^~]+)~~/g, '<s>$1</s>')
  s = s.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
  s = s.replace(/(^|[^_\w])_([^_]+)_/g, '$1<em>$2</em>')
  if (tokens.length) {
    s = s.replace(new RegExp(`${TOK_OPEN}(\\d+)${TOK_CLOSE}`, 'g'), (_m, k) => tokens[Number(k)] ?? '')
  }
  return s
}

// ---------------------------------------------------------------------------
// Small helpers.
// ---------------------------------------------------------------------------

function childElements(inner: string, name: string): ElNode[] {
  return extractNodes(inner).filter((n): n is ElNode => n.type === 'el' && n.name === name)
}

function parseFences(src: string): { lang: string; label: string; code: string }[] {
  const lines = src.split('\n')
  const blocks: { lang: string; label: string; code: string }[] = []
  let i = 0
  while (i < lines.length) {
    const open = /^\s*(```|~~~)\s*(\w+)?\s*(.*)$/.exec(lines[i]!)
    if (!open) {
      i++
      continue
    }
    i++
    const body: string[] = []
    while (i < lines.length && !/^\s*(```|~~~)\s*$/.test(lines[i]!)) body.push(lines[i++]!)
    i++
    blocks.push({ lang: open[2] ?? '', label: (open[3] ?? '').trim(), code: body.join('\n') })
  }
  return blocks
}

function textOf(inner: string): string {
  return inner.replace(/^\n+/, '').replace(/\n+$/, '')
}

function toEmbedUrl(src: string): string {
  const yt = /(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/))([\w-]+)/.exec(src)
  return yt ? `https://www.youtube.com/embed/${yt[1]}` : src
}

const ICONS: Record<string, string> = {
  rocket: '🚀', sparkles: '✨', 'wand-sparkles': '🪄', star: '⭐', globe: '🌐', terminal: '⌨️',
  'pen-line': '✏️', pencil: '✏️', users: '👥', user: '👤', layers: '🧱', book: '📘', 'book-open': '📖',
  'message-circle': '💬', chat: '💬', bell: '🔔', lock: '🔒', key: '🔑', shield: '🛡️', search: '🔍',
  zap: '⚡', bolt: '⚡', code: '💻', file: '📄', folder: '📁', settings: '⚙️', gear: '⚙️', check: '✅',
  info: 'ℹ️', warning: '⚠️', heart: '❤️', mail: '✉️', link: '🔗', download: '⬇️', upload: '⬆️',
  database: '🗄️', cloud: '☁️', plug: '🔌', package: '📦', tag: '🏷️', calendar: '📅', clock: '🕒',
  eye: '👁️', git: '🌿', branch: '🌿', play: '▶️', flag: '🚩', map: '🗺️', compass: '🧭',
}

function iconGlyph(name: string): string {
  if (/[^\p{L}\p{N}\s_-]/u.test(name)) return name
  return ICONS[name.toLowerCase()] ?? '📄'
}

function slugify(text: string): string {
  const base =
    text
      .toLowerCase()
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-') || 'section'
  // De-duplicate repeated slugs on the same page.
  const seen = slugCounts.get(base)
  if (seen === undefined) {
    slugCounts.set(base, base)
    return base
  }
  let n = 2
  while (slugCounts.has(`${base}-${n}`)) n++
  const out = `${base}-${n}`
  slugCounts.set(out, out)
  return out
}

function stripInline(text: string): string {
  return text
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .trim()
}

function num(v: string | boolean | undefined, fallback: number): number {
  const n = typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) ? n : fallback
}

function clampCols(n: number, max: number): number {
  return Math.min(max, Math.max(1, Math.round(n) || 1))
}

function str(v: string | boolean | undefined): string {
  return typeof v === 'string' ? v : ''
}

function countNewlines(s: string): number {
  return (s.match(/\n/g) ?? []).length
}

function dedent(s: string): string {
  const body = s.replace(/^\n/, '')
  const lines = body.split('\n')
  let min = Infinity
  for (const l of lines) {
    if (!l.trim()) continue
    min = Math.min(min, /^[ \t]*/.exec(l)![0].length)
  }
  if (!Number.isFinite(min) || min === 0) return body
  return lines.map((l) => l.slice(min)).join('\n')
}

function splitRow(line: string): string[] {
  return line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((c) => c.trim())
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escAttr(s: string): string {
  return esc(s).replace(/"/g, '&quot;')
}
