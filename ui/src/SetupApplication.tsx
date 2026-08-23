import type { ComponentChildren } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import './SetupApplication.css'
import { post } from './api'
import { Badge, Button, Combo, Field, Input, Lines, Note, Segmented, Select, Textarea, Toggle } from './components'
import { Icon } from './icons'
import { agentModels, defaultModelForAgent, modelReasoningLevels, preferredReasoningLevel } from './model-options'
import type { UiJob, UiState } from './types'

const DOXLOOP_LOGO = new URL('../../assets/brand/doxloop-logo-light.png', import.meta.url).href

type SetupValidation = { directoryPath?: string; directoryError?: string; sourcePath?: string; sourcePathError?: string }

type SetupSource = {
  name: string
  sourceKind: 'directory' | 'openapi'
  sourceLocation: 'git' | 'local'
  sourcePath: string
  repository: string
  branch: string
  subdirectory: string
  authMethod: 'automatic' | 'credentials'
  gitUsername: string
  gitSecret: string
  specInput: 'file' | 'url'
  specContent: string
}

type SourceFlowStep = 'closed' | 'type' | 'source-location' | 'git-access' | 'git-connect' | 'git-select' | 'local' | 'openapi-format' | 'openapi-input'

function repositoryProvider(repository: string): 'github' | 'gitlab' | 'git' {
  const value = repository.toLowerCase()
  if (value.includes('gitlab.com') || value.includes('gitlab.')) return 'gitlab'
  if (value.includes('github.com') || value.includes('github.')) return 'github'
  return 'git'
}

function repositoryProviderIcon(repository: string): string {
  const provider = repositoryProvider(repository)
  return provider === 'git' ? 'sources' : provider
}

const emptySetupSource = (): SetupSource => ({
  name: '', sourceKind: 'directory', sourceLocation: 'git', sourcePath: '', repository: '', branch: 'main',
  subdirectory: '', authMethod: 'automatic', gitUsername: '', gitSecret: '', specInput: 'file', specContent: '',
})

