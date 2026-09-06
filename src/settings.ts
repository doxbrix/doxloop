import { relative, resolve } from 'node:path'
import { detectAgents } from './agents.js'
import { apiUrl } from './auth.js'
import { generatorCatalogEntry } from './generators.js'
import {
  isSpecUrl,
  loadProject,
  parseDesignReference,
  parseSpec,
  saveProjectSettings,
  validateProjectSourceBoundaries,
} from './project.js'
import {
  heading,
  note,
  promptConfirm,
  promptSecret,
  promptSelect,
  promptText,
  type PromptIo,
} from './prompts.js'
import {
  captureAuthStatus,
  removeCaptureCredentials,
  removeCaptureSession,
  saveCaptureCredentials,
  saveCaptureSession,
} from './capture-auth.js'
import { startCaptureSignIn } from './screen-capture-provider.js'
import type {
  AgentName,
  ApplicationConfig,
  DeploymentConfig,
  DocumentationBrief,
  DoxloopProject,
  SourceBinding,
} from './types.js'

type SettingsArea =
  | 'show'
  | 'title'
  | 'evidence'
  | 'agent'
  | 'documentation'
  | 'references'
  | 'screenshots'
  | 'deployment'
  | 'generator'
  | 'exit'

export async function runSettingsWizard(
  root: string,
  cwd: string,
  io: PromptIo = { input: process.stdin, output: process.stdout },
): Promise<void> {
  heading(io, 'Doxloop — project settings')
  while (true) {
    const project = await loadProject(root)
    const area = await promptSelect<SettingsArea>({
      message: `What would you like to change for "${project.title}"?`,
      choices: [
        { value: 'show', label: 'Show all settings' },
        { value: 'title', label: 'Site title and identity' },
        { value: 'evidence', label: 'Product evidence' },
        { value: 'agent', label: 'Default authoring agent' },
        { value: 'documentation', label: 'Documentation preferences' },
        { value: 'references', label: 'Design references' },
        { value: 'screenshots', label: 'Application screenshots' },
        { value: 'deployment', label: 'Deployment' },
        { value: 'generator', label: 'Documentation generator' },
        { value: 'exit', label: 'Exit' },
      ],
      io,
    })
    if (area === 'exit') return
    if (area === 'show') {
      io.output.write(`\n${formatProjectSettings(root, project)}\n\n`)
    } else if (area === 'title') {
      await editTitle(root, project, io)
    } else if (area === 'evidence') {
      await editEvidence(root, cwd, project, io)
    } else if (area === 'agent') {
      await editAgent(root, io)
    } else if (area === 'documentation') {
      await editDocumentation(root, project.documentation, io)
    } else if (area === 'references') {
      await editReferences(root, project, io)
    } else if (area === 'screenshots') {
      await editScreenshots(root, project, io)
    } else if (area === 'deployment') {
      await editDeployment(root, project, io)
    } else {
      showGenerator(project, io)
    }
  }
}

export function formatProjectSettings(root: string, project: DoxloopProject): string {
  const generator =
    generatorCatalogEntry(project.generator)?.displayName ?? project.generator
  const evidence =
    project.sources.length === 0
      ? 'None configured'
      : project.sources
          .map(
            (source) =>
              `${source.name}: ${(source.kind ?? 'directory') === 'openapi' ? 'OpenAPI ' : ''}${source.path}`,
          )
          .join('\n  ')
  const deployment = effectiveDeployment(project)
  return `Project\n  Root: ${root}\n  Title: ${project.title}\n  Generator: ${generator}\n  Agent: ${project.defaultAgent ?? 'Choose at authoring time'}\n\nEvidence\n  ${evidence}\n\nDocumentation\n  Audience: ${project.documentation.primaryAudience ?? 'Agent will determine'}\n  Locale: ${project.documentation.locale}\n  Tone: ${project.documentation.tone.join(', ')}\n\nApplication screenshots\n  ${project.application ? `${project.application.screenshots?.policy ?? 'requested'} at ${project.application.baseUrl}` : 'Not configured'}\n\nDeployment\n  Target: ${deployment.target}\n  Name: ${deployment.name}\n  Slug: ${deployment.slug}\n  Visibility: ${deployment.visibility}\n  Destination: ${deployment.apiUrl}`
}

