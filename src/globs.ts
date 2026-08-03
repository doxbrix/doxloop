const SEGMENT = '[^/]'

/**
 * Match a project-relative POSIX path against a glob pattern.
 *
 * Supported syntax is deliberately small: `*` inside one segment, `**` across
 * segments, and `?` for one character. A pattern without a slash matches the
 * file name at any depth, which is what people expect from `.gitignore` and
 * keeps `pnpm-lock.yaml` or `*.test.ts` working without a leading `**\/`.
 */
export function matchesGlob(path: string, pattern: string): boolean {
  const normalizedPath = normalize(path)
  const normalizedPattern = normalize(pattern)
  if (normalizedPattern === '') return false
  const effective = normalizedPattern.includes('/')
    ? normalizedPattern
    : `**/${normalizedPattern}`
  return globRegExp(effective).test(normalizedPath)
}

export function matchesAnyGlob(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => matchesGlob(path, pattern))
}

/**
 * Decide whether a changed source path is worth documenting attention.
 * `ignore` always wins so a broad `watch` entry stays easy to narrow.
 */
export function isWatchedPath(
  path: string,
  watch: readonly string[],
  ignore: readonly string[],
): boolean {
  if (matchesAnyGlob(path, ignore)) return false
  if (watch.length === 0) return true
  return matchesAnyGlob(path, watch)
}

function normalize(value: string): string {
  return value.trim().split('\\').join('/').replace(/^\.\//, '').replace(/\/+$/, '')
}

function globRegExp(pattern: string): RegExp {
  let source = '^'
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index] as string
    if (character === '*') {
      const doubled = pattern[index + 1] === '*'
      if (doubled) {
        // `a/**/b` must also match `a/b`, so the separator is part of the group.
        if (pattern[index + 2] === '/') {
          source += `(?:${SEGMENT}+/)*`
          index += 2
          continue
        }
        source += '.*'
        index += 1
        continue
      }
      source += `${SEGMENT}*`
      continue
    }
    if (character === '?') {
      source += SEGMENT
      continue
    }
    source += character.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`${source}$`)
}