export function SetupApplication({ state, act, error, onOpenPreview, onContinue }: { state: UiState; act: Action; error: string; onOpenPreview: (openInSystemBrowser: boolean) => Promise<void>; onContinue: (page: 'authoring' | 'sync' | 'publish') => Promise<void> }) {
  const [form, setForm] = useState(() => {
    const agent = state.agents?.find((item) => item.executable)?.name ?? 'codex'
    const model = defaultModelForAgent(agent)
    const reasoning = preferredReasoningLevel(agent, model)
    return {
      directory: 'my-product-docs',
      title: 'Product documentation',
      sourceKind: 'directory',
      sourceLocation: 'git',
      sourceName: '',
      sourcePath: '',
      repository: '',
      branch: 'main',
      subdirectory: '',
      authMethod: 'automatic',
      gitUsername: '',
      gitSecret: '',
      specInput: 'file',
      specContent: '',
      generator: 'doxbrix',
      agent,
      model,
      reasoning: agent === 'codex' ? reasoning : '',
      effort: agent === 'claude' ? reasoning : '',
      screenshots: false,
      audiences: [] as string[],
      customInstructions: '',
    }
  })
  const [step, setStep] = useState(1)
  const [sources, setSources] = useState<SetupSource[]>([])
  const [sourceFlowStep, setSourceFlowStep] = useState<SourceFlowStep>('closed')
  const [sourceMenuOpen, setSourceMenuOpen] = useState(false)
  const [sourceAddedNotice, setSourceAddedNotice] = useState(false)
  const [setupSpecFileName, setSetupSpecFileName] = useState('')
  const setupSpecInput = useRef<HTMLInputElement>(null)
  const [savingSource, setSavingSource] = useState(false)
  const [pathErrors, setPathErrors] = useState({ directory: '', sourcePath: '' })
  const [setupError, setSetupError] = useState('')
  const [validatingPaths, setValidatingPaths] = useState(false)
  const [browsing, setBrowsing] = useState(false)
  const [gitTesting, setGitTesting] = useState(false)
  const [gitBranches, setGitBranches] = useState<string[]>([])
  const [gitDirectories, setGitDirectories] = useState<string[]>([])
  const [gitHead, setGitHead] = useState('')
  const [gitFoldersLoading, setGitFoldersLoading] = useState(false)
  const [gitDialog, setGitDialog] = useState<'access' | 'branch' | 'folder' | null>(null)
  const [gitAccessDraft, setGitAccessDraft] = useState<'automatic' | 'credentials'>('automatic')
  const [gitUsernameDraft, setGitUsernameDraft] = useState('')
  const [gitSecretDraft, setGitSecretDraft] = useState('')
  const [gitBranchDraft, setGitBranchDraft] = useState('main')
  const [gitFolderDraft, setGitFolderDraft] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [projectCreated, setProjectCreated] = useState(false)
  const [creationJob, setCreationJob] = useState<UiJob | null>(null)
  const [creationStreamConnected, setCreationStreamConnected] = useState(false)
  const [openingPreview, setOpeningPreview] = useState(false)
  const [cancellingCreation, setCancellingCreation] = useState(false)
  const [requestedAgentInstall, setRequestedAgentInstall] = useState('')
  const generators = state.generators
  const availableModels = agentModels(form.agent)
  const supportedReasoning = modelReasoningLevels(form.agent, form.model)
  const selectedAgent = state.agents?.find((agent) => agent.name === form.agent)
  const selectedAgentInstallJob = form.agent
    ? state.jobs.find((job) => job.type === 'agent:install' && job.agent === form.agent && (job.status === 'running' || job.agent === requestedAgentInstall))
    : undefined
  const agentInstallPending = requestedAgentInstall === form.agent && !selectedAgentInstallJob
  const openDocumentationPreview = async () => {
    if (openingPreview) return
    const previewTab = window.open('about:blank', '_blank')
    if (previewTab) previewTab.opener = null
    setOpeningPreview(true)
    try {
      await onOpenPreview(!previewTab)
      if (previewTab) {
        await waitForPreview('http://127.0.0.1:4321')
        previewTab.location.replace('http://127.0.0.1:4321')
      }
    } catch (cause) {
      previewTab?.close()
      throw cause
    } finally {
      setOpeningPreview(false)
    }
  }
  useEffect(() => {
    if (!creationJob || creationJob.status !== 'running') return
    const stream = new EventSource('/api/jobs/stream')
    stream.onopen = () => setCreationStreamConnected(true)
    stream.onmessage = (event) => {
      try {
        const jobs = JSON.parse(event.data) as UiJob[]
        const current = jobs.find((job) => job.id === creationJob.id)
        if (current) setCreationJob(current)
      } catch {
        // The next complete job snapshot replaces malformed or partial output.
      }
    }
    stream.onerror = () => setCreationStreamConnected(false)
    return () => {
      stream.close()
      setCreationStreamConnected(false)
    }
  }, [creationJob?.id, creationJob?.status])
  const update = (key: string, value: string) => {
    setForm((current) => ({ ...current, [key]: value }))
    setSetupError('')
    if (key === 'directory') setPathErrors((current) => ({ ...current, directory: '' }))
    if (key === 'sourcePath' || key === 'sourceKind') setPathErrors((current) => ({ ...current, sourcePath: '' }))
    if (['repository', 'authMethod', 'gitUsername', 'gitSecret', 'sourceLocation'].includes(key)) {
      setPathErrors((current) => ({ ...current, sourcePath: '' }))
      setGitHead('')
      setGitDirectories([])
    }
  }
  const sourceType = form.sourceKind === 'openapi' ? 'openapi' : form.sourceLocation === 'git' ? 'git' : 'local'
  const filteredSetupSources = sources.map((source, index) => ({ source, index }))
  const updateSourceType = (value: string) => {
    if (value === 'openapi') {
      update('sourceKind', value)
      return
    }
    setForm((current) => ({ ...current, sourceKind: 'directory', sourceLocation: value }))
    setSetupError('')
    setPathErrors((current) => ({ ...current, sourcePath: '' }))
    setGitHead('')
  }
  const currentSource = (): SetupSource => ({
    name: form.sourceName,
    sourceKind: form.sourceKind as 'directory' | 'openapi',
    sourceLocation: form.sourceLocation as 'git' | 'local',
    sourcePath: form.sourcePath,
    repository: form.repository,
    branch: form.branch,
    subdirectory: form.subdirectory,
    authMethod: form.authMethod as 'automatic' | 'credentials',
    gitUsername: form.gitUsername,
    gitSecret: form.gitSecret,
    specInput: form.specInput as 'file' | 'url',
    specContent: form.specContent,
  })
  const validatePaths = async (includeSource: boolean, source = currentSource()): Promise<SetupValidation | undefined> => {
    try {
      const result = await post<SetupValidation>('/api/setup/validate', {
        directory: form.directory,
        ...(includeSource ? {
          ...source,
        } : {}),
      })
      setPathErrors({ directory: result.directoryError ?? '', sourcePath: result.sourcePathError ?? '' })
      return result
    } catch (cause) {
      setSetupError(message(cause))
      return undefined
    }
  }
  const continueSetup = async () => {
    setValidatingPaths(true)
    try {
      if (step === 1) {
        const result = await validatePaths(false)
        if (!result || result.directoryError) return
      }
      if (step === 2) {
        for (const source of sources) {
          if (source.sourceKind === 'openapi' && source.specInput === 'file' && source.specContent.trim()) continue
          const result = await validatePaths(true, source)
          if (!result || result.directoryError || result.sourcePathError) return
        }
      }
      setStep((value) => value + 1)
    } finally {
      setValidatingPaths(false)
    }
  }
  const installSelectedAgent = async () => {
    if (!form.agent) return
    setRequestedAgentInstall(form.agent)
    const result = await act(() => post<UiJob | { name: string; executable: string; alreadyInstalled: true }>('/api/agent/install', { agent: form.agent }))
    if (!result || !('status' in result)) setRequestedAgentInstall('')
  }
  const resetSourceDraft = () => {
    const next = emptySetupSource()
    setForm((current) => ({ ...current, sourceKind: next.sourceKind, sourceLocation: next.sourceLocation, sourceName: next.name, sourcePath: next.sourcePath, repository: next.repository, branch: next.branch, subdirectory: next.subdirectory, authMethod: next.authMethod, gitUsername: next.gitUsername, gitSecret: next.gitSecret, specInput: next.specInput, specContent: next.specContent }))
    setGitHead('')
    setGitBranches([])
    setGitDirectories([])
    setPathErrors((current) => ({ ...current, sourcePath: '' }))
    setSetupSpecFileName('')
  }
  const readSetupSpecification = async (file: File | undefined) => {
    if (!file) return
    update('specContent', await file.text())
    update('sourcePath', '')
    update('specInput', 'file')
    setSetupSpecFileName(file.name)
  }
  const startSourceFlow = () => {
    resetSourceDraft()
    setSourceFlowStep('type')
  }
  const nextSourceFlowStep = () => {
    if (sourceFlowStep === 'type') {
      setSourceFlowStep(form.sourceKind === 'openapi' ? 'openapi-format' : 'source-location')
    } else if (sourceFlowStep === 'source-location') {
      setSourceFlowStep(form.sourceLocation === 'git' ? 'git-access' : 'local')
    } else if (sourceFlowStep === 'git-access') {
      setSourceFlowStep('git-connect')
    } else if (sourceFlowStep === 'openapi-format') {
      setSourceFlowStep('openapi-input')
    }
  }
  const previousSourceFlowStep = () => {
    if (sourceFlowStep === 'source-location' || sourceFlowStep === 'openapi-format') setSourceFlowStep('type')
    else if (sourceFlowStep === 'git-access' || sourceFlowStep === 'local') setSourceFlowStep('source-location')
    else if (sourceFlowStep === 'git-connect') setSourceFlowStep('git-access')
    else if (sourceFlowStep === 'git-select') setSourceFlowStep('git-connect')
    else if (sourceFlowStep === 'openapi-input') setSourceFlowStep('openapi-format')
  }
  const addSetupSource = async () => {
    const draft = currentSource()
    const location = draft.sourceKind === 'openapi' ? draft.sourcePath || 'OpenAPI Specification' : draft.sourceLocation === 'git' ? draft.repository : draft.sourcePath
    const fallback = draft.sourceKind === 'openapi' ? 'OpenAPI Specification' : draft.sourceLocation === 'git' ? 'Git Repository' : 'Local Repository'
    const segment = location.replace(/[?#].*$/, '').replace(/[\\/]+$/, '').split(/[\\/]/).pop()?.replace(/\.git$/i, '').replace(/\.(json|ya?ml)$/i, '')
    const baseName = segment || fallback
    const matching = sources.filter((source) => source.name === baseName || source.name.startsWith(`${baseName} `)).length
    const source = { ...draft, name: matching ? `${baseName} ${matching + 1}` : baseName }
    setSavingSource(true)
    try {
      const inlineSpecification = source.sourceKind === 'openapi' && source.specInput === 'file' && source.specContent.trim()
      const result = inlineSpecification ? {} : await validatePaths(true, source)
      if (!result || result.directoryError || result.sourcePathError) return
      const normalized = result.sourcePath && source.sourceLocation === 'local' ? { ...source, sourcePath: result.sourcePath } : source
      setSources((current) => [...current, normalized])
      resetSourceDraft()
      setSourceFlowStep('closed')
      setSourceMenuOpen(false)
      setSourceAddedNotice(true)
    } finally {
      setSavingSource(false)
    }
  }
  const browseSourceDirectory = async () => {
    setBrowsing(true)
    setSetupError('')
    try {
      const result = await post<{ path: string | null }>('/api/setup/browse-directory')
      if (result.path) update('sourcePath', result.path)
    } catch (cause) {
      setPathErrors((current) => ({ ...current, sourcePath: message(cause) }))
    } finally {
      setBrowsing(false)
    }
  }
  const testGitConnection = async () => {
    setGitTesting(true)
    setSetupError('')
    setPathErrors((current) => ({ ...current, sourcePath: '' }))
    try {
      const result = await post<{ repository: string; branch: string; head: string; branches: string[] }>('/api/setup/git/test', {
        repository: form.repository,
        branch: form.branch,
        authMethod: form.authMethod,
        gitUsername: form.gitUsername,
        gitSecret: form.gitSecret,
      })
      setForm((current) => ({ ...current, repository: result.repository, branch: result.branch }))
      setGitBranches(result.branches)
      await loadGitDirectories(result.repository, result.branch)
      setGitHead(result.head)
    } catch (cause) {
      setGitHead('')
      setGitDirectories([])
      setPathErrors((current) => ({ ...current, sourcePath: message(cause) }))
    } finally {
      setGitTesting(false)
    }
  }
  const loadGitDirectories = async (repository: string, branch: string) => {
    setGitFoldersLoading(true)
    try {
      const result = await post<{ directories: string[] }>('/api/setup/git/folders', { ...form, repository, branch, subdirectory: '' })
      setGitDirectories(result.directories)
    } finally {
      setGitFoldersLoading(false)
    }
  }
  const selectGitBranch = async (branch: string) => {
    setForm((current) => ({ ...current, branch, subdirectory: '' }))
    setSetupError('')
    setPathErrors((current) => ({ ...current, sourcePath: '' }))
    try {
      await loadGitDirectories(form.repository, branch)
    } catch (cause) {
      setPathErrors((current) => ({ ...current, sourcePath: message(cause) }))
    }
  }
  const editGitConnection = () => {
    setGitHead('')
    setGitBranches([])
    setGitDirectories([])
    setPathErrors((current) => ({ ...current, sourcePath: '' }))
  }
  const openGitDialog = (dialog: 'access' | 'branch' | 'folder') => {
    setGitDialog(dialog)
    setGitAccessDraft(form.authMethod as 'automatic' | 'credentials')
    setGitUsernameDraft(form.gitUsername)
    setGitSecretDraft(form.gitSecret)
    setGitBranchDraft(form.branch)
    setGitFolderDraft(form.subdirectory)
  }
  const saveGitAccess = () => {
    const changed = gitAccessDraft !== form.authMethod || gitUsernameDraft !== form.gitUsername || gitSecretDraft !== form.gitSecret
    setForm((current) => ({
      ...current,
      authMethod: gitAccessDraft,
      gitUsername: gitAccessDraft === 'credentials' ? gitUsernameDraft : '',
      gitSecret: gitAccessDraft === 'credentials' ? gitSecretDraft : '',
    }))
    if (changed) editGitConnection()
    setGitDialog(null)
  }
  const saveGitBranch = async () => {
    setGitDialog(null)
    await selectGitBranch(gitBranchDraft)
  }
  useEffect(() => {
    if (!gitDialog) return
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setGitDialog(null)
    }
    addEventListener('keydown', close)
    return () => removeEventListener('keydown', close)
  }, [gitDialog])
  const documentationRunRequest = () => ({
    mode: 'create',
    request: '',
    ...(form.agent ? { agent: form.agent } : {}),
    ...(form.model ? { model: form.model } : {}),
    ...(form.agent === 'codex' && form.reasoning ? { reasoning: form.reasoning } : {}),
    ...(form.agent === 'claude' && form.effort ? { effort: form.effort } : {}),
    screenshots: form.screenshots,
  })
  const retryDocumentationCreation = async () => {
    setSubmitting(true)
    setSetupError('')
    try {
      const result = await act(() => post<UiJob>('/api/author', documentationRunRequest()), undefined, false)
      if (result) setCreationJob(result)
      else setSetupError('Documentation creation could not be restarted. Review the log and try again.')
    } finally {
      setSubmitting(false)
    }
  }
  const cancelDocumentationCreation = async () => {
    if (!creationJob || creationJob.status !== 'running') return
    setCancellingCreation(true)
    try {
      const result = await act(() => post<UiJob>(`/api/jobs/${creationJob.id}/cancel`), undefined, false)
      if (result) setCreationJob(result)
    } finally {
      setCancellingCreation(false)
    }
  }
  const createDocumentation = async () => {
    setSubmitting(true)
    setSetupError('')
    try {
      if (!projectCreated) {
        const directoryValidation = await validatePaths(false)
        if (!directoryValidation) return
        if (directoryValidation.directoryError) {
          setStep(1)
          return
        }
        for (const source of sources) {
          if (source.sourceKind === 'openapi' && source.specInput === 'file' && source.specContent.trim()) continue
          const validation = await validatePaths(true, source)
          if (!validation || validation.sourcePathError) {
            setStep(2)
            return
          }
        }
      }
      if (!projectCreated) {
        const created = await act(() => post<UiState>('/api/project', {
          ...form,
          sources,
          documentation: {
            audiences: form.audiences,
            primaryAudience: form.audiences.join(', '),
            customInstructions: form.customInstructions,
          },
        }), undefined, false)
        if (!created) {
          setSetupError('The documentation workspace could not be created. Review the configuration and try again.')
          return
        }
        setProjectCreated(true)
      }
      const result = await act(() => post<UiJob>('/api/author', documentationRunRequest()), undefined, false)
      if (result) setCreationJob(result)
      else setSetupError('Documentation creation could not be started. Review the configuration and try again.')
    } finally {
      setSubmitting(false)
    }
  }
  return <div class="setup reference-setup">
    <section class="setup-panel">
      <aside class="setup-rail">
        <div class="doxloop-sidebar-brand"><span><img src={DOXLOOP_LOGO} alt="Doxloop" /></span></div>
        <div class="setup-sidebar-heading"><strong>Create documentation</strong><small>Configure your documentation workspace</small></div>
        <nav class="reference-sidebar-nav setup-reference-nav" aria-label="Setup navigation">{([['folder', 'Workspace', 'Name your workspace'], ['sources', 'Sources', 'Connect your content'], ['settings', 'Tools', 'Configure generation'], ['users', 'Guidance', 'Audience and instructions'], ['quality', 'Review', 'Review and create']] as const).map(([icon, label, detail], index) => <button type="button" key={label} disabled={Boolean(creationJob) || index + 1 > step} class={step === index + 1 ? 'active' : ''} onClick={() => setStep(index + 1)}><Icon name={icon} size={18} /><span><strong>{label}</strong><small>{detail}</small></span></button>)}</nav>
      </aside>
      <div class={`setup-body ${step === 1 ? 'setup-home-body' : step === 5 ? 'setup-review-body' : ''} ${creationJob?.status === 'succeeded' ? 'setup-complete-body' : ''}`}>
        {step === 1 && <div class="setup-home-card">
          <header class="setup-home-heading"><span><Icon name="folder" size={34} /></span><div><h1>Let's name your workspace</h1><p>This will be your docs' home in Doxloop.</p></div></header>
          <div class="setup-home-fields"><section class="setup-home-field"><span class="setup-home-field-icon workspace"><Icon name="folder" size={25} /></span><Field label="Workspace name" hint="This is the folder where your docs will live."><ValidatedSetupInput value={form.directory} valid={Boolean(form.directory.trim()) && !pathErrors.directory} invalid={Boolean(pathErrors.directory)} onInput={(value) => update('directory', value)} />{pathErrors.directory && <small class="field-error">{pathErrors.directory}</small>}</Field></section><section class="setup-home-field"><span class="setup-home-field-icon title">T<small>T</small></span><Field label="What should we call your docs?" hint="This is the title people will see."><ValidatedSetupInput value={form.title} valid={Boolean(form.title.trim())} onInput={(value) => update('title', value)} /></Field></section></div>
        </div>}
        {false && step === 2 && sourceType === 'git' && <><div class="git-connect-heading"><SetupStepHeading visual="📁" title="Connect a source" detail="Paste your Git repository URL. We'll handle the rest." /><Button size="sm" tone="ghost" onClick={() => updateSourceType('local')}>Change source type</Button></div>
          <div class="git-connect-page">
            <div class={`git-repository-box ${gitHead ? 'connected' : ''}`}><Icon name="sources" size={19} /><Input value={form.repository} aria-invalid={Boolean(pathErrors.sourcePath)} placeholder="https://github.com/company/product" onInput={(event) => update('repository', event.currentTarget.value)} />{gitHead ? <span class="git-repository-check"><Icon name="check" size={19} /></span> : <Button type="button" tone="primary" busy={gitTesting} disabled={!form.repository.trim() || (form.authMethod === 'credentials' && !form.gitSecret)} onClick={() => void testGitConnection()}>Connect</Button>}</div>
            {pathErrors.sourcePath && <small class="field-error">{pathErrors.sourcePath}</small>}
            <div class="git-summary-list">
              <GitSettingRow icon="cloud" label="Access" value={form.authMethod === 'credentials' ? 'Private repository' : 'Public or already connected'} onChange={() => openGitDialog('access')} />
              <GitSettingRow icon="sources" label="Branch" value={gitHead ? form.branch : 'Available after connecting'} disabled={!gitHead} onChange={() => openGitDialog('branch')} />
              <GitSettingRow icon="folder" label="Folder" value={gitHead ? form.subdirectory || 'Entire repository' : 'Available after connecting'} disabled={!gitHead || gitFoldersLoading} onChange={() => openGitDialog('folder')} />
            </div>
            {gitHead && <div class="git-connected-banner"><span><Icon name="check" size={16} /></span><div><strong>All set! We can access this repository.</strong><small>{gitBranches.length} {gitBranches.length === 1 ? 'branch' : 'branches'} available</small></div></div>}
          </div></>}
        {false && step === 2 && sourceType !== 'git' && <><SetupStepHeading visual="📁" title="Where is your content?" detail="Tell us where your product content is stored." />
          <div class="setup-form-stack"><span class="field-label">Source type</span><div class="source-type-grid">
            <SourceTypeChoice selected={false} visual="code" title="Git repository" detail="Connect a GitHub, GitLab, Azure DevOps or other Git service." onClick={() => updateSourceType('git')} />
            <SourceTypeChoice selected={sourceType === 'local'} visual="folder" title="Local folder" detail="Use a folder on your computer or network." onClick={() => updateSourceType('local')} />
            <SourceTypeChoice selected={sourceType === 'openapi'} visual="api" title="API / OpenAPI" detail="Import from an OpenAPI spec file or URL." onClick={() => updateSourceType('openapi')} />
          </div>
            {false && <div class="setup-source-details"><Field label="Repository URL"><div class="path-input git-url-input"><Input value={form.repository} aria-invalid={Boolean(pathErrors.sourcePath)} placeholder="https://github.com/company/product" onInput={(event) => update('repository', event.currentTarget.value)} />{gitHead ? <span class="setup-input-check"><Icon name="check" size={14} /></span> : <Button type="button" tone="primary" busy={gitTesting} disabled={!form.repository.trim() || (form.authMethod === 'credentials' && !form.gitSecret)} onClick={() => void testGitConnection()}>Connect</Button>}</div>{pathErrors.sourcePath && <small class="field-error">{pathErrors.sourcePath}</small>}</Field>
              <section class="setup-git-options"><div class="setup-section-title"><span><Icon name="settings" size={15} /></span><div><strong>Repository settings</strong><small>Access, branch and folder are always visible.</small></div>{gitHead && <Button size="sm" tone="ghost" onClick={editGitConnection}>Reconnect</Button>}</div>
                <div class="git-option-grid">
                  <Field label="Access"><Segmented value={form.authMethod as 'automatic' | 'credentials'} onChange={(value) => update('authMethod', value)} items={[['automatic', 'Public'], ['credentials', 'Private']] as const} /></Field>
                  <Field label="Branch" hint={gitHead ? `${gitBranches.length} available` : 'Available after connecting.'}><Select value={form.branch} disabled={!gitHead || gitFoldersLoading} onChange={(event) => void selectGitBranch(event.currentTarget.value)}>{gitHead ? gitBranches.map((branch) => <option key={branch} value={branch}>{branch}</option>) : <option value="main">Connect repository first</option>}</Select></Field>
                  <RepositoryFolderSelect value={form.subdirectory} directories={gitDirectories} loading={gitFoldersLoading} connected={Boolean(gitHead)} onChange={(value) => update('subdirectory', value)} />
                </div>
                {form.authMethod === 'credentials' && <div class="git-private-section"><div class="git-private-heading"><Icon name="lock" size={15} /><span><strong>Private repository access</strong><small>Read-only permission is enough. Credentials are never saved in the project.</small></span></div><div class="git-private-fields"><Field label="Account username"><Input value={form.gitUsername} autocomplete="username" onInput={(event) => update('gitUsername', event.currentTarget.value)} /></Field><Field label="Personal access token"><Input type="password" value={form.gitSecret} autocomplete="off" onInput={(event) => update('gitSecret', event.currentTarget.value)} /></Field></div></div>}
                {gitHead && <div class="git-ready-inline"><Icon name="check" size={13} /><span>Repository connected successfully</span></div>}
              </section></div>}
            {sourceType === 'local' && <div class="setup-source-details"><Field label="Local folder"><div class="path-input"><Input value={form.sourcePath} aria-invalid={Boolean(pathErrors.sourcePath)} placeholder="/path/to/my-product" onInput={(event) => update('sourcePath', event.currentTarget.value)} /><Button type="button" icon="folder" busy={browsing} onClick={() => void browseSourceDirectory()}>Browse</Button></div>{pathErrors.sourcePath && <small class="field-error">{pathErrors.sourcePath}</small>}</Field></div>}
            {sourceType === 'openapi' && <div class="setup-source-details"><Field label="OpenAPI file or URL"><Input value={form.sourcePath} aria-invalid={Boolean(pathErrors.sourcePath)} placeholder="openapi.yaml or https://…" onInput={(event) => update('sourcePath', event.currentTarget.value)} />{pathErrors.sourcePath && <small class="field-error">{pathErrors.sourcePath}</small>}</Field></div>}
          </div></>}
        {false && step === 2 && <><SetupStepHeading visual="📚" title="Connect your sources" detail="Bring repositories, local folders, and API specifications together in one documentation." />
          <div class="multi-source-step">
            {sources.length > 0 && <div class="connected-source-list">
              <div class="connected-source-heading"><span><strong>Sources</strong><small>{sources.length} configured source{sources.length === 1 ? '' : 's'} for this documentation.</small></span>{sourceFlowStep === 'closed' && <Button size="sm" tone="primary" icon="plus" onClick={startSourceFlow}>Add Sources</Button>}</div>
              {sources.map((source, index) => <div class="connected-source-card" key={`${source.name}-${index}`}>
                <span class={`connected-source-icon ${source.sourceKind === 'openapi' ? 'api' : source.sourceLocation}`}><Icon name={source.sourceKind === 'openapi' ? 'api' : source.sourceLocation === 'git' ? 'sources' : 'folder'} size={17} /></span>
                <div><strong>{source.name}</strong><small>{source.sourceKind === 'openapi' ? 'OpenAPI Specification' : source.sourceLocation === 'git' ? 'Git Repository' : 'Local Folder'}</small><code>{source.sourceKind === 'openapi' ? source.sourcePath : source.sourceLocation === 'git' ? `${source.repository} · ${source.branch}${source.subdirectory ? ` / ${source.subdirectory}` : ''}` : source.sourcePath}</code></div>
                <button type="button" aria-label={`Remove ${source.name}`} onClick={() => setSources((current) => current.filter((_, itemIndex) => itemIndex !== index))}><Icon name="trash" size={14} /></button>
              </div>)}
            </div>}
            {sources.length === 0 && sourceFlowStep === 'closed' && <div class="add-sources-empty"><span><Icon name="sources" size={19} /></span><div><strong>No sources added yet</strong><small>Add a repository or OpenAPI specification to begin.</small></div><Button tone="primary" icon="plus" onClick={startSourceFlow}>Add Sources</Button></div>}
            {sourceFlowStep !== 'closed' && <section class="source-composer source-wizard">
              <header><div><span class="source-number">{sources.length + 1}</span><span><strong>{sourceFlowTitle(sourceFlowStep)}</strong><small>{sourceFlowDetail(sourceFlowStep)}</small></span></div><Button size="sm" tone="ghost" onClick={() => { resetSourceDraft(); setSourceFlowStep('closed') }}>Cancel</Button></header>
              <div class="source-wizard-body">
                {sourceFlowStep === 'type' && <Field label="Add Sources"><Select value={form.sourceKind === 'openapi' ? 'openapi' : 'directory'} onChange={(event) => updateSourceType(event.currentTarget.value === 'openapi' ? 'openapi' : 'git')}><option value="directory">Source</option><option value="openapi">OpenAPI Specification</option></Select></Field>}
                {sourceFlowStep === 'source-location' && <Field label="Choose source"><Select value={form.sourceLocation} onChange={(event) => updateSourceType(event.currentTarget.value)}><option value="local">Local Repository</option><option value="git">Git Repository</option></Select></Field>}
                {sourceFlowStep === 'git-access' && <Field label="Repository access"><Select value={form.authMethod} onChange={(event) => update('authMethod', event.currentTarget.value)}><option value="automatic">Public Repository</option><option value="credentials">Private Repository</option></Select></Field>}
              {sourceFlowStep === 'git-connect' && <div class="source-wizard-fields"><Field label="Repository URL"><Input value={form.repository} aria-invalid={Boolean(pathErrors.sourcePath)} onInput={(event) => update('repository', event.currentTarget.value)} /></Field>{form.authMethod === 'credentials' && <><Field label="Username"><Input value={form.gitUsername} autocomplete="username" onInput={(event) => update('gitUsername', event.currentTarget.value)} /></Field><Field label="Personal Access Token (PAT)"><Input type="password" value={form.gitSecret} autocomplete="off" onInput={(event) => update('gitSecret', event.currentTarget.value)} /></Field></>}<div class="credential-note"><Icon name="shield" size={14} />{form.authMethod === 'credentials' ? 'Credentials are used only to authenticate and are not saved in the project.' : 'Doxloop will connect with read-only access.'}</div></div>}
                {sourceFlowStep === 'git-select' && <div class="source-wizard-fields"><div class="source-authenticated"><Icon name="check" size={13} /><span>Repository connected. Choose the content to use.</span></div><div class="source-option-grid"><Field label="Branch" hint={`${gitBranches.length} available`}><Select value={form.branch} disabled={gitFoldersLoading} onChange={(event) => void selectGitBranch(event.currentTarget.value)}>{gitBranches.map((branch) => <option key={branch} value={branch}>{branch}</option>)}</Select></Field><RepositoryFolderSelect value={form.subdirectory} directories={gitDirectories} loading={gitFoldersLoading} connected={Boolean(gitHead)} onChange={(value) => update('subdirectory', value)} /></div></div>}
                {sourceFlowStep === 'local' && <Field label="Local Repository"><div class="path-input"><Input value={form.sourcePath} aria-invalid={Boolean(pathErrors.sourcePath)} onInput={(event) => update('sourcePath', event.currentTarget.value)} /><Button type="button" icon="folder" busy={browsing} onClick={() => void browseSourceDirectory()}>Select folder</Button></div>{form.sourcePath && <small class="selected-path"><Icon name="folder" size={13} />Selected repository · {form.sourcePath}</small>}</Field>}
                {sourceFlowStep === 'openapi-format' && <Field label="Provide specification as"><Select value={form.specInput} onChange={(event) => { update('specInput', event.currentTarget.value); update('sourcePath', '') }}><option value="url">OpenAPI specification URL</option><option value="file">OpenAPI YAML/JSON</option></Select></Field>}
                {sourceFlowStep === 'openapi-input' && <Field label={form.specInput === 'url' ? 'OpenAPI specification URL' : 'OpenAPI YAML/JSON'}><Input value={form.sourcePath} aria-invalid={Boolean(pathErrors.sourcePath)} onInput={(event) => update('sourcePath', event.currentTarget.value)} /></Field>}
                {pathErrors.sourcePath && <small class="field-error">{pathErrors.sourcePath}</small>}
              </div>
              <footer><Button disabled={sourceFlowStep === 'type'} onClick={previousSourceFlowStep}>Back</Button>{['type', 'source-location', 'git-access', 'openapi-format'].includes(sourceFlowStep) && <Button tone="primary" onClick={nextSourceFlowStep}>Next <Icon name="arrowRight" size={14} /></Button>}{sourceFlowStep === 'git-connect' && <Button tone="primary" busy={gitTesting} disabled={!form.repository.trim() || (form.authMethod === 'credentials' && (!form.gitUsername.trim() || !form.gitSecret.trim()))} onClick={() => void testGitConnection()}>Next <Icon name="arrowRight" size={14} /></Button>}{sourceFlowStep === 'git-select' && <Button tone="primary" icon="plus" busy={savingSource} disabled={!gitHead || gitFoldersLoading} onClick={() => void addSetupSource()}>Add Source</Button>}{(sourceFlowStep === 'local' || sourceFlowStep === 'openapi-input') && <Button tone="primary" icon="plus" busy={savingSource} disabled={!form.sourcePath.trim()} onClick={() => void addSetupSource()}>Add Source</Button>}</footer>
            </section>}
            {sourceFlowStep === 'closed' && sources.length > 0 && <div class="multi-source-note"><Icon name="info" size={15} /><span>Use “+ Add Sources” to combine another repository or OpenAPI specification with this documentation.</span></div>}
          </div></>}
        {step === 2 && <><header class="sources-page-header setup-sources-header"><div><h1>Sources</h1><p>Manage all the sources you've connected to create documentation.</p></div><div class="sources-page-tools"><div class="sources-add-wrap"><button type="button" class="sources-add-dropdown-button" aria-expanded={sourceMenuOpen} onClick={() => setSourceMenuOpen((open) => !open)}><Icon name="plus" size={16} />Add source<Icon name="chevronDown" size={14} /></button>{sourceMenuOpen && <div class="sources-add-menu"><button type="button" onClick={() => { resetSourceDraft(); setForm((current) => ({ ...current, sourceKind: 'directory', sourceLocation: 'git' })); setSourceFlowStep('source-location') }}><span><Icon name="api" size={20} /></span><span><strong>Source code</strong></span></button><button type="button" onClick={() => { resetSourceDraft(); setForm((current) => ({ ...current, sourceKind: 'openapi' })); setSourceFlowStep('openapi-format') }}><span><Icon name="braces" size={20} /></span><span><strong>OpenAPI spec</strong></span></button></div>}</div></div></header>
          <section class="sources-data-panel setup-sources-table"><header>All sources ({sources.length})</header><div class="sources-table-head"><span>Name</span><span>Type</span><span>Last updated</span><span>Status</span><span /></div>{filteredSetupSources.length ? <div class="sources-table-body">{filteredSetupSources.map(({ source, index }) => <div class="sources-data-row" key={`${source.name}-${index}`}><span class="sources-name-cell"><span class={`source-service-icon ${source.sourceKind === 'openapi' ? 'openapi' : source.sourceLocation === 'git' ? `git ${repositoryProvider(source.repository)}` : 'local'}`}><Icon name={source.sourceKind === 'openapi' ? 'braces' : source.sourceLocation === 'git' ? repositoryProviderIcon(source.repository) : 'folder'} size={20} /></span><span><strong>{source.name}</strong><small>{source.sourceKind === 'openapi' ? source.sourcePath || 'Uploaded OpenAPI specification' : source.sourceLocation === 'git' ? source.repository : source.sourcePath}</small></span></span><span><em class={`source-type-pill ${source.sourceKind === 'openapi' ? 'openapi' : source.sourceLocation}`}>{source.sourceKind === 'openapi' ? 'OpenAPI' : source.sourceLocation === 'git' ? 'Git' : 'Local'}</em></span><span class="source-updated">Just now</span><span><em class="source-sync-status"><Icon name="check" size={12} />Synced</em></span><span class="source-row-menu"><button type="button" aria-label={`Delete ${source.name}`} title="Delete source" onClick={() => setSources((current) => current.filter((_, itemIndex) => itemIndex !== index))}><Icon name="trash" size={22} /></button></span></div>)}</div> : <div class="sources-table-empty"><Icon name={sources.length ? 'search' : 'sources'} size={28} /><strong>{sources.length ? 'No matching sources' : 'No sources added yet'}</strong><small>{sources.length ? 'Try a different name, URL, path, or source type.' : 'Use “Add source” to connect your first source.'}</small></div>}<footer><span>Showing {filteredSetupSources.length ? `1 to ${filteredSetupSources.length}` : '0'} of {sources.length} results</span><span><button disabled><Icon name="chevronRight" size={14} /></button><button disabled><Icon name="chevronRight" size={14} /></button></span></footer></section>
          {sourceAddedNotice && <div class="source-added-success"><span><Icon name="check" size={20} /></span><div><strong>Source added successfully!</strong><small>The source will appear in the list.</small></div><button type="button" aria-label="Dismiss" onClick={() => setSourceAddedNotice(false)}><Icon name="close" size={13} /></button></div>}
          {false && sourceFlowStep !== 'closed' && sourceFlowStep !== 'type' && <div class="source-modal-scrim" onClick={() => setSourceFlowStep('closed')}><section class="source-reference-modal" role="dialog" aria-modal="true" aria-labelledby="add-source-title" onClick={(event) => event.stopPropagation()}>
            <header><strong id="add-source-title">Add Source</strong><button type="button" aria-label="Close" onClick={() => setSourceFlowStep('closed')}><Icon name="close" size={15} /></button></header>
            <div class="source-reference-modal-body">
              {sourceFlowStep === 'source-location' && <><p>How would you like to add the source?</p><div class="reference-choice-list"><ReferenceChoice icon="github" title="Git Source" detail="Add from a Git repository" onClick={() => setSourceFlowStep('git-access')} /><ReferenceChoice icon="folder" tone="folder" title="Local Repository" detail="Add from your local folder" onClick={() => { updateSourceType('local'); setSourceFlowStep('local') }} /></div></>}
              {sourceFlowStep === 'git-access' && <><p>Is this a public or private repository?</p><div class="reference-choice-list"><ReferenceChoice icon="cloud" title="Public Git" detail="Anyone can access" onClick={() => { update('authMethod', 'automatic'); setSourceFlowStep('git-connect') }} /><ReferenceChoice icon="lock" title="Private Git" detail="Requires authentication" onClick={() => { update('authMethod', 'credentials'); setSourceFlowStep('git-connect') }} /></div></>}
              {sourceFlowStep === 'git-connect' && <div class="reference-modal-fields">{form.authMethod === 'automatic' && <p>Enter the public repository URL</p>}<Field label={form.authMethod === 'credentials' ? 'Repository URL' : ''}><Input value={form.repository} placeholder="https://github.com/owner/repo.git" onInput={(event) => update('repository', event.currentTarget.value)} /></Field>{form.authMethod === 'credentials' && <><Field label="Username"><Input value={form.gitUsername} autocomplete="username" placeholder="Enter username" onInput={(event) => update('gitUsername', event.currentTarget.value)} /></Field><Field label="Personal Access Token (PAT)"><Input type="password" value={form.gitSecret} autocomplete="off" placeholder="Enter personal access token" onInput={(event) => update('gitSecret', event.currentTarget.value)} /></Field></>}</div>}
              {sourceFlowStep === 'git-select' && <div class="reference-modal-fields"><Field label="Select branch"><Select value={form.branch} disabled={gitFoldersLoading} onChange={(event) => void selectGitBranch(event.currentTarget.value)}>{gitBranches.map((branch) => <option key={branch} value={branch}>{branch}</option>)}</Select></Field><Field label="Select folder"><RepositoryFolderTree value={form.subdirectory} directories={gitDirectories} loading={gitFoldersLoading} onChange={(value) => update('subdirectory', value)} /></Field></div>}
              {sourceFlowStep === 'local' && <div class="reference-modal-fields"><p>Select your local repository or folder</p><Field label="Local repository"><div class="path-input"><Input value={form.sourcePath} placeholder="/path/to/local-repository" onInput={(event) => update('sourcePath', event.currentTarget.value)} /><Button icon="folder" busy={browsing} onClick={() => void browseSourceDirectory()}>Browse</Button></div></Field></div>}
              {sourceFlowStep === 'openapi-format' && <><p>How would you like to add the OpenAPI specification?</p><div class="reference-choice-list compact"><ReferenceChoice icon="external" title="From URL" detail="Provide a URL to your OpenAPI spec" onClick={() => { update('specInput', 'url'); setSourceFlowStep('openapi-input') }} /><ReferenceChoice icon="api" tone="api" title="From YAML / JSON" detail="Paste your YAML or JSON content" onClick={() => { update('specInput', 'file'); setSourceFlowStep('openapi-input') }} /></div></>}
              {sourceFlowStep === 'openapi-input' && <div class="reference-modal-fields">{form.specInput === 'url' ? <><p>Enter OpenAPI specification URL</p><Input value={form.sourcePath} placeholder="https://example.com/openapi.yaml" onInput={(event) => update('sourcePath', event.currentTarget.value)} /></> : <><p>Paste your OpenAPI specification</p><Textarea value={form.specContent} placeholder="Paste YAML or JSON content here..." onInput={(event) => update('specContent', event.currentTarget.value)} /></>}</div>}
              {pathErrors.sourcePath && <small class="reference-modal-error">{pathErrors.sourcePath}</small>}
            </div>
            {['git-connect', 'git-select', 'local', 'openapi-input'].includes(sourceFlowStep) && <footer>{sourceFlowStep === 'git-connect' ? <Button tone="primary" busy={gitTesting} disabled={!form.repository.trim() || (form.authMethod === 'credentials' && (!form.gitUsername.trim() || !form.gitSecret.trim()))} onClick={() => void testGitConnection()}>Next</Button> : <Button tone="primary" busy={savingSource} disabled={sourceFlowStep === 'git-select' ? !gitHead || gitFoldersLoading : sourceFlowStep === 'local' ? !form.sourcePath.trim() : form.specInput === 'url' ? !form.sourcePath.trim() : !form.specContent.trim()} onClick={() => void addSetupSource()}>Add Source</Button>}</footer>}
          </section></div>}
          {sourceFlowStep !== 'closed' && <div class="sources-modal-scrim" onClick={() => setSourceFlowStep('closed')}><section class={`sources-reference-dialog ${form.sourceKind === 'openapi' ? 'openapi' : 'source'}`} role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
            <header>{form.sourceKind === 'openapi' && <span class="sources-dialog-icon"><Icon name="file" size={24} /></span>}<div><h2>{form.sourceKind === 'openapi' ? 'Add OpenAPI spec' : 'Add source code'}</h2><p>{form.sourceKind === 'openapi' ? 'Import your OpenAPI specification from a local file or a public URL.' : 'Choose how you want to connect your source code.'}</p></div><button type="button" aria-label="Close" onClick={() => setSourceFlowStep('closed')}><Icon name="close" size={17} /></button></header>
            {form.sourceKind === 'directory' ? <div class="sources-dialog-body"><span class="dialog-section-label">Source type</span><div class="source-mode-grid"><button type="button" class={sourceType === 'git' ? 'selected' : ''} onClick={() => updateSourceType('git')}><span><Icon name="api" size={22} /></span><i /><strong>Git repository</strong><small>Connect a GitHub, GitLab, Azure DevOps or other Git service.</small></button><button type="button" class={sourceType === 'local' ? 'selected' : ''} onClick={() => updateSourceType('local')}><span><Icon name="folder" size={22} /></span><i /><strong>Local folder</strong><small>Use a folder on your computer or network.</small></button></div>{sourceType === 'git' ? <div class="source-code-fields"><Field label="Repository access"><Select value={form.authMethod} onChange={(event) => { update('authMethod', event.currentTarget.value); editGitConnection() }}><option value="automatic">Public repository</option><option value="credentials">Private repository</option></Select></Field><Field label="Repository URL"><div class="repository-connect-input"><Input value={form.repository} onInput={(event) => { update('repository', event.currentTarget.value); editGitConnection() }} /><RepositoryConnectButton connected={Boolean(gitHead)} busy={gitTesting} disabled={!form.repository.trim() || (form.authMethod === 'credentials' && (!form.gitUsername.trim() || !form.gitSecret.trim()))} onClick={() => void testGitConnection()} /></div></Field>{form.authMethod === 'credentials' && <div class="private-git-fields"><Field label="Username"><Input value={form.gitUsername} autocomplete="username" onInput={(event) => { update('gitUsername', event.currentTarget.value); editGitConnection() }} /></Field><Field label="Personal Access Token (PAT)"><Input type="password" value={form.gitSecret} autocomplete="off" onInput={(event) => { update('gitSecret', event.currentTarget.value); editGitConnection() }} /></Field></div>}<div class="source-branch-grid"><Field label="Branch"><Select value={form.branch} disabled={!gitHead || gitTesting} onChange={(event) => void selectGitBranch(event.currentTarget.value)}>{gitBranches.length ? gitBranches.map((branch) => <option key={branch}>{branch}</option>) : <option>{gitTesting ? 'Connecting...' : 'Connect repository first'}</option>}</Select></Field><Field label="Folder (optional)"><Select value={form.subdirectory} disabled={!gitHead || gitFoldersLoading} onChange={(event) => update('subdirectory', event.currentTarget.value)}><option value="">/</option>{gitDirectories.map((directory) => <option key={directory}>{directory}</option>)}</Select></Field></div></div> : <Field label="Local folder"><div class="source-folder-input"><Input value={form.sourcePath} onInput={(event) => update('sourcePath', event.currentTarget.value)} /><Button icon="folder" busy={browsing} onClick={() => void browseSourceDirectory()}>Browse</Button></div></Field>}</div> : <div class="sources-dialog-body openapi-body"><div class="openapi-tabs"><button type="button" class={form.specInput === 'file' ? 'active' : ''} onClick={() => update('specInput', 'file')}><Icon name="publish" size={18} />Upload file</button><button type="button" class={form.specInput === 'url' ? 'active' : ''} onClick={() => update('specInput', 'url')}><Icon name="external" size={18} />From URL</button></div>{form.specInput === 'file' ? <div class={`openapi-dropzone ${setupSpecFileName ? 'has-file' : ''}`} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); void readSetupSpecification(event.dataTransfer?.files[0]) }}><input ref={setupSpecInput} type="file" accept=".yaml,.yml,.json,application/json,text/yaml" onChange={(event) => void readSetupSpecification(event.currentTarget.files?.[0])} /><span><Icon name={setupSpecFileName ? 'check' : 'publish'} size={28} /></span><strong>{setupSpecFileName || 'Drag and drop your OpenAPI file here'}</strong>{!setupSpecFileName && <small>or</small>}<Button onClick={() => setupSpecInput.current?.click()}>{setupSpecFileName ? 'Choose another file' : 'Browse file'}</Button><em>Accepted formats: .yaml, .yml, .json</em></div> : <Field label="OpenAPI spec URL"><div class="openapi-url-input"><Icon name="external" size={18} /><Input value={form.sourcePath} onInput={(event) => { update('sourcePath', event.currentTarget.value); update('specContent', ''); setSetupSpecFileName('') }} /></div><small>We support public URLs and standard OpenAPI formats.</small></Field>}</div>}
            <footer><Button onClick={() => setSourceFlowStep('closed')}>Cancel</Button><Button tone="primary" busy={savingSource} disabled={form.sourceKind === 'directory' ? sourceType === 'git' ? !gitHead || gitFoldersLoading : !form.sourcePath.trim() : form.specInput === 'file' ? !form.specContent.trim() : !form.sourcePath.trim()} onClick={() => void addSetupSource()}>Add source</Button></footer>
          </section></div>}
        </>}
        {step === 3 && <div class="setup-tools-stage"><SetupStepHeading visual="🪄" title="Configure your tools" detail="Choose how Doxloop should generate your documentation." />
          <div class="setup-tools"><Field label="Documentation generator" hint="Creates and organizes your documentation."><Select value={form.generator} onChange={(event) => update('generator', event.currentTarget.value)}>{generators.map((item) => <option value={item.id}>{item.displayName}</option>)}</Select>{form.generator === 'doxbrix' && <small class="recommended-label"><Icon name="sparkle" size={12} />Recommended</small>}</Field><Field label="Coding assistant" hint="Helps understand and explain your product."><Select value={form.agent} disabled={selectedAgentInstallJob?.status === 'running'} onChange={(event) => {
            const agent = event.currentTarget.value
            const model = defaultModelForAgent(agent)
            const level = preferredReasoningLevel(agent, model)
            setRequestedAgentInstall('')
            setForm((current) => ({ ...current, agent, model, reasoning: agent === 'codex' ? level : '', effort: agent === 'claude' ? level : '' }))
          }}><option value="">Select coding assistant</option><option value="codex">Codex</option><option value="claude">Claude Code</option><option value="gemini">Gemini</option></Select>{form.agent === 'codex' && <small class="recommended-label"><Icon name="sparkle" size={12} />Recommended</small>}</Field>
            {form.agent && !selectedAgent && <div class="setup-agent-readiness missing">
              <span class="setup-agent-readiness-icon"><Icon name="alert" size={17} /></span>
              <div class="setup-agent-readiness-copy"><strong>{agentLabel(form.agent)} is not installed</strong><small>Install this coding agent to continue creating your documentation.</small></div>
              {selectedAgentInstallJob
                ? <AgentInstallProgress job={selectedAgentInstallJob} onRetry={() => void installSelectedAgent()} />
                : <Button size="sm" tone="primary" busy={agentInstallPending} onClick={() => void installSelectedAgent()}>Install {agentLabel(form.agent)}</Button>}
            </div>}
            <Field label="Select Model" hint={form.agent ? `Search suggested ${agentLabel(form.agent)} models or enter another model ID.` : 'Select a coding assistant first.'}><Combo value={form.model} options={availableModels.map((model) => [model.id, model.label] as const)} disabled={!form.agent} placeholder="Search or enter a model ID" onValueChange={(value) => update('model', value)} /></Field><Field label={form.agent === 'claude' ? 'Effort' : 'Reasoning'} hint={supportedReasoning.length ? 'Search suggested levels or enter a custom value.' : 'Enter a supported value, or leave blank for the default.'}><Combo value={form.agent === 'claude' ? form.effort : form.reasoning} options={supportedReasoning.map((value) => [value, value] as const)} disabled={!form.agent} placeholder="Search or enter a value" onValueChange={(value) => update(form.agent === 'claude' ? 'effort' : 'reasoning', value)} /></Field><div class="screenshot-option setup-screenshot-option"><span>Capture application screenshots</span><Toggle checked={form.screenshots} onChange={(screenshots) => setForm((current) => ({ ...current, screenshots }))} label="Capture screenshots during documentation creation" /></div></div>
          {selectedAgent && <div class="setup-success-note"><span><Icon name="check" size={13} /></span><p><strong>Great choice!</strong>This setup works well for most projects and is easy to change later.</p></div>}</div>}
        {step === 4 && <DocumentationGuidance
          audiences={form.audiences}
          customInstructions={form.customInstructions}
          onAudiencesChange={(audiences) => setForm((current) => ({ ...current, audiences }))}
          onInstructionsChange={(customInstructions) => setForm((current) => ({ ...current, customInstructions }))}
        />}
        {step === 5 && !creationJob && <><div class="setup-review-heading"><span aria-hidden="true">🚀</span><div><h1>Review and create</h1><p>Everything looks good! Let's create your documentation.</p></div></div>
          <div class="setup-review-grid">
            <section class="setup-review-summary concise" aria-label="Documentation configuration">
              <ReviewSummaryRow icon="file" label="Title"><strong>{form.title}</strong></ReviewSummaryRow>
              <ReviewSummaryRow icon="link" label="Sources" trailing={<span class="review-source-count"><Icon name="check" size={12} />{sources.length} {sources.length === 1 ? 'source' : 'sources'}</span>}><span class="review-source-list">{sources.map((source) => <span class="review-source" key={source.name}><strong>{source.name} · {source.sourceKind === 'openapi' ? 'OpenAPI Specification' : source.sourceLocation === 'git' ? 'Git Repository' : 'Local Folder'}</strong><small>{source.sourceKind === 'openapi' || source.sourceLocation === 'local' ? source.sourcePath || 'Uploaded specification' : `${source.repository} · ${source.branch}${source.subdirectory ? ` / ${source.subdirectory}` : ''}`}</small></span>)}</span></ReviewSummaryRow>
              <ReviewSummaryRow icon="bot" label="Model"><strong>{form.model || 'Default'}</strong></ReviewSummaryRow>
              <ReviewSummaryRow icon="users" label="Guidance"><span class="review-guidance"><strong>{form.audiences.length ? form.audiences.join(', ') : 'Agent will determine the audience'}</strong><small>{form.customInstructions.trim() || 'No custom instructions'}</small></span></ReviewSummaryRow>
            </section>
          </div>
          <div class="setup-review-ready"><span><Icon name="check" size={20} /></span><div><strong>All set to create!</strong><small>We'll create your documentation workspace with the configuration above.</small></div></div>
          {submitting && sources.some((source) => source.sourceLocation === 'git') && <Note>Downloading read-only repository snapshots and starting documentation creation…</Note>}
          {(setupError || error) && <Note tone="bad">{error || setupError}</Note>}</>}
        {step === 5 && creationJob && <SetupCreationProgress job={creationJob} model={form.model} streamConnected={creationStreamConnected} />}
        {step === 5 && creationJob?.status === 'succeeded' && <SetupNextSteps
          openingPreview={openingPreview}
          onPreview={() => void openDocumentationPreview()}
          onUpdate={() => void onContinue('authoring')}
          onPublish={() => void onContinue('publish')}
        />}
        {step === 5 && creationJob && (setupError || error) && <Note tone="bad">{error || setupError}</Note>}
        {step !== 5 && setupError && <Note tone="bad">{setupError}</Note>}
        <footer class="setup-actions setup-review-actions">
          {creationJob
            ? <><div class="setup-creation-footer-status"><span class={creationJob.status} /><strong>{creationJob.status === 'running' ? 'Documentation creation in progress' : creationJob.status === 'succeeded' ? 'Documentation is ready — preview it or publish to Doxbrix above' : 'Documentation creation stopped'}</strong></div>{creationJob.status !== 'succeeded' && <div>{creationJob.status === 'running' && <Button tone="danger" icon="stop" busy={cancellingCreation} onClick={() => void cancelDocumentationCreation()}>Stop creation</Button>}{(creationJob.status === 'failed' || creationJob.status === 'cancelled') && <Button tone="primary" icon="refresh" busy={submitting} onClick={() => void retryDocumentationCreation()}>Try Again</Button>}</div>}</>
            : <><div class="setup-review-progress"><strong>Step {step} of 5</strong><span>{[1, 2, 3, 4, 5].map((item) => <span class={item === step ? 'current' : item < step ? 'complete' : 'pending'} key={item}><i>{item <= step && <Icon name="check" size={10} />}</i>{item < 5 && <b />}</span>)}</span></div>
              <div>{step > 1 && <Button class="setup-back-button" onClick={() => setStep((value) => value - 1)}>Back</Button>}
                {step < 5
                  ? <Button tone="primary" busy={validatingPaths} disabled={(step === 1 && (!form.directory.trim() || !form.title.trim() || Boolean(pathErrors.directory))) || (step === 2 && (sources.length === 0 || sourceFlowStep !== 'closed')) || (step === 3 && Boolean(form.agent) && !selectedAgent)} onClick={() => void continueSetup()}>Continue <Icon name="arrowRight" size={14} /></Button>
                  : <Button tone="primary" icon="sparkle" busy={submitting} onClick={() => void createDocumentation()}>Create Documentation</Button>}
              </div></>}
        </footer>
      </div>
    </section>
  </div>
}

