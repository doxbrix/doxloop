import { compactLogText } from './agent-log.js'
import { DoxloopError } from './errors.js'
import type { AgentName } from './types.js'

/**
 * Reading one JSON object out of an agent's reply. Agents wrap the object in
 * an agreed tag (`<doxloop-plan>`, `<doxloop-brief>`), but they also echo the
 * instructions they were sent, quote the reference files they read, and drop
 * the closing brackets of very long objects. Everything here exists to read
 * the answer anyway without ever inventing content: a reply that is complete
 * apart from its closers is closed and the fix reported; a reply cut off
 * inside a value is refused with the exact defect.
 */

/**
 * Fields that only a documentation plan carries. An agent transcript also
 * contains the skill references it read, whose fenced examples (a
 * `.doxloop/project.json`, an evidence map) parse as perfectly valid JSON.
 */
const PLAN_SIGNAL_KEYS = [
  'productProfile',
  'summary',
  'audiences',
  'outcomes',
  'capabilities',
  'navigation',
  'questions',
  'instructions',
  'experienceLevel',
  'estimatedPages',
  'estimatedEffort',
  'preferredExamples',
  'styleGuide',
]

export function looksLikeDocumentationPlan(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  const signals = PLAN_SIGNAL_KEYS.filter((key) => key in candidate).length
  // A plan lists planned pages as an array of page objects. An evidence map
  // keys `pages` by path, a project manifest has no planned pages at all, and
  // the plan's own nested objects (an existing-documentation finding or
  // assessment) carry a `pages` array too but almost none of the plan's other
  // top-level fields, so a pages array alone is not enough.
  if (Array.isArray(candidate.pages) && candidate.pages.every((page) => page && typeof page === 'object') && signals >= 2) return true
  return signals >= 3
}

/**
 * Read one balanced `{...}` starting at `start`, ignoring braces inside JSON
 * strings. Each call starts fresh, so unbalanced braces or stray quotes in
 * surrounding prose cannot desynchronize a later candidate.
 */
function objectTextAt(text: string, start: number): string | undefined {
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < text.length; index += 1) {
    const character = text[index]!
    if (inString) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') inString = true
    else if (character === '{') depth += 1
    else if (character === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, index + 1)
    }
  }
  return undefined
}

/**
 * Close an object whose final brackets are missing or wrong. Agents drop
 * the outermost closers of a very long reply often enough (a 60k-character
 * plan came back `]}` short twice in a row) that giving up would cost the
 * whole planning run, and they also swap them: a product brief twice ended
 * its top-level `unknowns` string array with `"}]}` where `"]}` was due.
 * Appending the missing closers, or replacing a trailing run of wrong ones
 * with the closers the open structures actually need, loses nothing when
 * the reply ends on a completed value, optionally followed by a stray tag
 * such as `</existingDocumentation>`. A reply that ends inside a string,
 * after a comma, or partway through a value is cut off and is left alone,
 * and so is a mismatched closer with more content after it: a plan silently
 * shortened is worse than a plan reported missing.
 */
function closeObjectAt(text: string, start: number): { text: string; closers: string; replaced?: string } | undefined {
  const closers: string[] = []
  let inString = false
  let escaped = false
  let lastStructureEnd = -1
  for (let index = start; index < text.length; index += 1) {
    const character = text[index]!
    if (inString) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') inString = true
    else if (character === '{') closers.push('}')
    else if (character === '[') closers.push(']')
    else if (character === '}' || character === ']') {
      if (closers.at(-1) !== character) {
        // The wrong closer. Only a tail made of nothing but closers (and a
        // stray tag) after a completed value can be rewritten safely.
        const tail = text.slice(index)
        const written = tail.replace(/[^\]}]/g, '')
        if (!/^[\s\]}]*(?:\s|<\/?[\w-]+>)*$/.test(tail) || !/(?:"|[\]}]|\d|true|false|null)\s*$/.test(text.slice(start, index))) return undefined
        const suffix = closers.reverse().join('')
        return { text: `${text.slice(start, index).trimEnd()}${suffix}`, closers: suffix, replaced: written }
      }
      closers.pop()
      if (closers.length === 0) return undefined
      lastStructureEnd = index
    }
  }
  if (inString || lastStructureEnd < 0 || closers.length === 0) return undefined
  if (!/^(?:\s|<\/?[\w-]+>)*$/.test(text.slice(lastStructureEnd + 1))) return undefined
  const suffix = closers.reverse().join('')
  return { text: `${text.slice(start, lastStructureEnd + 1)}${suffix}`, closers: suffix }
}

