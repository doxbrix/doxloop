import { createInterface } from 'node:readline/promises'
import { styleText } from 'node:util'
import { booleanFlag } from './args.js'
import { DoxloopError } from './errors.js'
import type { ParsedArgs } from './types.js'

export interface PromptIo {
  input: NodeJS.ReadableStream & {
    isTTY?: boolean
    setRawMode?: (mode: boolean) => unknown
  }
  output: NodeJS.WritableStream & { isTTY?: boolean }
}

export interface PromptChoice<T> {
  value: T
  label: string
  hint?: string
  disabled?: string
}

const CANCEL_EXIT_CODE = 130

function defaultIo(): PromptIo {
  return { input: process.stdin, output: process.stdout }
}

export function promptCanceled(): DoxloopError {
  return new DoxloopError('Canceled.', CANCEL_EXIT_CODE)
}

export function isInteractive(args: ParsedArgs, io: PromptIo = defaultIo()): boolean {
  return (
    io.input.isTTY === true &&
    io.output.isTTY === true &&
    !booleanFlag(args, 'yes') &&
    (process.env.CI === undefined || process.env.CI === '')
  )
}

function color(
  io: PromptIo,
  style: Parameters<typeof styleText>[0],
  text: string,
): string {
  if (io.output.isTTY !== true || process.env.NO_COLOR) return text
  return styleText(style, text)
}

export function note(io: PromptIo, lines: string): void {
  for (const line of lines.split('\n')) {
    io.output.write(`${color(io, 'dim', '│')}  ${line}\n`)
  }
}

export function heading(io: PromptIo, text: string): void {
  io.output.write(`\n  ${color(io, 'bold', text)}\n\n`)
}

function renderAnswered(io: PromptIo, message: string, answer: string): void {
  io.output.write(
    `${color(io, 'green', '◆')} ${message} ${color(io, 'dim', '·')} ${color(io, 'cyan', answer)}\n`,
  )
}

// Reads lines through one readline interface per prompt, buffering lines that
// arrive between questions so piped and scripted input is never dropped.
class LineReader {
  private readonly queue: string[] = []
  private pending:
    | { resolve: (line: string) => void; reject: (error: Error) => void }
    | undefined
  private canceled = false
  private readonly prompt: ReturnType<typeof createInterface>

  constructor(io: PromptIo) {
    this.prompt = createInterface({ input: io.input, output: io.output })
    this.prompt.on('line', (line) => {
      if (this.pending) {
        const waiting = this.pending
        this.pending = undefined
        waiting.resolve(line)
      } else {
        this.queue.push(line)
      }
    })
    const cancel = (): void => {
      this.canceled = true
      if (this.pending) {
        const waiting = this.pending
        this.pending = undefined
        waiting.reject(promptCanceled())
      }
    }
    this.prompt.on('SIGINT', cancel)
    this.prompt.on('close', cancel)
  }

  next(io: PromptIo, query: string): Promise<string> {
    io.output.write(query)
    const buffered = this.queue.shift()
    if (buffered !== undefined) return Promise.resolve(buffered)
    if (this.canceled) return Promise.reject(promptCanceled())
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject }
    })
  }

  close(): void {
    this.prompt.removeAllListeners('close')
    this.prompt.close()
  }
}

export async function promptText(options: {
  message: string
  initial?: string
  hint?: string
  allowEmpty?: boolean
  validate?: (value: string) => string | undefined | Promise<string | undefined>
  io?: PromptIo
}): Promise<string> {
  const io = options.io ?? defaultIo()
  const suffix = options.initial
    ? ` ${color(io, 'dim', `(${options.initial})`)}`
    : options.allowEmpty
      ? ` ${color(io, 'dim', '(Enter to skip)')}`
      : ''
  io.output.write(`${color(io, 'cyan', '◆')} ${options.message}${suffix}\n`)
  if (options.hint) note(io, color(io, 'dim', options.hint))

  const reader = new LineReader(io)
  try {
    while (true) {
      const raw = await reader.next(io, `${color(io, 'dim', '│')}  `)
      const value = raw.trim() || options.initial?.trim() || ''
      if (value === '' && !options.allowEmpty) {
        note(io, color(io, 'yellow', 'A value is required.'))
        continue
      }
      const problem = value === '' ? undefined : await options.validate?.(value)
      if (problem) {
        note(io, color(io, 'yellow', problem))
        continue
      }
      return value
    }
  } finally {
    reader.close()
  }
}

export async function promptConfirm(options: {
  message: string
  initial?: boolean
  io?: PromptIo
}): Promise<boolean> {
  const io = options.io ?? defaultIo()
  const fallback = options.initial ?? true
  const marks = fallback ? 'Y/n' : 'y/N'
  const reader = new LineReader(io)
  try {
    while (true) {
      const raw = (
        await reader.next(
          io,
          `${color(io, 'cyan', '◆')} ${options.message} ${color(io, 'dim', `(${marks})`)} `,
        )
      )
        .trim()
        .toLowerCase()
      if (raw === '') return fallback
      if (raw === 'y' || raw === 'yes') return true
      if (raw === 'n' || raw === 'no') return false
      note(io, color(io, 'yellow', 'Answer y or n.'))
    }
  } finally {
    reader.close()
  }
}

export async function promptSelect<T>(options: {
  message: string
  choices: Array<PromptChoice<T>>
  initialIndex?: number
  io?: PromptIo
}): Promise<T> {
  const io = options.io ?? defaultIo()
  const enabled = options.choices.filter((choice) => !choice.disabled)
  if (enabled.length === 0) {
    throw new DoxloopError('No selectable choices are available.')
  }
  if (typeof io.input.setRawMode !== 'function' || io.input.isTTY !== true) {
    return numberedSelect(io, options)
  }
  return rawSelect(io, options)
}

