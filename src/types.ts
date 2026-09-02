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
  /** Optional ownership boundary for monorepos and multi-source documentation. */
  scope?: {
    space?: string
    routePrefix?: string
    navigationGroup?: string
    /** Page paths or globs that this source explicitly shares with another source. */
    sharedPages?: string[]
  }
}

export interface DesignReference {
  url: string
}

export type ScreenshotPolicy = 'requested' | 'auto' | 'off'
export type ScreenshotIntent = 'auto' | 'enabled' | 'disabled'

export interface DocumentationPlanVisuals {
  mode: 'none' | 'recommended' | 'required'
  rationale: string
  estimatedCaptures: number
  /** Application-relative route where the documented workflow begins. */
  startPath?: string
  /** Ordered actions, fixture assumptions, and visible outcomes to capture. */
  workflow?: string
  /** One reader-useful visible state for every planned screenshot, in capture order. */
  captureSequence?: string[]
}

export interface ScreenshotRunSummary {
  intent: ScreenshotIntent
  status: 'not-requested' | 'planned' | 'verified' | 'skipped' | 'failed'
  planned: number
  captured: number
  textOnly: number
  guides: number
  manifest?: string
  message?: string
  /** Screenshot problems the reviewer chose to accept instead of failing the run. */
  ignoredProblems?: number
}

export interface ApplicationScreenshots {
  policy: ScreenshotPolicy
  viewport?: {
    width: number
    height: number
  }
  highlight?: boolean
  /** Default application-relative route used when planning visual guides. */
  startPath?: string
  /** Safe fixture, authentication, and workflow guidance supplied by the user. */
  workflow?: string
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
  audiences?: string[]
  customInstructions?: string
  experienceLevel?: DocumentationExperienceLevel
  priorityOutcomes?: string[]
  preferredExamples?: string[]
  designDirection?: string
  locale: string
  tone: string[]
  standardsProfile: string
  styleGuide: string
  terminology: Record<string, string>
  exclusions: string[]
  accessibilityTarget: string
}

export type DocumentationPlanMode = 'create' | 'update'
export type DocumentationPlanScope = 'starter' | 'standard' | 'comprehensive' | 'custom'
export type DocumentationPlanStatus =
  | 'planning'
  | 'revising'
  | 'needs-input'
  | 'ready-for-review'
  | 'approved'
  | 'generating'
  | 'generated'
  | 'failed'
  | 'stale'
  | 'cancelled'

export type DocumentationPlanPageAction = 'create' | 'update' | 'preserve' | 'remove'
export type DocumentationPlanPagePriority = 'must-have' | 'next' | 'later'

export interface DocumentationPlanEvidence {
  source: string
  path: string
  kind?: string
  label?: string
  line?: number
}

export interface DocumentationPlanPage {
  id: string
  title: string
  path: string
  type: string
  priority: DocumentationPlanPagePriority
  action: DocumentationPlanPageAction
  purpose: string
  rationale: string
  evidence: string[]
  evidenceDetails: DocumentationPlanEvidence[]
  /** Planned reader-facing application images for this page. */
  visuals?: DocumentationPlanVisuals
}

export interface DocumentationPlanQuestion {
  id: string
  question: string
  whyItMatters: string
  recommendation?: string
}

export interface DocumentationPlanExecution {
  agent?: AgentName
  model?: string
  reasoning?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  /** Booleans are accepted only for persisted v2 plan compatibility. */
  screenshots: ScreenshotIntent | boolean
}

export interface DocumentationPlanCapability {
  id: string
  title: string
  kind: string
  evidence: DocumentationPlanEvidence[]
  pageIds: string[]
  disposition: 'planned' | 'existing' | 'excluded' | 'needs-human'
}

export interface DocumentationPlanNavigationSection {
  id: string
  title: string
  pageIds: string[]
}

export interface DocumentationPlanNavigation {
  top: string[]
  sections: DocumentationPlanNavigationSection[]
}

export interface DocumentationPlanTarget {
  generator: GeneratorName
  contentDir: string
  contentFormat: 'markdown' | 'rst' | 'html'
  pageExtensions: string[]
  navigationFiles: string[]
}

export interface DocumentationPlanFailure {
  stage: 'propose' | 'revise' | 'generate'
  /** The preserved proposal workspace a generation failure left behind. */
  proposalId?: string
  /** The agent can continue in the preserved workspace without redoing finished work. */
  resumable: boolean
  /** The output that exists can be accepted with the reported problems recorded for review. */
  ignorable: boolean
}

