/**
 * Hedged wording about the product itself. Writers that could not settle a
 * claim from the evidence pack wrote around it ("this probably stores the
 * token", "the setting may be available depending on your configuration"),
 * and the uptime-kuma2 pages read as guesses although the answer was one
 * source read away. Doxloop counts the phrases so a fix round can check each
 * one against the source: state it plainly, name the real condition, or cut it.
 *
 * The list is deliberately narrow. "You may", "can", and "should" are normal
 * instructions; these phrases express the writer's uncertainty, not the
 * reader's options.
 */
import type { ValidationIssue } from './types.js'

const HEDGES: Array<{ label: string; pattern: RegExp }> = [
  { label: 'probably', pattern: /\bprobably\b/gi },
  { label: 'presumably', pattern: /\bpresumably\b/gi },
  { label: 'likely', pattern: /\b(?:most |very )?likely\b/gi },
  { label: 'possibly', pattern: /\bpossibly\b/gi },
  { label: 'might', pattern: /\bmight(?: not)?\b/gi },
  { label: 'appears to', pattern: /\b(?:it |this |that )?(?:appears|seems) to\b/gi },
  { label: 'it appears', pattern: /\bit (?:appears|seems)\b(?! to\b)/gi },
  { label: 'may or may not', pattern: /\bmay or may not\b/gi },
  { label: 'may be available', pattern: /\bmay (?:be (?:available|supported|required|different|named|called|located)|not be (?:available|supported))\b/gi },
  { label: 'depending on your configuration', pattern: /\bdepending on (?:your|the) (?:configuration|setup|version|environment|installation|deployment)\b/gi },
  { label: 'should work', pattern: /\bshould (?:work|be (?:similar|the same|available|supported))\b/gi },
  { label: 'if supported', pattern: /\bif (?:supported|available|enabled) (?:by|in) your (?:version|instance|installation|deployment)\b/gi },
  { label: 'unclear', pattern: /\b(?:it is |it's )?(?:unclear|not clear) (?:whether|if|how|what)\b/gi },
  { label: 'we assume', pattern: /\b(?:we|i) (?:assume|believe|think|expect)\b/gi },
  { label: 'typically', pattern: /\btypically\b/gi },
  { label: 'in most cases', pattern: /\bin (?:most|many) cases\b/gi },
  { label: 'consult your administrator', pattern: /\b(?:check with|consult|ask) your (?:administrator|admin|team)\b/gi },
]

/** Two guesses flag any page; a longer page is allowed one per this many words. */
const WORDS_PER_HEDGE = 200

export interface HedgeFinding {
  label: string
  sentence: string
}

/** Prose only: code, front matter, component tags, and quoted UI strings are not the writer's claims. */
function prose(body: string): string {
  return body
    .replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1\s*$/gm, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/<[^>\n]+>/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
}

/** Every hedge in the page's prose, with the sentence it sits in. */
export function findHedges(body: string): HedgeFinding[] {
  const text = prose(body)
  const sentences = text.split(/(?<=[.!?])\s+|\n{2,}|\n(?=\s*(?:[-*+]|\d+\.)\s)/)
  const findings: HedgeFinding[] = []
  for (const sentence of sentences) {
    const trimmed = sentence.replace(/\s+/g, ' ').trim()
    if (!trimmed) continue
    for (const hedge of HEDGES) {
      hedge.pattern.lastIndex = 0
      const count = trimmed.match(hedge.pattern)?.length ?? 0
      for (let index = 0; index < count; index += 1) findings.push({ label: hedge.label, sentence: trimmed })
    }
  }
  return findings
}

function wordCount(body: string): number {
  return prose(body).split(/\s+/).filter((token) => /[A-Za-z0-9]/.test(token)).length
}

function clip(sentence: string, maximum = 140): string {
  return sentence.length > maximum ? `${sentence.slice(0, maximum - 1)}…` : sentence
}

/**
 * A warning when hedges are frequent enough to make the page read as a guess.
 * One "typically" in a long page is ordinary prose; the threshold scales with
 * length so a short page with two guesses is still flagged.
 */
export function validateHedging(body: string, file: string): ValidationIssue[] {
  if (body.includes('doxloop:glossary')) return []
  const findings = findHedges(body)
  if (findings.length === 0) return []
  const threshold = Math.max(2, Math.ceil(wordCount(body) / WORDS_PER_HEDGE))
  if (findings.length < threshold) return []
  const examples = [...new Map(findings.map((finding) => [finding.sentence, finding])).values()].slice(0, 3)
  return [{
    severity: 'warning',
    code: 'hedged-wording',
    file,
    message: `The page hedges ${findings.length} times (${[...new Set(findings.map((finding) => finding.label))].slice(0, 5).join(', ')}), so it reads as a guess. For each one, check the cited source: state the behavior plainly, name the exact condition or version it depends on, or remove the sentence. For example: ${examples.map((finding) => `"${clip(finding.sentence)}"`).join('; ')}.`,
  }]
}
