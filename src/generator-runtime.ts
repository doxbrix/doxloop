import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { access, readFile, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { delimiter, extname, join, normalize, relative, resolve, sep } from 'node:path'
import { DoxloopError } from './errors.js'
import type {
  GeneratorPreviewOptions,
  ValidationIssue,
} from './generator-api.js'

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

export function resolvePublicAsset(
  root: string,
  directory: string,
  reference: string,
): string | undefined {
  if (!reference.startsWith('/')) return undefined
  const base = resolve(root, directory)
  const target = resolve(base, `.${reference}`)
  return target === base || target.startsWith(`${base}${sep}`)
    ? target
    : undefined
}

export async function readPackageJson(
  root: string,
): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as Record<
      string,
      unknown
    >
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
}

export async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function slugFromTitle(title: string): string {
  return (
    title
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'documentation'
  )
}

export function shownHost(host: string): string {
  return host === '0.0.0.0' || host === '::' ? 'localhost' : host
}

export function nodeBinary(root: string, name: string): string {
  return resolve(
    root,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? `${name}.cmd` : name,
  )
}

export async function findExecutable(name: string): Promise<string | undefined> {
  const path = process.env.PATH
  if (!path) return undefined
  const suffixes =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')
      : ['']
  for (const directory of path.split(delimiter)) {
    for (const suffix of suffixes) {
      const candidate = join(directory, `${name}${suffix.toLowerCase()}`)
      if (await pathExists(candidate)) return candidate
    }
  }
  return undefined
}

export async function nodeInstallInvocation(root: string): Promise<{
  command: string
  args: string[]
}> {
  const suffix = process.platform === 'win32' ? '.cmd' : ''
  if (await pathExists(join(root, 'pnpm-lock.yaml'))) {
    return { command: `pnpm${suffix}`, args: ['install'] }
  }
  if (await pathExists(join(root, 'yarn.lock'))) {
    return { command: `yarn${suffix}`, args: ['install'] }
  }
  return { command: `npm${suffix}`, args: ['install'] }
}

export async function ensureNodeDependencies(
  root: string,
  binaryName: string,
  label: string,
): Promise<string> {
  const binary = nodeBinary(root, binaryName)
  if (await pathExists(binary)) return binary
  if (!(await pathExists(join(root, 'package.json')))) {
    throw new DoxloopError(`This ${label} project has no package.json.`, 2)
  }
  const install = await nodeInstallInvocation(root)
  process.stdout.write(
    `Installing ${label} dependencies with \`${install.command} ${install.args.join(' ')}\` (first preview only)...\n`,
  )
  const code = await runCommand(install.command, install.args, root)
  if (code !== 0 || !(await pathExists(binary))) {
    throw new DoxloopError(
      `${label} dependency installation did not complete. Run \`${install.command} ${install.args.join(' ')}\` in this documentation project.`,
      2,
    )
  }
  return binary
}

export async function ensureNodeModule(
  root: string,
  modulePath: string,
  label: string,
): Promise<void> {
  if (await pathExists(join(root, 'node_modules', ...modulePath.split('/')))) return
  if (!(await pathExists(join(root, 'package.json')))) {
    throw new DoxloopError(`This ${label} project has no package.json.`, 2)
  }
  const install = await nodeInstallInvocation(root)
  process.stdout.write(
    `Installing ${label} dependencies with \`${install.command} ${install.args.join(' ')}\` (first preview only)...\n`,
  )
  const code = await runCommand(install.command, install.args, root)
  if (
    code !== 0 ||
    !(await pathExists(join(root, 'node_modules', ...modulePath.split('/'))))
  ) {
    throw new DoxloopError(
      `${label} dependency installation did not complete. Run \`${install.command} ${install.args.join(' ')}\` in this documentation project.`,
      2,
    )
  }
}

export function venvExecutable(root: string, name: string): string {
  return join(
    root,
    '.doxloop',
    'venv',
    process.platform === 'win32' ? 'Scripts' : 'bin',
    process.platform === 'win32' ? `${name}.exe` : name,
  )
}

export async function ensurePythonDependencies(
  root: string,
  binaryName: string,
  label: string,
): Promise<string> {
  const binary = venvExecutable(root, binaryName)
  if (await pathExists(binary)) return binary
  if (!(await pathExists(join(root, 'requirements.txt')))) {
    throw new DoxloopError(`This ${label} project has no requirements.txt.`, 2)
  }
  const python = process.platform === 'win32' ? 'python' : 'python3'
  const venv = join(root, '.doxloop', 'venv')
  process.stdout.write(
    `Creating .doxloop/venv and installing ${label} dependencies (first preview only)...\n`,
  )
  let code = await runCommand(python, ['-m', 'venv', venv], root)
  if (code === 0) {
    code = await runCommand(
      venvExecutable(root, 'python'),
      ['-m', 'pip', 'install', '-r', 'requirements.txt'],
      root,
    )
  }
  if (code !== 0 || !(await pathExists(binary))) {
    throw new DoxloopError(
      `${label} dependency installation did not complete. Create a Python virtual environment and run \`pip install -r requirements.txt\`.`,
      2,
    )
  }
  return binary
}

