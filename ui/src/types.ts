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
  budget?: { maxRunsPerDay?: number; maxMinutes?: number; maxUsd?: number }
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
  state: 'documented' | 'uncovered' | 'excluded' | 'needs-human' | 'planned' | 'stale'
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
    authentication?: { loginPath?: string }
  }
  deployment?: { target?: 'doxbrix' | 'github-pages' | 'netlify' | 'vercel'; name?: string; slug?: string; visibility?: string; apiUrl?: string; siteId?: string; projectId?: string; teamId?: string; branch?: string; basePath?: string }
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
  stages: Array<{ id: string; label: string; status: 'pending' | 'running' | 'completed' | 'failed'; startedAt?: string; finishedAt?: string; progress?: { done: number; total?: number } }>
  planId?: string
  retryable?: boolean
  recovered?: boolean
  /** What the job concluded, once its CLI reported it. */
  outcome?: JobOutcome
}

export interface JobOutcome {
  kind: 'sync'
  status: 'current' | 'stale' | 'proposal' | 'skipped' | 'failed' | 'unknown'
  message: string
  pages?: number
  proposalId?: string
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
  /** Concept pages default to a required Mermaid diagram; the reviewer can change it per page. */
  diagram?: 'required' | 'none'
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
  navigation: DocumentationPlanNavigation
  pages: DocumentationPlanPage[]
  questions: DocumentationPlanQuestion[]
  estimatedPages: number
  targetPages?: number
  estimatedEffort: 'small' | 'medium' | 'large'
  discovery: { cacheKey: string; generatedAt: string; deterministic: true; publicSignals: number; suggestedPages: { starter: number; standard: number; comprehensive: number } }
  target: { generator: string; contentDir: string; contentFormat: 'markdown' | 'rst' | 'html'; pageExtensions: string[]; navigationFiles: string[] }
  clarification: { mode: 'review' | 'defaults' | 'stop'; answers: Record<string, string> }
  execution: { limits?: { maxPages: number; maxScreenshots: number; maxMinutes: number }; agent?: string; model?: string; reasoning?: string; effort?: string; screenshots: 'auto' | 'enabled' | 'disabled' | boolean }
  /** Present when the plan was started from a content-type template such as release notes. */
  template?: DocumentationPlanTemplate
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
}

/** Any state slice the server computes may come back as a failure instead. */
export type Failed = { error: string }

export interface DriftSummary {
  status: 'current' | 'stale' | 'unknown'
  pages: Array<{ page: string; reasons?: Array<{ source: string; paths?: string[]; kind?: 'source-change' | 'max-age'; ageDays?: number }>; verifiedAt?: string }>
  trackedPages?: number
  sources?: Array<{ name: string; kind?: string; changedPaths: string[]; filteredPaths: number; baseline?: string; head?: string }>
  evidenceMap?: 'present' | 'missing'
  notes?: string[]
}

