import { useEffect, useRef, useState } from 'preact/hooks'

/**
 * Decide what a form should hold after the values it was seeded from change
 * underneath it: a save just landed, another screen changed the project, or
 * the state was reloaded after a job. Unsaved edits are never replaced
 * silently; they are kept and the form is marked stale until the reader
 * decides.
 */
export function reconcileSeed<T>(form: T, seeded: T, next: T): { form: T; seeded: T; stale: boolean } {
  const clean = same(form, seeded) || same(form, next)
  return clean ? { form: next, seeded: next, stale: false } : { form, seeded: next, stale: true }
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/**
 * Form state seeded from props that resyncs whenever `key` changes. When the
 * reader has unsaved edits the new values wait behind `stale`, and `resync`
 * discards the edits in favour of what the project now holds.
 */
export function useSeededForm<T>(seed: () => T, key: string): [T, (next: T | ((current: T) => T)) => void, { stale: boolean; resync: () => void }] {
  const [form, setForm] = useState<T>(seed)
  const seeded = useRef<T>(form)
  const [stale, setStale] = useState(false)
  const lastKey = useRef(key)
  useEffect(() => {
    if (lastKey.current === key) return
    lastKey.current = key
    const outcome = reconcileSeed(form, seeded.current, seed())
    seeded.current = outcome.seeded
    setStale(outcome.stale)
    if (!outcome.stale) setForm(outcome.form)
  }, [key])
  const resync = () => {
    setForm(seeded.current)
    setStale(false)
  }
  return [form, setForm, { stale, resync }]
}
