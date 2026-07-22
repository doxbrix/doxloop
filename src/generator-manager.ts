import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { DoxloopError, UsageError } from './errors.js'
import { pathExists } from './fs.js'
import {
  generatorCatalogEntry,
  installedGeneratorEntries,
  loadGeneratorAdapter,
  parseGenerator,
} from './generators.js'
import { PROJECT_FILE, loadProject } from './project.js'
import type { GeneratorName } from './types.js'

type PackageManager = 'npm' | 'pnpm' | 'yarn'

export function generatorPackageInvocation(
  packageManager: PackageManager,
  action: 'add' | 'remove',
  packageName: string,
): { command: string; args: string[] } {
  const suffix = process.platform === 'win32' ? '.cmd' : ''
  if (packageManager === 'pnpm') {
    return {
      command: `pnpm${suffix}`,
      args:
        action === 'add'
          ? ['add', '--save-dev', packageName]
          : ['remove', packageName],
    }
  }
  if (packageManager === 'yarn') {
    return {
      command: `yarn${suffix}`,
      args: [action, ...(action === 'add' ? ['--dev'] : []), packageName],
    }
  }
  return {
    command: `npm${suffix}`,
    args: [action === 'add' ? 'install' : 'uninstall', '--save-dev', packageName],
  }
}

export async function detectProjectPackageManager(root: string): Promise<PackageManager> {
  if (await pathExists(join(root, 'pnpm-lock.yaml'))) return 'pnpm'
  if (await pathExists(join(root, 'yarn.lock'))) return 'yarn'
  return 'npm'
}

export async function addGenerator(root: string, raw: string): Promise<void> {
  const generator = requiredExternalGenerator(raw)
  const entry = generatorCatalogEntry(generator)!
  await ensurePackageJson(root)
  const manager = await detectProjectPackageManager(root)
  const invocation = generatorPackageInvocation(
    manager,
    'add',
    entry.packageName!,
  )
  process.stdout.write(
    `Installing ${entry.displayName} support with \`${invocation.command} ${invocation.args.join(' ')}\`...\n`,
  )
  await runPackageManager(invocation.command, invocation.args, root)
}

export async function removeGenerator(root: string, raw: string): Promise<void> {
  const generator = requiredExternalGenerator(raw)
  const projectRoot = await optionalProjectRoot(root)
  if (projectRoot) {
    const project = await loadProject(projectRoot)
    if (project.generator === generator) {
      throw new DoxloopError(
        `Cannot remove ${generator} because the current Doxloop project uses it.`,
        2,
      )
    }
  }
  const entry = generatorCatalogEntry(generator)!
  const manager = await detectProjectPackageManager(root)
  const invocation = generatorPackageInvocation(
    manager,
    'remove',
    entry.packageName!,
  )
  process.stdout.write(
    `Removing ${entry.displayName} support with \`${invocation.command} ${invocation.args.join(' ')}\`...\n`,
  )
  await runPackageManager(invocation.command, invocation.args, root)
}

export async function formatGeneratorList(root: string): Promise<string> {
  const entries = await installedGeneratorEntries(root)
  return entries
    .map(
      (entry) =>
        `${entry.installed ? 'installed' : 'missing  '}  ${entry.id.padEnd(12)} ${entry.displayName}${entry.packageName ? `  ${entry.packageName}` : '  built in'}`,
    )
    .join('\n')
}

export async function formatGeneratorInfo(root: string, raw: string): Promise<string> {
  const generator = parseGenerator(raw)
  if (!generator) throw new UsageError('A generator name is required.')
  const entry = generatorCatalogEntry(generator)!
  const installed = (await installedGeneratorEntries(root)).find(
    (candidate) => candidate.id === generator,
  )?.installed
  return [
    `${entry.displayName} (${entry.id})`,
    `Status: ${installed ? 'installed' : 'not installed'}`,
    `Package: ${entry.packageName ?? 'built into @doxbrix/doxloop'}`,
    `Authoring skill: $${entry.skillName}`,
    ...(entry.buildCommand ? [`Build: ${entry.buildCommand}`] : []),
    ...(entry.outputDir ? [`Output: ${entry.outputDir}`] : []),
  ].join('\n')
}

export async function diagnoseGenerator(root: string): Promise<string> {
  const projectRoot = await requireProjectRoot(root)
  const project = await loadProject(projectRoot)
  if (project.generator === 'doxbrix') {
    return [
      'Generator: Doxbrix',
      'Package: built in',
      'API: native',
      'Authoring skill: $doxloop-doxbrix',
      'Status: ready',
    ].join('\n')
  }
  const adapter = await loadGeneratorAdapter(projectRoot, project)
  if (!(await pathExists(adapter.authoring.skillDirectory))) {
    throw new DoxloopError(
      `Generator ${adapter.packageName} is installed but its authoring skill is missing.`,
    )
  }
  return [
    `Generator: ${adapter.displayName}`,
    `Package: ${adapter.packageName}@${adapter.packageVersion}`,
    `API: ${adapter.apiVersion}`,
    `Authoring skill: $${adapter.authoring.skillName}`,
    `Build: ${adapter.build.command}`,
    `Output: ${adapter.build.outputDir}`,
    'Status: ready',
  ].join('\n')
}

async function ensurePackageJson(root: string): Promise<void> {
  const path = join(root, 'package.json')
  if (await pathExists(path)) return
  await writeFile(
    path,
    `${JSON.stringify(
      {
        name: basename(root) || 'documentation',
        private: true,
        version: '0.0.0',
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
}

function requiredExternalGenerator(raw: string): Exclude<GeneratorName, 'doxbrix'> {
  const generator = parseGenerator(raw)
  if (!generator) throw new UsageError('A generator name is required.')
  const entry = generatorCatalogEntry(generator)
  if (!entry?.packageName) {
    throw new UsageError(`${entry?.displayName ?? generator} support is built into Doxloop.`)
  }
  return generator as Exclude<GeneratorName, 'doxbrix'>
}

async function runPackageManager(
  command: string,
  args: string[],
  root: string,
): Promise<void> {
  const code = await new Promise<number>((resolveExit, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (exitCode) => resolveExit(exitCode ?? 1))
  })
  if (code !== 0) {
    throw new DoxloopError(
      `Generator package installation failed with exit code ${code}.`,
      2,
    )
  }
}

async function optionalProjectRoot(start: string): Promise<string | undefined> {
  let current = resolve(start)
  while (true) {
    if (await pathExists(join(current, PROJECT_FILE))) return current
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

async function requireProjectRoot(start: string): Promise<string> {
  const root = await optionalProjectRoot(start)
  if (!root) {
    throw new DoxloopError(
      'No Doxloop project found. Run `doxloop init <directory>` first.',
      2,
    )
  }
  return root
}