export interface ProposalChange {
  afterHash?: string
  id: string
  title: string
  path: string
  category: string
  kind: string
  binary?: boolean
  /** The file also changed in the project while the agent ran; applying needs confirmation. */
  changedDuringRun?: boolean
  hunks: Array<{ id: string; acceptedAt?: string; rejectedAt?: string; rejectionReason?: string }>
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
  editRequest?: { instruction: string; paths: string[]; allowRelated: boolean; followUps: Array<{ id: string; createdAt: string; instruction: string }> }
  revisionOf?: string
  supersededBy?: string
  archivedAt?: string
  retentionUntil?: string
  revisionRequests: Array<{ id: string; createdAt: string; instruction: string; changeIds: string[]; hunkIds: string[] }>
  humanEdits: Array<{ changeId: string; path: string; editedAt: string; evidenceDisposition: 'preserved' | 'needs-review' }>
  undo?: { status: 'available' | 'undone' | 'unavailable'; undoneAt?: string; reason?: string }
  validation?: { pages: number; errors: number; warnings: number; issues?: Array<{ severity: 'error' | 'warning'; code: string; message: string; file?: string }> }
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
  kind: 'create' | 'update' | 'review' | 'edit' | 'navigation' | 'branding' | 'asset' | 'metadata' | 'glossary'
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

export type GeneratorTier = 'full' | 'supported' | 'basic'

export interface GeneratorEntry {
  id: string
  displayName: string
  packageName?: string
  installed: boolean
  /** Adapter tier; absent only in older servers and test fixtures. */
  tier?: GeneratorTier
  tierLabel?: string
  tierDescription?: string
  /** Human labels for the runtimes the generator needs, e.g. "Python 3.9+". */
  toolchainLabels?: string[]
}

export interface GeneratorPreflightCheck {
  status: 'pass' | 'warning' | 'fail'
  label: string
  detail?: string
}

export interface GeneratorPreflight {
  generator: string
  tier: GeneratorTier
  ready: boolean
  checks: GeneratorPreflightCheck[]
}

export interface RecentProject {
  path: string
  title: string
  generator: string
  lastOpenedAt: string
  /** The project file is gone; the entry stays until forgotten. */
  missing?: boolean
}

export interface GeneratorCandidate {
  generator: string
  contentDir: string
  markers: string[]
  title?: string
}

/** A read-only look at a folder before it is imported. */
export interface ProjectInspection {
  root: string
  alreadyProject: boolean
  detection: { candidates: GeneratorCandidate[]; recommended?: GeneratorCandidate }
  generator?: string
  contentDir?: string
  title: string
  markers: string[]
  pageCount: number
  pages: string[]
  generatorInstalled: boolean
  generatorPackage?: string
}

export interface UiState {
  projectFound: boolean
  cwd: string
  root?: string
  project?: Project
  latestDeployment?: { startedAt: string; finishedAt?: string; url?: string; target: string; status: 'succeeded' | 'failed' }
  effectiveDeployment?: { target: 'doxbrix' | 'github-pages' | 'netlify' | 'vercel'; name: string; slug: string; visibility: string; apiUrl: string; siteId?: string; projectId?: string; teamId?: string; branch?: string; basePath?: string }
  validation?: Validation | Failed
  doctor?: { ready: boolean; checks: Array<{ status: string; label: string; detail?: string }> } | Failed
  runs?: Proposal[] | Failed
  syncStatus?: string | Failed
  drift?: DriftSummary | Failed
  agents?: AgentState[]
  account?: { signedIn: boolean; apiUrl: string; user?: { email: string; name: string | null }; detail?: string }
  receipt?: { mode?: string; completedAt?: string; pendingSources?: string[] } | null
  documentationPlan?: DocumentationPlan
  generators: GeneratorEntry[]
  jobs: UiJob[]
  preview?: { running: boolean; url?: string }
  recentProjects?: RecentProject[]
}

export interface PageSummary {
  version?: string
  locale?: string
  path: string
  title: string
  description?: string
  section?: string
  route: string
  wordCount: number
  updatedAt?: string
  evidence: 'verified' | 'needs-review' | 'none'
  inNavigation: boolean
}

export interface DocumentationPlanNavigation {
  top: string[]
  sections: Array<{ id: string; title: string; pageIds: string[] }>
}

export interface ReleaseCommit { hash: string; date: string; author: string; subject: string; body?: string }

export interface DocumentationPlanTemplate {
  kind: 'release-notes'
  version: string
  from: string
  to: string
  sources: string[]
  inventory: {
    version: string
    from: string
    to: string
    collectedAt: string
    sources: Array<{ source: string; from: string; to: string; commits: ReleaseCommit[]; changedFiles: string[]; truncated: boolean; changelog?: { path: string; excerpt: string } }>
  }
}

export type NavigationNode =
  | { type: 'page'; file: string; path?: string; title?: string; pageTitle?: string; icon?: string; hidden?: boolean }
  | { type: 'group'; label: string; icon?: string; hidden?: boolean; items: NavigationNode[] }
  | { type: 'label'; text: string }
  | { type: 'divider' }
  | { type: 'link'; title: string; href: string; icon?: string }
  | { type: 'api'; title: string; spec: string; icon?: string }

export interface NavigationSupport { icons: boolean; hidden: boolean; labels: boolean; links: boolean; dividers: boolean; spaces: boolean }

export interface NavigationSpace { name: string; icon?: string; nav: NavigationNode[] }

export interface NavigationTree {
  generator: string
  editable: boolean
  reason?: string
  configFile: string
  fingerprint: string
  requiresEveryPage: boolean
  supports: NavigationSupport
  spaces: NavigationSpace[]
  orphans: Array<{ file: string; path: string; title: string }>
  icons: string[]
}

export type ThemeField =
  | 'primaryColor' | 'lightColor' | 'darkColor' | 'backgroundColorLight' | 'backgroundColorDark'
  | 'font' | 'headingFont' | 'codeFont'
  | 'logoLight' | 'logoDark' | 'favicon' | 'faviconLight' | 'faviconDark' | 'backgroundImage'
  | 'mode' | 'codeTheme' | 'logoHref'

export interface Branding {
  generator: string
  editable: boolean
  reason?: string
  configFile: string
  fingerprint: string
  site: { name: string; description: string }
  theme: Partial<Record<ThemeField, string>>
  assets: Array<{ path: string; name: string; publicPath: string }>
}

export interface AssetReference { page: string; alt: string }

export interface AssetEntry {
  path: string
  name: string
  publicPath: string
  kind: 'image' | 'file'
  bytes: number
  modifiedAt: string
  references: AssetReference[]
}

export interface AssetLibraryData { directory: string; publicPrefix: string; maxBytes: number; assets: AssetEntry[] }

export type PageMetadataField = 'title' | 'description' | 'canonical' | 'socialImage' | 'icon'

export interface PageMetadata {
  path: string
  editable: boolean
  reason?: string
  fingerprint: string
  fields: Partial<Record<PageMetadataField, string>>
  otherKeys: string[]
}

export interface GlossaryTerm { term: string; definition: string }

export interface GlossaryState { terms: GlossaryTerm[]; page?: string; generated: boolean; fromPlan: number }

export interface SourceRefs {
  source: string
  tags: string[]
  branches: string[]
  head: string
  suggested?: { from: string; to: string; version: string }
}
