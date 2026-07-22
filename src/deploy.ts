import { readFile } from 'node:fs/promises'
import {
  apiUrl,
  authenticatedRequest,
  authenticatedRequestOptional,
} from './auth.js'
import { DoxloopError } from './errors.js'
import { listFiles, resolveContainedDirectory } from './fs.js'
import { deployGeneratedSite } from './artifact-deploy.js'
import {
  loadPages,
  loadProject,
  loadSiteConfig,
  relativePath,
} from './project.js'
import { createStepList, formatDuration } from './progress.js'
import { validateProject } from './validation.js'

const MEDIA_EXTENSIONS = new Set([
  '.avif',
  '.bmp',
  '.eot',
  '.gif',
  '.ico',
  '.jpeg',
  '.jpg',
  '.mov',
  '.mp3',
  '.mp4',
  '.ogg',
  '.otf',
  '.pdf',
  '.png',
  '.svg',
  '.ttf',
  '.wav',
  '.webm',
  '.webp',
  '.woff',
  '.woff2',
])

interface DeploymentBundle {
  manifest: unknown
  basePath: string
  pages: Array<{ path: string; markdown: string }>
  media: Array<{ path: string; base64: string }>
}

interface ProjectSummary {
  id: string
  name: string
  slug: string
}

interface PushReport {
  spaces: number
  pagesCreated: number
  pagesUpdated: number
  navItems: number
  warnings: string[]
}

export async function deploy(options: {
  root: string
  name?: string
  slug?: string
  dryRun?: boolean
  apiUrl?: string
}): Promise<void> {
  const project = await loadProject(options.root)
  const name = options.name?.trim() || project.title
  const slug = options.slug?.trim() || slugify(project.title)
  process.stdout.write(
    `Documentation project:\n  ${options.root}\nProduct sources excluded from deployment: ${project.sources.length}\n\n`,
  )
  if (project.generator !== 'doxbrix') {
    return deployGeneratedSite({ ...options, name, slug })
  }
  const steps = createStepList()
  process.stdout.write(`Deploying "${name}" → ${apiUrl(options.apiUrl)}\n\n`)

  try {
    const validating = steps.start('Validating documentation')
    const result = await validateProject(options.root)
    if (result.errors > 0) {
      throw new DoxloopError(
        `Deployment stopped because documentation has ${result.errors} validation error${result.errors === 1 ? '' : 's'}. Run \`doxloop test\`.`,
      )
    }
    validating.done('Validated documentation')

    const building = steps.start('Building bundle')
    const bundle = await buildDeploymentBundle(options.root, project.contentDir)
    const bytes = Buffer.byteLength(JSON.stringify(bundle))
    building.done(
      'Built bundle',
      `${count(bundle.pages.length, 'page')}${bundle.media.length > 0 ? `, ${count(bundle.media.length, 'media file')}` : ''}, ${formatBytes(bytes)}`,
    )

    if (options.dryRun) {
      process.stdout.write(
        `\nDeployment is valid.\nProject: ${name}\nSlug: ${slug}\nPages: ${bundle.pages.length}\nMedia files: ${bundle.media.length}\nPayload: ${formatBytes(bytes)}\nNo data was uploaded.\n`,
      )
      return
    }

    const locating = steps.start('Locating project')
    const existing = await authenticatedRequestOptional<{ project: ProjectSummary }>(
      `/api/v1/projects/${encodeURIComponent(slug)}`,
      { method: 'GET' },
      options.apiUrl,
    )
    let target = existing?.project
    if (target) {
      locating.done(`Found project "${target.name}" (${target.slug})`)
    } else {
      const created = await authenticatedRequest<{ project: ProjectSummary }>(
        '/api/v1/projects',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // The bundle below is the source of truth. Do not let Doxbrix seed its
          // web starter template (Guides / API Reference / FAQ) first.
          body: JSON.stringify({ name, slug, seedTemplate: false }),
        },
        options.apiUrl,
      )
      target = created.project
      locating.done(`Created project "${target.name}" (${target.slug})`)
    }

    const publishing = steps.start('Publishing to Doxbrix')
    const pushed = await authenticatedRequest<{ result: PushReport }>(
      `/api/v1/projects/${encodeURIComponent(target.slug)}/bundle`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...bundle, publish: true }),
      },
      options.apiUrl,
    )
    const report = pushed.result
    publishing.done(
      'Published',
      `${count(bundle.pages.length, 'page')} (${report.pagesCreated} created, ${report.pagesUpdated} updated), ${count(report.spaces, 'space')}${bundle.media.length > 0 ? `, ${count(bundle.media.length, 'media file')}` : ''} · ${formatDuration(publishing.durationMs)}`,
    )
    for (const warning of report.warnings ?? []) {
      process.stdout.write(`warning: ${warning}\n`)
    }
    process.stdout.write(
      `\n${apiUrl(options.apiUrl)}/editor?project=${encodeURIComponent(target.slug)}\n`,
    )
  } catch (error) {
    steps.failActive()
    throw error
  }
}

export async function buildDeploymentBundle(
  root: string,
  contentDir: string,
): Promise<DeploymentBundle> {
  const project = await loadProject(root)
  if (contentDir !== project.contentDir) {
    throw new DoxloopError(
      'Deployment content directory must match .doxloop/project.json.',
    )
  }
  const contentRoot = await resolveContainedDirectory(
    root,
    project.contentDir,
    'Deployment content directory',
  )
  const pages: DeploymentBundle['pages'] = []
  for (const path of await loadPages(root, project)) {
    pages.push({
      path: relativePath(contentRoot, path),
      markdown: await readFile(path, 'utf8'),
    })
  }
  const media: DeploymentBundle['media'] = []
  for (const path of await listFiles(contentRoot, MEDIA_EXTENSIONS)) {
    media.push({
      path: relativePath(contentRoot, path),
      base64: (await readFile(path)).toString('base64'),
    })
  }
  const manifest = await loadSiteConfig(root, project)
  return { manifest, basePath: contentDir, pages, media }
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!slug) throw new DoxloopError('Cannot derive a project slug. Pass --slug.')
  return slug
}

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? '' : 's'}`
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}
