import { Icon } from './icons'

export type AgentCapabilityLevel = 'full' | 'limited' | 'none'
export type AgentCapabilityAgent = 'codex' | 'claude' | 'gemini'

export interface AgentCapabilityRow {
  id: string
  label: string
  /** What the capability means for a run, in one sentence. */
  hint: string
  support: Record<AgentCapabilityAgent, { level: AgentCapabilityLevel; note: string }>
}

export const AGENT_CAPABILITY_AGENTS: ReadonlyArray<readonly [AgentCapabilityAgent, string]> = [
  ['codex', 'Codex'],
  ['claude', 'Claude Code'],
  ['gemini', 'Gemini'],
]

/**
 * What each assistant gets from Doxloop. Anything short of parity is marked
 * "Limited" here and in docs/agent-compatibility.md, which carries the same
 * rows, so the agent choice is informed rather than a guess.
 */
export const AGENT_CAPABILITIES: readonly AgentCapabilityRow[] = [
  {
    id: 'screenshots',
    label: 'Application screenshots',
    hint: 'A run-scoped capture browser the agent uses to photograph the product.',
    support: {
      codex: { level: 'full', note: 'Capture browser passed on the command line.' },
      claude: { level: 'full', note: 'Capture browser passed on the command line.' },
      gemini: { level: 'full', note: 'Capture browser merged into the workspace .gemini/settings.json and trusted for the run.' },
    },
  },
  {
    id: 'sources',
    label: 'External sources',
    hint: 'Reading product folders outside the documentation project without being able to change them.',
    support: {
      codex: { level: 'full', note: 'Read through a sandbox that denies writes.' },
      claude: { level: 'full', note: 'Read through a sandbox that denies writes.' },
      gemini: { level: 'limited', note: 'Cannot be denied writes, so an unattended run reads a throwaway copy of each local folder instead of the real checkout.' },
    },
  },
  {
    id: 'cost-cap',
    label: 'Spending cap',
    hint: 'Stops an unattended run at the "Maximum Claude spend" amount.',
    support: {
      codex: { level: 'none', note: 'No spending flag; use the minutes and runs-per-day budgets.' },
      claude: { level: 'full', note: 'Passed as --max-budget-usd; the stop reason names the cap.' },
      gemini: { level: 'none', note: 'No spending flag; use the minutes and runs-per-day budgets.' },
    },
  },
  {
    id: 'live-log',
    label: 'Live activity log',
    hint: 'One-line summaries of what the agent reads, writes, and runs, with stage progress.',
    support: {
      codex: { level: 'full', note: 'Formatted from the codex exec event stream.' },
      claude: { level: 'full', note: 'Formatted from the stream-json output.' },
      gemini: { level: 'full', note: 'Formatted from the stream-json output.' },
    },
  },
  {
    id: 'sign-in',
    label: 'Sign-in check',
    hint: 'Whether Doxloop can tell before a run that the assistant is signed in.',
    support: {
      codex: { level: 'full', note: 'Asks codex login status.' },
      claude: { level: 'full', note: 'Asks claude auth status.' },
      gemini: { level: 'limited', note: 'Looks for an API key or Vertex AI project in the environment, or the Google sign-in token file.' },
    },
  },
  {
    id: 'validation',
    label: 'Validation during a run',
    hint: 'Letting the agent run the Doxloop checks on what it wrote.',
    support: {
      codex: { level: 'full', note: 'Commands run inside the workspace sandbox.' },
      claude: { level: 'full', note: 'Commands run inside the sandbox.' },
      gemini: { level: 'limited', note: 'Only the doxloop command is pre-approved; other commands need a confirmation an unattended run cannot give.' },
    },
  },
]

/** "Full" when every row is at parity, otherwise "Limited". A missing feature nobody else has is not a limitation. */
export function agentParityLabel(agent: AgentCapabilityAgent): 'Full' | 'Limited' {
  return AGENT_CAPABILITIES.some((row) => row.support[agent].level === 'limited') ? 'Limited' : 'Full'
}

const LEVEL_LABEL: Record<AgentCapabilityLevel, string> = { full: 'Yes', limited: 'Limited', none: 'No' }
const LEVEL_ICON: Record<AgentCapabilityLevel, string> = { full: 'check', limited: 'alert', none: 'close' }

export function AgentCapabilityMatrix({ selected, compact = false }: { selected?: string | undefined; compact?: boolean }) {
  return <div class={`agent-capabilities${compact ? ' compact' : ''}`} role="table" aria-label="What each coding assistant supports">
    <div class="agent-capabilities-head" role="row">
      <span role="columnheader">Capability</span>
      {AGENT_CAPABILITY_AGENTS.map(([id, label]) => <span role="columnheader" key={id} class={selected === id ? 'selected' : ''}><strong>{label}</strong><small class={agentParityLabel(id).toLowerCase()}>{agentParityLabel(id)}</small></span>)}
    </div>
    {AGENT_CAPABILITIES.map((row) => <div class="agent-capabilities-row" role="row" key={row.id}>
      <span role="rowheader"><strong>{row.label}</strong>{!compact && <small>{row.hint}</small>}</span>
      {AGENT_CAPABILITY_AGENTS.map(([id]) => {
        const support = row.support[id]
        return <span role="cell" key={id} class={`${support.level}${selected === id ? ' selected' : ''}`} title={support.note}>
          <Icon name={LEVEL_ICON[support.level]} size={12} />{LEVEL_LABEL[support.level]}
          {!compact && selected === id && <small>{support.note}</small>}
        </span>
      })}
    </div>)}
  </div>
}
