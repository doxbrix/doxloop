import type { DocumentationPlanTarget } from './types.js'

/**
 * The one file extension new pages are written with. Doxbrix reads `.md` and
 * `.mdx` alike, so its plan target lists both, but a site whose pages switch
 * between the two by batch reads as unfinished and its components only
 * belong in `.mdx`. Other generators write their first listed extension.
 */
export function preferredPageExtension(target: Partial<Pick<DocumentationPlanTarget, 'generator' | 'pageExtensions'>> | undefined): string {
  const listed = (target?.pageExtensions ?? []).map((extension) => (extension.startsWith('.') ? extension : `.${extension}`).toLowerCase())
  if (target?.generator === 'doxbrix' || target?.generator === undefined) {
    if (listed.length === 0 || listed.includes('.mdx')) return '.mdx'
  }
  return listed[0] ?? '.mdx'
}
