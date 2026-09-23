import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { UsageBudget, isAccountLimit } from './usage-budget.js'
import type { AgentUsage } from './types.js'
const roots: string[] = []
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
const usage = (tokens: number, cost = 0): AgentUsage => ({ inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: tokens, costUsd: cost, sessions: 1, turns: 1, maxContextTokens: tokens, durationMs: 1 })
test('one budget covers concurrent sessions and persists across planning, writing, and resume', async () => {
  const root = await mkdtemp(join(tmpdir(), 'doxloop-budget-')); roots.push(root)
  vi.stubEnv('DOXLOOP_MAX_TOKENS', '100')
  const budget = await UsageBudget.open(root, 'plan-test')
  const stopA = vi.fn(), stopB = vi.fn()
  const a = budget.register(stopA), b = budget.register(stopB)
  budget.update(a, usage(30)); budget.update(a, usage(40))
  budget.update(b, usage(61))
  expect(budget.totals.tokens).toBe(101)
  expect(stopA).toHaveBeenCalledOnce(); expect(stopB).toHaveBeenCalledOnce()
  expect(() => budget.register(vi.fn())).toThrow('budget exhausted')
  await budget.finish(a, usage(40)); await budget.finish(b, usage(61))
  const resumed = await UsageBudget.open(root, 'plan-test')
  expect(() => resumed.assertAvailable()).toThrow('budget exhausted')
  vi.stubEnv('DOXLOOP_MAX_TOKENS', '200')
  const raised = await UsageBudget.open(root, 'plan-test')
  expect(() => raised.assertAvailable()).not.toThrow()
  expect(raised.totals.tokens).toBe(101)
})
test('account exhaustion stops every active session, but is not persisted after allowance reset', async () => {
  const root = await mkdtemp(join(tmpdir(), 'doxloop-budget-')); roots.push(root)
  const budget = await UsageBudget.open(root, 'plan-test')
  const stop = vi.fn(); const id = budget.register(stop)
  await budget.finish(id, usage(20), "You've hit your session limit · resets 6pm")
  expect(() => budget.assertAvailable()).toThrow('account limit')
  const resumed = await UsageBudget.open(root, 'plan-test')
  expect(() => resumed.assertAvailable()).not.toThrow()
  expect(isAccountLimit('API server error 500')).toBe(false)
})
test('no limit applies unless one is set explicitly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'doxloop-budget-')); roots.push(root)
  const budget = await UsageBudget.open(root, 'plan-test')
  const id = budget.register(vi.fn())
  await budget.finish(id, usage(50_000_000, 250))
  expect(() => budget.assertAvailable()).not.toThrow()
  expect(budget.remainingUsd).toBeUndefined()
})
test('cost limit applies even below the token ceiling', async () => {
  const root = await mkdtemp(join(tmpdir(), 'doxloop-budget-')); roots.push(root)
  const budget = await UsageBudget.open(root, 'plan-test', 0.5)
  const id = budget.register(vi.fn())
  await budget.finish(id, usage(10, 0.6))
  expect(() => budget.assertAvailable()).toThrow('budget exhausted')
})

test('does not reset an unreadable ledger to a fresh allowance', async () => {
  const { mkdir, writeFile } = await import('node:fs/promises')
  const root = await mkdtemp(join(tmpdir(), 'doxloop-budget-corrupt-')); roots.push(root)
  await mkdir(join(root, '.doxloop/plans/plan-test'), { recursive: true })
  await writeFile(join(root, '.doxloop/plans/plan-test/usage-budget.json'), '{broken')
  await expect(UsageBudget.open(root, 'plan-test')).rejects.toThrow('Cannot read the saved usage budget')
})