/** Compare transcript text to prompt text without depending on re-wrapping. */
function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Offsets where a JSON object plausibly begins, in document order. */
function objectStarts(text: string, tag: string): number[] {
  const starts = new Set<number>()
  const pattern = new RegExp(`(?:^|\\n|\`\`\`(?:json)?|<${tag}>)[ \\t\\r]*\\{`, 'gi')
  for (const match of text.matchAll(pattern)) {
    starts.add(match.index + match[0].lastIndexOf('{'))
  }
  return [...starts].sort((left, right) => left - right)
}

function closedReplyNote(closers: string, noun: string, replaced?: string): string {
  if (replaced !== undefined) {
    return `The ${noun} reply ended with the wrong closing brackets ("${replaced}" where "${closers}" closes the JSON object); Doxloop replaced them and read it. Check that its last entries are complete before relying on them.`
  }
  const count = closers.length
  return `The ${noun} reply stopped ${count} closing bracket${count === 1 ? '' : 's'} short of a complete JSON object; Doxloop appended "${closers}" and read it. Check that its last entries are complete before relying on them.`
}

function unclosedDefect(text: string): string {
  return `the JSON object is never closed and looks cut off; the reply ends with «${compactLogText(text.trimEnd().slice(-120), 120)}»`
}

export interface TaggedJsonContract {
  /** Tag name without angle brackets, for example `doxloop-plan`. */
  tag: string
  /** Whether a parsed candidate is the answer rather than a quoted example. */
  accept: (value: unknown) => boolean
  /** Whether a candidate's text was clearly trying to be the answer, for defect reporting. */
  attempted: (text: string) => boolean
  /** How the answer is named in messages: "documentation-plan", "research brief". */
  noun: string
}

/**
 * The last accepted object in `text`; the answer follows what was quoted.
 * Also reports why the most answer-like candidate failed, so a malformed reply
 * is distinguishable from one that never contained an answer at all.
 */
function lastAcceptedIn(text: string, contract: TaggedJsonContract, sent?: string): { value?: unknown; repair?: string; defect?: string } {
  const starts = objectStarts(text, contract.tag)
  let defect: string | undefined
  for (let index = starts.length - 1; index >= 0; index -= 1) {
    const start = starts[index]!
    let objectText = objectTextAt(text, start)
    let repair: string | undefined
    if (!objectText) {
      const closed = closeObjectAt(text, start)
      if (!closed) {
        if (!defect && contract.attempted(text.slice(start))) defect = unclosedDefect(text.slice(start))
        continue
      }
      objectText = closed.text
      repair = closedReplyNote(closed.closers, contract.noun, closed.replaced)
    }
    // Agents echo their instructions. The shape template we sent is a valid,
    // answer-shaped object full of placeholders, so it must never be read as
    // an answer.
    if (sent && sent.includes(collapse(objectText))) continue
    try {
      const parsed = JSON.parse(objectText) as unknown
      if (contract.accept(parsed)) return { value: parsed, ...(repair ? { repair } : {}) }
    } catch (error) {
      // A brace-balanced candidate can still be malformed when a closer is
      // the wrong kind (`"}]}` ending a string array); a swapped tail is
      // rewritten deterministically before the defect is reported.
      const rewritten = closeObjectAt(text, start)
      if (rewritten?.replaced !== undefined) {
        try {
          const parsed = JSON.parse(rewritten.text) as unknown
          if (contract.accept(parsed)) return { value: parsed, repair: closedReplyNote(rewritten.closers, contract.noun, rewritten.replaced) }
        } catch {
          // Fall through to report the original defect.
        }
      }
      // Prose and templates fail here too; only report a candidate that was
      // clearly trying to be the answer.
      if (!defect && contract.attempted(objectText)) {
        defect = error instanceof Error ? error.message : String(error)
      }
    }
  }
  return defect ? { defect } : {}
}

/**
 * The agent's own final reply, read out of its machine-readable stream:
 * Claude's `result` event, Codex's completed `agent_message` items, and
 * Gemini's assistant `message` events. Undefined when the output is not a
 * stream, in which case the whole transcript is searched instead.
 */
export function agentReplyFromStream(raw: string, agent: AgentName): string | undefined {
  const events = raw.split(/\r?\n/).flatMap((line): Record<string, unknown>[] => {
    try {
      const value = JSON.parse(line) as unknown
      return value && typeof value === 'object' && !Array.isArray(value) ? [value as Record<string, unknown>] : []
    } catch {
      return []
    }
  })
  if (agent === 'claude') {
    const results = events.flatMap((event) => event.type === 'result' && typeof event.result === 'string' ? [event.result] : [])
    return results.at(-1)
  }
  if (agent === 'codex') {
    const messages = events.flatMap((event) => {
      const item = event.type === 'item.completed' && event.item && typeof event.item === 'object' ? event.item as Record<string, unknown> : undefined
      return item?.type === 'agent_message' && typeof item.text === 'string' ? [item.text] : []
    })
    return messages.length > 0 ? messages.join('\n') : undefined
  }
  const parts = events.flatMap((event) => event.type === 'message' && event.role === 'assistant' && typeof event.content === 'string' ? [event.content] : [])
  return parts.length > 0 ? parts.join('') : undefined
}

