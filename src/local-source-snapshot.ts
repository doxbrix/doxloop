import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep, isAbsolute } from 'node:path'
import { pathExists } from './fs.js'
import { sourceKind } from './project.js'
import { localSourceManifest } from './sync.js'
import type { SourceBinding } from './types.js'

export interface LocalSourceSnapshot {
  /** The sources with every copied path replaced by its snapshot. */
  sources: SourceBinding[]
  copied: Array<{ name: string; path: string; files: number }>
}

/**
 * Copy each local source folder into a throwaway snapshot beside the managed
 * remote snapshots, so an agent that cannot be denied write access to extra
 * directories (Gemini) never touches the user's real checkout. Sources that
 * are already managed snapshots, remote, inside the project, or missing are
 * left as they are. A snapshot is keyed by content, so an unchanged source is
 * reused rather than copied again.
 */
export async function snapshotLocalSources(
  root: string,
  sources: SourceBinding[],
): Promise<LocalSourceSnapshot> {
  const projectRoot = resolve(root)
  const projectId = createHash('sha256').update(projectRoot).digest('hex').slice(0, 12)
  const copied: LocalSourceSnapshot['copied'] = []
  const rewritten: SourceBinding[] = []
  for (const source of sources) {
    const sourcePath = resolve(projectRoot, source.path)
    if (
      sourceKind(source) !== 'directory' ||
      source.remote ||
      sourcePath.split(sep).includes('.doxloop-sources') ||
      !isOutside(projectRoot, sourcePath) ||
      !(await pathExists(sourcePath))
    ) {
      rewritten.push(source)
      continue
    }
    const manifest = await localSourceManifest(sourcePath)
    const destination = join(
      dirname(projectRoot),
      '.doxloop-sources',
      projectId,
      safeName(source.name),
      `local-${manifest.fingerprint.slice(0, 12)}`,
    )
    if (!(await pathExists(destination))) {
      const parent = dirname(destination)
      await mkdir(parent, { recursive: true })
      const temporary = await mkdtemp(join(parent, '.copy-'))
      try {
        for (const file of Object.keys(manifest.files)) {
          const target = join(temporary, file)
          await mkdir(dirname(target), { recursive: true })
          await cp(join(sourcePath, file), target, { dereference: false, errorOnExist: false, force: true })
        }
        await rename(temporary, destination)
      } catch (error) {
        await rm(temporary, { recursive: true, force: true })
        throw error
      }
    }
    copied.push({ name: source.name, path: destination, files: Object.keys(manifest.files).length })
    rewritten.push({ ...source, path: destination })
  }
  return { sources: rewritten, copied }
}

function isOutside(projectRoot: string, path: string): boolean {
  const rel = relative(projectRoot, path)
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)
}

function safeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'source'
}
