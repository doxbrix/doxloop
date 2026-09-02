export interface SourceRemote {
  provider: 'git' | 'github'
  repository: string
  branch: string
  subdirectory?: string
  tokenEnv?: string
  apiBaseUrl?: string
}

export interface Source {
  name: string
  path: string
  kind?: 'directory' | 'openapi'
  remote?: SourceRemote
  scope?: { space?: string; routePrefix?: string; navigationGroup?: string; sharedPages?: string[] }
}

export interface SyncConfig {
  mode: 'check' | 'propose' | 'auto'
  branch?: string
  on: string[]
  watch: string[]
  ignore: string[]
  budget?: { maxRunsPerDay?: number; maxMinutes?: number }
  maxVerificationAgeDays?: number
  maxVerificationAgeSeverity?: 'warn' | 'fail'
}

export interface SourceIntelligence {
  generatedAt: string
  health: Array<{ name: string; connector: string; status: 'healthy' | 'warning' | 'error'; checkedAt: string; lastSuccessfulAt?: string; lastMonitoringAt?: string; location: string; provider: string; branch?: string; subdirectory?: string; monitored: boolean; revision?: string; summary: string; details: string[]; openapi?: { title: string; version: string; specificationVersion: string; servers: string[]; securitySchemes: string[]; schemas: string[]; operationCount: number }; scope?: Source['scope'] }>
  coverage: {
    metrics: Array<{ id: string; label: string; documented: number; total: number; excluded: number; percent: number; status?: 'measured' | 'unknown'; denominator: string; items: CoverageItem[] }>
    groups: Array<{ source: string; scope?: Source['scope']; documented: number; total: number; percent: number; status?: 'measured' | 'unknown' }>
    pages: string[]
    disclaimer: string
  }
  evidenceDiagnostics: Array<{ severity: 'error' | 'warning'; code: string; page: string; source?: string; identifier?: string; message: string; suggestion: string }>
}

export interface CoverageItem {
  id: string
  surface: string
  label: string
  state: 'documented' | 'uncovered' | 'excluded' | 'needs-human'
  source?: string
  path?: string
  kind?: string
  page?: string
  suggestedPage?: string
  reason?: string
}

