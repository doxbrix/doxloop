import { access, readFile } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve } from 'node:path'
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
  )
  const files = await loadPages(root, project)
  const pages = files.map((path) => pageId(contentRoot, path))
  const pageSet = new Set(pages)
  const adapter =
    project.generator === 'doxbrix'
      ? undefined
      : await loadGeneratorAdapter(root, project)
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
        pages: files,
        pageIds: pages,
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
    if ((adapter?.project.contentFormat ?? 'markdown') === 'markdown') {
      issues.push(...(await validateLinks(path, contentRoot, raw, root, adapter)))
    }
  }

  const errors = issues.filter((issue) => issue.severity === 'error').length
  const warnings = issues.length - errors
  return { issues, pages, errors, warnings }
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

async function validateDoxbrixTheme(
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

function validateDoxbrixComponents(
  content: string,
  file: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const withoutFences = content.replace(/```[\s\S]*?```/g, '')
  for (const name of DOXBRIX_CONTAINER_COMPONENTS) {
    const openings =
      withoutFences.match(new RegExp(`<${name}(?:\\s[^>]*)?(?<!/)>`, 'g'))?.length ?? 0
    const closings = withoutFences.match(new RegExp(`</${name}>`, 'g'))?.length ?? 0
    if (openings !== closings) {
      issues.push(
        error(
          'component-tag',
          `<${name}> tags are not balanced (${openings} opening, ${closings} closing).`,
          file,
        ),
      )
    }
  }
  issues.push(...validateDoxbrixApiEndpoints(withoutFences, file))
  return issues
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

function validateProfessionalContent(
  body: string,
  raw: string,
  file: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const prose = stripCodeFences(body)

  if (
    /(?:<!--|\{\/\*)\s*doxloop:starter-page\s*(?:-->|\*\/\})/i.test(prose) ||
    /\b(?:replace this starter|the authoring agent will replace this starter)\b/i.test(
      prose,
    )
  ) {
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
  const pattern = /!?\[[^\]]*]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g
  for (const match of content.matchAll(pattern)) {
    const href = match[1]
    if (
      href === undefined ||
      href.startsWith('#') ||
      /^[a-z][a-z0-9+.-]*:/i.test(href)
    ) {
      continue
    }
    let decoded: string
    try {
      decoded = decodeURIComponent(href.split('#')[0] ?? '')
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
        ? [base, `${base}.md`, `${base}.mdx`, join(base, 'index.md'), join(base, 'index.mdx')]
        : [base]
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
