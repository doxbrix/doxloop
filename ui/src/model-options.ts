export type AgentId = 'codex' | 'claude' | 'gemini'

export type AgentModelOption = {
  id: string
  label: string
  reasoning: readonly string[]
}

export const AGENT_MODELS: Record<AgentId, readonly AgentModelOption[]> = {
  codex: [
    { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', reasoning: ['low', 'medium', 'high', 'xhigh'] },
    { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', reasoning: ['low', 'medium', 'high', 'xhigh'] },
    { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', reasoning: ['none', 'low', 'medium', 'high', 'xhigh', 'max'] },
  ],
  claude: [
    { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', reasoning: ['low', 'medium', 'high', 'xhigh'] },
    { id: 'claude-opus-5', label: 'Claude Opus 5', reasoning: ['medium', 'high', 'xhigh', 'max'] },
    { id: 'claude-fable-5', label: 'Claude Fable 5', reasoning: ['low', 'medium', 'high'] },
    { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', reasoning: ['low', 'medium'] },
  ],
  gemini: [
    { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro Preview', reasoning: [] },
    { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash', reasoning: [] },
    { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', reasoning: [] },
    { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash Lite', reasoning: [] },
  ],
}

export function agentModels(agent: string): readonly AgentModelOption[] {
  return agent === 'codex' || agent === 'claude' || agent === 'gemini' ? AGENT_MODELS[agent] : []
}

export function defaultModelForAgent(agent: string): string {
  return agentModels(agent)[0]?.id ?? ''
}

export function modelReasoningLevels(agent: string, model: string): readonly string[] {
  return agentModels(agent).find((option) => option.id === model)?.reasoning ?? []
}

export function preferredReasoningLevel(agent: string, model: string): string {
  const levels = modelReasoningLevels(agent, model)
  return levels.includes('high') ? 'high' : levels[0] ?? ''
}
