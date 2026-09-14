import { existsSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'

/** Resolve an untrusted relative path while guaranteeing it stays under root. */
export function resolveWithin(root: string, untrustedPath: string): string {
  if (!untrustedPath || isAbsolute(untrustedPath) || untrustedPath.includes('\0')) {
    throw new Error(`Unsafe path outside the docs directory: ${untrustedPath}`)
  }
  const absoluteRoot = resolve(root)
  const candidate = resolve(absoluteRoot, untrustedPath)
  if (!isWithin(absoluteRoot, candidate)) {
    throw new Error(`Unsafe path outside the docs directory: ${untrustedPath}`)
  }
  return candidate
}

/**
 * Verify that the nearest existing parent is not a symlink escape before a
 * caller creates directories or writes a file below it.
 */
export function assertSafeWriteParent(root: string, destination: string): void {
  const absoluteRoot = resolve(root)
  let parent = dirname(destination)
  while (!existsSync(parent)) {
    const next = dirname(parent)
    if (next === parent) break
    parent = next
  }
  const realRoot = realpathSync(absoluteRoot)
  const realParent = realpathSync(parent)
  if (!isWithin(realRoot, realParent)) {
    throw new Error(`Unsafe path through a symlink outside the docs directory: ${destination}`)
  }
}

/** Resolve an existing file and reject symlink escapes from root. */
export function resolveExistingWithin(root: string, untrustedPath: string): string {
  const candidate = resolveWithin(root, untrustedPath)
  const realRoot = realpathSync(resolve(root))
  const realCandidate = realpathSync(candidate)
  if (!isWithin(realRoot, realCandidate)) {
    throw new Error(`Unsafe path through a symlink outside the docs directory: ${untrustedPath}`)
  }
  return realCandidate
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}