export interface Project {
  title: string
  contentDir: string
  generator: string
  defaultAgent?: string
  sources: Source[]
  designReferences: Array<{ url: string }>
  documentation: {
    primaryAudience?: string
    audiences?: string[]
    customInstructions?: string
    experienceLevel?: string
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
  application?: {
    baseUrl: string
    source?: string
    startCommand?: string
    readyPath?: string
    screenshots?: { policy: string; viewport?: { width: number; height: number }; highlight?: boolean; startPath?: string; workflow?: string }
  }
  deployment?: { name?: string; slug?: string; visibility?: string; apiUrl?: string }
  sync: SyncConfig
}

export interface UiJob {
  id: string
  type: string
  agent?: string
  status: 'running' | 'succeeded' | 'failed' | 'cancelled'
  startedAt: string
  lastOutputAt?: string
  finishedAt?: string
  exitCode?: number
  lines: string[]
  stages: Array<{ id: string; label: string; status: 'pending' | 'running' | 'completed' | 'failed'; startedAt?: string; finishedAt?: string }>
  planId?: string
  retryable?: boolean
  recovered?: boolean
}

export interface DocumentationPlanPage {
  id: string
  title: string
  path: string
  type: string
  priority: 'must-have' | 'next' | 'later'
  action: 'create' | 'update' | 'preserve' | 'remove'
  purpose: string
  rationale: string
  evidence: string[]
  evidenceDetails: Array<{ source: string; path: string; kind?: string; label?: string; line?: number }>
  visuals?: { mode: 'none' | 'recommended' | 'required'; rationale: string; estimatedCaptures: number; startPath?: string; workflow?: string; captureSequence?: string[] }
}

export interface DocumentationPlanQuestion {
  id: string
  question: string
  whyItMatters: string
  recommendation?: string
}

export interface DocumentationPlan {
  schemaVersion: 2
  id: string
  version: number
  mode: 'create' | 'update'
  status: 'planning' | 'revising' | 'needs-input' | 'ready-for-review' | 'approved' | 'generating' | 'generated' | 'failed' | 'stale' | 'cancelled'
  scope: 'starter' | 'standard' | 'comprehensive' | 'custom'
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
  experienceLevel: 'beginner' | 'intermediate' | 'advanced' | 'mixed'
  preferredExamples: string[]
  locale: string
  accessibilityTarget: string
  styleGuide: string
  capabilities: Array<{
    id: string
    title: string
    kind: string
    evidence: Array<{ source: string; path: string; kind?: string; label?: string; line?: number }>
    pageIds: string[]
    disposition: 'planned' | 'existing' | 'excluded' | 'needs-human'
  }>
  navigation: { top: string[]; sections: Array<{ id: string; title: string; pageIds: string[] }> }
  pages: DocumentationPlanPage[]
  questions: DocumentationPlanQuestion[]
  estimatedPages: number
  targetPages?: number
  estimatedEffort: 'small' | 'medium' | 'large'
  discovery: { cacheKey: string; generatedAt: string; deterministic: true; publicSignals: number; suggestedPages: { starter: number; standard: number; comprehensive: number } }
  target: { generator: string; contentDir: string; contentFormat: 'markdown' | 'rst' | 'html'; pageExtensions: string[]; navigationFiles: string[] }
  clarification: { mode: 'review' | 'defaults' | 'stop'; answers: Record<string, string> }
  execution: { agent?: string; model?: string; reasoning?: string; effort?: string; screenshots: 'auto' | 'enabled' | 'disabled' | boolean }
  approvedAt?: string
  approvedHash?: string
  proposalId?: string
  error?: string
  failure?: { stage: 'propose' | 'revise' | 'generate'; proposalId?: string; resumable: boolean; ignorable: boolean }
  advisories?: string[]
}

export interface ValidationIssue {
  severity: 'error' | 'warning'
  code: string
  message: string
  file?: string
}

export interface Validation {
  pages: string[]
  errors: number
  warnings: number
  issues: ValidationIssue[]
  error?: string
}

export interface ProposalChange {
  id: string
  title: string
  path: string
  category: string
  kind: string
  binary?: boolean
  hunks: Array<{ id: string; acceptedAt?: string; rejectedAt?: string }>
  rationale: {
    reason: string
    evidence: Array<{ source: string; path?: string; operation?: string; revision?: string; available: boolean }>
    affectedInterfaces: string[]
    claims: { added: string[]; changed: string[]; removed: string[] }
    validation: { errors: number; warnings: number }
    confidence: 'verified' | 'inferred' | 'needs-human'
    assumptions: string[]
    planId?: string
    planPageId?: string
    request?: string
    authorship: 'agent' | 'human'
  }
}

export interface DiffRow {
  type: 'context' | 'delete' | 'insert' | 'gap'
  oldNumber?: number
  newNumber?: number
  html: string
  hidden?: number
  hunkId?: string
  hunkState?: 'pending' | 'accepted' | 'rejected'
}

export interface SourceDiff {
  binary: boolean
  rows: DiffRow[]
  added: number
  removed: number
}

export interface Proposal {
  id: string
  status: string
  mode: string
  trigger: string
  createdAt: string
  summary: string
  sourceSummary: string
  stalePages: string[]
  changes: ProposalChange[]
  sourceSnapshot?: string
  authoringMode?: 'create' | 'update'
  planId?: string
  revisionOf?: string
  supersededBy?: string
  archivedAt?: string
  retentionUntil?: string
  revisionRequests: Array<{ id: string; createdAt: string; instruction: string; changeIds: string[]; hunkIds: string[] }>
  humanEdits: Array<{ changeId: string; path: string; editedAt: string; evidenceDisposition: 'preserved' | 'needs-review' }>
  undo?: { status: 'available' | 'undone' | 'unavailable'; undoneAt?: string; reason?: string }
  validation?: { pages: number; errors: number; warnings: number }
  screenshots?: { intent: 'auto' | 'enabled' | 'disabled'; status: 'not-requested' | 'planned' | 'verified' | 'skipped' | 'failed'; planned: number; captured: number; textOnly: number; guides: number; manifest?: string; message?: string; ignoredProblems?: number }
  error?: string
  resumedAt?: string
  advisories?: string[]
  recovery?: { resumable: boolean; ignorable: boolean }
}

export interface HistoryChangedPage {
  path: string
  title?: string
  changeKind: 'added' | 'modified' | 'deleted'
  decision: 'pending' | 'accepted' | 'rejected' | 'partial'
  linesAdded: number
  linesRemoved: number
}

export interface HistoryRequest {
  id: string
  pages?: HistoryChangedPage[]
  createdAt: string
  finishedAt?: string
  durationMs?: number
  kind: 'create' | 'update' | 'review'
  trigger: string
  requestText?: string
  agent?: string
  model?: string
  status: string
  pagesChanged: number
  linesAdded: number
  linesRemoved: number
  validationErrors?: number
  validationWarnings?: number
  sourceSummary?: string
  error?: string
}

export interface HistoryPageEntry {
  requestId: string
  path: string
  title?: string
  changeKind: 'added' | 'modified' | 'deleted'
  decision: 'pending' | 'accepted' | 'rejected' | 'partial'
  decidedAt?: string
  linesAdded: number
  linesRemoved: number
  requestedAt: string
  requestText?: string
  agent?: string
  requestStatus: string
}

export interface DeploymentRecord {
  startedAt: string
  finishedAt?: string
  durationMs?: number
  target: string
  name?: string
  slug?: string
  visibility?: string
  url?: string
  status: 'succeeded' | 'failed'
  pagesCount?: number
  pagesCreated?: number
  pagesUpdated?: number
  pagesDeleted?: number
  error?: string
}

export interface AgentState {
  name: string
  executable: string
  preferred: boolean
  authentication: { status: string; detail: string }
  skills: Array<{ name?: string; path?: string; status: string }>
}

export interface GeneratorEntry {
  id: string
  displayName: string
  packageName?: string
  installed: boolean
}

export interface UiState {
  projectFound: boolean
  cwd: string
  root?: string
  project?: Project
  effectiveDeployment?: { name: string; slug: string; visibility: string; apiUrl: string }
  validation?: Validation
  doctor?: { ready: boolean; checks: Array<{ status: string; label: string; detail?: string }> } | { error: string }
  runs?: Proposal[] | { error: string }
  syncStatus?: string | { error: string }
  drift?: { status: string; pages: Array<{ page: string; reasons?: unknown[] }> } | { error: string }
  agents?: AgentState[]
  account?: { signedIn: boolean; apiUrl: string; user?: { email: string; name: string | null }; detail?: string }
  receipt?: { mode?: string; completedAt?: string; pendingSources?: string[] } | null
  documentationPlan?: DocumentationPlan
  generators: GeneratorEntry[]
  jobs: UiJob[]
  preview?: { running: boolean; url: string }
}
