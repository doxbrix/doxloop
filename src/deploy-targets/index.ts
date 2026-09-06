import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { packageStaticOutput, containedOutput, runLocalBuild, writeDryRunArchive } from '../artifact-deploy.js'
import { buildDoxbrixStaticSite } from '../doxbrix-build.js'
import { DoxloopError } from '../errors.js'
import { loadGeneratorAdapter } from '../generators.js'
import { recordDeployment } from '../history.js'
import { loadProject } from '../project.js'
import { validateProject } from '../validation.js'
import { githubPagesTarget } from './github-pages.js'
import { netlifyTarget } from './netlify.js'
import type { DeployBundle, DeployTarget, DeployTargetId, DeployTargetOptions, DeployTargetResult } from './types.js'
import { vercelTarget } from './vercel.js'

export type { DeployBundle, DeployTarget, DeployTargetId, DeployTargetOptions, DeployTargetResult } from './types.js'

export const STATIC_DEPLOY_TARGETS: readonly DeployTarget[] = [githubPagesTarget, netlifyTarget, vercelTarget]

export function deployTarget(id: DeployTargetId): DeployTarget {
  const target = STATIC_DEPLOY_TARGETS.find((candidate) => candidate.id === id)
  if (!target) throw new DoxloopError(`Unsupported static deploy target: ${id}`)
  return target
}

export async function publishStaticTarget(
  id: Extract<DeployTargetId, 'github-pages' | 'netlify' | 'vercel'>,
  options: DeployTargetOptions & { dryRun?: boolean },
): Promise<DeployTargetResult> {
  const startedAt = new Date().toISOString()
  const target = deployTarget(id)
  let configured: DeployTargetOptions | undefined
  try {
    const validation = await validateProject(options.root)
    if (validation.errors > 0) throw new DoxloopError(`Deployment stopped because documentation has ${validation.errors} validation error${validation.errors === 1 ? '' : 's'}. Run \`doxloop test\`.`)
    configured = await target.configure(options)
    const project = await loadProject(options.root)
    const temporary = await mkdtemp(join(tmpdir(), 'doxloop-deploy-'))
    try {
      let outputDir: string
      if (project.generator === 'doxbrix') {
        outputDir = join(temporary, 'site')
        await buildDoxbrixStaticSite({
          root: options.root,
          outDir: outputDir,
          ...(configured.basePath ? { basePath: configured.basePath } : {}),
          ...(configured.siteUrl ? { siteUrl: configured.siteUrl } : {}),
        })
      } else {
        const adapter = await loadGeneratorAdapter(options.root, project)
        await runLocalBuild(adapter.id, adapter.build.command, options.root, configured.siteUrl ?? 'https://example.com')
        outputDir = containedOutput(options.root, adapter.build.outputDir)
      }
      const packaged = await packageStaticOutput(outputDir)
      const bundle: DeployBundle = { outputDir, archive: packaged.archive, files: packaged.files, bytes: packaged.archive.byteLength, sha256: packaged.sha256 }
      if (options.dryRun) {
        const archivePath = await writeDryRunArchive(options.root, bundle.archive)
        process.stdout.write(`Deployment is valid.\nTarget: ${target.label}\nFiles: ${bundle.files}\nArchive: ${archivePath}\nSHA-256: ${bundle.sha256}\nNo data was uploaded.\n`)
        return { detail: archivePath }
      }
      const result = await target.publish(bundle, configured)
      await recordDeployment(options.root, {
        target: id,
        status: 'succeeded',
        startedAt,
        name: options.name,
        slug: options.slug,
        ...(result.url ? { url: result.url } : {}),
        pagesCount: validation.pages.length,
        bytes: bundle.bytes,
      })
      process.stdout.write(`${target.label} deployment succeeded.${result.detail ? ` ${result.detail}.` : ''}${result.url ? `\n${result.url}` : ''}\n`)
      return result
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  } catch (error) {
    await recordDeployment(options.root, { target: id, status: 'failed', startedAt, name: options.name, slug: options.slug, error: error instanceof Error ? error.message : String(error) })
    throw error
  }
}
