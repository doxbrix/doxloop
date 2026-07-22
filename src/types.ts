export type AgentName = 'codex' | 'claude' | 'gemini'
export type GeneratorName =
  | 'doxbrix'
  | 'docusaurus'
  | 'mkdocs'
  | 'sphinx'
  | 'hugo'
  | 'vitepress'
  | 'markdoc'
  | 'nextra'
  | 'starlight'
  | 'jekyll'
  | 'static'

export interface SourceBinding {
  name: string
  path: string
}

export interface DesignReference {
  url: string
}

export type ScreenshotPolicy = 'requested' | 'auto' | 'off'

export interface ApplicationScreenshots {
  policy: ScreenshotPolicy
  viewport?: {
    width: number
    height: number
  }
  highlight?: boolean
}

export interface ApplicationConfig {
  baseUrl: string
  source?: string
  startCommand?: string
  readyPath?: string
  screenshots?: ApplicationScreenshots
}

export type DocumentationExperienceLevel =
  | 'beginner'
  | 'intermediate'
  | 'advanced'
  | 'mixed'

export interface DocumentationBrief {
  primaryAudience?: string
  experienceLevel?: DocumentationExperienceLevel
  priorityOutcomes?: string[]
  locale: string
  tone: string[]
  standardsProfile: string
  styleGuide: string
  terminology: Record<string, string>
  exclusions: string[]
  accessibilityTarget: string
}

export interface DoxloopProject {
  schemaVersion: 1
  title: string
  contentDir: string
  generator: GeneratorName
  generatorPackage?: string
  sources: SourceBinding[]
  designReferences: DesignReference[]
  application?: ApplicationConfig
  documentation: DocumentationBrief
}

export type DoxbrixNavNode =
  | { type: 'page'; file: string; title?: string; icon?: string; hidden?: boolean }
  | { type: 'group'; label: string; icon?: string; hidden?: boolean; items: DoxbrixNavNode[] }
  | { type: 'label'; text: string }
  | { type: 'divider' }
  | { type: 'link'; title: string; href: string; icon?: string }
  | { type: 'api'; title: string; spec: string; icon?: string }

export interface DoxbrixSpace {
  name: string
  slug?: string
  locale?: string
  parent?: string
  icon?: string
  tag?: string
  nav: DoxbrixNavNode[]
}

export interface DoxbrixSiteConfig {
  version: 1
  name?: string
  description?: string
  spaces: DoxbrixSpace[]
  theme?: Record<string, unknown> | 'light' | 'dark' | 'system'
  site?: Record<string, unknown>
}

export interface SourceSyncRecord {
  commit: string
  recordedAt: string
  contentFingerprint?: string
}

export interface SyncState {
  schemaVersion: 1
  sources: Record<string, SourceSyncRecord>
}

export type SourceChange = SourceBinding &
  (
    | { kind: 'missing-path' }
    | { kind: 'not-git' }
    | { kind: 'no-baseline'; head: string; uncommittedFiles: string[] }
    | { kind: 'baseline-lost'; head: string; uncommittedFiles: string[] }
    | {
        kind: 'unchanged' | 'changed'
        baseline: string
        head: string
        changedFiles: string[]
        uncommittedFiles: string[]
      }
  )

export type IssueSeverity = 'error' | 'warning'

export interface ValidationIssue {
  severity: IssueSeverity
  code: string
  message: string
  file?: string
}

export interface ValidationResult {
  issues: ValidationIssue[]
  pages: string[]
  errors: number
  warnings: number
}

export interface ParsedArgs {
  command?: string
  positionals: string[]
  flags: Map<string, string[]>
}