export function effectiveDeployment(
  project: DoxloopProject,
  fallbackApiUrl?: string,
): Required<Pick<DeploymentConfig, 'target' | 'name' | 'slug' | 'visibility' | 'apiUrl'>> & Omit<DeploymentConfig, 'target' | 'name' | 'slug' | 'visibility' | 'apiUrl'> {
  return {
    target: project.deployment?.target ?? 'doxbrix',
    name: project.deployment?.name?.trim() || project.title,
    slug: project.deployment?.slug?.trim() || slugify(project.title),
    visibility: project.deployment?.visibility ?? 'private',
    apiUrl: apiUrl(project.deployment?.apiUrl ?? fallbackApiUrl),
    ...(project.deployment?.siteId ? { siteId: project.deployment.siteId } : {}),
    ...(project.deployment?.projectId ? { projectId: project.deployment.projectId } : {}),
    ...(project.deployment?.teamId ? { teamId: project.deployment.teamId } : {}),
    ...(project.deployment?.branch ? { branch: project.deployment.branch } : {}),
    ...(project.deployment?.basePath ? { basePath: project.deployment.basePath } : {}),
  }
}

async function editTitle(
  root: string,
  project: DoxloopProject,
  io: PromptIo,
): Promise<void> {
  const title = await promptText({ message: 'Site title', initial: project.title, io })
  if (title === project.title) {
    note(io, 'No change.')
    return
  }
  await saveProjectSettings(root, { title })
  note(io, `✓ Site title changed to ${title}. The next authoring run will synchronize generator-native site metadata.`)
}