export async function runCommand(
  command: string,
  args: string[],
  root: string,
): Promise<number> {
  return new Promise((resolveExit, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code) => resolveExit(code ?? 1))
  })
}

export async function runPreviewProcess(
  command: string,
  args: string[],
  root: string,
  label: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const child = spawn(command, args, {
    cwd: root,
    env: environment,
    stdio: 'inherit',
  })
  const forward = (signal: NodeJS.Signals): void => {
    if (!child.killed) child.kill(signal)
  }
  const onSigint = (): void => forward('SIGINT')
  const onSigterm = (): void => forward('SIGTERM')
  process.once('SIGINT', onSigint)
  process.once('SIGTERM', onSigterm)
  try {
    const result = await new Promise<{
      code: number | null
      signal: NodeJS.Signals | null
    }>((resolveExit, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => resolveExit({ code, signal }))
    })
    if (result.code !== 0 && result.signal === null) {
      throw new DoxloopError(`${label} preview exited with code ${result.code ?? 1}.`)
    }
  } finally {
    process.off('SIGINT', onSigint)
    process.off('SIGTERM', onSigterm)
  }
}

export async function openBrowser(url: string): Promise<void> {
  const invocation =
    process.platform === 'darwin'
      ? { command: 'open', args: [url] }
      : process.platform === 'win32'
        ? { command: 'cmd', args: ['/c', 'start', '', url] }
        : { command: 'xdg-open', args: [url] }
  await new Promise<void>((resolveOpen) => {
    const child = spawn(invocation.command, invocation.args, {
      stdio: 'ignore',
      detached: true,
    })
    child.once('error', () => resolveOpen())
    child.once('spawn', () => {
      child.unref()
      resolveOpen()
    })
  })
}

/**
 * A validator that cannot tell which pages the native site links reports one
 * warning instead of guessing. The native strict build remains the authority.
 */
export function navigationUnverifiedIssue(
  label: string,
  file: string,
  reason: string,
): ValidationIssue {
  return {
    severity: 'warning',
    code: 'navigation-unverified',
    message: `${label} navigation was not verified: ${reason} Run the native build to confirm every page is reachable.`,
    file,
  }
}

/** Content-relative, forward-slash page paths for the validation context. */
export function contentRelativePages(
  contentRoot: string,
  pages: readonly string[],
): string[] {
  return pages.map((page) => relative(contentRoot, page).split('\\').join('/'))
}

export function requiredFileIssues(
  label: string,
  files: string[],
  existing: Set<string>,
): ValidationIssue[] {
  return files
    .filter((file) => !existing.has(file))
    .map((file) => ({
      severity: 'error' as const,
      code: 'missing-generator-file',
      message: `${label} project is missing ${file}.`,
      file,
    }))
}

const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

export async function serveStaticDirectory(
  options: GeneratorPreviewOptions,
  directory: string,
  label: string,
): Promise<void> {
  const root = resolve(options.root, directory)
  if (!(await pathExists(join(root, 'index.html')))) {
    throw new DoxloopError(`${label} output is missing ${directory}/index.html.`, 2)
  }
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(
        request.url ?? '/',
        `http://${request.headers.host ?? 'localhost'}`,
      )
      const decoded = decodeURIComponent(url.pathname)
      const relativePath = normalize(decoded).replace(/^([/\\])+/, '')
      let path = resolve(root, relativePath)
      if (path !== root && !path.startsWith(`${root}${sep}`)) {
        response.writeHead(403).end('Forbidden')
        return
      }
      try {
        if ((await stat(path)).isDirectory()) path = join(path, 'index.html')
      } catch {
        if (extname(path) === '') path = join(path, 'index.html')
      }
      if (!(await pathExists(path))) {
        response.writeHead(404).end('Not found')
        return
      }
      response.writeHead(200, {
        'Content-Type':
          CONTENT_TYPES[extname(path).toLowerCase()] ??
          'application/octet-stream',
      })
      createReadStream(path).pipe(response)
    } catch {
      response.writeHead(400).end('Bad request')
    }
  })
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(options.port, options.host, resolveListen)
  })
  const url = `http://${shownHost(options.host)}:${options.port}`
  process.stdout.write(`Starting ${label} preview at ${url}\n`)
  if (options.open) void openBrowser(url)
  await new Promise<void>((resolveClose) => {
    const close = (): void => {
      server.close(() => resolveClose())
    }
    process.once('SIGINT', close)
    process.once('SIGTERM', close)
  })
}
