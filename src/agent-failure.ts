/**
 * Why an agent session ended, in words a reader can act on. A bare "exited
 * with status 1" hid a signed-out Claude Code for a whole planning run: the
 * agent's own error text names the cause, and a sign-in or account problem
 * needs a different next step than a retry.
 */
import { DoxloopError } from './errors.js'
import type { AgentName } from './types.js'

export type AgentFailureKind = 'sign-in' | 'account' | 'other'

const DISPLAY_NAMES: Record<AgentName, string> = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini' }

const SIGN_IN_COMMANDS: Record<AgentName, string> = {
  claude: 'Run `claude auth login`',
  codex: 'Run `codex login`',
  gemini: 'Run `gemini` once in a terminal and sign in (or set GEMINI_API_KEY)',
}

export function agentDisplayName(agent: AgentName): string {
  return DISPLAY_NAMES[agent]
}

/** Sign-in trouble: expired OAuth, a missing login, a rejected key. */
export function isAgentSignInFailure(text: string | undefined): boolean {
  return /failed to authenticate|authenticat(?:e|ion) (?:failed|error|required)|oauth|not (?:logged|signed) in|log ?in required|please (?:log|sign) ?in|\/login\b|auth login|\b401\b|unauthori[sz]ed|invalid (?:api[ _-]?key|x-api-key|token|credentials)|api key (?:is )?(?:missing|invalid|not (?:set|found))|token (?:has )?expired|refresh token/i.test(text ?? '')
}

/** Account trouble: out of credits, quota, or rate/usage limits. */
export function isAgentAccountFailure(text: string | undefined): boolean {
  return /credit balance|insufficient[_ ](?:quota|credits?|funds)|out of credits|quota|usage limit|hit your (?:session|usage|weekly|daily) limit|rate[ _-]?limit|too many requests|\b429\b|billing/i.test(text ?? '')
}

export function agentFailureKind(text: string | undefined): AgentFailureKind {
  if (isAgentSignInFailure(text)) return 'sign-in'
  if (isAgentAccountFailure(text)) return 'account'
  return 'other'
}

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g

/**
 * The most useful error text a session left: the formatter's stop reason
 * (the agent's own result event) or else the last error-looking line on
 * stderr. Prefixes such as "stopped with an error:" are removed.
 */
export function agentFailureDetail(stopReason: string | undefined, stderr = ''): string | undefined {
  const fromStop = stopReason?.replace(/^stopped with an error:\s*/i, '').replace(/^stopped because its API request failed:\s*/i, '').trim()
  if (fromStop) return fromStop
  const lines = stderr.replace(ANSI, '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    .filter((line) => !/^Reading additional input from stdin/i.test(line))
  const errorLine = [...lines].reverse().find((line) => /error|fail|denied|unauthori|expired|not (?:logged|signed) in|quota|limit/i.test(line))
  const picked = errorLine ?? lines.at(-1)
  return picked ? compact(picked.replace(/^\S*\d{4}-\d{2}-\d{2}T\S+\s+(?:ERROR|WARN|INFO)\s+/, '')) : undefined
}

/** The cause without the agent's own "Failed to authenticate:" wrapper. */
function signInCause(detail: string): string {
  return detail.replace(/^(?:API Error:\s*)?(?:Failed to authenticate|Authentication (?:failed|error))[:.]?\s*/i, '').replace(/\.$/, '') || detail
}

/** One sentence that names the cause and the next step. */
export function describeAgentFailure(agent: AgentName, detail: string): { kind: AgentFailureKind; message: string } {
  const name = agentDisplayName(agent)
  const kind = agentFailureKind(detail)
  if (kind === 'sign-in') {
    return {
      kind,
      message: `${name} could not sign in (${compact(signInCause(detail))}). ${SIGN_IN_COMMANDS[agent]} or switch assistant, then retry.`,
    }
  }
  if (kind === 'account') {
    return {
      kind,
      message: `${name} stopped on an account limit (${compact(detail.replace(/\.$/, ''))}). Wait for the limit to reset or add credits, or switch assistant, then retry.`,
    }
  }
  return { kind, message: compact(detail) }
}

/** A session failure that carries its cause, so callers can tell sign-in trouble from task failures. */
export class AgentSessionError extends DoxloopError {
  readonly kind: AgentFailureKind
  readonly detail: string
  readonly agent: AgentName

  constructor(agent: AgentName, label: string, exitCode: number, detail: string) {
    const described = describeAgentFailure(agent, detail)
    super(described.kind === 'other'
      ? `${agent} ${label} exited with status ${exitCode}: ${described.message}`
      : described.message)
    this.name = 'AgentSessionError'
    this.kind = described.kind
    this.detail = detail
    this.agent = agent
  }
}

function compact(value: string, maximum = 240): string {
  const single = value.replace(/\s+/g, ' ').trim()
  return single.length > maximum ? `${single.slice(0, maximum - 1)}…` : single
}

/** The refusal shown before a run starts with a signed-out assistant. */
export function agentSignedOutMessage(agent: AgentName): string {
  if (agent === 'claude') return 'Claude Code is signed out. Open Terminal, run `claude auth login`, then try again — or switch to another assistant.'
  if (agent === 'codex') return 'Codex is signed out. Open Terminal, run `codex login`, then try again — or switch to another assistant.'
  return 'Gemini is not signed in. Open Terminal, run `gemini` and complete the sign-in (or set GEMINI_API_KEY), then try again — or switch to another assistant.'
}
