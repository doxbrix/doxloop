import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, join, relative, resolve } from 'node:path'
import { detectAgents } from './agents.js'
import { DoxloopError } from './errors.js'
import { pathExists } from './fs.js'
import { GENERATOR_CATALOG, resolveGeneratorPackage } from './generators.js'
import { PROJECT_FILE, isSpecUrl, parseSpec } from './project.js'
import {
  heading,
  note,
  promptConfirm,
  promptSelect,
  promptText,
  type PromptIo,
} from './prompts.js'
import type { AgentName, GeneratorName, SourceBinding } from './types.js'

export interface InitPlan {
  directory: string
  title?: string
  sources: SourceBinding[]
  generator: GeneratorName
}

const PRODUCT_MARKERS = [
  'package.json',
  'pyproject.toml',
  'go.mod',
  'Cargo.toml',
  'pom.xml',
  'build.gradle',
  'Gemfile',
  'composer.json',
  'src',
  'lib',
  '.git',
]

type EvidenceChoice = 'directory' | 'spec' | 'both' | 'none'

export async function runInitWizard(
  cwd: string,
  providedIo?: PromptIo,
): Promise<InitPlan> {
  const io = providedIo ?? { input: process.stdin, output: process.stdout }
  heading(io, 'Doxloop — create a documentation project')

  const detected = await describeDirectory(cwd)
  if (detected) {
    note(
      io,
      `✓ Detected product source: ${cwd}\n  Found: ${detected}`,
    )
  }

  const directory = await promptText({
    message: 'Where should the documentation project live?',
    initial: detected ? `../${basename(cwd)}-docs` : './docs',
    hint: 'A new or empty directory, separate from your product source.',
    validate: async (value) =>
      (await validateProjectDirectory(cwd, value)) ??
      (detected
        ? await validateSourceDirectory(cwd, resolve(cwd, value), '.')
        : undefined),
    io,
  })
  const projectRoot = resolve(cwd, directory)

  const evidence = await promptSelect<EvidenceChoice>({
    message: 'What should the documentation be based on?',
    choices: [
      {
        value: 'directory',
        label: detected ? 'This product source' : 'Local source code',
        hint: detected
          ? cwd
          : 'a directory Doxloop reads as read-only evidence',
      },
      {
        value: 'spec',
        label: 'An API specification',
        hint: 'OpenAPI or Swagger — file or URL',
      },
      { value: 'both', label: 'Both', hint: 'source code and a specification' },
      {
        value: 'none',
        label: 'Nothing yet',
        hint: 'author from my written request; add evidence later',
      },
    ],
    io,
  })

  const sources: SourceBinding[] = []
  let sourceRoot: string | undefined
  if (evidence === 'directory' || evidence === 'both') {
    if (detected) {
      sourceRoot = cwd
    } else {
      const path = await promptText({
        message: 'Path to your product source',
        validate: (value) => validateSourceDirectory(cwd, projectRoot, value),
        io,
      })
      sourceRoot = resolve(cwd, path)
    }
    const found = await describeDirectory(sourceRoot)
    if (found) note(io, `✓ found: ${found}`)
    // Stored source paths are resolved from the project root, not the wizard cwd.
    sources.push({ name: 'product', path: projectRelative(projectRoot, sourceRoot) })
  }
  if (evidence === 'spec' || evidence === 'both') {
    const location = await promptText({
      message: 'API specification (file or URL)',
      validate: (value) => validateSpecLocation(cwd, value),
      io,
    })
    const summary = await describeSpec(cwd, location)
    if (summary) note(io, `✓ ${summary}`)
    const spec = parseSpec(`api=${location}`)
    sources.push(
      isSpecUrl(spec.path)
        ? spec
        : { ...spec, path: projectRelative(projectRoot, resolve(cwd, spec.path)) },
    )
  }
  if (evidence === 'none') {
    note(
      io,
      'The agent will author from your request and ask before inventing product behavior.\nAttach evidence later with `doxloop settings`.',
    )
  }

  const suggestedTitle =
    (sourceRoot ? await titleFromPackageMetadata(sourceRoot) : undefined) ??
    titleize(basename(projectRoot))
  const title = await promptText({
    message: 'Site title',
    initial: suggestedTitle,
    io,
  })

  const generatorChoice = await promptSelect<'doxbrix' | 'other'>({
    message: 'How should the documentation site be generated?',
    choices: [
      {
        value: 'doxbrix',
        label: 'Doxbrix',
        hint: 'recommended · built in · no additional setup',
      },
      {
        value: 'other',
        label: 'Use another documentation framework',
      },
    ],
    io,
  })
  const generator: GeneratorName =
    generatorChoice === 'doxbrix'
      ? 'doxbrix'
      : await promptSelect<GeneratorName>({
          message: 'Choose your documentation framework',
          choices: GENERATOR_CATALOG.filter((entry) => entry.id !== 'doxbrix').map(
            (entry) => ({
              value: entry.id,
              label: entry.displayName,
              ...(
                entry.packageName &&
                resolveGeneratorPackage(projectRoot, entry.packageName)
                  ? { hint: 'installed' }
                  : entry.packageName
                    ? { hint: `will install ${entry.packageName}` }
                    : {}),
            }),
          ),
          io,
        })

  return { directory, title, sources, generator }
}

