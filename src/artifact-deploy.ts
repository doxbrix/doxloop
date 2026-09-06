import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { basename, extname, join, relative, resolve, sep } from 'node:path'
import { zipSync } from 'fflate'
import { apiUrl, authenticatedRequest, authenticatedRequestOptional } from './auth.js'
import { DoxloopError } from './errors.js'
import { loadGeneratorAdapter } from './generators.js'
import { loadProject } from './project.js'
import { createStepList, formatDuration } from './progress.js'
import { validateProject } from './validation.js'
import {
  deploymentVisibility,
  updateDeploymentVisibility,
  type DeploymentVisibility,
} from './deployment-visibility.js'

const MAX_ZIP_BYTES = 100 * 1024 * 1024
const MAX_FILES = 20_000
const MAX_UNCOMPRESSED_BYTES = 300 * 1024 * 1024
const MAX_FILE_BYTES = 50 * 1024 * 1024
const POLL_TIMEOUT_MS = 20 * 60_000

interface ProjectSummary {
  id: string
  name: string
  slug: string
  kind?: 'native' | 'connected'
  generator?: string | null
  source?: string | null
  hostedUrl?: string | null
  visibility?: DeploymentVisibility
}

interface Reservation {
  buildId: string
  status: string
  alreadyRunning?: boolean
  upload?: { url: string; method: 'PUT'; headers: Record<string, string>; expiresAt: string }
}

interface DeploymentStatus {
  buildId: string
  status: 'building' | 'indexing' | 'ready' | 'failed' | 'canceled'
  fileCount: number | null
  pagesIndexed: number | null
  error: string | null
  hostedUrl: string | null
}

export async function deployGeneratedSite(options: {
  root: string
  name: string
  slug: string
  dryRun?: boolean
  public?: boolean
  apiUrl?: string
}): Promise<void> {
  const project = await loadProject(options.root)
  const adapter = await loadGeneratorAdapter(options.root, project)
  const steps = createStepList()
  const visibility = deploymentVisibility(options.public)
  process.stdout.write(
    `Deploying "${options.name}" as ${visibility} → ${apiUrl(options.apiUrl)}\n\n`,
  )

  try {
    const validating = steps.start('Validating documentation')
    const validation = await validateProject(options.root)
    if (validation.errors > 0) {
      throw new DoxloopError(`Deployment stopped because documentation has ${validation.errors} validation error${validation.errors === 1 ? '' : 's'}. Run \`doxloop test\`.`)
    }
    validating.done('Validated documentation')

    let target: ProjectSummary | undefined
    let siteUrl = process.env.DOXLOOP_SITE_URL || 'https://example.com'
    if (!options.dryRun) {
      const locating = steps.start('Locating project')
      const existing = await authenticatedRequestOptional<{ project: ProjectSummary }>(
        `/api/v1/projects/${encodeURIComponent(options.slug)}`,
        { method: 'GET' },
        options.apiUrl,
      )
      if (existing?.project) {
        target = existing.project
        assertArtifactProject(target, project.generator)
        await updateDeploymentVisibility(target, visibility, options.apiUrl)
        locating.done(`Found project "${target.name}" (${target.slug})`)
      } else {
        const created = await authenticatedRequest<{ project: ProjectSummary }>(
          '/api/v1/projects',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: options.name,
              slug: options.slug,
              visibility,
              seedTemplate: false,
              connectedArtifact: { generator: project.generator },
            }),
          },
          options.apiUrl,
        )
        target = created.project
        assertArtifactProject(target, project.generator)
        locating.done(`Created hosted project "${target.name}" (${target.slug})`)
      }
      if (!target.hostedUrl) throw new DoxloopError('Doxbrix did not return a hosted site URL for this project.')
      siteUrl = target.hostedUrl
    }

    const building = steps.start(`Building ${adapter.displayName} site locally`)
    await runLocalBuild(adapter.id, adapter.build.command, options.root, siteUrl)
    const outputRoot = containedOutput(options.root, adapter.build.outputDir)
    const packaged = await packageStaticOutput(outputRoot)
    building.done(
      `Built ${adapter.displayName} artifact`,
      `${packaged.files} files, ${formatBytes(packaged.archive.byteLength)}${packaged.omittedSourceMaps ? `, omitted ${packaged.omittedSourceMaps} source maps` : ''}`,
    )

    if (options.dryRun) {
      const archivePath = await writeDryRunArchive(options.root, packaged.archive)
      process.stdout.write(`\nDeployment is valid.\nGenerator: ${project.generator}\nVisibility: ${visibility}\nOutput: ${adapter.build.outputDir}\nFiles: ${packaged.files}\nArtifact: ${formatBytes(packaged.archive.byteLength)}\nArchive: ${archivePath}\nSHA-256: ${packaged.sha256}\nNo data was uploaded.\n`)
      return
    }
    if (!target) throw new DoxloopError('Doxbrix project resolution failed.')

    const reserving = steps.start('Reserving secure upload')
    const reserved = await authenticatedRequest<{ deployment: Reservation }>(
      `/api/v1/projects/${encodeURIComponent(target.id)}/deployments`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bytes: packaged.archive.byteLength, sha256: packaged.sha256 }),
      },
      options.apiUrl,
    )
    if (reserved.deployment.alreadyRunning || !reserved.deployment.upload) {
      throw new DoxloopError(`A deployment is already running for this project (${reserved.deployment.buildId}).`)
    }
    reserving.done('Reserved checksum-bound upload')

    const uploading = steps.start('Uploading static artifact')
    await uploadArtifact(reserved.deployment.upload, packaged.archive)
    uploading.done('Uploaded static artifact', formatBytes(packaged.archive.byteLength))

    const deploying = steps.start('Indexing and deploying on Doxbrix')
    await authenticatedRequest(
      `/api/v1/projects/${encodeURIComponent(target.id)}/deployments/${encodeURIComponent(reserved.deployment.buildId)}/complete`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      options.apiUrl,
    )
    const result = await waitForDeployment(target.id, reserved.deployment.buildId, options.apiUrl)
    if (result.status !== 'ready') throw new DoxloopError(result.error || `Deployment ended with status ${result.status}.`)
    deploying.done('Deployed', `${result.fileCount ?? packaged.files} files, ${result.pagesIndexed ?? 0} pages indexed · ${formatDuration(deploying.durationMs)}`)
    process.stdout.write(`\n${result.hostedUrl || target.hostedUrl}\n`)
  } catch (error) {
    steps.failActive()
    throw error
  }
}

