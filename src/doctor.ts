import { createServer } from 'node:net'
import type { AgentName } from './types.js'
import {
  agentAuthenticationStatus,
  chooseAgent,
  skillStatus,
} from './agents.js'
import { DoxloopError } from './errors.js'
import { diagnoseGenerator } from './generator-manager.js'
import {
  findProjectRoot,
  loadProject,
  resolveSeparateProjectLayout,
  validateProjectSourceBoundaries,
} from './project.js'
import { validateProject } from './validation.js'

export interface DoctorCheck {
  status: 'pass' | 'warning' | 'fail'
  label: string
  detail?: string
}

export interface DoctorReport {
  ready: boolean
  checks: DoctorCheck[]
}

export async function runDoctor(options: {
  cwd: string
  source?: string
  output?: string
  agent?: AgentName
}): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [nodeCheck()]
  const preflight = options.source !== undefined || options.output !== undefined

  if (preflight) {
    if (!options.source || !options.output) {
      checks.push({
        status: 'fail',
        label: 'New project paths',
        detail: 'Pass both `--source <product-directory>` and `--output <documentation-directory>`.',
      })
    } else {
      try {
        const layout = await resolveSeparateProjectLayout({
          cwd: options.cwd,
          source: options.source,
          output: options.output,
        })
        checks.push({
          status: 'pass',
          label: 'Product source found',
          detail: layout.sourceRoot,
        })
        checks.push({
          status: 'pass',
          label: 'Documentation output is separate and available',
          detail: layout.projectRoot,
        })
      } catch (error) {
        checks.push({
          status: 'fail',
          label: 'Product and documentation directories',
          detail: errorMessage(error),
        })
      }
    }
  } else {
    await inspectExistingProject(options.cwd, checks)
  }

  await inspectAgent(options.agent, checks, preflight ? undefined : options.cwd)
  checks.push(await previewPortCheck())
  return {
    ready: checks.every((check) => check.status !== 'fail'),
    checks,
  }
}

async function previewPortCheck(): Promise<DoctorCheck> {
  return new Promise((resolveCheck) => {
    const server = createServer()
    server.unref()
    server.once('error', () => {
      resolveCheck({
        status: 'warning',
        label: 'Preview port 4321 is occupied',
        detail: 'Use `doxloop preview --port 4400 --open` or stop the process using port 4321.',
      })
    })
    server.listen(4321, '127.0.0.1', () => {
      server.close(() => {
        resolveCheck({ status: 'pass', label: 'Preview port 4321 is available' })
      })
    })
  })
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = ['Checking Doxloop…', '']
  for (const check of report.checks) {
    const symbol =
      check.status === 'pass' ? '✓' : check.status === 'warning' ? '!' : '✗'
    lines.push(`${symbol} ${check.label}`)
    if (check.detail) {
      for (const line of check.detail.split('\n')) lines.push(`  ${line}`)
    }
  }
  lines.push('', report.ready ? 'Doxloop is ready.' : 'Doxloop needs attention before you continue.')
  return lines.join('\n')
}

async function inspectExistingProject(
  cwd: string,
  checks: DoctorCheck[],
): Promise<void> {
  let root: string
  try {
    root = await findProjectRoot(cwd)
    checks.push({
      status: 'pass',
      label: 'Documentation project found',
      detail: root,
    })
  } catch (error) {
    checks.push({
      status: 'fail',
      label: 'Documentation project',
      detail: `${errorMessage(error)}\nFor a new project, run: doxloop doctor --source ./my-product --output ./my-docs`,
    })
    return
  }

  try {
    const project = await loadProject(root)
    await validateProjectSourceBoundaries(root, project.sources)
    checks.push({
      status: 'pass',
      label: `${project.sources.length} product source${project.sources.length === 1 ? '' : 's'} found and separate`,
    })
  } catch (error) {
    checks.push({
      status: 'fail',
      label: 'Product source boundary',
      detail: errorMessage(error),
    })
  }

  try {
    const generator = await diagnoseGenerator(root)
    const name = generator.split('\n')[0]?.replace(/^Generator:\s*/, '') ?? 'Generator'
    checks.push({ status: 'pass', label: `${name} generator is ready` })
  } catch (error) {
    checks.push({
      status: 'fail',
      label: 'Documentation generator',
      detail: errorMessage(error),
    })
  }

  const validation = await validateProject(root)
  checks.push({
    status:
      validation.errors > 0
        ? 'fail'
        : validation.warnings > 0
          ? 'warning'
          : 'pass',
    label: `${validation.pages.length} documentation page${validation.pages.length === 1 ? '' : 's'} checked`,
    detail: `${validation.errors} errors, ${validation.warnings} warnings`,
  })
}

async function inspectAgent(
  preferredAgent: AgentName | undefined,
  checks: DoctorCheck[],
  projectCwd: string | undefined,
): Promise<void> {
  try {
    const agent = await chooseAgent(preferredAgent)
    const label = agent.name === 'claude' ? 'Claude Code' : capitalize(agent.name)
    checks.push({ status: 'pass', label: `${label} is installed` })
    const authentication = await agentAuthenticationStatus(agent)
    checks.push({
      status:
        authentication.status === 'authenticated'
          ? 'pass'
          : authentication.status === 'unknown'
            ? 'warning'
            : 'fail',
      label:
        authentication.status === 'authenticated'
          ? `${label} is signed in`
          : `${label} authentication`,
      ...(authentication.status === 'authenticated'
        ? {}
        : { detail: authentication.detail }),
    })
    if (projectCwd) {
      let root: string | undefined
      try {
        root = await findProjectRoot(projectCwd)
      } catch {
        return
      }
      await inspectSkills(root, agent.name, checks)
    }
  } catch (error) {
    checks.push({
      status: 'fail',
      label: 'Coding agent',
      detail: errorMessage(error),
    })
  }
}

async function inspectSkills(
  root: string,
  agent: AgentName,
  checks: DoctorCheck[],
): Promise<void> {
  const skills = await skillStatus(root, agent)
  const missing = skills.filter((skill) => skill.status === 'missing')
  const modified = skills.filter((skill) => skill.status === 'modified')
  const label = agent === 'claude' ? 'Claude Code' : capitalize(agent)
  if (missing.length > 0) {
    checks.push({
      status: 'fail',
      label: `${label} project skills`,
      detail: `Missing ${missing.length} skill${missing.length === 1 ? '' : 's'}. Run \`doxloop agent setup --agent ${agent}\`.`,
    })
  } else if (modified.length > 0) {
    checks.push({
      status: 'fail',
      label: `${label} project skills`,
      detail: `Modified ${modified.length} skill${modified.length === 1 ? '' : 's'}. Review them, then run \`doxloop agent update --agent ${agent}\` if they should be replaced.`,
    })
  } else {
    checks.push({ status: 'pass', label: `${label} project skills are ready` })
  }
}

function nodeCheck(): DoctorCheck {
  const [major = 0, minor = 0] = process.versions.node
    .split('.')
    .map((value) => Number(value))
  const supported = major > 20 || (major === 20 && minor >= 12)
  return {
    status: supported ? 'pass' : 'fail',
    label: `Node.js ${process.versions.node} ${supported ? 'is supported' : 'is not supported'}`,
    ...(supported ? {} : { detail: 'Install Node.js 20.12 or later.' }),
  }
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`
}

function errorMessage(error: unknown): string {
  if (error instanceof DoxloopError || error instanceof Error) return error.message
  return String(error)
}