const AUDIENCE_SUGGESTIONS = [
  'Developers',
  'API consumers',
  'Administrators',
  'End users',
  'Technical decision-makers',
] as const

const INSTRUCTION_SUGGESTIONS = [
  ['Beginner-friendly', 'Explain unfamiliar concepts for readers who are new to the product.'],
  ['Concise', 'Keep explanations concise and action-oriented.'],
  ['Code-heavy', 'Prioritize practical code examples where the sources support them.'],
  ['Include examples', 'Include realistic examples for important workflows.'],
] as const

function DocumentationGuidance({ audiences, customInstructions, onAudiencesChange, onInstructionsChange }: {
  audiences: string[]
  customInstructions: string
  onAudiencesChange: (audiences: string[]) => void
  onInstructionsChange: (instructions: string) => void
}) {
  const [audienceInput, setAudienceInput] = useState('')
  const matchingSuggestions = AUDIENCE_SUGGESTIONS.filter((suggestion) =>
    suggestion.toLowerCase().includes(audienceInput.trim().toLowerCase()),
  )
  const addAudience = (value: string) => {
    const audience = value.trim().replace(/,$/, '').trim()
    if (!audience || audiences.some((item) => item.toLowerCase() === audience.toLowerCase())) {
      setAudienceInput('')
      return
    }
    onAudiencesChange([...audiences, audience])
    setAudienceInput('')
  }
  const toggleAudience = (audience: string) => {
    const selected = audiences.some((item) => item.toLowerCase() === audience.toLowerCase())
    onAudiencesChange(selected
      ? audiences.filter((item) => item.toLowerCase() !== audience.toLowerCase())
      : [...audiences, audience])
  }
  const toggleInstruction = (instruction: string) => {
    const lines = customInstructions.split('\n').map((line) => line.trim()).filter(Boolean)
    onInstructionsChange(lines.includes(instruction)
      ? lines.filter((line) => line !== instruction).join('\n')
      : [...lines, instruction].join('\n'))
  }
  return <div class="setup-guidance-stage">
    <SetupStepHeading visual="✍️" title="Guide your documentation" detail="Help the agent tailor the documentation to your readers and preferences." />
    <div class="setup-guidance-card">
      <section class="setup-guidance-section">
        <div class="setup-guidance-label"><span><strong>Who is this documentation for?</strong><small>Select suggestions or enter your own audience.</small></span><em>Optional</em></div>
        <div class="audience-picker" onClick={(event) => (event.currentTarget.querySelector('input') as HTMLInputElement | null)?.focus()}>
          {audiences.map((audience) => <span class="audience-token" key={audience}>{audience}<button type="button" aria-label={`Remove ${audience}`} onClick={(event) => { event.stopPropagation(); toggleAudience(audience) }}><Icon name="close" size={11} /></button></span>)}
          <input value={audienceInput} aria-label="Add an audience" placeholder={audiences.length ? 'Add another audience…' : 'Type an audience and press Enter…'} onInput={(event) => setAudienceInput(event.currentTarget.value)} onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ',') {
              event.preventDefault()
              addAudience(event.currentTarget.value)
            } else if (event.key === 'Backspace' && !event.currentTarget.value && audiences.length) {
              onAudiencesChange(audiences.slice(0, -1))
            }
          }} onBlur={() => addAudience(audienceInput)} />
        </div>
        <div class="guidance-suggestions" aria-label="Suggested audiences">
          {matchingSuggestions.map((audience) => <button type="button" class={audiences.includes(audience) ? 'selected' : ''} aria-pressed={audiences.includes(audience)} onMouseDown={(event) => event.preventDefault()} onClick={() => toggleAudience(audience)} key={audience}>{audiences.includes(audience) && <Icon name="check" size={11} />}{audience}</button>)}
        </div>
      </section>
      <section class="setup-guidance-section">
        <div class="setup-guidance-label"><span><strong>Instructions</strong><small>Describe how you want the agent to prepare the documentation.</small></span><em>Optional</em></div>
        <Textarea rows={6} value={customInstructions} placeholder="For example: Use concise explanations, include TypeScript examples, and add troubleshooting sections." onInput={(event) => onInstructionsChange(event.currentTarget.value)} />
        <div class="guidance-suggestions instruction-suggestions" aria-label="Suggested writing instructions">
          {INSTRUCTION_SUGGESTIONS.map(([label, instruction]) => <button type="button" class={customInstructions.split('\n').map((line) => line.trim()).includes(instruction) ? 'selected' : ''} aria-pressed={customInstructions.split('\n').map((line) => line.trim()).includes(instruction)} onClick={() => toggleInstruction(instruction)} key={label}>{customInstructions.split('\n').map((line) => line.trim()).includes(instruction) && <Icon name="check" size={11} />}{label}</button>)}
        </div>
      </section>
    </div>
    <div class="setup-guidance-note"><Icon name="sparkles" size={15} /><span>These preferences are saved with the workspace and reused for future documentation updates.</span></div>
  </div>
}