function assertArtifactProject(project: ProjectSummary, generator: string): void {
  if (project.kind !== 'connected' || project.source !== 'bundle') {
    throw new DoxloopError(`Project "${project.slug}" already exists but is not a Connected Docs artifact project. Choose another --slug.`)
  }
  if (project.generator !== generator) {
    throw new DoxloopError(`Project "${project.slug}" expects generator "${project.generator ?? 'unknown'}", but this Doxloop project uses "${generator}". Choose another --slug.`)
  }
}

export function containedOutput(root: string, outputDir: string): string {
  const base = resolve(root)
  const output = resolve(base, outputDir)
  if (output === base || !output.startsWith(`${base}${sep}`)) {
    throw new DoxloopError(`Generator output directory must be inside the project: ${outputDir}`)
  }
  return output
}

export async function runLocalBuild(generator: string, command: string, root: string, siteUrl: string): Promise<void> {
  const environment: NodeJS.ProcessEnv = { ...process.env, DOXLOOP_SITE_URL: siteUrl, SITE_URL: siteUrl }
  delete environment.DOXLOOP_TOKEN
  delete environment.DOXBRIX_TOKEN
  delete environment.DOXLOOP_NETLIFY_TOKEN
  delete environment.NETLIFY_AUTH_TOKEN
  delete environment.DOXLOOP_VERCEL_TOKEN
  delete environment.VERCEL_TOKEN
  const effectiveCommand = generator === 'hugo'
    ? `${command} --baseURL ${JSON.stringify(`${siteUrl.replace(/\/$/, '')}/`)}`
    : generator === 'jekyll'
      ? `${command} --url ${JSON.stringify(siteUrl.replace(/\/$/, ''))}`
      : command
  const code = await new Promise<number>((resolveExit, reject) => {
    const child = spawn(effectiveCommand, {
      cwd: root,
      env: environment,
      shell: true,
      stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('exit', (value) => resolveExit(value ?? 1))
  })
  if (code !== 0) {
    throw new DoxloopError(`Local generator build failed (exit ${code}). Doxloop does not install dependencies during deploy; install them and run \`${command}\` locally to diagnose.`)
  }
}

export async function packageStaticOutput(root: string): Promise<{
  archive: Uint8Array
  files: number
  omittedSourceMaps: number
  sha256: string
}> {
  let rootStat
  try { rootStat = await lstat(root) } catch { throw new DoxloopError(`Generator build output was not found: ${root}`) }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new DoxloopError('Generator build output must be a real directory, not a symbolic link.')

  const entries: Record<string, Uint8Array> = {}
  let files = 0
  let bytes = 0
  let omittedSourceMaps = 0
  let hasIndex = false
  const visit = async (directory: string): Promise<void> => {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const absolute = resolve(directory, item.name)
      const path = relative(root, absolute).split(sep).join('/')
      const stat = await lstat(absolute)
      if (stat.isSymbolicLink()) throw new DoxloopError(`Build output contains a symbolic link, which cannot be deployed safely: ${path}`)
      if (stat.isDirectory()) { await visit(absolute); continue }
      if (!stat.isFile()) throw new DoxloopError(`Build output contains an unsupported file type: ${path}`)
      if (extname(path).toLowerCase() === '.map') { omittedSourceMaps++; continue }
      assertSafeArtifactName(path)
      if (stat.size > MAX_FILE_BYTES) throw new DoxloopError(`Build output file exceeds ${formatBytes(MAX_FILE_BYTES)}: ${path}`)
      files++
      bytes += stat.size
      if (files > MAX_FILES) throw new DoxloopError(`Build output contains more than ${MAX_FILES} files.`)
      if (bytes > MAX_UNCOMPRESSED_BYTES) throw new DoxloopError(`Build output exceeds ${formatBytes(MAX_UNCOMPRESSED_BYTES)} before compression.`)
      const data = await readFile(absolute)
      const text = data.toString('utf8')
      if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) {
        throw new DoxloopError(`Build output appears to contain a private key: ${path}`)
      }
      const activeTokens = [
        process.env.DOXLOOP_TOKEN,
        process.env.DOXBRIX_TOKEN,
        process.env.DOXLOOP_NETLIFY_TOKEN,
        process.env.NETLIFY_AUTH_TOKEN,
        process.env.DOXLOOP_VERCEL_TOKEN,
        process.env.VERCEL_TOKEN,
      ].filter(
        (value): value is string => Boolean(value && value.length >= 12),
      )
      if (activeTokens.some((token) => text.includes(token)) || /\bdxb_[A-Za-z0-9_-]{20,}\b/.test(text)) {
        throw new DoxloopError(`Build output appears to contain a deployment access token: ${path}`)
      }
      entries[path] = new Uint8Array(data)
      if (path === 'index.html') hasIndex = true
    }
  }
  await visit(root)
  if (!hasIndex) throw new DoxloopError('Generator output does not contain a root index.html file.')
  if (files === 0) throw new DoxloopError('Generator produced no deployable files.')
  const archive = zipSync(entries, { level: 6 })
  if (archive.byteLength > MAX_ZIP_BYTES) throw new DoxloopError(`Compressed artifact exceeds ${formatBytes(MAX_ZIP_BYTES)}.`)
  return { archive, files, omittedSourceMaps, sha256: createHash('sha256').update(archive).digest('hex') }
}

