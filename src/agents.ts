import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import {
  access,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import spawn from 'cross-spawn'
import { DoxloopError, UsageError } from './errors.js'
import { pathExists } from './fs.js'
import { loadGeneratorAdapter } from './generators.js'
import { loadProject } from './project.js'
import type { AgentName } from './types.js'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export function parseAgent(value: string | undefined): AgentName | undefined {
  if (value === undefined) return undefined
  if (value === 'codex' || value === 'claude' || value === 'gemini') return value
  throw new UsageError('--agent must be codex, claude, or gemini')
}

export async function installSkill(options: {
  root: string
  agent?: AgentName
  replace?: boolean
}): Promise<Array<{ path: string; action: 'installed' | 'updated' | 'unchanged' }>> {
  const results: Array<{ path: string; action: 'installed' | 'updated' | 'unchanged' }> = []

  for (const { skillName, source } of await packagedSkills(options.root)) {
    if (!(await pathExists(source))) {
      throw new DoxloopError(`The packaged ${skillName} skill is missing.`)
    }
    const expected = await directoryDigest(source)
    for (const destination of skillDestinationsFor(
      options.root,
      skillName,
      options.agent,
    )) {
      await assertSafeDestination(options.root, destination)
      if (await pathExists(destination)) {
        const actual = await directoryDigest(destination)
        if (actual === expected) {
          results.push({ path: destination, action: 'unchanged' })
          continue
        }
        if (!options.replace) {
          throw new DoxloopError(
            `The installed skill has local changes: ${destination}\nRun \`doxloop agent update\` to replace it explicitly.`,
          )
        }
        await rm(destination, { recursive: true })
      }
      await mkdir(dirname(destination), { recursive: true })
      await cp(source, destination, { recursive: true, errorOnExist: true })
      results.push({
        path: destination,
        action: options.replace ? 'updated' : 'installed',
      })
    }
  }
  return results
}

export async function skillStatus(
  root: string,
  agent?: AgentName,
): Promise<Array<{ path: string; status: 'missing' | 'current' | 'modified' }>> {
  const results: Array<{ path: string; status: 'missing' | 'current' | 'modified' }> = []
  for (const { skillName, source } of await packagedSkills(root)) {
    if (!(await pathExists(source))) {
      throw new DoxloopError(`The packaged ${skillName} skill is missing.`)
    }
    const expected = await directoryDigest(source)
    for (const destination of skillDestinationsFor(root, skillName, agent)) {
      if (!(await pathExists(destination))) {
        results.push({ path: destination, status: 'missing' })
        continue
      }
      results.push({
        path: destination,
        status: (await directoryDigest(destination)) === expected ? 'current' : 'modified',
      })
    }
  }
  return results
}

async function packagedSkills(
  root: string,
): Promise<Array<{ skillName: string; source: string }>> {
  const project = await loadProject(root)
  const shared = {
    skillName: 'doxloop-authoring',
    source: join(packageRoot, 'skills', 'doxloop-authoring'),
  }
  if (project.generator === 'doxbrix') {
    return [
      shared,
      {
        skillName: 'doxloop-doxbrix',
        source: join(packageRoot, 'skills', 'doxloop-doxbrix'),
      },
    ]
  }
  const adapter = await loadGeneratorAdapter(root, project)
  return [
    shared,
    {
      skillName: adapter.authoring.skillName,
      source: adapter.authoring.skillDirectory,
    },
  ]
}

function skillDestinationsFor(
  root: string,
  skillName: string,
  agent?: AgentName,
): string[] {
  const destinations: string[] = []
  if (agent === undefined || agent === 'codex' || agent === 'gemini') {
    destinations.push(join(root, '.agents', 'skills', skillName))
  }
  if (agent === undefined || agent === 'claude') {
    destinations.push(join(root, '.claude', 'skills', skillName))
  }
  return destinations
}

export async function detectAgents(): Promise<
  Array<{ name: AgentName; executable: string }>
> {
  const found: Array<{ name: AgentName; executable: string }> = []
  for (const name of ['codex', 'claude', 'gemini'] as const) {
    const executable = await findExecutable(name)
    if (executable) found.push({ name, executable })
  }
  return found
}

export async function chooseAgent(preferred?: AgentName): Promise<{
  name: AgentName
  executable: string
}> {
  const candidates: AgentName[] = preferred ? [preferred] : ['codex', 'claude', 'gemini']
  for (const name of candidates) {
    const executable = await findExecutable(name)
    if (executable) return { name, executable }
  }
  const expected = preferred ?? 'Codex, Claude Code, or Gemini'
  throw new DoxloopError(
    `${expected} is not available on PATH. Install an agent or use --print to copy the prompt.`,
  )
}

export async function agentAuthenticationStatus(agent: {
  name: AgentName
  executable: string
}): Promise<{
  status: 'authenticated' | 'unauthenticated' | 'unknown'
  detail: string
}> {
  if (agent.name === 'gemini') {
    return {
      status: 'unknown',
      detail: 'Gemini authentication cannot be verified automatically; it will be checked when Gemini starts.',
    }
  }

  const args =
    agent.name === 'codex'
      ? ['login', 'status']
      : ['auth', 'status', '--json']
  const result = await runAgentStatus(agent.executable, args)
  if (result.timedOut) {
    return {
      status: 'unknown',
      detail: `${agent.name} authentication check timed out.`,
    }
  }
  if (agent.name === 'claude' && result.stdout.trim()) {
    try {
      const parsed = JSON.parse(result.stdout) as { loggedIn?: unknown }
      if (parsed.loggedIn === true) {
        return { status: 'authenticated', detail: 'Claude Code is signed in.' }
      }
      if (parsed.loggedIn === false) {
        return {
          status: 'unauthenticated',
          detail: 'Claude Code is not signed in. Run `claude auth login`.',
        }
      }
    } catch {
      // Fall through to the command exit code without exposing command output.
    }
  }
  if (result.exitCode === 0) {
    return {
      status: 'authenticated',
      detail: `${agent.name === 'codex' ? 'Codex' : 'Claude Code'} is signed in.`,
    }
  }
  return {
    status: 'unauthenticated',
    detail:
      agent.name === 'codex'
        ? 'Codex is not signed in. Run `codex login`.'
        : 'Claude Code is not signed in. Run `claude auth login`.',
  }
}

async function runAgentStatus(
  executable: string,
  args: string[],
): Promise<{ exitCode: number; stdout: string; timedOut: boolean }> {
  return new Promise((resolveStatus) => {
    const child = spawn(executable, args, {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    let stdout = ''
    let settled = false
    const finish = (value: {
      exitCode: number
      stdout: string
      timedOut: boolean
    }): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveStatus(value)
    }
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      if (stdout.length < 16_384) stdout += chunk.slice(0, 16_384 - stdout.length)
    })
    child.once('error', () => finish({ exitCode: 1, stdout, timedOut: false }))
    child.once('exit', (code) =>
      finish({ exitCode: code ?? 1, stdout, timedOut: false }),
    )
    const timer = setTimeout(() => {
      child.kill()
      finish({ exitCode: 1, stdout, timedOut: true })
    }, 5_000)
  })
}

