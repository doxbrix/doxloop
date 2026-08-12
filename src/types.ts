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

export type SourceKind = 'directory' | 'openapi'

export interface RemoteSource {
  /** `github` is retained for projects created before generic Git support. */
  provider: 'git' | 'github'
  /** Clone URL for generic Git, or owner/name for legacy GitHub sources. */
  repository: string
  branch: string
  /** Optional repository-relative directory used as the evidence root. */
  subdirectory?: string
  /** Legacy GitHub authentication option. New credentials are session-only. */
  tokenEnv?: string
  /** Primarily for GitHub Enterprise Server. */
  apiBaseUrl?: string
}

export interface SourceBinding {
  name: string
  path: string
  kind?: SourceKind
  remote?: RemoteSource
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

export type DeploymentVisibilitySetting = 'private' | 'public'

export interface DeploymentConfig {
  name?: string
  slug?: string
  visibility?: DeploymentVisibilitySetting
  apiUrl?: string
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

/**
 * `check` reports drift and never starts an agent. Authoring modes generate an
 * isolated proposal; neither changes the real documentation before approval.
 */
export type SyncMode = 'check' | 'propose' | 'auto'

/** Remote polling runs at a user-friendly calendar cadence or fixed interval. */
export type SyncTrigger =
  | `every@${number}m`
  | `every@${number}h`
  | `daily@${string}`
  | `weekdays@${string}`
  | `weekly@${string}@${string}`
  | `monthly@${number}@${string}`

export interface SyncBudget {
  maxRunsPerDay?: number
  maxMinutes?: number
}

export interface SyncConfig {
  mode: SyncMode
  branch?: string
  on: SyncTrigger[]
  watch: string[]
  ignore: string[]
  budget?: SyncBudget
}

export interface DoxloopProject {
  schemaVersion: 1
  title: string
  contentDir: string
  generator: GeneratorName
  generatorPackage?: string
  defaultAgent?: AgentName
  sources: SourceBinding[]
  designReferences: DesignReference[]
  application?: ApplicationConfig
  deployment?: DeploymentConfig
  documentation: DocumentationBrief
  sync: SyncConfig
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

export type SyncRunStatus =
  | 'generating'
  | 'awaiting-review'
  | 'partially-applied'
  | 'applied'
  | 'rejected'
  | 'failed'
  | 'conflicted'

export type SyncRunTrigger =
  | 'manual'
  | 'schedule'

export type SyncChangeKind = 'added' | 'modified' | 'deleted'
export type SyncChangeCategory = 'page' | 'navigation' | 'configuration' | 'evidence' | 'asset'

export interface SyncChangeHunk {
  id: string
  oldStart: number
  oldLines: string[]
  newStart: number
  newLines: string[]
  acceptedAt?: string
  rejectedAt?: string
}

export interface SyncFileChange {
  id: string
  path: string
  title: string
  kind: SyncChangeKind
  category: SyncChangeCategory
  binary: boolean
  beforeHash?: string
  afterHash?: string
  beforeEndsWithNewline?: boolean
  afterEndsWithNewline?: boolean
  hunks: SyncChangeHunk[]
}

export interface SyncRunValidation {
  pages: number
  errors: number
  warnings: number
}

/** A generated documentation proposal. The real documentation changes only after review. */
export interface SyncRun {
  schemaVersion: 1
  id: string
  status: SyncRunStatus
  mode: Exclude<SyncMode, 'check'>
  trigger: SyncRunTrigger
  createdAt: string
  completedAt?: string
  appliedAt?: string
  rejectedAt?: string
  summary: string
  sourceSummary: string
  stalePages: string[]
  changes: SyncFileChange[]
  validation?: SyncRunValidation
  error?: string
}

export type SourceChange = Omit<SourceBinding, 'kind'> &
  (
    | { kind: 'missing-path' }
    | { kind: 'not-git' }
    | { kind: 'spec-remote' }
    | { kind: 'spec-unchanged' }
    | { kind: 'spec-changed' }
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

/**
 * How well the authoring agent could ground a page in configured evidence.
 * `needs-human` is surfaced by validation rather than silently accepted.
 */
export type EvidenceConfidence = 'verified' | 'inferred' | 'needs-human'

export interface PageEvidenceSource {
  /** Name of a configured source binding. */
  source: string
  /** Source-relative paths or globs the page was written from. */
  paths?: string[]
  /** OpenAPI operations the page documents, such as `POST /oauth/token`. */
  operations?: string[]
}

export interface PageEvidence {
  sources: PageEvidenceSource[]
  /** Source name to the commit or content hash the page was last checked against. */
  verifiedAt?: Record<string, string>
  confidence?: EvidenceConfidence
  /** Reader-facing factual claims the page makes, for targeted re-verification. */
  claims?: string[]
}

export interface EvidenceMap {
  schemaVersion: 1
  /** Project-relative page paths, matching the paths reported by validation. */
  pages: Record<string, PageEvidence>
}

export interface StaleReason {
  source: string
  paths: string[]
  baseline?: string
  head?: string
}

export interface StalePage {
  page: string
  reasons: StaleReason[]
  verifiedAt?: string
}

export interface DriftSourceSummary {
  name: string
  path: string
  kind: SourceChange['kind']
  /** Changed paths that survived the watch and ignore filters. */
  changedPaths: string[]
  /** How many changed paths the filters dropped. */
  filteredPaths: number
  baseline?: string
  head?: string
}

/**
 * `current` means nothing reader-visible changed. `stale` names the affected
 * pages. `unknown` means something changed but page-level attribution is not
 * possible yet, usually because no evidence map or baseline exists.
 */
export type DriftStatus = 'current' | 'stale' | 'unknown'

export interface DriftResult {
  status: DriftStatus
  pages: StalePage[]
  trackedPages: number
  sources: DriftSourceSummary[]
  evidenceMap: 'present' | 'missing'
  notes: string[]
}

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