export async function writeDryRunArchive(root: string, archive: Uint8Array): Promise<string> {
  const directory = join(root, '.doxloop', 'exports')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const path = join(directory, `${stamp}.zip`)
  await writeFile(path, archive, { mode: 0o600 })
  return path
}

function assertSafeArtifactName(path: string): void {
  const name = basename(path).toLowerCase()
  if (
    name === '.env' || name.startsWith('.env.') || name === 'id_rsa' || name === 'id_ed25519' ||
    name === 'credentials' || name.endsWith('.pem') || name.endsWith('.key') || name.endsWith('.p12') || name.endsWith('.pfx')
  ) {
    throw new DoxloopError(`Build output contains a likely secret file: ${path}`)
  }
}

async function uploadArtifact(upload: NonNullable<Reservation['upload']>, bytes: Uint8Array): Promise<void> {
  let response: Response
  try {
    response = await fetch(upload.url, {
      method: upload.method,
      headers: upload.headers,
      body: bytes as unknown as BodyInit,
      redirect: 'error',
    })
  } catch (error) {
    throw new DoxloopError(`Artifact upload failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!response.ok) throw new DoxloopError(`Artifact upload failed: ${response.status} ${response.statusText}`)
}

async function waitForDeployment(projectId: string, buildId: string, override?: string): Promise<DeploymentStatus> {
  const deadline = Date.now() + POLL_TIMEOUT_MS
  for (;;) {
    const response = await authenticatedRequest<{ deployment: DeploymentStatus }>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/deployments/${encodeURIComponent(buildId)}`,
      { method: 'GET' },
      override,
    )
    if (response.deployment.status === 'ready' || response.deployment.status === 'failed' || response.deployment.status === 'canceled') return response.deployment
    if (Date.now() >= deadline) throw new DoxloopError(`Deployment is still running after ${POLL_TIMEOUT_MS / 60_000} minutes. Check it in Doxbrix: ${apiUrl(override)}`)
    await new Promise((resolveWait) => setTimeout(resolveWait, 2_000))
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}
