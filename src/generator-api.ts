import type { DoxloopProject, ValidationIssue } from './types.js'

export { DoxloopError, UsageError } from './errors.js'
export type { DoxloopProject, ValidationIssue } from './types.js'
export const GENERATOR_API_VERSION = 1 as const

export interface GeneratorScaffoldContext {
  root: string
  title: string
  contentDir: string
  corePackage: { name: string; version: string }
  generatorPackage: { name: string; version: string }
}

export interface GeneratorPreviewOptions {
  root: string
  host: string
  port: number
  open: boolean
}

export interface GeneratorValidationContext {
  root: string
  contentRoot: string
  project: DoxloopProject
  pages: string[]
  pageIds: string[]
}

export interface GeneratorAssetContext {
  root: string
  contentRoot: string
  pagePath: string
  reference: string
}

export interface GeneratorPage {
  title: string
  description?: string
  body: string
}

/** One page the navigation should reference. `path` is relative to the content root. */
export interface GeneratorNavigationPage {
  path: string
  title: string
  /** Section label; adapters that support grouping nest the page under it. */
  section?: string
}

export interface GeneratorNavigationContext {
  root: string
  contentRoot: string
  project: DoxloopProject
  /** `add` inserts the page, `remove` drops it, `rename` moves `from` to `page`. */
  action: 'add' | 'remove' | 'rename'
  page: GeneratorNavigationPage
  /** Content-relative path of the page before a rename. */
  from?: string
}

/**
 * A whole navigation as a tree, for the control center's navigation editor.
 * `file` is content-relative and keeps the page extension the generator uses.
 */
export type GeneratorNavigationTreeNode =
  | { type: 'page'; file: string; title?: string }
  | { type: 'group'; label: string; items: GeneratorNavigationTreeNode[] }

export interface GeneratorNavigationTree {
  nodes: GeneratorNavigationTreeNode[]
}

export interface GeneratorNavigationTreeContext {
  root: string
  contentRoot: string
  project: DoxloopProject
}

export interface GeneratorRenderContext {
  root: string
  contentRoot: string
  /** Content-relative path of the page being rendered. */
  path: string
  /** The page as read from disk, or unsaved content when previewing an edit. */
  page: GeneratorPage
}

export interface GeneratorRenderedPage {
  /** HTML for the page body only; the host supplies the document shell. */
  html: string
  /** True when native components were left unrendered and the full build would differ. */
  partial?: boolean
}

export interface GeneratorAdapter {
  apiVersion: typeof GENERATOR_API_VERSION
  id: string
  displayName: string
  packageName: string
  packageVersion: string
  authoring: {
    skillName: string
    skillDirectory: string
  }
  planning?: {
    /** Generator-native files that own primary or sidebar navigation. */
    navigationFiles: string[]
  }
  project: {
    defaultContentDir: string
    pageExtensions: string[]
    gitignore: string[]
    contentFormat?: 'markdown' | 'rst' | 'html'
    /**
     * Project-relative directory uploaded images land in, and the URL prefix
     * pages use to reference them. Absent means `assets` under the content
     * directory, referenced as `/assets/<name>`.
     */
    assets?: { directory: string; publicPrefix: string }
  }
  /** The generator's own theme configuration, named in the branding panel when Doxloop cannot edit it. */
  theme?: { configFile: string }
  build: {
    command: string
    outputDir: string
  }
  scaffold(context: GeneratorScaffoldContext): Promise<void>
  preview(options: GeneratorPreviewOptions): Promise<void>
  validate(context: GeneratorValidationContext): Promise<ValidationIssue[]>
  resolveLocalAsset?(context: GeneratorAssetContext): string | undefined
  readPage?(path: string): Promise<GeneratorPage>
  /**
   * Update the generator's own navigation file when a page is created,
   * removed, or renamed. Absent when the generator derives navigation from the
   * file system or from configuration Doxloop cannot rewrite safely.
   */
  writeNavigation?(context: GeneratorNavigationContext): Promise<void>
  /**
   * Read the whole navigation as a tree so the control center can reorder,
   * group, and relabel it, and write the edited tree back. Absent when the
   * generator's navigation is code or is derived from the file system.
   */
  readNavigationTree?(context: GeneratorNavigationTreeContext): Promise<GeneratorNavigationTree>
  writeNavigationTree?(context: GeneratorNavigationTreeContext & { tree: GeneratorNavigationTree }): Promise<void>
  /**
   * Render one page to HTML without running the native build. Absent when the
   * host's generic Markdown preview is the best available approximation.
   */
  renderPage?(context: GeneratorRenderContext): Promise<GeneratorRenderedPage>
}

export function defineGenerator<T extends GeneratorAdapter>(adapter: T): T {
  return adapter
}