export function replayInitCommand(plan: InitPlan): string {
  const parts = ['doxloop init', quoteArgument(plan.directory)]
  if (plan.title) parts.push('--title', quoteArgument(plan.title))
  for (const source of plan.sources) {
    if ((source.kind ?? 'directory') === 'openapi') {
      parts.push('--spec', quoteArgument(`${source.name}=${source.path}`))
    } else {
      parts.push('--source', quoteArgument(`${source.name}=${source.path}`))
    }
  }
  if (plan.generator !== 'doxbrix') parts.push('--generator', plan.generator)
  return parts.join(' ')
}

export function formatInitPlan(cwd: string, plan: InitPlan): string {
  const projectRoot = resolve(cwd, plan.directory)
  const evidence =
    plan.sources.length === 0
      ? 'None yet'
      : plan.sources
          .map((source) =>
            (source.kind ?? 'directory') === 'openapi'
              ? `OpenAPI: ${source.path}`
              : `Source: ${resolve(projectRoot, source.path)}`,
          )
          .join('\n            ')
  const generator =
    GENERATOR_CATALOG.find((entry) => entry.id === plan.generator)?.displayName ??
    plan.generator
  return `Setup summary\n\n  Documentation: ${projectRoot}\n  Evidence:      ${evidence}\n  Site title:    ${plan.title ?? basename(projectRoot)}\n  Generator:     ${generator}`
}

export async function runCreateRescueWizard(
  cwd: string,
  io: PromptIo,
): Promise<InitPlan | undefined> {
  const found = await describeDirectory(cwd)
  if (!found) return undefined
  const name = basename(cwd)
  note(io, `This directory is not a Doxloop project — it looks like your product source\n(found: ${found}).`)
  const proceed = await promptConfirm({
    message: `Set up a separate documentation project for "${name}" now?`,
    initial: true,
    io,
  })
  if (!proceed) return undefined
  return runInitWizard(cwd, io)
}

export async function promptForRequest(
  mode: 'create' | 'update',
  io: PromptIo,
  hasEvidence = true,
): Promise<string | undefined> {
  const value = await promptText({
    message:
      mode === 'create'
        ? 'What documentation do you need?'
        : 'Anything specific to focus on?',
    hint:
      mode === 'create'
        ? 'Describe readers, required pages, tone, or priorities — or press Enter to let the agent propose a plan.'
        : hasEvidence
          ? 'Press Enter to synchronize documentation with the source changes above.'
          : 'Describe the documentation-only change, or press Enter to cancel.',
    allowEmpty: true,
    io,
  })
  return value === '' ? undefined : value
}

export async function selectAgentInteractive(
  io: PromptIo,
): Promise<AgentName | undefined> {
  const agents = await detectAgents()
  if (agents.length === 0) {
    throw new DoxloopError(
      'Codex, Claude Code, or Gemini is not available on PATH. Install an agent, or run `doxloop create --print` to prepare the authoring prompt.',
      2,
    )
  }
  if (agents.length === 1) return agents[0]?.name
  const labels: Record<AgentName, string> = {
    codex: 'Codex',
    claude: 'Claude Code',
    gemini: 'Gemini',
  }
  return promptSelect<AgentName>({
    message: 'Which agent should author this run?',
    choices: agents.map((agent) => ({
      value: agent.name,
      label: labels[agent.name],
    })),
    io,
  })
}

