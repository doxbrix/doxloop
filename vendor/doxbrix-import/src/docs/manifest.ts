/**
 * Local mirror of the Doxbrix `docs.json` manifest model. Kept in sync with the
 * server's `git-sync/manifest.ts` shape (the CLI can't import server-only code).
 * The manifest is authoritative for navigation; pages live in files referenced
 * by `file` (without extension).
 */

export type ManifestNavNode =
  | { type: 'page'; file: string; title?: string; icon?: string; hidden?: boolean }
  | { type: 'group'; label: string; icon?: string; hidden?: boolean; items: ManifestNavNode[] }
  | { type: 'label'; text: string }
  | { type: 'divider' }
  | { type: 'link'; title: string; href: string; icon?: string }
  | { type: 'api'; title: string; spec: string; icon?: string }

export interface ManifestSpace {
  name: string
  slug?: string
  locale?: string
  parent?: string
  icon?: string
  tag?: string
  /** Doc-version slug from the manifest `versions` catalog; absent = default. */
  version?: string
  nav: ManifestNavNode[]
}

/** Product-docs version entry. First entry is the default unless one sets
 *  `default: true` (the Mintlify rule). `tag` renders as a badge. The SDK
 *  importer emits `isDefault`; hand-authored docs.json may use `default`. */
export interface ManifestDocVersion {
  version: string
  label?: string
  tag?: string
  default?: boolean
  isDefault?: boolean
}

export interface DocsManifest {
  version: number
  name?: string
  description?: string
  openapiSources?: string[]
  apiBaseUrl?: string
  /** Product-docs versions in switcher order; absent = unversioned project. */
  versions?: ManifestDocVersion[]
  spaces: ManifestSpace[]
  /** Portable brand/layout settings produced by local migrations. */
  theme?: {
    source?: string
    preset?: string
    primaryColor?: string
    lightColor?: string
    darkColor?: string
    mode?: 'light' | 'dark' | 'system'
    strictMode?: boolean
    font?: string
    headingFont?: string
    codeFont?: string
    typography?: {
      titleWeight?: number
      titleSize?: number
      titleSizeMobile?: number
      titleLineHeight?: number
      titleLineHeightMobile?: number
      descriptionSize?: number
      descriptionLineHeight?: number
      bodyWeight?: number
      bodySize?: number
      bodyLineHeight?: number
      fontFeatures?: string[]
      fontVariationSettings?: 'normal'
      fontSmoothing?: 'auto' | 'antialiased'
      headingWeight?: number
      h2Size?: number
      h2LineHeight?: number
      h2MarginTop?: number
      h2MarginBottom?: number
      h3Size?: number
      h3LineHeight?: number
      h3MarginTop?: number
      h3MarginBottom?: number
      h4Size?: number
      h4LineHeight?: number
      h4MarginTop?: number
      h4MarginBottom?: number
      strongWeight?: number
      apiFieldWeight?: number
    }
    textColors?: {
      light?: { heading?: string; body?: string; muted?: string }
      dark?: { heading?: string; body?: string; muted?: string }
    }
    fontSources?: Array<{ family: string; source: string; format?: string; weight?: number; role: 'body' | 'heading' | 'code' }>
    logoLight?: string
    logoDark?: string
    logoHref?: string
    favicon?: string
    faviconLight?: string
    faviconDark?: string
    backgroundColorLight?: string
    backgroundColorDark?: string
    backgroundImage?: string
    backgroundDecoration?: string
    codeTheme?: string
    codeThemeLight?: string
    codeThemeDark?: string
    eyebrow?: string
    layout?: {
      headerHeight: number
      sidebarWidth: number
      tocWidth: number
      contentMaxWidth: number
      contentPadding: number
      navPadding: number
      tabsHeight?: number
      shellMaxWidth?: number
    }
  }
  site?: Record<string, unknown>
}

export const PAGE_EXTENSIONS = ['.mdx', '.md', '.markdown']

export function isPageFile(path: string): boolean {
  const lower = path.toLowerCase()
  return PAGE_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

export function stripPageExtension(path: string): string {
  for (const ext of PAGE_EXTENSIONS) {
    if (path.toLowerCase().endsWith(ext)) return path.slice(0, -ext.length)
  }
  return path
}

export function withPageExtension(file: string, ext = '.mdx'): string {
  return isPageFile(file) ? file : `${file}${ext}`
}

/** Parse + lightly validate a `docs.json` string. Throws on malformed JSON. */
export function parseManifest(jsonText: string): DocsManifest {
  const raw = JSON.parse(jsonText) as Partial<DocsManifest>
  if (!raw || typeof raw !== 'object') throw new Error('docs.json must be a JSON object')
  const spaces = Array.isArray(raw.spaces) ? raw.spaces : []
  return {
    ...raw,
    version: typeof raw.version === 'number' ? raw.version : 1,
    spaces: spaces as ManifestSpace[],
  } as DocsManifest
}

export function stringifyManifest(manifest: DocsManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`
}

/** Every page `file` referenced in the manifest (without extension). */
export function manifestPageFiles(manifest: DocsManifest): string[] {
  const out: string[] = []
  const walk = (nodes: ManifestNavNode[]) => {
    for (const node of nodes) {
      if (node.type === 'page') out.push(node.file)
      else if (node.type === 'group') walk(node.items)
    }
  }
  for (const space of manifest.spaces) walk(space.nav)
  return out
}

/** Walk every nav node (for validation), depth-first. */
export function walkNav(manifest: DocsManifest, visit: (node: ManifestNavNode, spaceIndex: number) => void): void {
  manifest.spaces.forEach((space, i) => {
    const walk = (nodes: ManifestNavNode[]) => {
      for (const node of nodes) {
        visit(node, i)
        if (node.type === 'group') walk(node.items)
      }
    }
    walk(space.nav)
  })
}