async function editEvidence(
  root: string,
  cwd: string,
  project: DoxloopProject,
  io: PromptIo,
): Promise<void> {
  const action = await promptSelect<'view' | 'directory' | 'spec' | 'remove' | 'back'>({
    message: 'Product evidence',
    choices: [
      { value: 'view', label: 'View configured evidence' },
      { value: 'directory', label: 'Add a source directory' },
      { value: 'spec', label: 'Add an API specification' },
      {
        value: 'remove',
        label: 'Remove evidence',
        ...(project.sources.length === 0 ? { disabled: 'nothing configured' } : {}),
      },
      { value: 'back', label: 'Back' },
    ],
    io,
  })
  if (action === 'back') return
  if (action === 'view') {
    note(
      io,
      project.sources.length === 0
        ? 'No product evidence is configured.'
        : project.sources
            .map(
              (source) =>
                `${source.name}: ${(source.kind ?? 'directory') === 'openapi' ? 'OpenAPI — ' : ''}${source.path}`,
            )
            .join('\n'),
    )
    return
  }
  if (action === 'remove') {
    const source = await promptSelect<SourceBinding>({
      message: 'Remove which evidence?',
      choices: project.sources.map((candidate) => ({
        value: candidate,
        label: candidate.name,
        hint: candidate.path,
      })),
      io,
    })
    if (
      !(await promptConfirm({
        message: `Remove "${source.name}" from the configured evidence?`,
        initial: false,
        io,
      }))
    ) {
      note(io, 'No change.')
      return
    }
    const sources = project.sources.filter((candidate) => candidate !== source)
    const application =
      project.application?.source === source.name
        ? withoutApplicationSource(project.application)
        : project.application
    await saveProjectSettings(root, { sources, application })
    note(io, `✓ Removed ${source.name}. No product files were changed.`)
    return
  }

  const name = await promptText({
    message: 'Evidence name',
    initial: uniqueSourceName(project.sources, action === 'spec' ? 'api' : 'product'),
    validate: (value) => validateSourceName(project.sources, value),
    io,
  })
  if (action === 'directory') {
    const location = await promptText({
      message: 'Path to product source',
      validate: async (value) => {
        const candidate: SourceBinding = {
          name,
          path: portableRelative(root, resolve(cwd, value)),
        }
        return validationProblem(() =>
          validateProjectSourceBoundaries(root, [...project.sources, candidate]),
        )
      },
      io,
    })
    const absolute = resolve(cwd, location)
    const source: SourceBinding = {
      name,
      path: portableRelative(root, absolute),
    }
    const sources = [...project.sources, source]
    await validateProjectSourceBoundaries(root, sources)
    await saveProjectSettings(root, { sources })
    note(io, `✓ Added read-only product source ${absolute}.`)
    return
  }

  const location = await promptText({
    message: 'OpenAPI specification file or URL',
    validate: async (value) => {
      try {
        const candidate = parseSpec(`${name}=${value}`)
        const normalized = isSpecUrl(candidate.path)
          ? candidate
          : {
              ...candidate,
              path: portableRelative(root, resolve(cwd, candidate.path)),
            }
        return validationProblem(() =>
          validateProjectSourceBoundaries(root, [...project.sources, normalized]),
        )
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    },
    io,
  })
  const parsed = parseSpec(`${name}=${location}`)
  const source = isSpecUrl(parsed.path)
    ? parsed
    : { ...parsed, path: portableRelative(root, resolve(cwd, parsed.path)) }
  const sources = [...project.sources, source]
  await validateProjectSourceBoundaries(root, sources)
  await saveProjectSettings(root, { sources })
  note(io, `✓ Added OpenAPI evidence ${source.path}.`)
}

async function editAgent(root: string, io: PromptIo): Promise<void> {
  const detected = await detectAgents()
  if (detected.length === 0) {
    note(io, 'No supported agent CLI was found on PATH. Install Codex, Claude Code, or Gemini first.')
    return
  }
  const labels: Record<AgentName, string> = {
    codex: 'Codex',
    claude: 'Claude Code',
    gemini: 'Gemini',
  }
  const agent = await promptSelect<AgentName>({
    message: 'Default authoring agent',
    choices: detected.map((candidate) => ({
      value: candidate.name,
      label: labels[candidate.name],
    })),
    io,
  })
  await saveProjectSettings(root, { defaultAgent: agent })
  note(io, `✓ Default agent changed to ${labels[agent]}.`)
}

async function editDocumentation(
  root: string,
  documentation: DocumentationBrief,
  io: PromptIo,
): Promise<void> {
  const field = await promptSelect<'audience' | 'locale' | 'tone' | 'outcomes' | 'back'>({
    message: 'Documentation preferences',
    choices: [
      { value: 'audience', label: 'Primary audience' },
      { value: 'locale', label: 'Locale' },
      { value: 'tone', label: 'Tone' },
      { value: 'outcomes', label: 'Priority reader outcomes' },
      { value: 'back', label: 'Back' },
    ],
    io,
  })
  if (field === 'back') return
  const next = { ...documentation }
  if (field === 'audience') {
    next.primaryAudience = await promptText({
      message: 'Primary audience',
      initial: documentation.primaryAudience ?? 'Developers',
      io,
    })
  } else if (field === 'locale') {
    next.locale = await promptText({
      message: 'Locale',
      initial: documentation.locale,
      io,
    })
  } else if (field === 'tone') {
    next.tone = commaList(
      await promptText({
        message: 'Tone, separated by commas',
        initial: documentation.tone.join(', '),
        validate: validateCommaList,
        io,
      }),
    )
  } else {
    next.priorityOutcomes = commaList(
      await promptText({
        message: 'Priority outcomes, separated by commas',
        initial: documentation.priorityOutcomes?.join(', ') ?? 'Reach a first successful result',
        validate: validateCommaList,
        io,
      }),
    )
  }
  await saveProjectSettings(root, { documentation: next })
  note(io, '✓ Documentation preferences updated.')
}

async function editReferences(
  root: string,
  project: DoxloopProject,
  io: PromptIo,
): Promise<void> {
  const action = await promptSelect<'add' | 'remove' | 'back'>({
    message: 'Design references',
    choices: [
      { value: 'add', label: 'Add a public documentation site' },
      {
        value: 'remove',
        label: 'Remove a design reference',
        ...(project.designReferences.length === 0
          ? { disabled: 'nothing configured' }
          : {}),
      },
      { value: 'back', label: 'Back' },
    ],
    io,
  })
  if (action === 'back') return
  if (action === 'add') {
    const raw = await promptText({
      message: 'Documentation site URL',
      validate: (value) => {
        try {
          parseDesignReference(value)
          return undefined
        } catch (error) {
          return error instanceof Error ? error.message : String(error)
        }
      },
      io,
    })
    const reference = parseDesignReference(raw)
    const urls = new Set(project.designReferences.map((item) => item.url))
    urls.add(reference.url)
    await saveProjectSettings(root, {
      designReferences: [...urls].map((url) => ({ url })),
    })
    note(io, `✓ Added ${reference.url}.`)
    return
  }
  const reference = await promptSelect<{ url: string }>({
    message: 'Remove which reference?',
    choices: project.designReferences.map((item) => ({
      value: item,
      label: item.url,
    })),
    io,
  })
  await saveProjectSettings(root, {
    designReferences: project.designReferences.filter((item) => item !== reference),
  })
  note(io, `✓ Removed ${reference.url}.`)
}

async function editScreenshots(
  root: string,
  project: DoxloopProject,
  io: PromptIo,
): Promise<void> {
  const action = await promptSelect<'configure' | 'policy' | 'signin' | 'remove' | 'back'>({
    message: 'Application screenshots',
    choices: [
      {
        value: 'configure',
        label: project.application ? 'Change application URL' : 'Configure application',
      },
      {
        value: 'policy',
        label: 'Screenshot policy',
        ...(!project.application ? { disabled: 'configure an application first' } : {}),
      },
      {
        value: 'signin',
        label: 'Application sign-in',
        hint: 'browser session or test-account credentials for login pages',
        ...(!project.application ? { disabled: 'configure an application first' } : {}),
      },
      {
        value: 'remove',
        label: 'Remove application configuration',
        ...(!project.application ? { disabled: 'nothing configured' } : {}),
      },
      { value: 'back', label: 'Back' },
    ],
    io,
  })
  if (action === 'back') return
  if (action === 'signin') {
    await editCaptureSignIn(root, project, io)
    return
  }
  if (action === 'remove') {
    await saveProjectSettings(root, { application: undefined })
    note(io, '✓ Application screenshot configuration removed.')
    return
  }
  if (action === 'configure') {
    const baseUrl = await promptText({
      message: 'Application base URL',
      initial: project.application?.baseUrl ?? 'http://localhost:3000',
      validate: validateApplicationUrl,
      io,
    })
    const application: ApplicationConfig = {
      ...project.application,
      baseUrl: new URL(baseUrl).toString().replace(/\/$/, ''),
      screenshots: project.application?.screenshots ?? { policy: 'requested' },
    }
    await saveProjectSettings(root, { application })
    note(io, `✓ Application configured at ${application.baseUrl}.`)
    return
  }
  const policy = await promptSelect<'requested' | 'auto' | 'off'>({
    message: 'When should Doxloop capture screenshots?',
    choices: [
      { value: 'requested', label: 'Only when requested' },
      { value: 'auto', label: 'Automatically for visible UI workflows' },
      { value: 'off', label: 'Never' },
    ],
    initialIndex:
      project.application?.screenshots?.policy === 'auto'
        ? 1
        : project.application?.screenshots?.policy === 'off'
          ? 2
          : 0,
    io,
  })
  await saveProjectSettings(root, {
    application: {
      ...project.application!,
      screenshots: { ...project.application!.screenshots, policy },
    },
  })
  note(io, `✓ Screenshot policy changed to ${policy}.`)
}

/**
 * Sign-in for the capture browser. Both options are stored in the user's
 * Doxloop config home against this project, never in `.doxloop/project.json`.
 */
async function editCaptureSignIn(
  root: string,
  project: DoxloopProject,
  io: PromptIo,
): Promise<void> {
  const application = project.application!
  const status = await captureAuthStatus(root)
  note(io, `Browser session: ${status.session ? `saved ${status.session.savedAt} for ${status.session.origin} (${status.session.cookies} cookies)` : 'none'}`)
  note(io, `Credentials: ${status.credentials ? `saved for ${status.credentials.username}` : 'none'}`)
  const action = await promptSelect<'browser' | 'credentials' | 'login-path' | 'forget-session' | 'forget-credentials' | 'back'>({
    message: 'Application sign-in',
    choices: [
      { value: 'browser', label: 'Sign in with browser', hint: 'opens Chrome; sign in by hand, including MFA or SSO' },
      { value: 'credentials', label: 'Save test-account credentials', hint: 'typed by the capture server, never shown to the agent' },
      { value: 'login-path', label: 'Set the sign-in route', hint: application.authentication?.loginPath ?? 'not set' },
      { value: 'forget-session', label: 'Forget the browser session', ...(!status.session ? { disabled: 'none saved' } : {}) },
      { value: 'forget-credentials', label: 'Remove the credentials', ...(!status.credentials ? { disabled: 'none saved' } : {}) },
      { value: 'back', label: 'Back' },
    ],
    io,
  })
  if (action === 'back') return
  if (action === 'browser') {
    const session = await startCaptureSignIn(application)
    note(io, `Chrome opened at ${session.url}. Complete the sign-in there and wait for the signed-in screen.`)
    const save = await promptConfirm({ message: 'Save the signed-in session now?', initial: true, io })
    if (!save) {
      await session.cancel()
      note(io, 'Sign-in discarded.')
      return
    }
    const state = await session.finish()
    const stored = await saveCaptureSession(root, new URL(application.baseUrl).origin, state)
    note(io, `✓ Browser session saved with ${stored.state.cookies.length} cookies. Capture runs start signed in.`)
    return
  }
  if (action === 'credentials') {
    const username = await promptText({ message: 'Test account username or email', ...(status.credentials ? { initial: status.credentials.username } : {}), io })
    const password = await promptSecret({ message: 'Test account password', io })
    await saveCaptureCredentials(root, { username, password })
    note(io, `✓ Credentials saved for ${username}. The agent fills the sign-in form by secret name during capture.`)
    return
  }
  if (action === 'login-path') {
    const loginPath = await promptText({
      message: 'Sign-in route (relative to the application URL)',
      initial: application.authentication?.loginPath ?? '/login',
      validate: (value) => value.startsWith('/') && !value.startsWith('//') ? undefined : 'Start with one slash.',
      io,
    })
    await saveProjectSettings(root, { application: { ...application, authentication: { ...application.authentication, loginPath } } })
    note(io, `✓ Sign-in route set to ${loginPath}.`)
    return
  }
  if (action === 'forget-session') {
    await removeCaptureSession(root)
    note(io, '✓ Browser session removed.')
    return
  }
  await removeCaptureCredentials(root)
  note(io, '✓ Credentials removed.')
}

async function editDeployment(
  root: string,
  project: DoxloopProject,
  io: PromptIo,
): Promise<void> {
  const effective = effectiveDeployment(project)
  const field = await promptSelect<'name' | 'slug' | 'visibility' | 'api' | 'back'>({
    message: 'Deployment settings',
    choices: [
      { value: 'name', label: 'Hosted project name', hint: effective.name },
      { value: 'slug', label: 'Project address', hint: effective.slug },
      { value: 'visibility', label: 'Visibility', hint: effective.visibility },
      { value: 'api', label: 'Doxbrix destination', hint: effective.apiUrl },
      { value: 'back', label: 'Back' },
    ],
    io,
  })
  if (field === 'back') return
  const deployment: DeploymentConfig = { ...project.deployment }
  if (field === 'name') {
    deployment.name = await promptText({
      message: 'Hosted project name',
      initial: effective.name,
      io,
    })
  } else if (field === 'slug') {
    deployment.slug = await promptText({
      message: 'Project address',
      initial: effective.slug,
      validate: (value) =>
        /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
          ? undefined
          : 'Use lowercase letters, numbers, and single hyphens.',
      io,
    })
  } else if (field === 'visibility') {
    deployment.visibility = await promptSelect<'private' | 'public'>({
      message: 'Deployment visibility',
      choices: [
        { value: 'private', label: 'Private', hint: 'available only to authorized viewers' },
        { value: 'public', label: 'Public', hint: 'anyone on the internet can access it' },
      ],
      initialIndex: effective.visibility === 'public' ? 1 : 0,
      io,
    })
  } else {
    deployment.apiUrl = await promptText({
      message: 'Doxbrix API destination',
      initial: effective.apiUrl,
      validate: validateApiUrl,
      io,
    })
    deployment.apiUrl = apiUrl(deployment.apiUrl)
  }
  await saveProjectSettings(root, { deployment })
  note(io, '✓ Deployment settings updated.')
}

function showGenerator(project: DoxloopProject, io: PromptIo): void {
  const generator =
    generatorCatalogEntry(project.generator)?.displayName ?? project.generator
  note(
    io,
    `Current generator: ${generator}\nChanging generators in place could overwrite generator-native files. Create a new project with \`doxloop init\` when you need to migrate frameworks.`,
  )
}

function withoutApplicationSource(application: ApplicationConfig): ApplicationConfig {
  const { source: _source, startCommand: _startCommand, ...remaining } = application
  return remaining
}

function uniqueSourceName(sources: SourceBinding[], base: string): string {
  const used = new Set(sources.map((source) => source.name))
  if (!used.has(base)) return base
  let suffix = 2
  while (used.has(`${base}-${suffix}`)) suffix += 1
  return `${base}-${suffix}`
}

function validateSourceName(
  sources: SourceBinding[],
  value: string,
): string | undefined {
  if (!/^[a-z][a-z0-9-]*$/.test(value)) {
    return 'Use lowercase letters, numbers, and hyphens; start with a letter.'
  }
  return sources.some((source) => source.name === value)
    ? `Evidence named "${value}" already exists.`
    : undefined
}

function portableRelative(root: string, absolute: string): string {
  return relative(root, absolute).split('\\').join('/')
}

function commaList(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function validateCommaList(value: string): string | undefined {
  return commaList(value).length > 0 ? undefined : 'Enter at least one value.'
}

function validateApplicationUrl(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol)) return 'Use an HTTP or HTTPS URL.'
    if (url.username || url.password || url.search || url.hash) {
      return 'Remove credentials, query parameters, and fragments.'
    }
    return undefined
  } catch {
    return 'Enter a valid HTTP or HTTPS URL.'
  }
}

function validateApiUrl(value: string): string | undefined {
  try {
    apiUrl(value)
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

async function validationProblem(
  operation: () => Promise<void>,
): Promise<string | undefined> {
  try {
    await operation()
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'documentation'
}