async function waitForPreview(url: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await fetch(url, { mode: 'no-cors', cache: 'no-store' })
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
  }
}

function SetupNextSteps({ openingPreview, onPreview, onUpdate, onPublish }: {
  openingPreview: boolean
  onPreview: () => void
  onUpdate: () => void
  onPublish: () => void
}) {
  return <section class="setup-next-steps" aria-labelledby="setup-next-steps-title">
    <header class="setup-next-steps-header">
      <strong id="setup-next-steps-title">What’s next?</strong>
      <Button class="setup-preview-documentation" busy={openingPreview} onClick={onPreview}>Preview documentation <Icon name="external" size={14} /></Button>
    </header>
    <div class="setup-agentify-layout">
      <div class="setup-agentify-pitch">
        <div class="setup-agentify-title"><span><Icon name="sparkles" size={22} /></span><h2>Agentify your docs</h2></div>
        <p>Publish to Doxbrix and enable an AI assistant that understands your documentation and helps users instantly.</p>
        <ul>
          <li><span><Icon name="check" size={13} /></span>Chat with your docs using natural language</li>
          <li><span><Icon name="check" size={13} /></span>Get accurate answers with citations</li>
          <li><span><Icon name="check" size={13} /></span>Keep your docs up-to-date and accessible</li>
        </ul>
        <div class="setup-agentify-actions">
          <Button tone="primary" class="setup-update-documentation" icon="authoring" onClick={onUpdate}>Update documentation</Button>
          <Button class="setup-agentify-action" onClick={onPublish}>Agentify docs on Doxbrix <Icon name="arrowRight" size={17} /></Button>
        </div>
      </div>
      <div class="setup-assistant-preview" aria-label="AI assistant preview">
        <header><span><Icon name="sparkles" size={14} />AI Assistant preview</span><i>−</i></header>
        <div class="setup-assistant-body">
          <p>Hi! I’m your documentation assistant.<br />How can I help you today?</p>
          <div class="setup-assistant-questions">
            <span>How do I integrate with the API?<Icon name="chevronRight" size={13} /></span>
            <span>Where can I find authentication details?<Icon name="chevronRight" size={13} /></span>
            <span>How do I troubleshoot common errors?<Icon name="chevronRight" size={13} /></span>
          </div>
          <div class="setup-assistant-input"><span>Ask a question about your docs…</span><i><Icon name="arrowRight" size={13} /></i></div>
        </div>
      </div>
    </div>
  </section>
}

