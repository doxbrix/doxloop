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
}

export interface SyncConfig {
  mode: 'check' | 'propose' | 'auto'
  branch?: string
  on: string[]
  watch: string[]
  ignore: string[]
  budget?: { maxRunsPerDay?: number; maxMinutes?: number }
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
    screenshots?: { policy: string; viewport?: { width: number; height: number }; highlight?: boolean }
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
  error?: string
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
  generators: GeneratorEntry[]
  jobs: UiJob[]
  preview?: { running: boolean; url: string }
}
