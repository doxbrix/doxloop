import type { DocumentationPlanNavigation } from './types.js'

const SPACE_WORD_STOP = new Set(['and', 'the', 'a', 'an', 'of', 'for', 'to', 'with', 'your', 'in', 'on', 'docs', 'documentation', 'guide', 'guides'])

function spaceWords(value: string): Set<string> {
  return new Set(value.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word && !SPACE_WORD_STOP.has(word)).map((word) => word.replace(/(?:ies)$/, 'y').replace(/s$/, '')))
}

/**
 * Every navigation section names the space its group lives in, so a plan
 * with several spaces is built with several spaces. A section the planner
 * gave a known space keeps it (matched case-insensitively); otherwise it goes
 * to the space whose name shares a word with the section title ("APIs" →
 * "API & integrations"). Any other section keeps no space, so navigation
 * repair places it by its pages' paths or in the primary space.
 */
export function assignSectionSpaces<T extends DocumentationPlanNavigation['sections'][number]>(top: readonly string[], sections: readonly T[]): T[] {
  if (top.length === 0) return [...sections]
  const byKey = new Map(top.map((name) => [name.trim().toLowerCase(), name]))
  const secondary = top.slice(1).map((name) => ({ name, words: spaceWords(name) }))
  return sections.map((section) => {
    const named = section.space ? byKey.get(section.space.trim().toLowerCase()) : undefined
    if (named) return { ...section, space: named }
    const titleWords = spaceWords(section.title)
    const match = secondary.find((candidate) => [...candidate.words].some((word) => titleWords.has(word)))
    if (match) return { ...section, space: match.name }
    const { space: _unknown, ...rest } = section
    return rest as T
  })
}

/**
 * Readers scan a handful of top tabs, and a plan split into six spaces left
 * "Get started" with three pages beside five thin tabs. Unless the reader
 * asks for another number, a new documentation set uses at most three.
 */
export const DEFAULT_SPACE_LIMIT = 3

const COUNT_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 }

/** The number of top-level spaces a request names ("use 5 spaces", "four top-level tabs"), if it names one. */
export function requestedSpaceCount(text: string | undefined): number | undefined {
  const match = /\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:top[- ]level\s+)?(?:spaces?|tabs?)\b/i.exec(text ?? '')
  if (!match) return undefined
  const value = COUNT_WORDS[match[1]!.toLowerCase()] ?? Number(match[1])
  return Number.isInteger(value) && value >= 1 ? value : undefined
}

/**
 * The most top-level spaces a plan may use: the number the reader asked for
 * (the newest instruction first), otherwise three for a new documentation
 * set. An update keeps whatever spaces the site already has unless the
 * request names a number, so existing navigation is never collapsed unasked.
 */
export function planSpaceLimit(plan: { mode: string; request?: string; instructions?: string }, feedback?: string): { limit?: number; requested: boolean } {
  for (const text of [feedback, plan.request, plan.instructions]) {
    const requested = requestedSpaceCount(text)
    if (requested !== undefined) return { limit: requested, requested: true }
  }
  return plan.mode === 'create' ? { limit: DEFAULT_SPACE_LIMIT, requested: false } : { requested: false }
}

/**
 * Brings a navigation outline within the space limit when the planner
 * ignored it. The first space (where readers land) and the largest others
 * stay; every other space becomes groups of the kept space before it, so
 * each section keeps its title and order and no page leaves the navigation.
 */
export function capNavigationSpaces<T extends { space?: string; pageIds?: readonly unknown[] }>(
  top: readonly string[],
  sections: readonly T[],
  limit: number,
): { top: string[]; sections: T[]; merged: Array<{ from: string; into: string }> } {
  if (limit < 1 || top.length <= limit) return { top: [...top], sections: [...sections], merged: [] }
  const key = (value: string) => value.trim().toLowerCase()
  const pages = new Map(top.map((name) => [key(name), 0]))
  for (const section of sections) {
    const space = section.space ? key(section.space) : undefined
    if (space && pages.has(space)) pages.set(space, pages.get(space)! + (section.pageIds?.length ?? 0))
  }
  const largest = top.slice(1)
    .map((name, index) => ({ index: index + 1, pages: pages.get(key(name)) ?? 0 }))
    .sort((left, right) => right.pages - left.pages || left.index - right.index)
    .slice(0, limit - 1)
  const kept = new Set([0, ...largest.map((item) => item.index)])
  const into = new Map<string, string>()
  const merged: Array<{ from: string; into: string }> = []
  let previous = top[0]!
  top.forEach((name, index) => {
    if (kept.has(index)) {
      previous = name
      return
    }
    into.set(key(name), previous)
    merged.push({ from: name, into: previous })
  })
  return {
    top: top.filter((_, index) => kept.has(index)),
    sections: sections.map((section) => {
      const target = section.space ? into.get(key(section.space)) : undefined
      return target ? { ...section, space: target } : section
    }),
    merged,
  }
}
