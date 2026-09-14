import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { convertSourceTree, materializeMintlifyOpenApiNavigation } from '../vendor/doxbrix-import/dist/importer.js'
import { collectSourceAssets, collectSourceFiles, copySourceAssets, writeConvertResult } from '../vendor/doxbrix-import/dist/docs/import.js'
import { listFilesRecursive } from '../vendor/doxbrix-import/dist/docs/project.js'
import { withPageExtension } from '../vendor/doxbrix-import/dist/docs/manifest.js'
import { DoxloopError } from './errors.js'
import { mintlifyMarker } from './mintlify-detect.js'
import { pathExists, resolveContainedDirectory } from './fs.js'
import { fetchRemoteOpenApi } from './openapi.js'
import { REDIRECTS_FILE } from './page-operations.js'
import { importExistingDocumentation } from './project-import.js'
import { listRemoteBranches, materializeRemoteSource, parseGitHubRepository } from './remote-source.js'
import type { DoxbrixNavNode, RemoteSource } from './types.js'

export interface MintlifySource {
  path?: string
  repository?: string
  branch?: string
  subdirectory?: string
}

export interface MintlifyInspection {
  id: string
  title: string
  source: { path?: string; repository?: string; branch?: string; head?: string; subdirectory?: string }
  pageCount: number
  assetCount: number
  pages: string[]
  spaces: string[]
  redirects: Array<{ from: string; to: string }>
  unmapped: string[]
  warnings: string[]
  suggestedDestination: string
}

interface PreparedImport { temporary: string; output: string; sourceRoot: string; expires: number; report: MintlifyInspection }
const EXPIRY_MS = 30 * 60 * 1000

/** A reviewed conversion is a frozen snapshot, including assets, not a second conversion on submit. */
export class MintlifyImports {
  private prepared = new Map<string, PreparedImport>()
  private preparing = false
  private converting = new Set<string>()

  async inspect(input: MintlifySource, cwd: string): Promise<MintlifyInspection> {
    if (this.preparing) throw new DoxloopError('Another Mintlify inspection is running. Wait for it to finish.')
    this.preparing = true
    let temporary: string | undefined
    try {
      for (const [id, item] of this.prepared) if (item.expires < Date.now()) await this.discard(id)
      if (this.prepared.size >= 3) throw new DoxloopError('Finish or cancel an existing Mintlify import before inspecting another project.')
      temporary = await mkdtemp(join(tmpdir(), 'doxloop-mintlify-'))
      let root: string
      let source: MintlifyInspection['source']
      if (input.repository) {
        const repository = `https://github.com/${parseGitHubRepository(input.repository)}.git`
        const branch = input.branch || (await listRemoteBranches({ provider: 'git', repository, branch: 'HEAD' }))[0]?.name
        if (!branch) throw new DoxloopError('The repository has no readable branches.')
        const remote: RemoteSource = { provider: 'git', repository, branch }
        const snapshot = await materializeRemoteSource(join(temporary, 'project'), { name: 'mintlify', remote })
        root = await realpath(snapshot.path)
        source = { repository, branch, head: snapshot.head }
      } else {
        if (!input.path?.trim()) throw new DoxloopError('Choose a local Mintlify folder or enter a GitHub repository.')
        root = await realpath(resolve(cwd, input.path))
        if (root === homedir() || dirname(root) === root) throw new DoxloopError('Choose the documentation repository, not your home folder or filesystem root.')
        source = { path: root }
      }
      const originalRoot = root
      if (input.subdirectory) root = await resolveContainedDirectory(root, input.subdirectory, 'Mintlify documentation directory')
      else if (!(await mintlifyMarker(root))) {
        // Reuse the CLI's traversal rules (including its symlink and tooling exclusions).
        const candidates: string[] = []
        for (const path of listFilesRecursive(root)) {
          if (!/(^|\/)(docs|mint)\.json$/.test(path)) continue
          const candidate = dirname(join(root, path))
          if (await mintlifyMarker(candidate) && !candidates.includes(candidate)) candidates.push(candidate)
        }
        if (candidates.length !== 1) throw new DoxloopError(candidates.length
          ? `Several Mintlify sites were found. Choose a documentation subfolder: ${candidates.map((path) => relative(root, path)).join(', ')}`
          : 'No Mintlify docs.json or mint.json with navigation was found. Choose the documentation folder.')
        root = candidates[0]!
      }
      if (!(await mintlifyMarker(root))) throw new DoxloopError('The selected folder is not a Mintlify documentation project.')
      const subdirectory = relative(originalRoot, root).replace(/\\/g, '/')
      if (subdirectory) source.subdirectory = subdirectory
      const isProjectFile = (path: string) => !path.split(/[\\/]/).some((part) => ['.doxloop', '.codex'].includes(part))
      const files = collectSourceFiles(root).filter((file) => isProjectFile(file.path))
      const converted = convertSourceTree(files)
      if (converted.dialect !== 'mintlify') throw new DoxloopError('The Doxbrix converter did not recognize this project as Mintlify.')
      const expanded = await materializeMintlifyOpenApiNavigation({ result: converted, files, loadRemote: async (url) => (await fetchRemoteOpenApi(url)).content })
      const result = expanded.result
      if (!result.pages.length) throw new DoxloopError('The selected Mintlify project contains no convertible pages.')
      const paths = result.pages.map((page) => withPageExtension(page.path))
      if (new Set(paths.map((path) => path.toLowerCase())).size !== paths.length) throw new DoxloopError('Several converted pages have the same output path. Resolve those collisions before importing.')
      const warnings = [...expanded.warnings]
      const convertedIds = new Set(paths.map((path) => path.replace(/\.(md|mdx)$/i, '')))
      const missingPages = new Set<string>()
      const inspectNavigation = (nodes: DoxbrixNavNode[]) => {
        for (const node of nodes) {
          if (node.type === 'group') inspectNavigation(node.items)
          else if (node.type === 'page' && !convertedIds.has(node.file)) missingPages.add(node.file)
        }
      }
      for (const space of result.manifest.spaces) inspectNavigation(space.nav)
      if (missingPages.size) warnings.push(`Navigation references ${missingPages.size} page(s) absent from the converted output: ${[...missingPages].join(', ')}. The converter excludes repository instruction files such as AGENTS.md; these pages need review before deployment.`)
      const collected = new Set(files.map((file) => file.path))
      const omitted = listFilesRecursive(root).filter((path) => /\.(mdx?|markdown)$/i.test(path) && !collected.has(path))
      if (omitted.length) warnings.push(`${omitted.length} source page(s) exceeded the converter's file limits or could not be read: ${omitted.slice(0, 10).join(', ')}`)
      const output = join(temporary, 'converted')
      writeConvertResult(output, result)
      const assets = collectSourceAssets(root).filter(isProjectFile)
      const assetCount = copySourceAssets(root, output, assets)
      if (assetCount !== assets.length) throw new DoxloopError('Some documentation assets could not be copied. Check source file access and try again.')
      // The CLI returns redirects separately. Preserve them in the native manifest as well as the report.
      if (result.redirects.length) await writeFile(join(output, 'docs.json'), JSON.stringify({ ...result.manifest, redirects: result.redirects }, null, 2) + '\n')
      const id = randomUUID()
      const title = result.manifest.name || basename(root)
      const folder = `${(source.repository ? parseGitHubRepository(source.repository).split('/')[1] : basename(root)) || 'documentation'}-doxbrix`
      const report: MintlifyInspection = { id, title, source, pageCount: paths.length, assetCount, pages: paths.slice(0, 25), spaces: result.manifest.spaces.map((space) => space.name), redirects: result.redirects, unmapped: result.unmapped, warnings, suggestedDestination: join(source.path ? dirname(originalRoot) : cwd, folder) }
      this.prepared.set(id, { temporary, output, sourceRoot: originalRoot, expires: Date.now() + EXPIRY_MS, report })
      return report
    } catch (error) {
      if (temporary) await rm(temporary, { recursive: true, force: true })
      throw error
    } finally { this.preparing = false }
  }

