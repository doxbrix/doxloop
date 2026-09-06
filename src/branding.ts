import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { listAssets, type AssetEntry } from './assets.js'
import { applyDirectEdit } from './direct-edit.js'
import { DoxloopError } from './errors.js'
import { resolveContainedDirectory } from './fs.js'
import { loadGeneratorAdapter } from './generators.js'
import { loadProject, loadSiteConfig, relativePath, siteConfigPath } from './project.js'
import type { DoxloopProject, ValidationIssue } from './types.js'
import { validateDoxbrixTheme } from './validation.js'

/**
 * The branding panel edits the Doxbrix theme block of `docs.json`: logos,
 * favicon, accent colours for light and dark, page backgrounds, colour mode,
 * and fonts. The preview reads `docs.json` on every request, so a saved
 * change shows up on the next reload without a build. External generators
 * keep their own theme configuration; the panel names the file instead.
 */
export const THEME_COLOR_FIELDS = ['primaryColor', 'lightColor', 'darkColor', 'backgroundColorLight', 'backgroundColorDark'] as const
export const THEME_FONT_FIELDS = ['font', 'headingFont', 'codeFont'] as const
export const THEME_ASSET_FIELDS = ['logoLight', 'logoDark', 'favicon', 'faviconLight', 'faviconDark', 'backgroundImage'] as const
export const THEME_MODES = ['light', 'dark', 'system'] as const
export const THEME_CODE_THEMES = ['auto', 'light', 'dark'] as const

export type ThemeField =
  | typeof THEME_COLOR_FIELDS[number]
  | typeof THEME_FONT_FIELDS[number]
  | typeof THEME_ASSET_FIELDS[number]
  | 'mode'
  | 'codeTheme'
  | 'logoHref'

const THEME_FIELDS: readonly ThemeField[] = [...THEME_COLOR_FIELDS, ...THEME_FONT_FIELDS, ...THEME_ASSET_FIELDS, 'mode', 'codeTheme', 'logoHref']

/** Where each external generator keeps the settings a branding panel would edit. */
const THEME_CONFIG_FILES: Record<string, string> = {
  docusaurus: 'docusaurus.config.js',
  mkdocs: 'mkdocs.yml',
  sphinx: 'conf.py',
  hugo: 'hugo.toml',
  vitepress: '.vitepress/config.mts',
  markdoc: 'markdoc.config.mjs',
  nextra: 'theme.config.tsx',
  starlight: 'astro.config.mjs',
  jekyll: '_config.yml',
  static: 'assets/styles.css',
}

export interface Branding {
  generator: string
  editable: boolean
  reason?: string
  /** Project-relative theme configuration file. */
  configFile: string
  fingerprint: string
  site: { name: string; description: string }
  theme: Partial<Record<ThemeField, string>>
  /** Image assets in the project the logo and favicon pickers can choose from. */
  assets: Array<Pick<AssetEntry, 'path' | 'name' | 'publicPath'>>
}

export async function readBranding(root: string): Promise<Branding> {
  const project = await loadProject(root)
  if (project.generator !== 'doxbrix') {
    const adapter = await loadGeneratorAdapter(root, project)
    const configFile = adapter.theme?.configFile ?? THEME_CONFIG_FILES[project.generator] ?? adapter.planning?.navigationFiles[0] ?? ''
    return {
      generator: project.generator,
      editable: false,
      reason: `${adapter.displayName} keeps its logo, colours, and fonts in ${configFile || 'its own configuration'}. Edit that file directly, or ask the agent to apply the branding.`,
      configFile,
      fingerprint: '',
      site: { name: project.title, description: '' },
      theme: {},
      assets: [],
    }
  }
  const configPath = await siteConfigPath(root, project)
  const raw = await readFile(configPath, 'utf8')
  const site = await loadSiteConfig(root, project)
  const theme = themeObject(site.theme)
  const values: Partial<Record<ThemeField, string>> = {}
  for (const field of THEME_FIELDS) {
    const value = theme[field]
    if (typeof value === 'string' && value.trim()) values[field] = value.trim()
  }
  const assets = (await listAssets(root)).filter((asset) => asset.kind === 'image').map((asset) => ({
    path: asset.path,
    name: asset.name,
    publicPath: asset.publicPath,
  }))
  return {
    generator: 'doxbrix',
    editable: true,
    configFile: relativePath(root, configPath),
    fingerprint: fingerprint(raw),
    site: { name: site.name ?? project.title, description: site.description ?? '' },
    theme: values,
    assets,
  }
}

export interface BrandingWrite {
  fingerprint: string
  site?: { name?: string; description?: string }
  /** A string sets the field; `null` or an empty string clears it. */
  theme?: Partial<Record<ThemeField, string | null>>
}