/**
 * The UI-owned checkpoint between source research and document authoring.
 * Terminal agents may propose or revise this contract, but only Doxloop can
 * persist edits, approve a version, or authorize generation.
 */
export interface DocumentationPlan {
  schemaVersion: 2
  id: string
  version: number
  mode: DocumentationPlanMode
  status: DocumentationPlanStatus
  scope: DocumentationPlanScope
  createdAt: string
  updatedAt: string
  request: string
  sourceSnapshot: string
  productProfile: string
  summary: string
  audiences: string[]
  outcomes: string[]
  terminology: Record<string, string>
  exclusions: string[]
  instructions: string
  experienceLevel: DocumentationExperienceLevel
  preferredExamples: string[]
  locale: string
  accessibilityTarget: string
  styleGuide: string
  capabilities: DocumentationPlanCapability[]
  navigation: DocumentationPlanNavigation
  pages: DocumentationPlanPage[]
  questions: DocumentationPlanQuestion[]
  estimatedPages: number
  /**
   * Reviewer-requested minimum number of pages to write. The planner must
   * reach it with distinct evidence-backed pages or record a scope exception.
   */
  targetPages?: number
  estimatedEffort: 'small' | 'medium' | 'large'
  discovery: {
    cacheKey: string
    generatedAt: string
    deterministic: true
    publicSignals: number
    suggestedPages: { starter: number; standard: number; comprehensive: number }
  }
  target: DocumentationPlanTarget
  clarification: { mode: 'review' | 'defaults' | 'stop'; answers: Record<string, string> }
  execution: DocumentationPlanExecution
  approvedAt?: string
  approvedHash?: string
  proposalId?: string
  error?: string
  /**
   * Where the last workflow stage stopped and which continuation is possible,
   * so a failed run can be resumed or accepted as-is instead of started over.
   */
  failure?: DocumentationPlanFailure
  /** Non-blocking findings a reviewer should weigh before approving. */
  advisories?: string[]
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
  maxVerificationAgeDays?: number
  maxVerificationAgeSeverity?: 'warn' | 'fail'
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
  connector?: {
    id: string
    version: 1
    etag?: string
    lastModified?: string
    openapi?: OpenApiSnapshot
  }
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
  | 'stale'
  | 'superseded'
  | 'undone'

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

export interface SyncEvidenceReference {
  source: string
  path?: string
  operation?: string
  revision?: string
  available: boolean
}

export interface SyncChangeRationale {
  reason: string
  evidence: SyncEvidenceReference[]
  affectedInterfaces: string[]
  claims: {
    added: string[]
    changed: string[]
    removed: string[]
  }
  validation: { errors: number; warnings: number }
  confidence: EvidenceConfidence
  assumptions: string[]
  planId?: string
  planPageId?: string
  request?: string
  authorship: 'agent' | 'human'
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
  rationale: SyncChangeRationale
}

export interface SyncRunValidation {
  pages: number
  errors: number
  warnings: number
}

/** A generated documentation proposal. The real documentation changes only after review. */
export interface SyncRun {
  schemaVersion: 2
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
  sourceSnapshot?: string
  /** Plan-first authoring mode, used to complete Create/Update state after acceptance. */
  authoringMode?: 'create' | 'update'
  planId?: string
  revisionOf?: string
  supersededBy?: string
  archivedAt?: string
  retentionUntil?: string
  revisionRequests: Array<{
    id: string
    createdAt: string
    instruction: string
    changeIds: string[]
    hunkIds: string[]
  }>
  humanEdits: Array<{
    changeId: string
    path: string
    editedAt: string
    evidenceDisposition: 'preserved' | 'needs-review'
  }>
  undo?: {
    status: 'available' | 'undone' | 'unavailable'
    undoneAt?: string
    reason?: string
  }
  validation?: SyncRunValidation
  screenshots?: ScreenshotRunSummary
  error?: string
  /** When the agent was last continued inside this run's preserved workspace. */
  resumedAt?: string
  /** Reviewer-facing notes about how this run was continued, never blocking. */
  advisories?: string[]
  /** Continuations available after a failure, given the workspace this run left behind. */
  recovery?: {
    /** The agent can continue in the preserved workspace without redoing finished work. */
    resumable: boolean
    /** The output that exists can be reviewed with screenshot problems recorded instead of enforced. */
    ignorable: boolean
  }
}

export type SourceChange = Omit<SourceBinding, 'kind'> &
  (
    | { kind: 'missing-path' }
    | { kind: 'not-git' }
    | { kind: 'spec-remote' }
    | { kind: 'spec-unchanged'; head?: string; summary?: OpenApiSummary }
    | { kind: 'spec-changed'; baseline?: string; head: string; summary: OpenApiSummary; apiDiff: ApiStructuralDiff; changedIdentifiers: string[] }
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
  /** Source name to the ISO timestamp when the page was last checked. */
  verifiedOn?: Record<string, string>
  confidence?: EvidenceConfidence
  /** Reader-facing factual claims the page makes, for targeted re-verification. */
  claims?: string[]
  /** Optional claim-level review state keyed by the exact reader-facing claim. */
  claimVerification?: Record<string, ClaimVerificationState>
}

export interface EvidenceMap {
  schemaVersion: 1
  /** Project-relative page paths, matching the paths reported by validation. */
  pages: Record<string, PageEvidence>
}

export interface StaleReason {
  source: string
  paths: string[]
  kind?: 'source-change' | 'max-age'
  ageDays?: number
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
  scope?: SourceBinding['scope']
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

export interface OpenApiSummary {
  title: string
  version: string
  specificationVersion: string
  servers: string[]
  securitySchemes: string[]
  schemas: string[]
  operationCount: number
}

export interface OpenApiSnapshot {
  schemaVersion: 1
  specificationVersion: string
  operations: Record<string, {
    operationId: string
    parameters: string
    requestBody: string
    responses: string
    security: string
    examples: string
    full: string
  }>
  schemas: Record<string, string>
  securitySchemes: Record<string, string>
}

export interface ApiStructuralDiff {
  operations: { added: string[]; removed: string[]; changed: Array<{ id: string; facets: string[] }> }
  schemas: { added: string[]; removed: string[]; changed: Array<{ id: string; facets: string[] }> }
  securitySchemes: { added: string[]; removed: string[]; changed: Array<{ id: string; facets: string[] }> }
}

export interface SourceHealth {
  name: string
  connector: string
  status: 'healthy' | 'warning' | 'error'
  checkedAt: string
  lastSuccessfulAt?: string
  lastMonitoringAt?: string
  location: string
  provider: string
  branch?: string
  subdirectory?: string
  monitored: boolean
  revision?: string
  summary: string
  details: string[]
  openapi?: OpenApiSummary
  scope?: SourceBinding['scope']
}

export type CoverageSurface = 'commands' | 'exports' | 'http-operations' | 'configuration' | 'security' | 'errors' | 'events-integrations' | 'reader-journeys' | 'verified-pages'

export type CoverageItemState = 'documented' | 'uncovered' | 'excluded' | 'needs-human'

export interface CoverageItem {
  id: string
  surface: CoverageSurface
  label: string
  state: CoverageItemState
  source?: string
  path?: string
  kind?: string
  page?: string
  suggestedPage?: string
  reason?: string
}

export interface CoverageMetric {
  id: CoverageSurface
  label: string
  documented: number
  total: number
  excluded: number
  percent: number
  status: 'measured' | 'unknown'
  denominator: string
  items: CoverageItem[]
}

export interface CoverageGroup {
  source: string
  scope?: SourceBinding['scope']
  documented: number
  total: number
  percent: number
  status: 'measured' | 'unknown'
}

export interface EvidenceDiagnostic {
  severity: IssueSeverity
  code: 'missing-page' | 'unknown-source' | 'source-only' | 'broad-pattern' | 'deleted-identifier' | 'weak-relation'
  page: string
  source?: string
  identifier?: string
  message: string
  suggestion: string
}

export interface SourceIntelligenceReport {
  generatedAt: string
  health: SourceHealth[]
  coverage: {
    metrics: CoverageMetric[]
    groups: CoverageGroup[]
    pages: string[]
    disclaimer: string
  }
  evidenceDiagnostics: EvidenceDiagnostic[]
}

export type ReviewFindingSeverity = 'blocker' | 'major' | 'minor'

export interface DocumentationReviewFinding {
  id: string
  severity: ReviewFindingSeverity
  title: string
  description: string
  pages: string[]
  evidence: string[]
  recommendation: string
}

export interface DocumentationReviewReport {
  schemaVersion: 1
  id: string
  createdAt: string
  agent: AgentName
  model?: string
  reasoning?: string
  score: number
  hardGates: 'pass' | 'fail' | 'unknown'
  summary: string
  findings: DocumentationReviewFinding[]
}

export type QualityCheckStatus = 'pass' | 'warning' | 'fail' | 'skipped'

export type QualityCheckCategory =
  | 'validation'
  | 'build'
  | 'links'
  | 'examples'
  | 'schemas'
  | 'accessibility'
  | 'visual'
  | 'lint'
  | 'claims'

/** Versioned, CI-stable result returned by `doxloop quality`. */
export interface QualityCheck {
  code: string
  category: QualityCheckCategory
  status: QualityCheckStatus
  message: string
  file?: string
  detail?: string
  fixable?: boolean
}

export interface QualityReport {
  schemaVersion: 1
  contractVersion: '1.0.0'
  generatedAt: string
  inputHash: string
  project: string
  generator: GeneratorName
  status: 'pass' | 'warning' | 'fail'
  checks: QualityCheck[]
  counts: { passed: number; warnings: number; failed: number; skipped: number }
  artifacts: { report: string; accessibility?: string; visuals?: string }
  options: { offline: boolean; rendered: boolean; examples: boolean }
}

export interface QualityConfig {
  schemaVersion: 1
  links?: {
    mode?: 'online' | 'offline'
    allowHosts?: string[]
    ignore?: string[]
    timeoutMs?: number
    retries?: number
    cacheHours?: number
  }
  examples?: { enabled?: boolean }
  rendered?: {
    enabled?: boolean
    routes?: string[]
    viewports?: Array<{ name: string; width: number; height: number }>
    themes?: Array<'light' | 'dark'>
    maximumDiffRatio?: number
  }
  lint?: { maximumTitleLength?: number; maximumNavigationLabelLength?: number }
  readerVerification?: { enabled?: boolean }
  suppressions?: Array<{ code: string; file?: string; reason: string; expires?: string }>
  ratchet?: { enabled?: boolean; baselineFile?: string }
}

export type ClaimVerificationState =
  | 'verified'
  | 'inferred'
  | 'contradicted'
  | 'needs-human'

export interface ReaderVerificationMetadata {
  schemaVersion: 1
  generatedAt: string
  pages: Record<string, {
    state: ClaimVerificationState
    confidence: EvidenceConfidence
    verifiedOn?: string
    revisions: Record<string, string>
    locale: string
  }>
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

/** What the user asked Doxloop to do. Agent transcripts are never recorded. */
export type RequestKind = 'create' | 'update' | 'review'

export type RequestStatus =
  | 'running'
  | 'generating'
  | 'awaiting-review'
  | 'partially-applied'
  | 'applied'
  | 'rejected'
  | 'failed'
  | 'conflicted'
  | 'stale'
  | 'superseded'
  | 'undone'
  | 'completed'

export interface HistoryRequest {
  id: string
  createdAt: string
  finishedAt?: string | undefined
  durationMs?: number | undefined
  kind: RequestKind
  trigger: SyncRunTrigger | 'watch'
  /** The instruction the user typed, which exists nowhere else after the run. */
  requestText?: string | undefined
  agent?: string | undefined
  model?: string | undefined
  status: RequestStatus
  pagesChanged: number
  linesAdded: number
  linesRemoved: number
  validationErrors?: number | undefined
  validationWarnings?: number | undefined
  sourceSummary?: string | undefined
  error?: string | undefined
}

/** A page touched by one request, as shown beside that request. */
export interface HistoryChangedPage {
  path: string
  title?: string | undefined
  changeKind: SyncChangeKind
  decision: 'pending' | 'accepted' | 'rejected' | 'partial'
  linesAdded: number
  linesRemoved: number
}

export interface HistoryRequestPage {
  requestId: string
  path: string
  title?: string | undefined
  changeKind: SyncChangeKind
  decision: 'pending' | 'accepted' | 'rejected' | 'partial'
  decidedAt?: string | undefined
  linesAdded: number
  linesRemoved: number
  requestedAt: string
  requestText?: string | undefined
  agent?: string | undefined
  requestStatus: RequestStatus
}

export interface HistoryPage {
  path: string
  title?: string | undefined
  createdAt: string
  updatedAt: string
  changeCount: number
  evidenceConfidence?: string | undefined
  status: 'active' | 'deleted'
}

export interface DeploymentRecord {
  startedAt: string
  finishedAt?: string | undefined
  durationMs?: number | undefined
  target: string
  name?: string | undefined
  slug?: string | undefined
  visibility?: string | undefined
  url?: string | undefined
  status: 'succeeded' | 'failed'
  pagesCount?: number | undefined
  pagesCreated?: number | undefined
  pagesUpdated?: number | undefined
  pagesDeleted?: number | undefined
  error?: string | undefined
}
