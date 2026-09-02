import { spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { pathExists } from './fs.js'
import { QUALITY_CODES } from './quality-contract.js'
import { loadOpenApiSource } from './openapi.js'
import { loadProject, sourceKind } from './project.js'
import type { QualityCheck } from './types.js'

export const EXAMPLES_FILE = join('.doxloop', 'examples.json')

interface ExampleManifest {
  schemaVersion: 1
  examples: ExampleDefinition[]
}

interface ExampleDefinition {
  id: string
  runtime: 'node' | 'python' | 'openapi-request' | 'shell-source-verified' | 'source-verified'
  file: string
  workingDirectory: string
  fixtures: string[]
  network: 'denied'
  expected: { exitCode: number; stdoutIncludes?: string; stderrIncludes?: string }
}

export async function verifyExamples(root: string, enabled: boolean): Promise<QualityCheck[]> {
  const path = join(root, EXAMPLES_FILE)
  if (!(await pathExists(path))) return [{ code: QUALITY_CODES.exampleSourceVerified, category: 'examples', status: 'skipped', message: 'No executable-example manifest is configured; examples remain source-verified.' }]
  if (!enabled) return [{ code: QUALITY_CODES.exampleSourceVerified, category: 'examples', status: 'skipped', message: `Executable examples are opt-in. Set examples.enabled in .doxloop/quality.json to run ${EXAMPLES_FILE}.` }]
  const manifest = JSON.parse(await readFile(path, 'utf8')) as unknown
  if (!validManifest(manifest)) return [{ code: QUALITY_CODES.exampleFailed, category: 'examples', status: 'fail', message: `${EXAMPLES_FILE} has an unsupported format.` }]
  const checks: QualityCheck[] = []
  for (const example of manifest.examples) {
    if (example.runtime === 'source-verified' || example.runtime === 'shell-source-verified') {
      checks.push({ code: QUALITY_CODES.exampleSourceVerified, category: 'examples', status: 'skipped', message: `${example.id} is explicitly source-verified rather than executed.`, file: example.file })
      continue
    }
    checks.push(example.runtime === 'python' ? await executePythonExample(root, example) : example.runtime === 'openapi-request' ? await verifyOpenApiRequest(root, example) : await executeNodeExample(root, example))
  }
  return checks.length > 0 ? checks : [{ code: QUALITY_CODES.exampleSourceVerified, category: 'examples', status: 'skipped', message: 'The executable-example manifest contains no examples.' }]
}

async function verifyOpenApiRequest(root: string, example: ExampleDefinition): Promise<QualityCheck> {
  const source = contained(contained(root, example.workingDirectory), example.file)
  if (!(await pathExists(source))) return failure(example, 'The declared HTTP example file does not exist.')
  const content = await readFile(source, 'utf8')
  const request = /^\s*(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s+(\/\S*)/im.exec(content)
  if (!request) return failure(example, 'HTTP examples must contain a METHOD /path request line.')
  const expectedStatus = /^\s*#\s*expect-status:\s*([1-5]\d\d)\s*$/im.exec(content)?.[1]
  const operationId = `${request[1]!.toUpperCase()} ${request[2]!.split('?')[0]}`
  const project = await loadProject(root)
  for (const binding of project.sources.filter((item) => sourceKind(item) === 'openapi')) {
    try {
      const loaded = await loadOpenApiSource(root, binding)
      const operation = loaded.snapshot.operations[operationId]
      if (!operation) continue
      const pathItem = objectRecord(objectRecord(loaded.document.paths)[request[2]!.split('?')[0]!])
      const rawOperation = objectRecord(pathItem[request[1]!.toLowerCase()])
      const responses = objectRecord(rawOperation.responses)
      if (expectedStatus && !Object.hasOwn(responses, expectedStatus)) return failure(example, `${operationId} does not declare expected HTTP ${expectedStatus}.`)
      return { code: QUALITY_CODES.examplePassed, category: 'examples', status: 'pass', message: `${example.id} matches ${operationId}${expectedStatus ? ` and HTTP ${expectedStatus}` : ''} in ${binding.name}.`, file: example.file }
    } catch { /* Continue to another configured OpenAPI source. */ }
  }
  return failure(example, `${operationId} was not found in a configured OpenAPI source.`)
}

function objectRecord(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }

async function executePythonExample(root: string, example: ExampleDefinition): Promise<QualityCheck> {
  const workingRoot = contained(root, example.workingDirectory)
  const source = contained(workingRoot, example.file)
  if (!(await pathExists(source))) return failure(example, 'The declared Python example file does not exist.')
  const content = await readFile(source, 'utf8')
  if (containsCredential(content)) return failure(example, 'Execution was refused because the example appears to contain a real credential.')
  if (containsProductionTarget(content)) return failure(example, 'Execution was refused because the example names a non-example network destination.')
  if (/\b(?:ctypes|os\.system|subprocess|pty|multiprocessing)\b/.test(content)) return failure(example, 'Python examples may not start subprocesses or load native process APIs.')
  const parent = await mkdtemp(join(tmpdir(), 'doxloop-python-example-'))
  try {
    const sandbox = join(parent, 'workspace'); await mkdir(sandbox)
    const script = join(sandbox, basename(source)); await cp(source, script)
    for (const fixture of example.fixtures) {
      const fixtureSource = contained(workingRoot, fixture)
      if (!(await pathExists(fixtureSource))) return failure(example, `Fixture does not exist: ${fixture}`)
      const unsafe = await unsafeFixture(fixtureSource)
      if (unsafe) return failure(example, `Fixture ${fixture} ${unsafe}.`)
      await cp(fixtureSource, join(sandbox, basename(fixtureSource)), { recursive: true })
    }
    const wrapper = `import runpy,socket,sys\nclass BlockedSocket:\n def __init__(self,*a,**k): raise RuntimeError('network disabled by Doxloop')\nsocket.socket=BlockedSocket\nrunpy.run_path(sys.argv[1],run_name='__main__')\n`
    const result = await run('python3', ['-I', '-c', wrapper, script], sandbox, 20_000)
    const matches = result.code === example.expected.exitCode &&
      (example.expected.stdoutIncludes === undefined || result.stdout.includes(example.expected.stdoutIncludes)) &&
      (example.expected.stderrIncludes === undefined || result.stderr.includes(example.expected.stderrIncludes))
    return matches
      ? { code: QUALITY_CODES.examplePassed, category: 'examples', status: 'pass', message: `${example.id} produced the declared result in an isolated Python process with socket access disabled.`, file: example.file }
      : failure(example, `Expected exit ${example.expected.exitCode}; received ${result.code}.`, `stdout: ${clip(result.stdout)}\nstderr: ${clip(result.stderr)}`)
  } catch (error) { return failure(example, error instanceof Error ? error.message : String(error)) }
  finally { await rm(parent, { recursive: true, force: true }) }
}

async function executeNodeExample(root: string, example: ExampleDefinition): Promise<QualityCheck> {
  const workingRoot = contained(root, example.workingDirectory)
  const source = contained(workingRoot, example.file)
  if (!(await pathExists(source))) return failure(example, 'The declared example file does not exist.')
  const content = await readFile(source, 'utf8')
  if (containsCredential(content)) return failure(example, 'Execution was refused because the example appears to contain a real credential.')
  if (containsProductionTarget(content)) return failure(example, 'Execution was refused because the example names a non-example network destination.')
  if (example.network !== 'denied') return failure(example, 'Executable examples must declare network: "denied".')
  const parent = await mkdtemp(join(tmpdir(), 'doxloop-example-'))
  try {
    const sandbox = join(parent, 'workspace')
    await mkdir(sandbox)
    const script = join(sandbox, basename(source))
    await cp(source, script)
    for (const fixture of example.fixtures) {
      const fixtureSource = contained(workingRoot, fixture)
      if (!(await pathExists(fixtureSource))) return failure(example, `Fixture does not exist: ${fixture}`)
      const unsafe = await unsafeFixture(fixtureSource)
      if (unsafe) return failure(example, `Fixture ${fixture} ${unsafe}.`)
      await cp(fixtureSource, join(sandbox, basename(fixtureSource)), { recursive: true })
    }
    const actualSandbox = await realpath(sandbox)
    const actualScript = await realpath(script)
    const result = await run(process.execPath, [
      '--experimental-permission',
      `--allow-fs-read=${actualSandbox}`,
      `--allow-fs-write=${actualSandbox}`,
      actualScript,
    ], actualSandbox, 20_000)
    const matches = result.code === example.expected.exitCode &&
      (example.expected.stdoutIncludes === undefined || result.stdout.includes(example.expected.stdoutIncludes)) &&
      (example.expected.stderrIncludes === undefined || result.stderr.includes(example.expected.stderrIncludes))
    return matches
      ? { code: QUALITY_CODES.examplePassed, category: 'examples', status: 'pass', message: `${example.id} produced the declared result in an isolated, network-denied Node process.`, file: example.file }
      : failure(example, `Expected exit ${example.expected.exitCode}; received ${result.code}.`, `stdout: ${clip(result.stdout)}\nstderr: ${clip(result.stderr)}`)
  } catch (error) {
    return failure(example, error instanceof Error ? error.message : String(error))
  } finally {
    await rm(parent, { recursive: true, force: true })
  }
}

function run(command: string, args: string[], cwd: string, timeout: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, env: { PATH: process.env.PATH ?? '' }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''; let stderr = ''; let timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, timeout)
    child.stdout.on('data', (chunk) => { if (stdout.length < 64_000) stdout += chunk })
    child.stderr.on('data', (chunk) => { if (stderr.length < 64_000) stderr += chunk })
    child.once('error', reject)
    child.once('exit', (code) => { clearTimeout(timer); resolveRun({ code: timedOut ? 124 : (code ?? 1), stdout, stderr }) })
  })
}

