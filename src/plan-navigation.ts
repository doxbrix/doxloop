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