export interface TaggedJsonReply<T = unknown> {
  value: T
  /** Deterministic fixes applied to read the reply, worded for a reviewer. */
  repairs: string[]
}

/**
 * Read the object an agent was asked to return inside `<tag>…</tag>`. The
 * agreed block wins outright when the agent honors it; otherwise the whole
 * reply is searched, skipping anything that merely echoes the prompt.
 * Returns undefined when nothing answer-shaped is found and no candidate was
 * clearly trying to be the answer, so callers can fall back to another
 * contract; throws when a candidate was found but is malformed.
 */
export function readTaggedJson<T = unknown>(raw: string, agent: AgentName, contract: TaggedJsonContract, prompt?: string): TaggedJsonReply<T> | undefined {
  const sent = prompt ? collapse(prompt) : undefined
  let candidate = raw.trim()
  const reply = agentReplyFromStream(candidate, agent)
  if (reply) candidate = reply
  const pattern = new RegExp(`<${contract.tag}>\\s*([\\s\\S]*?)\\s*</${contract.tag}>`, 'gi')
  const blocks = [...candidate.matchAll(pattern)].flatMap((match) => (match[1] ? [match[1]] : []))
  let defect: string | undefined
  for (const text of [...blocks.reverse(), candidate]) {
    const result = lastAcceptedIn(text, contract, sent)
    if (result.value !== undefined) return { value: result.value as T, repairs: result.repair ? [result.repair] : [] }
    defect ??= result.defect
  }
  if (defect) {
    throw new DoxloopError(`The agent returned a malformed ${contract.noun} JSON object (${defect}). Open the full log, then retry.`)
  }
  return undefined
}

const PLAN_CONTRACT: TaggedJsonContract = {
  tag: 'doxloop-plan',
  accept: looksLikeDocumentationPlan,
  attempted: (text) => /"(?:pages|productProfile|capabilities)"\s*:/.test(text),
  noun: 'documentation-plan',
}

export interface PlanReply {
  plan: unknown
  /** Deterministic fixes applied to read the reply, worded for the plan review. */
  repairs: string[]
}

export function readPlanOutput(raw: string, agent: AgentName, prompt?: string): PlanReply {
  let reply: TaggedJsonReply | undefined
  try {
    reply = readTaggedJson(raw, agent, PLAN_CONTRACT, prompt)
  } catch (error) {
    const defect = error instanceof Error ? error.message.replace(/^The agent returned a malformed documentation-plan JSON object \((.*)\)\. Open the full log, then retry\.$/s, '$1') : String(error)
    throw new DoxloopError(`The planning agent returned a malformed documentation-plan JSON object (${defect}). Open the full log, then retry the plan.`)
  }
  if (!reply) {
    throw new DoxloopError('The planning agent did not return a valid documentation-plan JSON object. Open the full log, then retry the plan.')
  }
  return { plan: reply.value, repairs: reply.repairs.map((note) => note.replace(/^The documentation-plan reply/, "The planner's reply")) }
}

export function extractPlanOutput(raw: string, agent: AgentName, prompt?: string): unknown {
  return readPlanOutput(raw, agent, prompt).plan
}

const PLAN_PATCH_KEYS = ['pages', 'removePageIds', 'capabilities', 'navigation', 'existingDocumentation', 'questions']
const PLAN_PATCH_CONTRACT: TaggedJsonContract = {
  tag: 'doxloop-plan-patch',
  accept: (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && PLAN_PATCH_KEYS.some((key) => key in (value as Record<string, unknown>)),
  attempted: (text) => /"(?:pages|removePageIds)"\s*:/.test(text),
  noun: 'documentation-plan patch',
}

/**
 * A corrective pass answers with the pages it changed inside
 * `<doxloop-plan-patch>`. Undefined when the reply carries no patch at all
 * (an agent that resent the whole plan is read with `readPlanOutput`).
 */
export function readPlanPatchOutput(raw: string, agent: AgentName, prompt?: string): TaggedJsonReply | undefined {
  const reply = readTaggedJson(raw, agent, PLAN_PATCH_CONTRACT, prompt)
  return reply ? { ...reply, repairs: reply.repairs.map((note) => note.replace(/^The documentation-plan patch reply/, "The planner's corrective reply")) } : undefined
}
