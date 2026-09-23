import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { AgentUsage } from './types.js'

export function isAccountLimit(reason: string | undefined): boolean {
  return /hit your (?:session|usage|weekly|daily) limit|usage limit|quota.{0,30}(?:exceeded|exhausted)|insufficient_quota|credit balance|rate.limit|budget exhausted/i.test(reason ?? '')
}
export const budgetContext = new AsyncLocalStorage<UsageBudget>()
export class UsageBudget {
  private sessions: Record<string, { tokens: number; cost: number }> = {}
  private stops = new Map<string, () => void>()
  private saving = Promise.resolve()
  private lastSave = 0
  stoppedReason: string | undefined
  constructor(readonly file: string, readonly maxTokens: number, readonly maxUsd: number) {}
  static async open(root: string, planId: string, maxUsd?: number): Promise<UsageBudget> {
    // No limit unless one is set explicitly: a run should never stop on its own because of a built-in cap.
    const positive = (raw: string | undefined, fallback: number): number => Number.isFinite(Number(raw)) && Number(raw) > 0 ? Number(raw) : fallback
    if (!/^[\w-]+$/.test(planId)) throw new Error('Invalid budget plan ID')
    const budget = new UsageBudget(join(root, '.doxloop', 'plans', planId, 'usage-budget.json'), positive(process.env.DOXLOOP_MAX_TOKENS, Number.POSITIVE_INFINITY), positive(process.env.DOXLOOP_MAX_USD, maxUsd ?? Number.POSITIVE_INFINITY))
    try {
      const saved = JSON.parse(await readFile(budget.file, 'utf8'))
      if (!saved.sessions || typeof saved.sessions !== 'object' || Array.isArray(saved.sessions) || Object.values(saved.sessions).some((value: any) => !value || !Number.isFinite(value.tokens) || value.tokens < 0 || !Number.isFinite(value.cost) || value.cost < 0)) throw new Error('Invalid saved usage ledger')
      budget.sessions = saved.sessions
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`Cannot read the saved usage budget: ${String(error)}. Preserve the ledger and repair it before resuming.`)
    }
    return budget
  }
  get totals(): { tokens: number; cost: number } {
    return Object.values(this.sessions).reduce((a, b) => ({ tokens: a.tokens + b.tokens, cost: a.cost + b.cost }), { tokens: 0, cost: 0 })
  }
  get remainingUsd(): number | undefined { return Number.isFinite(this.maxUsd) ? Math.max(0, this.maxUsd - this.totals.cost) : undefined }
  assertAvailable(): void {
    const totals = this.totals
    if (!this.stoppedReason && (totals.tokens >= this.maxTokens || totals.cost >= this.maxUsd)) this.stop(`Documentation budget exhausted (${totals.tokens} tokens, $${totals.cost.toFixed(2)}). Completed work is saved. Raise or clear DOXLOOP_MAX_TOKENS / DOXLOOP_MAX_USD or the project spend cap to continue this plan.`)
    if (this.stoppedReason) throw new Error(this.stoppedReason)
  }
  register(stop: () => void): string { this.assertAvailable(); const id = randomUUID(); this.stops.set(id, stop); return id }
  update(id: string, usage: AgentUsage | undefined, reason?: string): void {
    if (usage) this.sessions[id] = { tokens: usage.totalTokens, cost: usage.costUsd ?? 0 }
    if (isAccountLimit(reason)) this.stop(`Agent account limit reached: ${reason}. Completed work is saved; resume after the allowance resets.`)
    try { this.assertAvailable() } catch { /* Stop callbacks checkpoint active sessions. */ }
    if (Date.now() - this.lastSave > 2000) { this.lastSave = Date.now(); void this.flush().catch(() => {}) }
  }
  stop(reason: string): void {
    if (this.stoppedReason) return
    this.stoppedReason = reason
    for (const stop of this.stops.values()) stop()
  }
  async finish(id: string, usage: AgentUsage | undefined, reason?: string): Promise<void> {
    this.stops.delete(id)
    this.update(id, usage, reason)
    await this.flush()
  }
  async flush(): Promise<void> {
    const value = JSON.stringify({ schemaVersion: 1, sessions: this.sessions, totals: this.totals })
    this.saving = this.saving.catch(() => {}).then(async () => {
      await mkdir(dirname(this.file), { recursive: true })
      const temp = `${this.file}.${randomUUID()}.tmp`
      await writeFile(temp, value, { mode: 0o600 })
      await rename(temp, this.file)
    })
    return this.saving
  }
}
