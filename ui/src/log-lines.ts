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