function choiceLine<T>(
  io: PromptIo,
  choice: PromptChoice<T>,
  active: boolean,
): string {
  const marker = choice.disabled
    ? color(io, 'dim', '○')
    : active
      ? color(io, 'cyan', '●')
      : '○'
  const label = choice.disabled
    ? color(io, 'dim', choice.label)
    : active
      ? color(io, 'cyan', choice.label)
      : choice.label
  const hint = choice.disabled ?? choice.hint
  return `${color(io, 'dim', '│')}  ${marker} ${label}${hint ? `  ${color(io, 'dim', hint)}` : ''}`
}

async function rawSelect<T>(
  io: PromptIo,
  options: {
    message: string
    choices: Array<PromptChoice<T>>
    initialIndex?: number
  },
): Promise<T> {
  const { choices } = options
  let index = firstEnabled(choices, options.initialIndex ?? 0)
  const renderedLines = choices.length + 2
  const render = (first: boolean): void => {
    if (!first) io.output.write(`\u001b[${renderedLines}A`)
    io.output.write(`\u001b[0J${color(io, 'cyan', '◆')} ${options.message}\n`)
    for (const [position, choice] of choices.entries()) {
      io.output.write(`${choiceLine(io, choice, position === index)}\n`)
    }
    io.output.write(
      `${color(io, 'dim', '│')}  ${color(io, 'dim', '↑/↓ move · Enter select · Esc cancel')}\n`,
    )
  }
  render(true)

  const input = io.input
  const wasRaw = (input as NodeJS.ReadStream).isRaw === true
  input.setRawMode?.(true)
  input.resume?.()
  try {
    return await new Promise<T>((resolveChoice, reject) => {
      let settled = false
      const move = (step: number): void => {
        for (let hops = 0; hops < choices.length; hops += 1) {
          index = (index + step + choices.length) % choices.length
          if (!choices[index]?.disabled) break
        }
        render(false)
      }
      const handleKey = (key: string): void => {
        if (key === '\u0003' || key === '\u001b') {
          finish()
          reject(promptCanceled())
          return
        }
        if (key === '\u001b[A' || key === 'k') move(-1)
        else if (key === '\u001b[B' || key === 'j') move(1)
        else if (key === '\r' || key === '\n') {
          const chosen = choices[index]
          if (!chosen || chosen.disabled) return
          finish()
          io.output.write(`\u001b[${renderedLines}A\u001b[0J`)
          renderAnswered(io, options.message, chosen.label)
          resolveChoice(chosen.value)
        } else if (/^[1-9]$/.test(key)) {
          const target = Number(key) - 1
          if (target < choices.length && !choices[target]?.disabled) {
            index = target
            render(false)
          }
        }
      }
      // One chunk can hold several keystrokes (paste, scripted input); split
      // it into keys, keeping three-byte arrow sequences together.
      const onData = (data: Buffer): void => {
        const chunk = data.toString('utf8')
        let position = 0
        while (position < chunk.length && !settled) {
          const arrow = chunk.slice(position, position + 3)
          if (arrow === '\u001b[A' || arrow === '\u001b[B') {
            handleKey(arrow)
            position += 3
          } else {
            handleKey(chunk[position] ?? '')
            position += 1
          }
        }
      }
      const onEnd = (): void => {
        finish()
        reject(promptCanceled())
      }
      const finish = (): void => {
        if (settled) return
        settled = true
        input.removeListener('data', onData)
        input.removeListener('end', onEnd)
        input.removeListener('close', onEnd)
        if (!wasRaw) input.setRawMode?.(false)
        input.pause?.()
      }
      input.on('data', onData)
      input.once('end', onEnd)
      input.once('close', onEnd)
    })
  } finally {
    if (!wasRaw) input.setRawMode?.(false)
  }
}

async function numberedSelect<T>(
  io: PromptIo,
  options: {
    message: string
    choices: Array<PromptChoice<T>>
    initialIndex?: number
  },
): Promise<T> {
  const { choices } = options
  const initial = firstEnabled(choices, options.initialIndex ?? 0)
  io.output.write(`${color(io, 'cyan', '◆')} ${options.message}\n`)
  for (const [position, choice] of choices.entries()) {
    const hint = choice.disabled ?? choice.hint
    io.output.write(
      `${color(io, 'dim', '│')}  ${position + 1}. ${choice.label}${hint ? `  ${color(io, 'dim', hint)}` : ''}\n`,
    )
  }
  const reader = new LineReader(io)
  try {
    while (true) {
      const raw = (
        await reader.next(
          io,
          `${color(io, 'dim', '│')}  Choose 1-${choices.length} ${color(io, 'dim', `(${initial + 1})`)}: `,
        )
      ).trim()
      const position = raw === '' ? initial : Number(raw) - 1
      const chosen = Number.isInteger(position) ? choices[position] : undefined
      if (chosen && !chosen.disabled) {
        renderAnswered(io, options.message, chosen.label)
        return chosen.value
      }
      note(io, color(io, 'yellow', `Enter a number between 1 and ${choices.length}.`))
    }
  } finally {
    reader.close()
  }
}

function firstEnabled<T>(choices: Array<PromptChoice<T>>, start: number): number {
  for (let offset = 0; offset < choices.length; offset += 1) {
    const index = (start + offset) % choices.length
    if (!choices[index]?.disabled) return index
  }
  return 0
}
