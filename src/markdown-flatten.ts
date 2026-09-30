/**
 * MDX -> plain Markdown for readers that are not browsers: llms.txt,
 * llms-full.txt, the per-page `.md` mirrors, and the local docs MCP server.
 * It walks the same component tree the preview renderer uses (see
 * doxbrix-markdown.ts), so a component the reader can draw is never silently
 * dropped here; unknown components keep their inner content.
 */

import {
  CALLOUTS,
  childElements,
  extractNodes,
  parseFences,
  parseProps,
  type ElNode,
  type Props,
} from './doxbrix-markdown.js'

const MAX_DEPTH = 40
const FENCE = /^\s*(```|~~~)/

/** Strip frontmatter and MDX module lines, then flatten components to Markdown. */
export function flattenMarkdown(source: string): string {
  const body = stripModuleLines(stripFrontmatter(source.replace(/\r\n/g, '\n')))
  return tidy(flattenNodes(joinMultilineOpeningTags(body), 0))
}

export function stripFrontmatter(source: string): string {
  const match = /^\uFEFF?---[ \t]*\n[\s\S]*?\n(?:---|\.\.\.)[ \t]*(?:\n|$)/.exec(source)
  return match ? source.slice(match[0].length) : source
}

/**
 * MDX `import`/`export` statements, `{/* comments *\/}` and HTML comments are
 * build instructions or notes to authors, not prose. Code fences are left
 * untouched.
 */
export function stripModuleLines(source: string): string {
  const lines = source.split('\n')
  const output: string[] = []
  let fence: string | undefined
  let comment: RegExp | undefined
  for (let index = 0; index < lines.length; index++) {
    let line = lines[index]!
    if (comment) {
      const end = comment.exec(line)
      if (!end) continue
      line = line.slice(end.index + end[0].length)
      comment = undefined
      if (!line.trim()) continue
    }
    const marker = FENCE.exec(line)?.[1]
    if (fence) {
      output.push(line)
      if (marker === fence && /^\s*(```|~~~)\s*$/.test(line)) fence = undefined
      continue
    }
    if (marker) {
      fence = marker
      output.push(line)
      continue
    }
    if (/^import\s+(?:.+\s+from\s+)?['"]/.test(line) || /^import\s*\{/.test(line) || /^export\s+(?:const|let|var|function|default|async|class|\{|\*)/.test(line)) {
      // A multi-line statement (an object, a function, a braced import list)
      // continues until its brackets balance again.
      let depth = bracketBalance(line)
      while (depth > 0 && index + 1 < lines.length) depth += bracketBalance(lines[++index]!)
      continue
    }
    const stripped = line.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/<!--[\s\S]*?-->/g, '')
    const open = /\{\/\*|<!--/.exec(stripped)
    if (open) {
      comment = open[0] === '<!--' ? /-->/ : /\*\/\}/
      const before = stripped.slice(0, open.index)
      if (before.trim()) output.push(before.trimEnd())
      continue
    }
    if (stripped !== line && !stripped.trim()) continue
    output.push(stripped)
  }
  return output.join('\n')
}

function bracketBalance(line: string): number {
  let depth = 0
  for (const character of line) {
    if (character === '{' || character === '(' || character === '[') depth++
    else if (character === '}' || character === ')' || character === ']') depth--
  }
  return depth
}

/**
 * The preview tokenizer requires an opening tag on one line. Mintlify-style
 * MDX often spreads props over several lines, so join them before parsing
 * instead of losing the component.
 */
function joinMultilineOpeningTags(source: string): string {
  const lines = source.split('\n')
  const output: string[] = []
  let inFence = false
  for (let index = 0; index < lines.length; index++) {
    let line = lines[index]!
    if (FENCE.test(line)) inFence = !inFence
    if (!inFence && /^\s*<[A-Z][A-Za-z0-9]*(\s|$)/.test(line)) {
      let extra = 0
      while (!openingTagCloses(line) && index + 1 < lines.length && extra < 30) {
        line = `${line} ${lines[++index]!.trim()}`
        extra++
      }
    }
    output.push(line)
  }
  return output.join('\n')
}

function openingTagCloses(line: string): boolean {
  let quote: string | undefined
  let brace = 0
  for (let index = line.indexOf('<') + 1; index < line.length; index++) {
    const character = line[index]!
    if (quote) {
      if (character === quote) quote = undefined
      continue
    }
    if (character === '"' || character === "'" || character === '`') quote = character
    else if (character === '{') brace++
    else if (character === '}') brace--
    else if (brace === 0 && character === '>') return true
  }
  return false
}

function flattenNodes(source: string, depth: number): string {
  if (depth > MAX_DEPTH) return source
  return extractNodes(source)
    .map((node) => (node.type === 'md' ? flattenText(node.text) : flattenElement(node, depth + 1)))
    .map((part) => part.replace(/^(?:[ \t]*\n)+/, '').trimEnd())
    .filter(Boolean)
    .join('\n\n')
}

/** Markdown runs pass through; inline components become text and stray closing tags go. */
function flattenText(text: string): string {
  const output: string[] = []
  let inFence = false
  for (const line of text.split('\n')) {
    if (FENCE.test(line)) {
      inFence = !inFence
      output.push(line)
      continue
    }
    if (inFence) {
      output.push(line)
      continue
    }
    if (/^\s*<\/[A-Z][A-Za-z0-9]*>\s*$/.test(line)) continue
    output.push(inlineText(line))
  }
  return output.join('\n')
}

function inlineText(line: string): string {
  return line
    .replace(/<Badge\b([^>]*?)\/>/g, (_match, attributes: string) => text(parseProps(attributes).text))
    .replace(/<Badge\b([^>]*?)>([\s\S]*?)<\/Badge>/g, (_match, attributes: string, body: string) => text(parseProps(attributes).text) || body.trim())
    .replace(/<Icon\b[^>]*?\/>/g, '')
    .replace(/<Icon\b[^>]*?>([\s\S]*?)<\/Icon>/g, (_match, body: string) => body.trim())
    .replace(/<Tooltip\b[^>]*?>([\s\S]*?)<\/Tooltip>/g, (_match, body: string) => body.trim())
    .replace(/[ \t]+$/, '')
}

function flattenElement(node: ElNode, depth: number): string {
  const { name, props, inner } = node
  const body = (): string => flattenNodes(inner, depth)
  if (CALLOUTS[name] || name === 'Callout') {
    const label = name === 'Callout' ? capitalize(text(props.type) || 'Note') : name
    const title = text(props.title)
    const content = body()
    // A paragraph can share the label's line; a list, table, or code block cannot.
    const inline = !title && content && !/^(\s*[-*+>|#]|\s*\d+\.\s|\s*```|\s*~~~)/.test(content)
    return blockquote(inline ? `**${label}:** ${content}` : [`**${label}${title ? `: ${title}` : ''}**`, content].filter(Boolean).join('\n\n'))
  }
  switch (name) {
    case 'ParseError':
      return ''
    case 'Steps':
      return steps(inner, depth)
    case 'Step':
      return [text(props.title) ? `**${text(props.title)}**` : '', body()].filter(Boolean).join('\n\n')
    case 'Tabs':
      return childElements(inner, 'Tab')
        .map((tab, index) => `### ${text(tab.props.title) || text(tab.props.label) || `Tab ${index + 1}`}\n\n${flattenNodes(tab.inner, depth)}`.trim())
        .join('\n\n')
    case 'Tab':
      return `### ${text(props.title) || text(props.label) || 'Tab'}\n\n${body()}`.trim()
    case 'Accordion':
    case 'AccordionGroup': {
      const items = childElements(inner, 'AccordionItem').concat(childElements(inner, 'Accordion'))
      if (items.length) return items.map((item) => titled(item.props, flattenNodes(item.inner, depth))).join('\n\n')
      return titled(props, body())
    }
    case 'AccordionItem':
    case 'Expandable':
      return titled(props, body())
    case 'CardGroup':
    case 'Columns': {
      const cards = childElements(inner, 'Card')
      return cards.length && extractNodes(inner).every((child) => child.type === 'el' && child.name === 'Card')
        ? cards.map((item) => card(item.props, item.inner, depth)).join('\n')
        : body()
    }
    case 'Card':
      return card(props, inner, depth)
    case 'CodeGroup':
      return codeGroup(inner, depth)
    case 'Terminal':
      return fenced('', trimBlankLines(inner))
    case 'Frame':
      return frame(props, inner, depth)
    case 'Image':
      return image(text(props.alt), text(props.src) || text(props.url), text(props.caption))
    case 'Video':
    case 'Embed': {
      const url = text(props.src) || text(props.url)
      return url ? `[${text(props.title) || (name === 'Video' ? 'Video' : 'Embedded content')}](${url})` : ''
    }
    case 'File': {
      const url = text(props.url) || text(props.src)
      return url ? `[${text(props.name) || url}](${url})` : ''
    }
    case 'ApiEndpoint':
      return apiEndpoint(props, inner, depth)
    case 'ParameterTable': {
      const params = parameters(inner)
      const title = text(props.title)
      return [title ? `**${title}**` : '', params.length ? parameterTable(params, depth) : body()].filter(Boolean).join('\n\n')
    }
    case 'Param':
    case 'ParamField':
    case 'ResponseField':
      return fieldLine(props, inner, depth)
    case 'ResponseExample':
    case 'RequestExample': {
      const responses = childElements(inner, 'Response')
      return responses.length ? responses.map((response) => responseBlock(response, depth)).join('\n\n') : body()
    }
    case 'Response':
      return responseBlock(node, depth)
    case 'Mermaid':
      return FENCE.test(trimBlankLines(inner)) ? trimBlankLines(inner) : fenced('mermaid', trimBlankLines(inner))
    case 'Math':
      return `$$\n${trimBlankLines(inner)}\n$$`
    case 'Excalidraw':
      return ''
    case 'Badge':
      return text(props.text) || inner.trim()
    case 'Icon':
      return inner.trim() ? body() : ''
    case 'Update': {
      const label = text(props.label) || [text(props.type), text(props.version)].filter(Boolean).join(' · ')
      const description = text(props.description) || text(props.date)
      return [label ? `### ${label}` : '', description ? `*${description}*` : '', body()].filter(Boolean).join('\n\n')
    }
    default:
      return inner.trim() ? body() : ''
  }
}

function steps(inner: string, depth: number): string {
  return childElements(inner, 'Step')
    .map((step, index) => {
      const title = text(step.props.title) || `Step ${index + 1}`
      const content = flattenNodes(step.inner, depth)
      return `${index + 1}. **${title}**${content ? `\n\n${indent(content, '   ')}` : ''}`
    })
    .join('\n\n')
}

function titled(props: Props, content: string): string {
  const title = text(props.title) || 'Details'
  return content ? `**${title}**\n\n${content}` : `**${title}**`
}

function card(props: Props, inner: string, depth: number): string {
  const title = text(props.title) || 'Card'
  const description = (inner.trim() ? flattenNodes(inner, depth) : text(props.description)).replace(/\s*\n\s*/g, ' ').trim()
  const href = text(props.href)
  const label = href ? `[${title}](${href})` : `**${title}**`
  return `- ${label}${description ? `: ${description}` : ''}`
}

function codeGroup(inner: string, depth: number): string {
  const blocks = parseFences(inner)
  if (!blocks.length) return flattenNodes(inner, depth)
  return blocks
    .map((block) => {
      const label = block.label.replace(/^title=["']?|["']$/g, '').trim()
      return `${label ? `**${label}**\n\n` : ''}${fenced(block.lang, block.code)}`
    })
    .join('\n\n')
}

function frame(props: Props, inner: string, depth: number): string {
  const img = /!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/.exec(inner)
  const caption = text(props.caption)
  if (img) return image(img[1] ?? '', img[2] ?? '', caption)
  const url = text(props.url) || text(props.src)
  if (url) return `[${text(props.title) || 'Framed content'}](${url})`
  const content = flattenNodes(inner, depth)
  return [content, caption ? `*${caption}*` : ''].filter(Boolean).join('\n\n')
}

function image(alt: string, src: string, caption: string): string {
  if (!src) return ''
  return `![${alt || caption}](${src})${caption ? `\n\n*${caption}*` : ''}`
}

interface Parameter { name: string; location: string; type: string; required: boolean; description: string; node: ElNode }

const LOCATION_KEYS = ['path', 'query', 'header', 'body', 'cookie'] as const

function parameters(inner: string): Parameter[] {
  return extractNodes(inner)
    .filter((node): node is ElNode => node.type === 'el' && (node.name === 'Param' || node.name === 'ParamField'))
    .map((node) => {
      // Doxbrix writes `name` + `in`; Mintlify's ParamField writes `query="limit"`.
      const locationKey = LOCATION_KEYS.find((key) => typeof node.props[key] === 'string')
      return {
        name: text(node.props.name) || (locationKey ? text(node.props[locationKey]) : ''),
        location: text(node.props.in) || locationKey || '',
        type: text(node.props.type),
        required: node.props.required === true || node.props.required === 'true',
        description: '',
        node,
      }
    })
}

function parameterTable(params: Parameter[], depth: number): string {
  const rows = params.map((param) => {
    const description = flattenNodes(param.node.inner, depth) || text(param.node.props.description)
    return `| ${cell(param.name ? `\`${param.name}\`` : '')} | ${cell(param.location)} | ${cell(param.type)} | ${param.required ? 'yes' : 'no'} | ${cell(description)} |`
  })
  return ['| Name | In | Type | Required | Description |', '| --- | --- | --- | --- | --- |', ...rows].join('\n')
}

function fieldLine(props: Props, inner: string, depth: number): string {
  const locationKey = LOCATION_KEYS.find((key) => typeof props[key] === 'string')
  const name = text(props.name) || (locationKey ? text(props[locationKey]) : '')
  const facts = [text(props.type), text(props.in) || locationKey || '', props.required === true || props.required === 'true' ? 'required' : ''].filter(Boolean)
  const description = (flattenNodes(inner, depth) || text(props.description)).trim()
  const head = `- ${name ? `\`${name}\`` : '(unnamed)'}${facts.length ? ` (${facts.join(', ')})` : ''}`
  if (!description) return head
  return description.includes('\n') ? `${head}:\n\n${indent(description, '  ')}` : `${head}: ${description}`
}

function apiEndpoint(props: Props, inner: string, depth: number): string {
  const method = (text(props.method) || 'GET').toUpperCase()
  const path = text(props.path) || '/'
  const baseUrl = text(props.baseUrl).replace(/\/+$/, '')
  const summary = text(props.summary)
  const description = text(props.description)
  const params = parameters(inner)
  const responses = childElements(inner, 'Response')
  // Prose between the parameters (anything that is not a Param or Response) still belongs to the endpoint.
  const prose = extractNodes(inner)
    .filter((node) => node.type === 'md' || !['Param', 'ParamField', 'Response'].includes(node.name))
    .map((node) => (node.type === 'md' ? flattenText(node.text) : flattenElement(node, depth + 1)))
    .filter((part) => part.trim())
    .join('\n\n')
  return [
    `### ${method} ${path}`,
    summary ? `**${summary}**` : '',
    baseUrl ? `Base URL: \`${baseUrl}\`` : '',
    description,
    prose,
    params.length ? `**Parameters**\n\n${parameterTable(params, depth)}` : '',
    responses.length ? `**Responses**\n\n${responses.map((response) => responseBlock(response, depth)).join('\n\n')}` : '',
  ].filter(Boolean).join('\n\n')
}

function responseBlock(response: ElNode, depth: number): string {
  const status = text(response.props.status)
  const description = text(response.props.description)
  const body = trimBlankLines(response.inner)
  const example = FENCE.test(body) ? flattenNodes(body, depth) : body ? fenced(/^[[{]/.test(body) ? 'json' : '', body) : ''
  const head = [status ? `\`${status}\`` : '', description].filter(Boolean).join(' ')
  return [head ? `- ${head}` : '', example].filter(Boolean).join('\n\n')
}

function blockquote(content: string): string {
  return content.split('\n').map((line) => (line ? `> ${line}` : '>')).join('\n')
}

function fenced(lang: string, code: string): string {
  const longest = Math.max(2, ...[...code.matchAll(/`{3,}/g)].map((match) => match[0].length))
  const ticks = '`'.repeat(longest + 1)
  return `${ticks}${lang}\n${code}\n${ticks}`
}

function indent(content: string, prefix: string): string {
  return content.split('\n').map((line) => (line ? `${prefix}${line}` : line)).join('\n')
}

function cell(value: string): string {
  return value.replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|').trim()
}

function trimBlankLines(value: string): string {
  return value.replace(/^\s*\n/, '').replace(/\n\s*$/, '')
}

function tidy(markdown: string): string {
  const lines = markdown.split('\n')
  const output: string[] = []
  let inFence = false
  let blank = 0
  for (const line of lines) {
    if (FENCE.test(line)) inFence = !inFence
    if (!inFence && !line.trim()) {
      blank++
      if (blank > 1) continue
      output.push('')
      continue
    }
    blank = 0
    output.push(line)
  }
  return `${output.join('\n').trim()}\n`
}

function text(value: string | boolean | undefined): string {
  return typeof value === 'string' ? value.trim() : ''
}

function capitalize(value: string): string {
  return value ? value[0]!.toUpperCase() + value.slice(1) : value
}