async function validateProjectDirectory(
  cwd: string,
  value: string,
): Promise<string | undefined> {
  const root = resolve(cwd, value)
  if (await pathExists(join(root, PROJECT_FILE))) {
    return `A Doxloop project already exists at ${root}. Choose another directory.`
  }
  if (await pathExists(root)) {
    try {
      const stats = await stat(root)
      if (!stats.isDirectory()) return `${root} is not a directory.`
      if ((await readdir(root)).length > 0) {
        return `${root} is not empty. Choose a new or empty directory.`
      }
    } catch {
      return `Cannot inspect ${root}.`
    }
  }
  return undefined
}

async function validateSourceDirectory(
  cwd: string,
  projectRoot: string,
  value: string,
): Promise<string | undefined> {
  const sourceRoot = resolve(cwd, value)
  try {
    const stats = await stat(sourceRoot)
    if (!stats.isDirectory()) return `${sourceRoot} is not a directory.`
  } catch {
    return `The product source does not exist: ${sourceRoot}`
  }
  if (
    sourceRoot === projectRoot ||
    projectRoot.startsWith(`${sourceRoot}/`) ||
    sourceRoot.startsWith(`${projectRoot}/`)
  ) {
    return 'The product source and documentation project must be separate directories.'
  }
  return undefined
}

async function validateSpecLocation(
  cwd: string,
  value: string,
): Promise<string | undefined> {
  if (isSpecUrl(value)) {
    try {
      const url = new URL(value)
      if (url.username || url.password) return 'Remove embedded credentials from the URL.'
    } catch {
      return 'Enter a valid HTTP or HTTPS URL.'
    }
    return undefined
  }
  const path = resolve(cwd, value)
  try {
    const stats = await stat(path)
    if (!stats.isFile()) return `${path} is not a file.`
  } catch {
    return `The specification file does not exist: ${path}`
  }
  return undefined
}

export async function describeSpec(
  cwd: string,
  location: string,
): Promise<string | undefined> {
  if (isSpecUrl(location)) return undefined
  const path = resolve(cwd, location)
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as {
      openapi?: unknown
      swagger?: unknown
      info?: { title?: unknown }
      paths?: Record<string, Record<string, unknown>>
    }
    const version =
      typeof parsed.openapi === 'string'
        ? `OpenAPI ${parsed.openapi}`
        : typeof parsed.swagger === 'string'
          ? `Swagger ${parsed.swagger}`
          : undefined
    if (!version) return undefined
    const title = typeof parsed.info?.title === 'string' ? parsed.info.title : undefined
    const operations = parsed.paths
      ? Object.values(parsed.paths).reduce(
          (total, methods) => total + Object.keys(methods ?? {}).length,
          0,
        )
      : 0
    return [version, title ? `"${title}"` : undefined, `${operations} operations`]
      .filter(Boolean)
      .join(' — ')
  } catch {
    return undefined
  }
}

export async function describeDirectory(path: string): Promise<string | undefined> {
  const found: string[] = []
  for (const marker of PRODUCT_MARKERS) {
    if (await pathExists(join(path, marker))) found.push(marker)
    if (found.length === 4) break
  }
  return found.length > 0 ? found.join(', ') : undefined
}

async function titleFromPackageMetadata(
  sourceRoot: string,
): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(
      await readFile(join(sourceRoot, 'package.json'), 'utf8'),
    ) as { name?: unknown }
    if (typeof parsed.name === 'string' && parsed.name.trim() !== '') {
      return titleize(parsed.name.replace(/^@[^/]+\//, ''))
    }
  } catch {
    // No package metadata; fall back to the directory name.
  }
  return undefined
}

function titleize(value: string): string {
  return value
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map((word) => `${word[0]?.toUpperCase() ?? ''}${word.slice(1)}`)
    .join(' ')
}

function quoteArgument(value: string): string {
  if (/^[a-zA-Z0-9_@%+=:,./-]+$/.test(value)) return value
  if (process.platform === 'win32') return `'${value.replaceAll("'", "''")}'`
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function projectRelative(projectRoot: string, absolute: string): string {
  return relative(projectRoot, absolute).split('\\').join('/')
}
