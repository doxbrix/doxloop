/**
 * The editorial standard, measured. The authoring skill asks for Google
 * developer-style prose — open with the reader's outcome, sentence-case
 * headings, no "simply" or "just", present tense, and a next step at the end
 * of every task — but a rule that is only an instruction is followed most of
 * the time. These checks find the misses deterministically so the fix pass
 * can correct them, and so the quality score can report them.
 *
 * Every check is narrow on purpose: a false warning costs a fix session and
 * teaches reviewers to ignore the list.
 */
import type { ValidationIssue } from './types.js'

/** Prose with code, inline code, tags, images, and link targets removed. */
function prose(body: string): string {
  return body
    .replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1\s*$/gm, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/<[^>\n]+>/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\]\([^)]*\)/g, ']')
}

function sentencesOf(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n{2,}/).map((sentence) => sentence.replace(/\s+/g, ' ').trim()).filter(Boolean)
}

function clip(value: string, maximum = 110): string {
  return value.length > maximum ? `${value.slice(0, maximum - 1)}…` : value
}

function warning(code: string, file: string, message: string): ValidationIssue {
  return { severity: 'warning', code, file, message }
}

/** The first paragraph of prose, skipping headings, imports, and components. */
function openingParagraph(body: string): string | undefined {
  for (const block of body.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1\s*$/gm, '\n').split(/\n\s*\n/)) {
    const text = block.trim()
    if (!text || /^(?:#|import\s|export\s|<|\||[-*+]\s|\d+\.\s|!\[)/.test(text)) continue
    return text.replace(/\s+/g, ' ')
  }
  return undefined
}

// "In this tutorial, you…" is the conventional tutorial opening and is allowed.
const GENERIC_OPENING = /^(?:(?:this|the following) (?:page|guide|document|documentation|article|section|topic) (?:describes|explains|covers|shows|walks you through|provides|contains|is about|will)|in this (?:page|guide|document|article|section|topic),? (?:you will|you'll|we will|we'll|we)|welcome to\b|here (?:you will|you'll) (?:learn|find))/i

export function genericOpeningIssue(body: string, file: string): ValidationIssue | undefined {
  const opening = openingParagraph(body)
  if (!opening || !GENERIC_OPENING.test(opening)) return undefined
  return warning('generic-opening', file, `The page opens with "${clip(opening, 90)}". Open with what the reader will accomplish or decide instead — for example "Invite teammates to a workspace and choose what each one can change." — and cut the announcement.`)
}

const MINIMIZERS: Array<{ label: string; pattern: RegExp }> = [
  { label: 'simply', pattern: /\bsimply\b/gi },
  { label: 'just', pattern: /\bjust (?:click|run|type|select|open|add|use|set|enter|press|copy|paste|call|install|create|change|drag|pick|choose|go|navigate|replace|edit|delete|remove)\b/gi },
  { label: 'easy', pattern: /\b(?:it'?s|it is) (?:very |really |quite )?easy\b|\beasily\b/gi },
  { label: 'obviously', pattern: /\b(?:obviously|of course|clearly,)\b/gi },
  { label: 'straightforward', pattern: /\b(?:is|are) (?:very |quite )?straightforward\b/gi },
]

export function minimizingLanguageIssue(body: string, file: string): ValidationIssue | undefined {
  const found: string[] = []
  for (const sentence of sentencesOf(prose(body))) {
    for (const minimizer of MINIMIZERS) {
      minimizer.pattern.lastIndex = 0
      if (minimizer.pattern.test(sentence)) found.push(`"${clip(sentence)}"`)
    }
  }
  if (found.length === 0) return undefined
  const unique = [...new Set(found)]
  return warning('minimizing-language', file, `${unique.length} sentence${unique.length === 1 ? '' : 's'} call${unique.length === 1 ? 's' : ''} a step simple, easy, or obvious, which reads as dismissive when the reader is stuck: ${unique.slice(0, 3).join('; ')}. Remove the word and state the action.`)
}

/** Words that stay lowercase inside a sentence-case heading written in title case. */
const MINOR_WORDS = new Set(['a', 'an', 'the', 'and', 'or', 'but', 'for', 'nor', 'of', 'to', 'in', 'on', 'at', 'by', 'with', 'from', 'as', 'into', 'via', 'vs', 'per'])

/**
 * A heading in Title Case: at least four words and every non-minor word after
 * the first capitalized. Product names and UI labels keep their capitals, so
 * the known names (terminology, words the page writes capitalized
 * mid-sentence) are excused, and all-caps acronyms never count.
 */
export function titleCaseHeadings(body: string, knownNames: Set<string> = new Set()): string[] {
  const text = body.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1\s*$/gm, '\n')
  const midSentence = new Set<string>()
  for (const match of prose(text.replace(/^#{1,6}\s.*$/gm, '')).matchAll(/(?<=[a-z,;]\s)([A-Z][a-z]+)/g)) midSentence.add(match[1]!)
  const flagged: string[] = []
  for (const match of text.matchAll(/^#{2,4}\s+(.+?)\s*#*\s*$/gm)) {
    const heading = match[1]!.replace(/`[^`]*`/g, 'code').replace(/[*_[\]]/g, '')
    const words = heading.split(/\s+/).filter((word) => /^[A-Za-z][A-Za-z'’-]*$/.test(word))
    if (words.length < 4) continue
    const rest = words.slice(1).filter((word) => !MINOR_WORDS.has(word.toLowerCase()) && !/^[A-Z0-9]{2,}$/.test(word))
    if (rest.length < 3) continue
    const capitalized = rest.filter((word) => /^[A-Z][a-z]/.test(word) && !knownNames.has(word) && !midSentence.has(word))
    if (capitalized.length === rest.length) flagged.push(match[1]!.trim())
  }
  return flagged
}

export function headingCaseIssue(body: string, file: string, knownNames?: Set<string>): ValidationIssue | undefined {
  const flagged = titleCaseHeadings(body, knownNames)
  if (flagged.length === 0) return undefined
  return warning('heading-case', file, `${flagged.length} heading${flagged.length === 1 ? ' is' : 's are'} in Title Case: ${flagged.slice(0, 4).map((heading) => `"${clip(heading, 60)}"`).join(', ')}. Use sentence case (capitalize the first word and proper names only), keeping product and UI names exactly as the product shows them.`)
}

const FUTURE_RESULT = /\b(?:will|'ll) (?:be (?:displayed|shown|redirected|created|added|saved|updated|opened|listed|sent|prompted|asked|taken)|(?:appear|open|display|show|see|redirect|return|change|update|reload|refresh|close))\b/gi

/**
 * Results described in the future tense ("the dialog will appear"). Google
 * and Microsoft style both describe what happens in the present ("the
 * dialog appears"). Flagged only when it is the page's habit.
 */
export function futureTenseIssue(body: string, file: string): ValidationIssue | undefined {
  const hits = sentencesOf(prose(body)).filter((sentence) => { FUTURE_RESULT.lastIndex = 0; return FUTURE_RESULT.test(sentence) })
  if (hits.length < 3) return undefined
  return warning('future-tense', file, `${hits.length} sentences describe results in the future tense, such as "${clip(hits[0]!)}". Describe what happens in the present: "The dialog appears", "Doxloop saves the file".`)
}

const PROCEDURAL = /<Steps?\b|^\s*\d+\.\s+\S/m

/**
 * A procedure that stops without a way forward. The editorial standard ends
 * every task with the next useful action; a page whose last section has no
 * link or card leaves the reader at a dead end.
 */
export function missingNextStepIssue(body: string, file: string, planType?: string): ValidationIssue | undefined {
  const procedural = planType ? ['how-to', 'tutorial', 'getting-started'].includes(planType) : PROCEDURAL.test(body)
  if (!procedural || body.includes('doxloop:glossary')) return undefined
  const sections = body.split(/^##\s+/m)
  const tail = sections.length > 1 ? sections.at(-1)! : body.slice(Math.floor(body.length * 0.75))
  if (/\]\((?!https?:\/\/)[^)]+\)|<Card\b|href=["'][^"']+["']|\[\[/.test(tail)) return undefined
  return warning('missing-next-step', file, 'The procedure ends without a next step. Finish with a short "Next steps" section that links to the task a reader usually does next, the concept behind it, or the reference it uses.')
}

/** Every editorial check for one page. */
export function editorialIssues(body: string, file: string, options: { planType?: string; knownNames?: Set<string> } = {}): ValidationIssue[] {
  if (body.includes('doxloop:glossary')) return []
  return [
    genericOpeningIssue(body, file),
    minimizingLanguageIssue(body, file),
    headingCaseIssue(body, file, options.knownNames),
    futureTenseIssue(body, file),
    missingNextStepIssue(body, file, options.planType),
  ].filter((issue): issue is ValidationIssue => issue !== undefined)
}
