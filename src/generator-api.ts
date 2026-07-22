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
  project: {
    defaultContentDir: string
    pageExtensions: string[]
    gitignore: string[]
    contentFormat?: 'markdown' | 'rst' | 'html'
  }
  build: {
    command: string
    outputDir: string
  }
  scaffold(context: GeneratorScaffoldContext): Promise<void>
  preview(options: GeneratorPreviewOptions): Promise<void>
  validate(context: GeneratorValidationContext): Promise<ValidationIssue[]>
  resolveLocalAsset?(context: GeneratorAssetContext): string | undefined
  readPage?(path: string): Promise<GeneratorPage>
}

export function defineGenerator<T extends GeneratorAdapter>(adapter: T): T {
  return adapter
}
