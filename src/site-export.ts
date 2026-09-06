import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, relative, resolve, sep } from 'node:path'
import {
  containedOutput,
  packageStaticOutput,
  runLocalBuild,
} from './artifact-deploy.js'
import { buildDoxbrixStaticSite } from './doxbrix-build.js'
import { DoxloopError } from './errors.js'
import { pathExists } from './fs.js'
import { loadGeneratorAdapter } from './generators.js'
import { loadProject } from './project.js'
import { validateProject } from './validation.js'

export interface ExportSiteOptions {
  root: string
  out: string
  zip?: boolean
  basePath?: string
  siteUrl?: string
}

export interface ExportSiteResult {
  outputDir: string
  zipPath?: string
  files: number
  bytes: number
  sha256: string
  generator: string
}

/** Build and copy a generator's deployable static output to a user-selected folder. */
export async function exportStaticSite(options: ExportSiteOptions): Promise<ExportSiteResult> {
  const root = resolve(options.root)
  const outputDir = resolve(options.out)
  if (outputDir === root) throw new DoxloopError('Export output cannot replace the project directory.')
  await assertEmptyDestination(outputDir)

  const validation = await validateProject(root)
  if (validation.errors > 0) {
    throw new DoxloopError(`Export stopped because documentation has ${validation.errors} validation error${validation.errors === 1 ? '' : 's'}. Run \`doxloop test\`.`)
  }
  const project = await loadProject(root)
  const temporary = await mkdtemp(`${tmpdir()}/doxloop-export-`)
  try {
    let builtOutput: string
    if (project.generator === 'doxbrix') {
      builtOutput = resolve(temporary, 'site')
      await buildDoxbrixStaticSite({
        root,
        outDir: builtOutput,
        ...(options.basePath ? { basePath: options.basePath } : {}),
        ...(options.siteUrl ? { siteUrl: options.siteUrl } : {}),
      })
    } else {
      const adapter = await loadGeneratorAdapter(root, project)
      const siteUrl = options.siteUrl ?? process.env.DOXLOOP_SITE_URL ?? 'https://example.com'
      await runLocalBuild(adapter.id, adapter.build.command, root, siteUrl)
      builtOutput = containedOutput(root, adapter.build.outputDir)
    }
    if (overlaps(outputDir, builtOutput)) {
      throw new DoxloopError('Export output must be different from the generator build directory.')
    }
    const packaged = await packageStaticOutput(builtOutput)
    await mkdir(dirname(outputDir), { recursive: true })
    await cp(builtOutput, outputDir, { recursive: true, errorOnExist: true, force: false })
    const zipPath = options.zip ? `${outputDir}.zip` : undefined
    if (zipPath) {
      if (await pathExists(zipPath)) throw new DoxloopError(`Export archive already exists: ${zipPath}`)
      await writeFile(zipPath, packaged.archive, { mode: 0o600 })
    }
    return {
      outputDir,
      ...(zipPath ? { zipPath } : {}),
      files: packaged.files,
      bytes: packaged.archive.byteLength,
      sha256: packaged.sha256,
      generator: project.generator,
    }
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

function overlaps(left: string, right: string): boolean {
  const relation = relative(left, right)
  const reverse = relative(right, left)
  const within = (value: string): boolean => value === '' || (value !== '..' && !value.startsWith(`..${sep}`))
  return within(relation) || within(reverse)
}

async function assertEmptyDestination(path: string): Promise<void> {
  if (!(await pathExists(path))) return
  let entries: string[]
  try { entries = await readdir(path) } catch { throw new DoxloopError(`Export output must be a directory: ${path}`) }
  if (entries.length > 0) throw new DoxloopError(`Export output directory is not empty: ${path}`)
  // cp with errorOnExist requires the destination not to exist.
  await rm(path, { recursive: true })
}