  async convert(id: string, destination: string, allowWarnings = false) {
    if (this.converting.has(id)) throw new DoxloopError('This conversion is already running.')
    this.converting.add(id)
    try { return await this.convertPrepared(id, destination, allowWarnings) }
    finally { this.converting.delete(id) }
  }

  private async convertPrepared(id: string, destination: string, allowWarnings: boolean) {
    const item = this.prepared.get(id)
    if (!item || item.expires < Date.now()) throw new DoxloopError('This conversion preview expired. Inspect the Mintlify project again.')
    if (!allowWarnings && (item.report.unmapped.length || item.report.warnings.length)) throw new DoxloopError('Review the conversion warnings and acknowledge them before importing.')
    if (!destination.trim()) throw new DoxloopError('Choose a new folder for the Doxbrix project.')
    const requested = resolve(destination)
    // Resolve the parent to catch aliases through symlinks; never place output in the source tree.
    const parent = await realpath(dirname(requested))
    const root = join(parent, basename(requested))
    const rel = relative(item.sourceRoot, root)
    if (!rel || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel))) throw new DoxloopError('Choose a destination outside the original Mintlify project.')
    if (await pathExists(root)) throw new DoxloopError('The destination already exists. Choose a new project folder.')
    // Claim a new directory exclusively. A failure may clean up only the directory we created.
    await mkdir(root)
    this.prepared.delete(id)
    try {
      await cp(item.output, root, { recursive: true, force: false, errorOnExist: true })
      const imported = await importExistingDocumentation({ directory: root, generator: 'doxbrix', contentDir: '', title: item.report.title })
      if (item.report.redirects.length) await writeFile(join(root, REDIRECTS_FILE), JSON.stringify(Object.fromEntries(item.report.redirects.map(({ from, to }) => [from, to])), null, 2) + '\n')
      const report = { ...item.report, importedAt: new Date().toISOString(), destination: root }
      await writeFile(join(root, '.doxloop', 'mintlify-import.json'), JSON.stringify(report, null, 2) + '\n')
      return { ...imported, conversion: report }
    } catch (error) {
      await rm(root, { recursive: true, force: true })
      throw error
    } finally { await rm(item.temporary, { recursive: true, force: true }) }
  }

  async discard(id: string): Promise<void> {
    const item = this.prepared.get(id)
    this.prepared.delete(id)
    if (item) await rm(item.temporary, { recursive: true, force: true })
  }

  async close(): Promise<void> { await Promise.all([...this.prepared.keys()].map((id) => this.discard(id))) }
}
