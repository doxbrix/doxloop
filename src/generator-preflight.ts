import { execFile } from 'node:child_process'
import { findExecutable } from './generator-runtime.js'
import {
  GENERATOR_TOOLCHAINS,
  generatorCatalogEntry,
  type GeneratorTier,
  type GeneratorToolchainId,
} from './generators.js'
import type { GeneratorName } from './types.js'

export interface GeneratorPreflightCheck {
  status: 'pass' | 'warning' | 'fail'
  label: string
  detail?: string
}

export interface GeneratorPreflight {
  generator: GeneratorName
  tier: GeneratorTier
  /** False when a required tool is missing; warnings do not clear it. */
  ready: boolean
  checks: GeneratorPreflightCheck[]
}

export interface PreflightProbe {
  findExecutable: (name: string) => Promise<string | undefined>
  /** Runs `command args` and resolves stdout+stderr, or undefined when it cannot run. */
  runVersion: (command: string, args: string[]) => Promise<string | undefined>
  nodeVersion: string
}

const DEFAULT_PROBE: PreflightProbe = {
  findExecutable,
  runVersion: (command, args) =>
    new Promise((resolveOutput) => {
      execFile(command, args, { timeout: 8_000, windowsHide: true }, (error, stdout, stderr) => {
        resolveOutput(error && !stdout && !stderr ? undefined : `${stdout}${stderr}`.trim())
      })
    }),
  nodeVersion: process.versions.node,
}

/**
 * Checks that the runtimes a generator's preview and strict build need are
 * present before the wizard creates a project with it. Doxloop's own
 * requirements (Node.js) are checked once regardless of generator.
 */
export async function generatorPreflight(
  generator: GeneratorName,
  probe: Partial<PreflightProbe> = {},
): Promise<GeneratorPreflight> {
  const entry = generatorCatalogEntry(generator)
  if (!entry) throw new Error(`Unknown generator "${generator}".`)
  const tools = { ...DEFAULT_PROBE, ...probe }
  const checks: GeneratorPreflightCheck[] = []
  if (entry.toolchain.length === 0) {
    checks.push({ status: 'pass', label: 'Built into Doxloop', detail: 'No extra toolchain is needed for preview or build.' })
  }
  for (const id of entry.toolchain) {
    checks.push(...(await toolchainChecks(id, tools)))
  }
  return {
    generator,
    tier: entry.tier,
    ready: checks.every((check) => check.status !== 'fail'),
    checks,
  }
}

async function toolchainChecks(
  id: GeneratorToolchainId,
  tools: PreflightProbe,
): Promise<GeneratorPreflightCheck[]> {
  const requirement = GENERATOR_TOOLCHAINS[id]
  switch (id) {
    case 'node': {
      const [major = 0, minor = 0] = tools.nodeVersion.split('.').map(Number)
      const supported = major > 20 || (major === 20 && minor >= 12)
      const checks: GeneratorPreflightCheck[] = [
        supported
          ? { status: 'pass', label: `Node.js ${tools.nodeVersion}` }
          : { status: 'fail', label: `Node.js ${tools.nodeVersion} is too old`, detail: `${requirement.label} is required for the native build.` },
      ]
      const managers = await Promise.all(['npm', 'pnpm', 'yarn'].map(async (name) => ((await tools.findExecutable(name)) ? name : undefined)))
      const available = managers.filter((name): name is string => Boolean(name))
      checks.push(
        available.length > 0
          ? { status: 'pass', label: `Package manager: ${available.join(', ')}` }
          : { status: 'fail', label: 'No package manager found', detail: 'Install npm, pnpm, or yarn so the site dependencies can be installed.' },
      )
      return checks
    }
    case 'python': {
      const python = (await tools.findExecutable('python3')) ?? (await tools.findExecutable('python'))
      if (!python) {
        return [{ status: 'fail', label: 'Python is not installed', detail: `${requirement.label} is required. ${requirement.detail}` }]
      }
      const version = await tools.runVersion(python, ['--version'])
      const match = version?.match(/(\d+)\.(\d+)(?:\.(\d+))?/)
      const [, major = '0', minor = '0'] = match ?? []
      const supported = Number(major) > 3 || (Number(major) === 3 && Number(minor) >= 9)
      const checks: GeneratorPreflightCheck[] = [
        supported
          ? { status: 'pass', label: `Python ${match?.[0] ?? version ?? 'found'}` }
          : { status: 'fail', label: `Python ${match?.[0] ?? 'version unknown'} is too old`, detail: `${requirement.label} is required for MkDocs and Sphinx.` },
      ]
      const venv = await tools.runVersion(python, ['-c', 'import venv, ensurepip; print("ok")'])
      checks.push(
        venv?.includes('ok')
          ? { status: 'pass', label: 'venv and pip modules available' }
          : { status: 'warning', label: 'venv or ensurepip module missing', detail: 'Doxloop creates .doxloop/venv on first preview; install the python3-venv package if that fails.' },
      )
      return checks
    }
    case 'hugo': {
      const hugo = await tools.findExecutable('hugo')
      if (!hugo) {
        return [{ status: 'fail', label: 'Hugo is not installed', detail: 'Install Hugo from https://gohugo.io/installation/ so preview and build can run.' }]
      }
      const version = await tools.runVersion(hugo, ['version'])
      const extended = /extended/i.test(version ?? '')
      return [
        { status: 'pass', label: `Hugo ${version?.match(/v?\d+\.\d+(?:\.\d+)?/)?.[0] ?? 'found'}${extended ? ' (extended)' : ''}` },
        ...(extended ? [] : [{ status: 'warning' as const, label: 'Standard edition', detail: 'Themes that compile Sass need the extended edition.' }]),
      ]
    }
    case 'ruby': {
      const ruby = await tools.findExecutable('ruby')
      const bundle = await tools.findExecutable('bundle')
      const checks: GeneratorPreflightCheck[] = []
      if (!ruby) {
        checks.push({ status: 'fail', label: 'Ruby is not installed', detail: 'Install Ruby 3.1 or later; Jekyll runs on it.' })
      } else {
        const version = await tools.runVersion(ruby, ['--version'])
        checks.push({ status: 'pass', label: `Ruby ${version?.match(/\d+\.\d+(?:\.\d+)?/)?.[0] ?? 'found'}` })
      }
      checks.push(
        bundle
          ? { status: 'pass', label: 'Bundler available' }
          : { status: 'fail', label: 'Bundler is not installed', detail: 'Run `gem install bundler` so Jekyll gems can be installed under .doxloop/bundle.' },
      )
      return checks
    }
  }
}