export async function writeBranding(root: string, raw: unknown): Promise<Branding> {
  const input = parseWrite(raw)
  const current = await readBranding(root)
  if (!current.editable) throw new DoxloopError(current.reason ?? 'Branding cannot be edited from Doxloop for this generator.', 2)
  if (input.fingerprint !== current.fingerprint) {
    throw new DoxloopError('The site configuration changed on disk since it was loaded. Reload the branding panel and apply your changes again.')
  }
  const project = await loadProject(root)
  const configPath = await siteConfigPath(root, project)
  const site = await loadSiteConfig(root, project)
  const theme = themeObject(site.theme)
  for (const [field, value] of Object.entries(input.theme ?? {}) as Array<[ThemeField, string | null]>) {
    if (value === null || value === '') delete theme[field]
    else theme[field] = value
  }
  const name = input.site?.name !== undefined ? input.site.name.trim() : site.name
  const description = input.site?.description !== undefined ? input.site.description.trim() : site.description
  if (input.site?.name !== undefined && !name) throw new DoxloopError('Site name cannot be empty.', 2)

  const contentRoot = await resolveContainedDirectory(root, project.contentDir, 'Documentation content directory', { allowRoot: true })
  const issues: ValidationIssue[] = []
  await validateDoxbrixTheme(theme, contentRoot, current.configFile, issues)
  const errors = issues.filter((issue) => issue.severity === 'error')
  if (errors.length > 0) throw new DoxloopError(errors.map((issue) => issue.message).join(' '), 2)

  const next = {
    ...site,
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    ...(Object.keys(theme).length > 0 ? { theme } : {}),
  }
  if (!description) delete (next as { description?: string }).description
  if (Object.keys(theme).length === 0) delete (next as { theme?: unknown }).theme
  await applyDirectEdit(root, {
    kind: 'branding',
    requestText: describeChange(input, project),
    files: [current.configFile],
    apply: () => writeFile(configPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8'),
  })
  return readBranding(root)
}

function parseWrite(raw: unknown): BrandingWrite {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new DoxloopError('A branding write needs a fingerprint and the fields to change.', 2)
  const body = raw as Record<string, unknown>
  if (typeof body.fingerprint !== 'string') throw new DoxloopError('A branding write needs the fingerprint it was loaded with.', 2)
  const result: BrandingWrite = { fingerprint: body.fingerprint }
  if (body.site !== undefined) {
    const site = (body.site && typeof body.site === 'object' ? body.site : {}) as Record<string, unknown>
    result.site = {}
    if (site.name !== undefined) result.site.name = textOrThrow(site.name, 'Site name')
    if (site.description !== undefined) result.site.description = textOrThrow(site.description, 'Site description')
  }
  if (body.theme !== undefined) {
    const theme = (body.theme && typeof body.theme === 'object' ? body.theme : {}) as Record<string, unknown>
    result.theme = {}
    for (const [key, value] of Object.entries(theme)) {
      if (!THEME_FIELDS.includes(key as ThemeField)) throw new DoxloopError(`"${key}" is not a branding field.`, 2)
      if (value === null || value === '') { result.theme[key as ThemeField] = null; continue }
      result.theme[key as ThemeField] = validateField(key as ThemeField, textOrThrow(value, key))
    }
  }
  return result
}

function validateField(field: ThemeField, value: string): string {
  const trimmed = value.trim()
  if ((THEME_COLOR_FIELDS as readonly string[]).includes(field)) {
    const color = trimmed.toLowerCase()
    if (!/^#[0-9a-f]{6}$/.test(color)) throw new DoxloopError(`${label(field)} must be a six-digit hex colour such as #6366f1.`, 2)
    return color
  }
  if ((THEME_FONT_FIELDS as readonly string[]).includes(field)) {
    if (!trimmed || trimmed.length > 80 || /[<>"';{}]/.test(trimmed)) throw new DoxloopError(`${label(field)} must be a font family name.`, 2)
    return trimmed
  }
  if (field === 'mode') {
    if (!(THEME_MODES as readonly string[]).includes(trimmed)) throw new DoxloopError('Colour mode must be light, dark, or system.', 2)
    return trimmed
  }
  if (field === 'codeTheme') {
    if (!(THEME_CODE_THEMES as readonly string[]).includes(trimmed)) throw new DoxloopError('Code theme must be auto, light, or dark.', 2)
    return trimmed
  }
  if (!/^(?:https:\/\/|\/(?!\/))/i.test(trimmed) || /\s/.test(trimmed)) {
    throw new DoxloopError(`${label(field)} must be an HTTPS address or a root-relative path such as /assets/logo.svg.`, 2)
  }
  if (trimmed.startsWith('/') && trimmed.split('/').some((part) => part === '..')) {
    throw new DoxloopError(`${label(field)} cannot leave the documentation folder.`, 2)
  }
  return trimmed
}

function describeChange(input: BrandingWrite, project: DoxloopProject): string {
  const fields = Object.keys(input.theme ?? {})
  const site = Object.keys(input.site ?? {})
  const parts = [...site.map((key) => `site ${key}`), ...fields.map(label)]
  return parts.length > 0 ? `Updated branding: ${parts.join(', ')}` : `Updated branding for ${project.title}`
}

function label(field: string): string {
  const words: Record<string, string> = {
    primaryColor: 'Primary colour',
    lightColor: 'Light-mode accent',
    darkColor: 'Dark-mode accent',
    backgroundColorLight: 'Light background',
    backgroundColorDark: 'Dark background',
    font: 'Body font',
    headingFont: 'Heading font',
    codeFont: 'Code font',
    logoLight: 'Light logo',
    logoDark: 'Dark logo',
    favicon: 'Favicon',
    faviconLight: 'Light favicon',
    faviconDark: 'Dark favicon',
    backgroundImage: 'Background image',
    logoHref: 'Logo link',
    mode: 'Colour mode',
    codeTheme: 'Code theme',
  }
  return words[field] ?? field
}

function textOrThrow(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new DoxloopError(`${name} must be text.`, 2)
  if (value.length > 500) throw new DoxloopError(`${name} is too long.`, 2)
  return value
}

function themeObject(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') return { mode: value }
  if (value && typeof value === 'object' && !Array.isArray(value)) return { ...(value as Record<string, unknown>) }
  return {}
}

function fingerprint(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}
