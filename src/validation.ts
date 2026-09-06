import { documentationCollections, collectionForPath } from './documentation-collections.js'
import { contentLinks } from './content-links.js'
import { access, readFile } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { EVIDENCE_MAP_FILE, readEvidenceMap } from './evidence.js'
import { readSyncState } from './sync.js'
import { pathExists, resolveContainedDirectory } from './fs.js'
import type { GeneratorAdapter } from './generator-api.js'
import { loadGeneratorAdapter } from './generators.js'
import {
  loadPages,
  loadProject,
  loadSiteConfig,
  pageId,
  readPage,
  relativePath,
  siteConfigPath,
} from './project.js'
import type {
  DoxbrixNavNode,
  DoxloopProject,
  SourceBinding,
  ValidationIssue,
  ValidationResult,
} from './types.js'

export async function validateProject(root: string): Promise<ValidationResult> {
  const issues: ValidationIssue[] = []
  const project = await loadProject(root)
  const contentRoot = await resolveContainedDirectory(
    root,
    project.contentDir,
    'Validation content directory',
    { allowRoot: project.generator === 'doxbrix' },
  )
  const collections = await documentationCollections(root, project)
  const files = await loadPages(root, project)
  const pages = files.map((path) => pageId(contentRoot, path))
  const pageSet = new Set(pages)
  const adapter =
    project.generator === 'doxbrix'
      ? undefined
      : await loadGeneratorAdapter(root, project)
  const planTypes = await plannedPageTypes(root, project)
  if (project.generator === 'doxbrix') {
    const site = await loadSiteConfig(root, project)
    const configFile = relativePath(root, await siteConfigPath(root, project))
    validateDoxbrixNavigation(site.spaces, pageSet, pages, configFile, issues)
    await validateDoxbrixTheme(site.theme, contentRoot, configFile, issues)
  } else {
    issues.push(
      ...(await adapter!.validate({
        root,
        contentRoot,
        project,
        pages: files.filter((file) => file.startsWith(`${contentRoot}/`)),
        pageIds: files.filter((file) => file.startsWith(`${contentRoot}/`)).map((file) => pageId(contentRoot, file)),
      })),
    )
  }

  for (const path of files) {
    const file = relativePath(root, path)
    const raw = await readFile(path, 'utf8')
    const page = adapter?.readPage ? await adapter.readPage(path) : await readPage(path)
    if (page.title === '') {
      issues.push(error('missing-title', 'Page frontmatter needs a title.', file))
    }
    if (page.description === undefined || page.description === '') {
      issues.push(
        error(
          'missing-description',
          'Page frontmatter needs an outcome-focused description.',
          file,
        ),
      )
    }
    if (page.body.trim() === '') {
      issues.push(error('empty-page', 'Page content cannot be empty.', file))
    }
    if ((adapter?.project.contentFormat ?? 'markdown') === 'markdown') {
      const fences = raw.match(/^```/gm)?.length ?? 0
      if (fences % 2 !== 0) {
        issues.push(error('code-fence', 'Code fences are not balanced.', file))
      }
    }
    if (project.generator === 'doxbrix') {
      issues.push(...validateDoxbrixComponents(raw, file))
    }
    issues.push(...validateProfessionalContent(page.body, raw, file))
    const planned = planTypes.get(file.replace(/\.[^./]+$/, ''))
    issues.push(...validatePageDepth(page.body, file, planned?.type))
    if (planned?.diagram === 'required' && !hasDiagram(raw)) {
      issues.push(
        warning(
          'missing-diagram',
          'The approved plan requires a diagram on this page. Add a Mermaid block that shows the model or lifecycle it explains.',
          file,
        ),
      )
    }
    issues.push(...(await validateLinks(path, resolve(root, collectionForPath(collections, file)?.directory ?? project.contentDir), raw, root, adapter)))
  }

  issues.push(
    ...(await validateEvidenceMap(
      root,
      files.map((path) => relativePath(root, path)),
      project,
    )),
  )

  const errors = issues.filter((issue) => issue.severity === 'error').length
  const warnings = issues.length - errors
  return { issues, pages, errors, warnings }
}

/**
 * Coverage checks for `.doxloop/evidence-map.json`. These are warnings and run
 * only once a project has a map, so projects that predate it are unaffected
 * and a partially recorded map never blocks validation.
 */
async function validateEvidenceMap(
  root: string,
  pageFiles: string[],
  project: DoxloopProject,
): Promise<ValidationIssue[]> {
  const map = await readEvidenceMap(root)
  if (!map) return []
  const issues: ValidationIssue[] = []
  const pages = new Set(pageFiles)
  const sourceNames = new Set(project.sources.map((source) => source.name))
  const pathCoverage = new Map<string, Set<string>>()
  const syncState = project.sync.maxVerificationAgeDays ? await readSyncState(root) : undefined

  for (const [page, evidence] of Object.entries(map.pages)) {
    if (!pages.has(page)) {
      issues.push(
        warning(
          'evidence-map-orphan',
          `The evidence map records "${page}", which is not a documentation page. Remove the entry when a page is deleted or renamed.`,
          EVIDENCE_MAP_FILE,
        ),
      )
      continue
    }
    for (const entry of evidence.sources) {
      if (!sourceNames.has(entry.source)) {
        issues.push(
          warning(
            'evidence-map-unknown-source',
            `The evidence map binds "${page}" to source "${entry.source}", which is not configured.`,
            EVIDENCE_MAP_FILE,
          ),
        )
      }
      for (const path of entry.paths ?? []) {
        const key = `${entry.source}:${path}`
        const covered = pathCoverage.get(key) ?? new Set<string>()
        covered.add(page)
        pathCoverage.set(key, covered)
      }
      if (project.sync.maxVerificationAgeDays) {
        const record = syncState?.sources[entry.source]
        const revision = evidence.verifiedAt?.[entry.source]
        const verifiedOn = evidence.verifiedOn?.[entry.source] ?? (record && revision && [record.commit, record.contentFingerprint].includes(revision) ? record.recordedAt : undefined)
        const ageDays = verifiedOn ? Math.floor((Date.now() - Date.parse(verifiedOn)) / 86_400_000) : Number.POSITIVE_INFINITY
        if (ageDays > project.sync.maxVerificationAgeDays) {
          const severity = project.sync.maxVerificationAgeSeverity === 'fail' ? 'error' : 'warning'
          issues.push({
            severity,
            code: 'evidence-verification-expired',
            message: `Verification for source "${entry.source}" is ${Number.isFinite(ageDays) ? `${ageDays} days old` : 'not dated'}; the maximum is ${project.sync.maxVerificationAgeDays} days. Re-verify the page even when the source revision is unchanged.`,
            file: page,
          })
        }
      }
    }
    if (evidence.confidence === 'needs-human') {
      issues.push(
        warning(
          'evidence-unverified',
          'A claim on this page could not be verified from configured evidence and needs human confirmation.',
          page,
        ),
      )
    }
  }

  if (pageFiles.length >= 4) {
    for (const [key, covered] of pathCoverage) {
      if (covered.size <= pageFiles.length / 2) continue
      const separator = key.indexOf(':')
      const source = key.slice(0, separator)
      const path = key.slice(separator + 1)
      issues.push(
        warning(
          'evidence-map-broad-path',
          `Source path "${path}" from "${source}" is attached to ${covered.size} of ${pageFiles.length} pages. Verify that each page directly depends on it; broad evidence makes localized changes mark most documentation stale.`,
          EVIDENCE_MAP_FILE,
        ),
      )
    }
  }

  for (const page of pageFiles) {
    if (!map.pages[page]) {
      issues.push(
        warning(
          'evidence-map-missing-page',
          'This page has no evidence-map entry, so `doxloop check` cannot report when its sources change.',
          page,
        ),
      )
    }
  }
  return issues
}

export interface DoxbrixNavigationEntry {
  path: string
  section?: string
}

/** Flatten Doxbrix navigation in reader order for validation and page discovery. */
export function readDoxbrixNavigation(
  spaces: Array<{ name: string; nav: DoxbrixNavNode[] }>,
): DoxbrixNavigationEntry[] {
  const entries: DoxbrixNavigationEntry[] = []
  const visit = (nodes: DoxbrixNavNode[], section?: string): void => {
    for (const node of nodes) {
      if (node.type === 'page' && typeof node.file === 'string' && node.file.trim()) {
        entries.push({ path: node.file, ...(section ? { section } : {}) })
      } else if (node.type === 'group' && Array.isArray(node.items)) {
        visit(node.items, node.label || section)
      }
    }
  }
  for (const space of spaces) visit(space.nav, space.name)
  return entries
}

function validateDoxbrixNavigation(
  spaces: Array<{ name: string; nav: DoxbrixNavNode[] }>,
  pageSet: Set<string>,
  pages: string[],
  configFile: string,
  issues: ValidationIssue[],
): void {
  const navigation = new Set<string>()
  if (spaces.length === 0) {
    issues.push(error('navigation-spaces', 'Doxbrix docs.json needs at least one space.', configFile))
  }

  const visit = (nodes: DoxbrixNavNode[], location: string): void => {
    for (const [index, node] of nodes.entries()) {
      const nodeLocation = `${location} item ${index + 1}`
      if (!node || typeof node !== 'object' || typeof node.type !== 'string') {
        issues.push(error('navigation-node', `${nodeLocation} is invalid.`, configFile))
        continue
      }
      if (node.type === 'page') {
        if (typeof node.file !== 'string' || node.file.trim() === '') {
          issues.push(error('navigation-page', `${nodeLocation} needs a page file.`, configFile))
          continue
        }
        if (navigation.has(node.file)) {
          issues.push(
            error('duplicate-navigation', `"${node.file}" appears more than once.`, configFile),
          )
        }
        navigation.add(node.file)
        if (!pageSet.has(node.file)) {
          issues.push(
            error(
              'missing-page',
              `Navigation references missing page "${node.file}".`,
              configFile,
            ),
          )
        }
      } else if (node.type === 'group') {
        if (typeof node.label !== 'string' || !Array.isArray(node.items)) {
          issues.push(
            error('navigation-group', `${nodeLocation} needs a label and items array.`, configFile),
          )
          continue
        }
        visit(node.items, `group "${node.label}"`)
      } else if (
        !['label', 'divider', 'link', 'api'].includes(node.type)
      ) {
        issues.push(
          error('navigation-node', `${nodeLocation} has unsupported type "${node.type}".`, configFile),
        )
      }
    }
  }

  for (const [index, space] of spaces.entries()) {
    if (typeof space.name !== 'string' || !Array.isArray(space.nav)) {
      issues.push(
        error(
          'navigation-space',
          `Space ${index + 1} must have a name and nav array.`,
          configFile,
        ),
      )
      continue
    }
    visit(space.nav, `space "${space.name}"`)
  }

  for (const id of pages) {
    if (!navigation.has(id)) {
      issues.push(error('unnavigated-page', `Page "${id}" is not in Doxbrix navigation.`))
    }
  }
}

/** Theme checks shared by validation and the branding panel's pre-write check. */
export async function validateDoxbrixTheme(
  value: unknown,
  contentRoot: string,
  configFile: string,
  issues: ValidationIssue[],
): Promise<void> {
  if (value === undefined) return
  if (value === 'light' || value === 'dark' || value === 'system') return
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    issues.push(error('theme-config', 'Doxbrix theme must be an object.', configFile))
    return
  }
  const theme = value as Record<string, unknown>
  const colorKeys = [
    'primaryColor',
    'lightColor',
    'darkColor',
    'backgroundColorLight',
    'backgroundColorDark',
  ]
  for (const key of colorKeys) {
    const color = theme[key]
    if (color !== undefined && (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color))) {
      issues.push(
        error('theme-color', `Doxbrix theme.${key} must be a six-digit hex color.`, configFile),
      )
    }
  }

  if (
    theme.mode !== undefined &&
    !['light', 'dark', 'system'].includes(String(theme.mode))
  ) {
    issues.push(
      error('theme-mode', 'Doxbrix theme.mode must be light, dark, or system.', configFile),
    )
  }
  for (const key of ['font', 'headingFont', 'codeFont']) {
    const font = theme[key]
    if (font !== undefined && (typeof font !== 'string' || font.trim() === '')) {
      issues.push(
        error('theme-font', `Doxbrix theme.${key} must be a font-family name.`, configFile),
      )
    }
  }
  if (
    theme.logoHref !== undefined &&
    (typeof theme.logoHref !== 'string' || !isThemeAssetReference(theme.logoHref))
  ) {
    issues.push(
      error(
        'theme-link',
        'Doxbrix theme.logoHref must be an HTTPS or root-relative URL.',
        configFile,
      ),
    )
  }

  for (const key of [
    'logoLight',
    'logoDark',
    'favicon',
    'faviconLight',
    'faviconDark',
    'backgroundImage',
  ]) {
    const asset = theme[key]
    if (asset === undefined) continue
    if (typeof asset !== 'string' || !isThemeAssetReference(asset)) {
      issues.push(
        error(
          'theme-asset',
          `Doxbrix theme.${key} must be an HTTPS or root-relative asset path.`,
          configFile,
        ),
      )
      continue
    }
    if (asset.startsWith('/') && !(await localThemeAssetExists(contentRoot, asset))) {
      issues.push(
        error('missing-theme-asset', `Doxbrix theme.${key} is missing "${asset}".`, configFile),
      )
    }
  }

  if (theme.fontSources !== undefined && !Array.isArray(theme.fontSources)) {
    issues.push(
      error('theme-font-source', 'Doxbrix theme.fontSources must be an array.', configFile),
    )
    return
  }
  for (const [index, entry] of (theme.fontSources ?? []).entries()) {
    if (!entry || typeof entry !== 'object') {
      issues.push(
        error('theme-font-source', `Doxbrix font source ${index + 1} is invalid.`, configFile),
      )
      continue
    }
    const source = entry as Record<string, unknown>
    if (
      typeof source.family !== 'string' ||
      source.family.trim() === '' ||
      typeof source.source !== 'string' ||
      !isThemeAssetReference(source.source)
    ) {
      issues.push(
        error(
          'theme-font-source',
          `Doxbrix font source ${index + 1} needs a family and HTTPS or root-relative source.`,
          configFile,
        ),
      )
      continue
    }
    if (
      source.source.startsWith('/') &&
      !(await localThemeAssetExists(contentRoot, source.source))
    ) {
      issues.push(
        error(
          'missing-theme-asset',
          `Doxbrix font source ${index + 1} is missing "${source.source}".`,
          configFile,
        ),
      )
    }
  }
}

function isThemeAssetReference(value: string): boolean {
  return value.startsWith('/') || /^https:\/\//i.test(value)
}

async function localThemeAssetExists(
  contentRoot: string,
  reference: string,
): Promise<boolean> {
  const path = resolve(contentRoot, `.${reference}`)
  if (relative(contentRoot, path).startsWith('..')) return false
  return pathExists(path)
}

const DOXBRIX_CONTAINER_COMPONENTS = [
  'Info',
  'Note',
  'Tip',
  'Check',
  'Warning',
  'Danger',
  'Steps',
  'Step',
  'Tabs',
  'Tab',
  'Accordion',
  'AccordionGroup',
  'AccordionItem',
  'Expandable',
  'CardGroup',
  'Card',
  'Columns',
  'Column',
  'CodeGroup',
  'Terminal',
  'Frame',
  'Update',
  'Mermaid',
  'Math',
  'ApiEndpoint',
  'Param',
  'Response',
  'ParameterTable',
  'ResponseExample',
] as const

type DoxbrixContainerName = (typeof DOXBRIX_CONTAINER_COMPONENTS)[number]

interface DoxbrixComponentTag {
  name: DoxbrixContainerName
  kind: 'open' | 'close' | 'self-close'
  line: number
  endLine: number
}

function validateDoxbrixComponents(
  content: string,
  file: string,
): ValidationIssue[] {
  const masked = maskDoxbrixCode(content)
  const scanned = scanDoxbrixComponentTags(masked, file)
  const issues = [...scanned.issues]
  const stack: DoxbrixComponentTag[] = []

  for (const tag of scanned.tags) {
    if (tag.kind === 'self-close') continue
    if (tag.kind === 'open') {
      stack.push(tag)
      continue
    }
    const opening = stack.at(-1)
    if (!opening) {
      issues.push(
        error(
          'component-tag',
          `Line ${tag.line}: unexpected closing </${tag.name}> tag.`,
          file,
        ),
      )
      continue
    }
    if (opening.name !== tag.name) {
      issues.push(
        error(
          'component-tag',
          `Line ${tag.line}: </${tag.name}> closes before <${opening.name}> opened on line ${opening.line}.`,
          file,
        ),
      )
      continue
    }
    stack.pop()
  }
  for (const opening of stack) {
    issues.push(
      error(
        'component-tag',
        `Line ${opening.line}: <${opening.name}> does not have a matching closing tag.`,
        file,
      ),
    )
  }

  if (issues.length === 0) {
    issues.push(...validateDoxbrixApiEndpoints(masked, file))
  }
  return issues
}

function scanDoxbrixComponentTags(
  content: string,
  file: string,
): { tags: DoxbrixComponentTag[]; issues: ValidationIssue[] } {
  const names = new Set<string>(DOXBRIX_CONTAINER_COMPONENTS)
  const tags: DoxbrixComponentTag[] = []
  const issues: ValidationIssue[] = []
  let index = 0
  let line = 1

  while (index < content.length) {
    if (content[index] === '\n') {
      line += 1
      index += 1
      continue
    }
    if (content[index] !== '<') {
      index += 1
      continue
    }

    const start = index
    const startLine = line
    const closing = content[index + 1] === '/'
    const nameStart = index + (closing ? 2 : 1)
    let nameEnd = nameStart
    while (/[A-Za-z0-9]/.test(content[nameEnd] ?? '')) nameEnd += 1
    const name = content.slice(nameStart, nameEnd)
    if (!names.has(name)) {
      index += 1
      continue
    }

    let quote: '"' | "'" | null = null
    let braces = 0
    let cursor = nameEnd
    let endLine = line
    let malformed = false
    for (; cursor < content.length; cursor += 1) {
      const character = content[cursor]!
      if (character === '\n') endLine += 1
      if (quote) {
        if (character === quote && content[cursor - 1] !== '\\') quote = null
        continue
      }
      if (character === '"' || character === "'") {
        quote = character
      } else if (character === '{') {
        braces += 1
      } else if (character === '}') {
        braces = Math.max(0, braces - 1)
      } else if (braces === 0 && character === '<') {
        issues.push(
          error(
            'component-tag',
            `Line ${startLine}: <${name}> opening tag is missing ">" before the component beginning on line ${endLine}.`,
            file,
          ),
        )
        malformed = true
        break
      } else if (braces === 0 && character === '>') {
        break
      }
    }

    if (malformed) {
      index = cursor
      line = endLine
      continue
    }
    if (cursor >= content.length) {
      issues.push(
        error(
          'component-tag',
          `Line ${startLine}: <${name}> opening tag is missing ">".`,
          file,
        ),
      )
      break
    }
    if (endLine !== startLine) {
      issues.push(
        error(
          'component-tag',
          `Line ${startLine}: <${name}> opening tag must end with ">" on the same line for Doxbrix ingestion.`,
          file,
        ),
      )
    }

    const beforeClose = content.slice(start, cursor).trimEnd()
    tags.push({
      name: name as DoxbrixContainerName,
      kind: closing ? 'close' : beforeClose.endsWith('/') ? 'self-close' : 'open',
      line: startLine,
      endLine,
    })
    index = cursor + 1
    line = endLine
  }

  return { tags, issues }
}

function maskDoxbrixCode(content: string): string {
  const lines = content.split('\n')
  let fence: { marker: '`' | '~'; length: number } | undefined
  const masked = lines.map((line) => {
    const match = /^\s*(`{3,}|~{3,})/.exec(line)
    if (match) {
      const marker = match[1]![0] as '`' | '~'
      const length = match[1]!.length
      if (!fence) fence = { marker, length }
      else if (fence.marker === marker && length >= fence.length) fence = undefined
      return ' '.repeat(line.length)
    }
    if (fence) return ' '.repeat(line.length)

    const characters = [...line]
    let index = 0
    while (index < characters.length) {
      if (characters[index] !== '`') {
        index += 1
        continue
      }
      let ticks = 1
      while (characters[index + ticks] === '`') ticks += 1
      const closing = '`'.repeat(ticks)
      const end = line.indexOf(closing, index + ticks)
      if (end === -1) {
        index += ticks
        continue
      }
      for (let cursor = index; cursor < end + ticks; cursor += 1) {
        characters[cursor] = ' '
      }
      index = end + ticks
    }
    return characters.join('')
  })
  return masked.join('\n')
}

function validateDoxbrixApiEndpoints(
  content: string,
  file: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  for (const [index, match] of [
    ...content.matchAll(/<ApiEndpoint\b([^>]*)>([\s\S]*?)<\/ApiEndpoint>/g),
  ].entries()) {
    const label = `API endpoint ${index + 1}`
    const attributes = componentAttributes(match[1] ?? '')
    const body = match[2] ?? ''
    const method = stringAttribute(attributes.method).toUpperCase()
    const path = stringAttribute(attributes.path)
    const baseUrl = stringAttribute(attributes.baseUrl)

    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      issues.push(
        error(
          'api-endpoint-method',
          `${label} needs method GET, POST, PUT, PATCH, or DELETE.`,
          file,
        ),
      )
    }
    if (!path.startsWith('/')) {
      issues.push(
        error(
          'api-endpoint-path',
          `${label} needs an absolute API path beginning with "/".`,
          file,
        ),
      )
    }
    if (!/^https?:\/\/[^/\s]+/i.test(baseUrl)) {
      issues.push(
        error(
          'api-endpoint-base-url',
          `${label} needs an absolute HTTP or HTTPS baseUrl so Doxbrix can generate the request example.`,
          file,
        ),
      )
    }
    if (
      stringAttribute(attributes.summary) === '' ||
      stringAttribute(attributes.description) === ''
    ) {
      issues.push(
        warning(
          'api-endpoint-description',
          `${label} should include both summary and description attributes.`,
          file,
        ),
      )
    }

    const pathParameters = new Set<string>()
    const paramPattern = /<Param\b([^>]*)>([\s\S]*?)<\/Param>/g
    for (const [paramIndex, paramMatch] of [
      ...body.matchAll(paramPattern),
    ].entries()) {
      const param = componentAttributes(paramMatch[1] ?? '')
      const name = stringAttribute(param.name)
      const location = stringAttribute(param.in)
      const type = stringAttribute(param.type)
      if (name === '' || type === '' || !['path', 'query', 'header', 'body'].includes(location)) {
        issues.push(
          error(
            'api-endpoint-param',
            `${label} parameter ${paramIndex + 1} needs name, type, and in="path|query|header|body".`,
            file,
          ),
        )
      }
      if (location === 'path') {
        pathParameters.add(name)
        if (!trueAttribute(param.required)) {
          issues.push(
            error(
              'api-endpoint-path-param',
              `${label} path parameter "${name}" must set required.`,
              file,
            ),
          )
        }
      }
      if (stringAttribute(param.example) === '') {
        issues.push(
          warning(
            'api-endpoint-param-example',
            `${label} parameter "${name || paramIndex + 1}" should include a verified example for the generated request.`,
            file,
          ),
        )
      }
    }

    for (const placeholder of path.matchAll(/\{([^}]+)}/g)) {
      const name = placeholder[1] ?? ''
      if (!pathParameters.has(name)) {
        issues.push(
          error(
            'api-endpoint-path-param',
            `${label} path placeholder "{${name}}" needs a matching required <Param in="path">.`,
            file,
          ),
        )
      }
    }

    const responses = [...body.matchAll(/<Response\b([^>]*)>([\s\S]*?)<\/Response>/g)]
    if (responses.length === 0) {
      issues.push(
        error(
          'api-endpoint-response',
          `${label} needs at least one <Response> with a verified example body.`,
          file,
        ),
      )
    }
    for (const [responseIndex, responseMatch] of responses.entries()) {
      const response = componentAttributes(responseMatch[1] ?? '')
      const status = stringAttribute(response.status)
      if (!/^\d{3}$/.test(status)) {
        issues.push(
          error(
            'api-endpoint-response',
            `${label} response ${responseIndex + 1} needs a numeric status such as status={200}.`,
            file,
          ),
        )
      }
      if (
        stringAttribute(response.contentType) === '' ||
        stringAttribute(response.description) === ''
      ) {
        issues.push(
          warning(
            'api-endpoint-response-metadata',
            `${label} response ${status || responseIndex + 1} should include contentType and description.`,
            file,
          ),
        )
      }
      if ((responseMatch[2] ?? '').trim() === '') {
        issues.push(
          error(
            'api-endpoint-response',
            `${label} response ${status || responseIndex + 1} needs an example body.`,
            file,
          ),
        )
      }
    }
  }
  return issues
}

function componentAttributes(
  source: string,
): Record<string, string | true> {
  const attributes: Record<string, string | true> = {}
  const pattern =
    /([A-Za-z_][\w-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|\{([^}]*)\}))?/g
  for (const match of source.matchAll(pattern)) {
    const name = match[1]
    if (name === undefined) continue
    attributes[name] =
      match[2] ?? match[3] ?? match[4]?.trim().replace(/^['"]|['"]$/g, '') ?? true
  }
  return attributes
}

function stringAttribute(value: string | true | undefined): string {
  return typeof value === 'string' ? value.trim() : ''
}

function trueAttribute(value: string | true | undefined): boolean {
  return value === true || value === 'true'
}

/**
 * Page types from the plan staged in the workspace, keyed by extension-less
 * page path. Direct authoring without a plan infers the type from the page.
 */
async function plannedPageTypes(
  root: string,
  project: DoxloopProject,
): Promise<Map<string, { type: string; diagram?: string }>> {
  const types = new Map<string, { type: string; diagram?: string }>()
  try {
    const plan = JSON.parse(await readFile(join(root, '.doxloop', 'documentation-plan.json'), 'utf8')) as {
      pages?: Array<{ path?: unknown; type?: unknown; diagram?: unknown }>
    }
    for (const page of plan.pages ?? []) {
      if (typeof page.path !== 'string' || typeof page.type !== 'string') continue
      const key = join(project.contentDir, page.path).replaceAll('\\', '/').replace(/^\.\//, '')
      types.set(key, { type: page.type, ...(typeof page.diagram === 'string' ? { diagram: page.diagram } : {}) })
    }
  } catch {
    // No staged plan: infer page types from content instead.
  }
  return types
}

/** A Mermaid diagram in any of the syntaxes the supported generators render. */
export function hasDiagram(raw: string): boolean {
  return /<Mermaid[\s>]|```mermaid\b|\.\. mermaid::|\{%\s*mermaid|<pre class="mermaid"|\{\{<\s*mermaid/i.test(raw)
}

const PROCEDURAL_TYPES = new Set(['how-to', 'tutorial', 'getting-started'])
/** Minimum prose words before a page reads as a stub rather than documentation. */
const MINIMUM_WORDS: Record<string, number> = { reference: 120, concept: 250, procedure: 250, other: 150 }
const MINIMUM_STEPS = 3

/**
 * Depth gate. A page with a title, a sentence, and one screenshot passes every
 * structural check yet reads as a placeholder; the agent's own quality pass
 * cannot notice that from inside the page, so Doxloop measures it. Warnings,
 * never errors: a genuinely small surface may legitimately produce a short
 * page, and the authoring contract tells the agent to resolve each one.
 */
export function validatePageDepth(body: string, file: string, planType?: string): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const withoutCode = stripCodeFences(body)
  const prose = withoutCode
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^\s*\|?\s*-{3,}.*$/gm, ' ')
  const words = prose.split(/\s+/).filter((token) => /[A-Za-z0-9]/.test(token)).length
  const stepCount = (withoutCode.match(/<Step\b/g) ?? []).length
  const orderedItems = (withoutCode.match(/^\s*\d+\.\s+\S/gm) ?? []).length
  const type = planType ?? inferPageType(file, withoutCode, stepCount, orderedItems)
  const procedural = PROCEDURAL_TYPES.has(type) || stepCount > 0
  const minimum = type === 'reference' ? MINIMUM_WORDS.reference! : procedural ? MINIMUM_WORDS.procedure! : type === 'concept' ? MINIMUM_WORDS.concept! : MINIMUM_WORDS.other!
  if (words < minimum) {
    issues.push(
      warning(
        'thin-page',
        `The page has about ${words} words of prose; a ${procedural ? 'procedural' : type} page normally needs at least ${minimum} to be complete. Add the reader outcome, prerequisites, every step with its observable result, verification, evidence-backed troubleshooting, and a next step — or merge this page into one that can be complete.`,
        file,
      ),
    )
  }
  if (procedural && Math.max(stepCount, orderedItems) < MINIMUM_STEPS && words < 600) {
    issues.push(
      warning(
        'thin-procedure',
        `The procedure has ${Math.max(stepCount, orderedItems)} step${Math.max(stepCount, orderedItems) === 1 ? '' : 's'}; a guide normally needs at least ${MINIMUM_STEPS} ordered steps that each name the reader action, the exact control or value, and the visible result. Split combined actions into their own steps and finish the workflow through verification.`,
        file,
      ),
    )
  }
  return issues
}

function inferPageType(file: string, body: string, stepCount: number, orderedItems: number): string {
  const normalized = file.toLowerCase()
  if (/(^|\/)(?:reference|api|cli|commands?|configuration)(\/|\.)/.test(normalized)) return 'reference'
  if (/(^|\/)(?:concepts?|explanations?|architecture)(\/|\.)/.test(normalized)) return 'concept'
  if (/(^|\/)(?:guides?|how-?to|tutorials?|getting-started|quickstart)(\/|\.)/.test(normalized)) return 'how-to'
  if (stepCount > 0 || orderedItems >= 2) return 'how-to'
  if (/^index\.[a-z]+$/.test(normalized) || /(^|\/)index\.[a-z]+$/.test(normalized)) return 'other'
  return body.includes('<Steps') ? 'how-to' : 'other'
}

/** Generated scaffolding the authoring agent is told to replace: a starter marker or its placeholder language. */
export function isStarterContent(content: string): boolean {
  const prose = stripCodeFences(content)
  return (
    /(?:<!--|\{\/\*)\s*doxloop:starter-page\s*(?:-->|\*\/\})/i.test(prose) ||
    /^\.\.\s+doxloop:starter-page\s*$/im.test(prose) ||
    /\b(?:replace this starter|the authoring agent will replace this starter)\b/i.test(prose)
  )
}

function validateProfessionalContent(
  body: string,
  raw: string,
  file: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const prose = stripCodeFences(body)

  if (isStarterContent(prose)) {
    issues.push(
      error(
        'starter-content',
        'Replace generated starter content before validation or publishing.',
        file,
      ),
    )
  }

  if (/^\s*(?:TODO|TBD|FIXME)(?:\s*:|\b)/im.test(prose)) {
    issues.push(
      error(
        'unresolved-placeholder',
        'Resolve TODO, TBD, or FIXME placeholder content.',
        file,
      ),
    )
  }

  const secretPatterns: Array<{ pattern: RegExp; label: string }> = [
    {
      pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
      label: 'private key',
    },
    { pattern: /\bAKIA[0-9A-Z]{16}\b/, label: 'AWS access key' },
    {
      pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
      label: 'GitHub token',
    },
  ]
  for (const secret of secretPatterns) {
    if (secret.pattern.test(raw)) {
      issues.push(
        error(
          'sensitive-content',
          `Remove the apparent ${secret.label} from reader-facing content.`,
          file,
        ),
      )
    }
  }

  if (
    /\/(?:Users|home)\/[A-Za-z0-9._-]+\//.test(prose) ||
    /[A-Za-z]:\\Users\\[^\\\s]+\\/i.test(prose)
  ) {
    issues.push(
      error(
        'private-path',
        'Replace the local user path with a portable placeholder or project-relative path.',
        file,
      ),
    )
  }

  for (const match of prose.matchAll(/<img\b[^>]*>/gi)) {
    if (!/\balt\s*=/i.test(match[0])) {
      issues.push(
        error('missing-image-alt', 'HTML images need an alt attribute.', file),
      )
    }
  }
  if (/!\[\s*]\([^)]+\)/.test(prose)) {
    issues.push(
      warning(
        'empty-image-alt',
        'Confirm that every image with empty alternative text is decorative.',
        file,
      ),
    )
  }

  for (const match of prose.matchAll(/(?<!!)\[([^\]]+)]\([^)]+\)/g)) {
    const label = match[1]?.trim().toLowerCase()
    if (
      label !== undefined &&
      ['click here', 'here', 'read more', 'learn more', 'this link'].includes(
        label,
      )
    ) {
      issues.push(
        warning(
          'weak-link-text',
          `Replace vague link text "${match[1]}" with a descriptive destination or action.`,
          file,
        ),
      )
    }
  }

  let previousHeading = 0
  for (const match of prose.matchAll(/^(#{1,6})\s+\S.*$/gm)) {
    const level = match[1]?.length ?? 0
    if (previousHeading > 0 && level > previousHeading + 1) {
      issues.push(
        warning(
          'heading-order',
          `Heading level jumps from h${previousHeading} to h${level}.`,
          file,
        ),
      )
    }
    previousHeading = level
  }

  let insideFence = false
  for (const line of body.split(/\r?\n/)) {
    const fence = line.match(/^```(.*)$/)
    if (!fence) continue
    if (!insideFence && fence[1]?.trim() === '') {
      issues.push(
        warning(
          'code-language',
          'Add a language identifier to the fenced code block when known.',
          file,
        ),
      )
    }
    insideFence = !insideFence
  }

  return issues
}

function stripCodeFences(content: string): string {
  return content.replace(/```[\s\S]*?```/g, '')
}

async function validateLinks(
  pagePath: string,
  contentRoot: string,
  content: string,
  projectRoot: string,
  adapter?: GeneratorAdapter,
): Promise<ValidationIssue[]> {
  const issues: ValidationIssue[] = []
  for (const href of contentLinks(content)) {
    if (
      href === undefined ||
      href.startsWith('#') || href.startsWith('//') ||
      /^[a-z][a-z0-9+.-]*:/i.test(href)
    ) {
      continue
    }
    let decoded: string
    try {
      decoded = decodeURIComponent(href.split(/[?#]/)[0] ?? '')
    } catch {
      issues.push(
        error(
          'invalid-link',
          `Local link is not valid URL syntax: ${href}`,
          relativePath(projectRoot, pagePath),
        ),
      )
      continue
    }
    if (decoded === '') continue
    const base = decoded.startsWith('/')
      ? resolve(contentRoot, `.${decoded}`)
      : resolve(dirname(pagePath), decoded)
    const candidates =
      extname(base) === ''
        ? [base, ...['md', 'mdx', 'rst', 'html', 'htm'].flatMap((extension) => [`${base}.${extension}`, join(base, `index.${extension}`)])]
        : /\.html?$/.test(base) ? [base, base.replace(/\.html?$/, '.rst'), base.replace(/\.html?$/, '.md'), base.replace(/\.html?$/, '.mdx')] : [base]
    const generatorAsset = adapter?.resolveLocalAsset?.({
      root: projectRoot,
      contentRoot,
      pagePath,
      reference: decoded,
    })
    if (generatorAsset) candidates.push(generatorAsset)
    let found = false
    for (const candidate of candidates) {
      const relation = relative(contentRoot, candidate)
      const projectRelation = relative(projectRoot, candidate)
      if (
        relation.startsWith('..') &&
        (candidate !== generatorAsset || projectRelation.startsWith('..'))
      ) {
        continue
      }
      try {
        await access(candidate)
        found = true
        break
      } catch {
        // Try the next supported form.
      }
    }
    if (!found) {
      issues.push(
        error(
          'broken-link',
          `Local link target does not exist: ${decoded}`,
          relativePath(projectRoot, pagePath),
        ),
      )
    }
  }
  return issues
}

export function formatValidation(result: ValidationResult): string {
  const lines = result.issues.map((issue) => {
    const location = issue.file ? `${issue.file}: ` : ''
    return `${issue.severity === 'error' ? 'error' : 'warning'} ${issue.code} ${location}${issue.message}`
  })
  lines.push(
    `${result.pages.length} page${result.pages.length === 1 ? '' : 's'}, ${result.errors} error${result.errors === 1 ? '' : 's'}, ${result.warnings} warning${result.warnings === 1 ? '' : 's'}`,
  )
  return lines.join('\n')
}

function error(code: string, message: string, file?: string): ValidationIssue {
  return file === undefined
    ? { severity: 'error', code, message }
    : { severity: 'error', code, message, file }
}

function warning(code: string, message: string, file?: string): ValidationIssue {
  return file === undefined
    ? { severity: 'warning', code, message }
    : { severity: 'warning', code, message, file }
}