async function findExecutable(name: string): Promise<string | undefined> {
  const path = process.env.PATH
  if (!path) return undefined
  const suffixes =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')
      : ['']
  for (const directory of path.split(delimiter)) {
    for (const suffix of suffixes) {
      const candidate = join(directory, `${name}${suffix.toLowerCase()}`)
      try {
        const stats = await stat(candidate)
        if (!stats.isFile()) continue
        if (process.platform !== 'win32') {
          await access(candidate, constants.X_OK)
        }
        return candidate
      } catch {
        // Continue searching PATH.
      }
    }
  }
  return undefined
}

async function assertSafeDestination(root: string, destination: string): Promise<void> {
  const relation = destination.slice(resolve(root).length)
  if (!relation.startsWith('/') && !relation.startsWith('\\')) {
    throw new DoxloopError(`Unsafe skill destination: ${destination}`)
  }
  let current = destination
  while (current.startsWith(resolve(root)) && current !== resolve(root)) {
    if (await pathExists(current)) {
      const stats = await lstat(current)
      if (stats.isSymbolicLink()) {
        throw new DoxloopError(`Refusing to write through symbolic link: ${current}`)
      }
    }
    current = dirname(current)
  }
}

async function directoryDigest(root: string): Promise<string> {
  const hash = createHash('sha256')
  for (const file of await treeFiles(root, root)) {
    hash.update(file.relative)
    hash.update('\0')
    hash.update(await readFile(file.absolute))
    hash.update('\0')
  }
  return hash.digest('hex')
}

async function treeFiles(
  root: string,
  directory: string,
): Promise<Array<{ absolute: string; relative: string }>> {
  const output: Array<{ absolute: string; relative: string }> = []
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = join(directory, entry.name)
    if (entry.isSymbolicLink()) {
      throw new DoxloopError(`Symbolic links are not allowed in the packaged skill: ${absolute}`)
    }
    if (entry.isDirectory()) output.push(...(await treeFiles(root, absolute)))
    else if (entry.isFile()) {
      output.push({
        absolute,
        relative: absolute.slice(root.length + 1).split('\\').join('/'),
      })
    }
  }
  return output
}
