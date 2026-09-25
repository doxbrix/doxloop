// CSI sequences (colours, cursor moves), OSC sequences (titles, links), and lone escapes.
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g
const LINE_STAMP = /^\d{2}:\d{2}:\d{2} /

export function stripAnsi(line: string): string {
  return line.replace(ANSI_PATTERN, '')
}

/**
 * A raw machine line an agent printed to its stream: an internal
 * `DOXLOOP_EVENT` or a whole JSON event object. Readers of the live log never
 * need these, and the full log keeps them.
 */
export function isMachineLogLine(line: string): boolean {
  const text = line.replace(LINE_STAMP, '').trim()
  if (text.startsWith('DOXLOOP_EVENT')) return true
  if (!text.startsWith('{') || !text.endsWith('}')) return false
  try {
    const value = JSON.parse(text) as unknown
    return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string'
  } catch {
    return false
  }
}

/** Job output as a person should read it: no terminal escape codes and no machine events. */
export function displayLogLines(lines: readonly string[]): string[] {
  return lines.map(stripAnsi).filter((line) => !isMachineLogLine(line))
}

export interface RunActivity {
  /** Screenshots the capture browser has saved so far. */
  screenshots: number
  /** Source files and commands the agents have read or run. */
  sourceReads: number
  /** Readable names of the sessions that have produced output. */
  sessions: string[]
  /** The agent's most recent plain-language note, if any. */
  latestNote?: { session: string; text: string }
}

const SESSION_NAMES: Array<[RegExp, string]> = [
  [/^product$/, 'Product research'],
  [/^application$/, 'App exploration'],
  [/^existing-docs/, 'Existing docs review'],
  [/^batch/, 'Writing'],
]

function sessionName(raw: string): string {
  return SESSION_NAMES.find(([pattern]) => pattern.test(raw))?.[1] ?? raw.replace(/[-_]+/g, ' ').replace(/^\w/, (letter) => letter.toUpperCase())
}

/**
 * What a run has done so far, in words a reader follows: the live log is a
 * stream of tool calls ("Using doxloop_capture browser_evaluate") that only
 * an engineer can read. Counts come from completed actions only.
 */
export function summarizeRunActivity(lines: readonly string[]): RunActivity {
  let screenshots = 0
  let sourceReads = 0
  const sessions: string[] = []
  let latestNote: RunActivity['latestNote']
  for (const raw of displayLogLines(lines)) {
    const text = raw.replace(LINE_STAMP, '')
    const tagged = /^\[([^\]]+)\]\s*(.*)$/.exec(text)
    const session = tagged ? sessionName(tagged[1]!) : ''
    const body = (tagged ? tagged[2]! : text).trim()
    if (session && !sessions.includes(session)) sessions.push(session)
    if (/^✓ Using \S*capture\S* browser_take_screenshot/.test(body)) screenshots += 1
    else if (/^✓ Running /.test(body)) sourceReads += 1
    else if (session && body.length > 40 && !/^[→✓✗×!]/.test(body) && !/^(?:Using|Running|Codex|Claude|Gemini) /.test(body)) latestNote = { session, text: body }
  }
  return { screenshots, sourceReads, sessions, ...(latestNote ? { latestNote } : {}) }
}
