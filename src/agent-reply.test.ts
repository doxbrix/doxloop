import { describe, expect, test } from 'vitest'
import { mendObjectAt, readTaggedJson, removeInvalidEscapes, type TaggedJsonContract } from './agent-reply.js'

const BRIEF: TaggedJsonContract = {
  tag: 'doxloop-brief',
  accept: (value) => Boolean(value && typeof value === 'object' && Array.isArray((value as { capabilities?: unknown }).capabilities)),
  attempted: (text) => /"capabilities"\s*:/.test(text),
  noun: 'research brief',
}

describe('mending agent JSON', () => {
  test('drops escapes JSON does not define and keeps valid ones', () => {
    expect(removeInvalidEscapes(String.raw`{"a":"it\'s","b":"line\nnext \"q\" \\ \/ A"}`)).toEqual({
      text: String.raw`{"a":"it's","b":"line\nnext \"q\" \\ \/ A"}`,
      removed: 1,
    })
    // Outside strings nothing is touched.
    expect(removeInvalidEscapes('{"a":1}').removed).toBe(0)
  })

  test('moves a brace that closed every array element early', () => {
    // The shape Claude returned for a Memos research brief: each capability
    // closed after its evidence, leaving "notes" outside the object.
    const broken = '{"capabilities":[{"id":"a","evidence":[{"line":1}]},"notes":"first"},{"id":"b","evidence":[{"line":2}]},"notes":"second"}],"unknowns":[]}'
    const mended = mendObjectAt(broken, 0)
    expect(mended).toMatchObject({ stray: 2, escapes: 0 })
    expect(mended!.value).toEqual({ capabilities: [{ id: 'a', evidence: [{ line: 1 }], notes: 'first' }, { id: 'b', evidence: [{ line: 2 }], notes: 'second' }], unknowns: [] })
  })

  test('a valid object needs no mending, and an unrelated defect is not guessed at', () => {
    expect(mendObjectAt('{"capabilities":[]}', 0)).toBeUndefined()
    expect(mendObjectAt('{"capabilities":[1 2]}', 0)).toBeUndefined()
  })

  test('a tagged reply is read with the repair named', () => {
    const raw = 'Here is the brief.\n<doxloop-brief>\n{"capabilities":[{"id":"a","evidence":[]},"notes":"n"}]}\n</doxloop-brief>'
    const reply = readTaggedJson(raw, 'claude', BRIEF)
    expect(reply?.value).toEqual({ capabilities: [{ id: 'a', evidence: [], notes: 'n' }] })
    expect(reply?.repairs).toEqual(["Doxloop removed 1 misplaced closing brace in the agent's research brief JSON before reading it."])
  })

  test('a reply that cannot be mended is still reported', () => {
    expect(() => readTaggedJson('<doxloop-brief>{"capabilities":[{"id":"a" "b"}]}</doxloop-brief>', 'claude', BRIEF)).toThrow(/malformed research brief/)
  })
})