function contained(root: string, candidate: string): string {
  const path = resolve(root, candidate)
  const rel = relative(resolve(root), path)
  if (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || rel.startsWith('../') || rel.startsWith('..\\')) throw new Error(`Example path leaves the project: ${candidate}`)
  return path
}

function validManifest(value: unknown): value is ExampleManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const manifest = value as Partial<ExampleManifest>
  return manifest.schemaVersion === 1 && Array.isArray(manifest.examples) && manifest.examples.every((example) => !!example && typeof example === 'object' && typeof example.id === 'string' && ['node', 'python', 'openapi-request', 'shell-source-verified', 'source-verified'].includes(example.runtime) && typeof example.file === 'string' && typeof example.workingDirectory === 'string' && Array.isArray(example.fixtures) && example.fixtures.every((item) => typeof item === 'string') && example.network === 'denied' && !!example.expected && Number.isInteger(example.expected.exitCode))
}

function containsCredential(value: string): boolean { return /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bAKIA[0-9A-Z]{16}\b|\bgh[pousr]_[A-Za-z0-9]{36,}\b/.test(value) }
function containsProductionTarget(value: string): boolean {
  return [...value.matchAll(/https?:\/\/([^/:\s"'`]+)/gi)].some((match) => {
    const host = match[1]?.toLowerCase() ?? ''
    return host !== 'localhost' && host !== '127.0.0.1' && host !== '::1' && host !== 'example.com' && !host.endsWith('.example')
  })
}
async function unsafeFixture(path: string): Promise<string | undefined> {
  const info = await stat(path)
  if (info.isDirectory()) {
    for (const entry of await readdir(path)) { const unsafe = await unsafeFixture(join(path, entry)); if (unsafe) return unsafe }
    return undefined
  }
  if (info.size > 1_000_000) return 'exceeds the 1 MB fixture safety limit'
  try {
    const content = await readFile(path, 'utf8')
    if (content.includes('\0')) return undefined
    if (containsCredential(content)) return 'appears to contain a real credential'
    if (containsProductionTarget(content)) return 'names a non-example network destination'
  } catch { /* Binary fixtures are copied but never interpreted. */ }
  return undefined
}
function failure(example: ExampleDefinition, message: string, detail?: string): QualityCheck { return { code: QUALITY_CODES.exampleFailed, category: 'examples', status: 'fail', message: `${example.id}: ${message}`, file: example.file, ...(detail ? { detail } : {}) } }
function clip(value: string): string { return value.trim().slice(0, 1_000) }