const DOCUMENTATION_PROGRESS_MESSAGES = [
  'Working on your documentation…',
  'This can take a few minutes. You can follow the activity below.',
  'Getting there — Doxloop is organizing and validating your content…',
  'Finishing the documentation and preparing your preview…',
]

function SetupCreationProgress({ job, model, streamConnected }: { job: UiJob; model: string; streamConnected: boolean }) {
  const [messageIndex, setMessageIndex] = useState(0)
  const [clock, setClock] = useState(() => Date.now())
  const [logOpen, setLogOpen] = useState(job.status !== 'succeeded')
  const log = useRef<HTMLPreElement>(null)
  const running = job.status === 'running'
  const succeeded = job.status === 'succeeded'
  useEffect(() => {
    if (!running) return
    const timer = window.setInterval(() => setMessageIndex((current) => (current + 1) % DOCUMENTATION_PROGRESS_MESSAGES.length), 4200)
    return () => clearInterval(timer)
  }, [running])
  useEffect(() => {
    if (!running) return
    setClock(Date.now())
    const timer = window.setInterval(() => setClock(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [running, job.startedAt])
  useEffect(() => {
    if (succeeded) setLogOpen(false)
    else if (running) setLogOpen(true)
  }, [job.id, running, succeeded])
  useEffect(() => {
    if (log.current) log.current.scrollTop = log.current.scrollHeight
  }, [job.lines.length, logOpen])
  const title = succeeded ? 'Your documentation is ready!' : running ? 'Creating your documentation' : 'Documentation creation stopped'
  const detail = succeeded
    ? 'Everything has been generated and validated. Open the preview when you are ready.'
    : running
      ? DOCUMENTATION_PROGRESS_MESSAGES[messageIndex]
      : 'The run did not complete. Review the latest activity below, then try again.'
  const elapsed = durationText(new Date(job.startedAt).getTime(), job.finishedAt ? new Date(job.finishedAt).getTime() : clock)
  return <div class={`setup-creation-progress ${job.status}`}>
    <header class="setup-creation-heading">
      <span class="setup-creation-spinner">{succeeded ? <Icon name="check" size={28} /> : running ? <i /> : <Icon name="alert" size={26} />}</span>
      <div><h1>{title}</h1><p aria-live="polite">{detail}</p></div>
    </header>
    <section class="setup-creation-status-card">
      <div class="setup-creation-status-top"><span><i class={job.status} />{running ? 'Generation in progress' : succeeded ? 'Generation complete' : 'Generation failed'}</span>{running && <Badge tone={streamConnected ? 'good' : 'warn'} icon="broadcast">{streamConnected ? 'Live' : 'Reconnecting…'}</Badge>}</div>
      <div class="setup-creation-track"><i /></div>
      <div class="setup-creation-meta"><span><Icon name="bot" size={14} />{job.agent ? agentLabel(job.agent) : 'Coding agent'}</span><span class="setup-creation-model"><Icon name="sparkles" size={14} />Model <strong>{model || 'Default'}</strong></span><span class="setup-creation-elapsed"><Icon name="clock" size={14} />{running ? 'Working for' : 'Worked for'} <strong>{elapsed}</strong></span><span><Icon name="file" size={14} />{job.lines.length} log {job.lines.length === 1 ? 'entry' : 'entries'}</span></div>
    </section>
    <section class={`setup-creation-log ${logOpen ? 'open' : 'collapsed'}`} aria-label="Documentation creation activity">
      <header><button type="button" class="setup-creation-log-toggle" aria-expanded={logOpen} onClick={() => setLogOpen((open) => !open)}><span><Icon name="record" size={14} /></span><strong>Live activity</strong><small>{logOpen ? 'Collapse terminal' : 'Show terminal'}</small><Icon name="chevronDown" size={13} /></button><a href={`/api/jobs/${job.id}/log`} target="_blank" rel="noreferrer">Open full log <Icon name="external" size={12} /></a></header>
      {logOpen && <pre ref={log} aria-live="polite">{job.lines.length ? job.lines.join('\n') : 'Starting the documentation agent…'}</pre>}
    </section>
  </div>
}

function durationText(startedAt: number, endedAt: number): string {
  const totalSeconds = Math.max(0, Math.floor((endedAt - startedAt) / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

function ReviewSummaryRow({ icon, label, trailing, children }: { icon: string; label: string; trailing?: ComponentChildren; children: ComponentChildren }) {
  return <div class="review-summary-row"><span class="review-summary-icon"><Icon name={icon} size={20} /></span><span class="review-summary-label">{label}</span><span class="review-summary-value">{children}</span>{trailing && <span class="review-summary-trailing">{trailing}</span>}</div>
}

function SetupStepHeading({ visual, title, detail }: { visual: string; title: string; detail: string }) {
  return <div class="setup-step-heading"><span class="setup-heading-visual" aria-hidden="true">{visual}</span><div><h3>{title}</h3><p>{detail}</p></div></div>
}

function sourceFlowTitle(step: SourceFlowStep): string {
  if (step === 'type') return 'What would you like to add?'
  if (step === 'source-location') return 'Choose a repository type'
  if (step === 'git-access') return 'Is the repository public or private?'
  if (step === 'git-connect') return 'Connect the Git repository'
  if (step === 'git-select') return 'Choose a branch and folder'
  if (step === 'local') return 'Select a local repository'
  if (step === 'openapi-format') return 'Choose an OpenAPI format'
  return 'Provide the OpenAPI specification'
}

function sourceFlowDetail(step: SourceFlowStep): string {
  if (step === 'type') return 'Select one option to continue.'
  if (step === 'source-location') return 'Choose where the source repository is located.'
  if (step === 'git-access') return 'This determines which connection details are required.'
  if (step === 'git-connect') return 'Enter only the details required to connect.'
  if (step === 'git-select') return 'Select the exact repository content to include.'
  if (step === 'local') return 'Choose or provide the local repository folder.'
  if (step === 'openapi-format') return 'Provide a hosted URL or a YAML/JSON file.'
  return 'Enter the specification location, then add it as a source.'
}

function ReferenceChoice({ icon, tone = '', title, detail, onClick }: { icon: string; tone?: string; title: string; detail: string; onClick: () => void }) {
  return <button type="button" class="reference-choice" onClick={onClick}><span class={tone}><Icon name={icon} size={22} /></span><span><strong>{title}</strong><small>{detail}</small></span></button>
}

function RepositoryFolderTree({ value, directories, loading, onChange }: { value: string; directories: string[]; loading: boolean; onChange: (value: string) => void }) {
  if (loading) return <div class="repository-folder-tree loading"><span class="spinner" />Loading folders…</div>
  return <div class="repository-folder-tree" role="listbox" aria-label="Repository folders">
    <button type="button" class={!value ? 'selected' : ''} onClick={() => onChange('')}><Icon name="folder" size={14} /><span>/</span></button>
    {directories.map((directory) => {
      const depth = Math.min(directory.split('/').length - 1, 4)
      const label = directory.split('/').pop() ?? directory
      return <button type="button" class={value === directory ? 'selected' : ''} style={{ paddingLeft: `${14 + depth * 16}px` }} onClick={() => onChange(directory)} key={directory}><Icon name="folder" size={14} /><span>{label}</span></button>
    })}
  </div>
}

function SourceTypeChoice({ selected, visual, title, detail, onClick }: { selected: boolean; visual: 'code' | 'folder' | 'api'; title: string; detail: string; onClick: () => void }) {
  const icon = visual === 'folder' ? 'folder' : visual === 'api' ? 'file' : 'api'
  return <button type="button" class={`source-type-choice ${selected ? 'selected' : ''}`} aria-pressed={selected} onClick={onClick}><span class={`source-type-visual ${visual}`}><Icon name={icon} size={20} /></span><strong>{title}</strong><small>{detail}</small></button>
}

function GitSettingRow({ icon, label, value, disabled, onChange }: { icon: string; label: string; value: string; disabled?: boolean; onChange: () => void }) {
  return <div class={`git-setting-row ${disabled ? 'disabled' : ''}`}><span class="git-setting-icon"><Icon name={icon} size={19} /></span><div><strong>{label}</strong><small>{value}</small></div><Button type="button" disabled={disabled} onClick={onChange}>Change</Button></div>
}

function ValidatedSetupInput({ value, valid, invalid, onInput }: { value: string; valid: boolean; invalid?: boolean; onInput: (value: string) => void }) {
  return <div class="validated-setup-input"><Input value={value} aria-invalid={Boolean(invalid)} onInput={(event) => onInput(event.currentTarget.value)} />{valid && <Icon name="check" size={14} />}</div>
}

function RepositoryConnectButton({ connected, busy, disabled, onClick }: { connected: boolean; busy: boolean; disabled: boolean; onClick: () => void }) {
  const label = connected ? 'Repository connected' : busy ? 'Connecting repository' : 'Connect repository'
  return <button type="button" class={`repository-connect-button ${connected ? 'connected' : ''}`} aria-label={label} title={label} disabled={disabled || busy || connected} onClick={onClick}>
    {busy ? <span class="repository-connect-spinner" /> : <Icon name={connected ? 'check' : 'link'} size={19} />}
  </button>
}

function RepositoryFolderSelect({ value, directories, loading, connected, onChange }: {
  value: string
  directories: string[]
  loading: boolean
  connected: boolean
  onChange: (value: string) => void
}) {
  const hint = loading
    ? 'Loading folders…'
    : connected
      ? directories.length ? `${directories.length} folders available. Choose one or use the entire repository.` : 'This repository has no folders, so the entire repository will be used.'
      : 'Connect the repository to browse its folders.'
  return <Field label="Folder within repository" hint={hint}>
    <Select value={value} disabled={!connected || loading} onChange={(event) => onChange(event.currentTarget.value)}>
      <option value="">Entire repository</option>
      {value && !directories.includes(value) && <option value={value}>{value}</option>}
      {directories.map((directory) => <option key={directory} value={directory}>{directory}</option>)}
    </Select>
  </Field>
}


type Action = <T>(run: () => Promise<T>, success?: string, refresh?: boolean) => Promise<T | undefined>

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function agentLabel(value: string): string {
  return value === 'claude' ? 'Claude Code' : value === 'codex' ? 'Codex' : 'Gemini'
}

function AgentInstallProgress({ job, onRetry }: { job: UiJob; onRetry: () => void }) {
  const label = job.agent ? agentLabel(job.agent) : 'Agent'
  if (job.status === 'running') return <div class="agent-install-progress"><span class="spinner" /><span>Installing {label}…</span></div>
  if (job.status === 'succeeded') return <div class="agent-install-progress good"><Icon name="check" size={14} /><span>{label} installed</span></div>
  return <div class="agent-install-progress bad"><Icon name="alert" size={14} /><span>Installation failed</span><Button size="sm" onClick={onRetry}>Try again</Button></div>
}
