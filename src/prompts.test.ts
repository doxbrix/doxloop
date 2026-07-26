import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, test } from 'vitest'
import { parseArgs } from './args.js'
import {
  isInteractive,
  promptConfirm,
  promptSelect,
  promptText,
  type PromptIo,
} from './prompts.js'

const previousCi = process.env.CI

afterEach(() => {
  if (previousCi === undefined) delete process.env.CI
  else process.env.CI = previousCi
})

function fakeIo(lines: string[], tty = false): PromptIo & { rendered: () => string } {
  const input = new PassThrough()
  const output = new PassThrough()
  let rendered = ''
  output.on('data', (chunk: Buffer) => {
    rendered += chunk.toString('utf8')
  })
  if (tty) {
    Object.assign(input, { isTTY: true })
    Object.assign(output, { isTTY: true })
  }
  setImmediate(() => {
    for (const line of lines) input.write(`${line}\n`)
  })
  return {
    input,
    output,
    rendered: () => rendered,
  }
}

describe('interactivity gate', () => {
  test('requires a terminal on both stdin and stdout', () => {
    const args = parseArgs(['init'])
    expect(isInteractive(args, fakeIo([]))).toBe(false)
    expect(isInteractive(args, fakeIo([], true))).toBe(true)
  })

  test('never prompts with --yes or in CI', () => {
    expect(isInteractive(parseArgs(['init', '--yes']), fakeIo([], true))).toBe(false)
    process.env.CI = 'true'
    expect(isInteractive(parseArgs(['init']), fakeIo([], true))).toBe(false)
  })
})

describe('text prompt', () => {
  test('returns the typed value and re-asks until validation passes', async () => {
    const io = fakeIo(['bad', 'good'])
    const value = await promptText({
      message: 'Name?',
      validate: (candidate) => (candidate === 'bad' ? 'Try again.' : undefined),
      io,
    })
    expect(value).toBe('good')
    expect(io.rendered()).toContain('Try again.')
  })

  test('falls back to the initial value on an empty answer', async () => {
    const value = await promptText({
      message: 'Title?',
      initial: 'My Docs',
      io: fakeIo(['']),
    })
    expect(value).toBe('My Docs')
  })

  test('allows an intentionally empty answer when permitted', async () => {
    const value = await promptText({
      message: 'Request?',
      allowEmpty: true,
      io: fakeIo(['']),
    })
    expect(value).toBe('')
  })

  test('cleans up terminal input handlers before the next prompt', async () => {
    const io = fakeIo([], true)
    Object.assign(io.input, { setRawMode: () => undefined })

    setImmediate(() => io.input.write('first\n'))
    await expect(promptText({ message: 'First?', io })).resolves.toBe('first')
    const renderedBeforeSecondPrompt = io.rendered().length
    const listenersAfterFirstPrompt = io.input.listenerCount('data')

    setImmediate(() => io.input.write('second\n'))
    await expect(promptText({ message: 'Second?', io })).resolves.toBe('second')

    const secondPromptOutput = io.rendered().slice(renderedBeforeSecondPrompt)
    expect(secondPromptOutput.match(/second/g)).toHaveLength(1)
    expect(io.input.listenerCount('data')).toBe(listenersAfterFirstPrompt)
  })
})

describe('confirm prompt', () => {
  test('uses the default on an empty answer and parses yes/no', async () => {
    expect(await promptConfirm({ message: 'Go?', io: fakeIo(['']) })).toBe(true)
    expect(
      await promptConfirm({ message: 'Go?', initial: false, io: fakeIo(['']) }),
    ).toBe(false)
    expect(await promptConfirm({ message: 'Go?', io: fakeIo(['n']) })).toBe(false)
    expect(
      await promptConfirm({ message: 'Go?', io: fakeIo(['what', 'yes']) }),
    ).toBe(true)
  })
})

describe('select prompt without raw terminal input', () => {
  test('selects by number and defaults to the first enabled choice', async () => {
    const choices = [
      { value: 'a', label: 'Alpha' },
      { value: 'b', label: 'Beta' },
    ]
    expect(
      await promptSelect({ message: 'Pick', choices, io: fakeIo(['2']) }),
    ).toBe('b')
    expect(
      await promptSelect({ message: 'Pick', choices, io: fakeIo(['']) }),
    ).toBe('a')
  })

  test('skips disabled choices and re-asks on invalid numbers', async () => {
    const io = fakeIo(['1', '9', '2'])
    const value = await promptSelect({
      message: 'Pick',
      choices: [
        { value: 'a', label: 'Alpha', disabled: 'not installed' },
        { value: 'b', label: 'Beta' },
      ],
      io,
    })
    expect(value).toBe('b')
  })
})

describe('select prompt with raw terminal input', () => {
  test('supports arrow keys, Enter, and renders keyboard instructions', async () => {
    const io = fakeIo([], true)
    let raw = false
    Object.assign(io.input, {
      setRawMode: (value: boolean) => {
        raw = value
      },
    })
    setImmediate(() => io.input.write('\u001b[B\r'))

    await expect(
      promptSelect({
        message: 'Pick',
        choices: [
          { value: 'a', label: 'Alpha' },
          { value: 'b', label: 'Beta' },
        ],
        io,
      }),
    ).resolves.toBe('b')
    expect(raw).toBe(false)
    expect(io.rendered()).toContain('↑/↓ move · Enter select · Esc cancel')
  })

  test('treats Escape as cancellation and restores terminal mode', async () => {
    const io = fakeIo([], true)
    let raw = false
    Object.assign(io.input, {
      setRawMode: (value: boolean) => {
        raw = value
      },
    })
    setImmediate(() => io.input.write('\u001b'))

    await expect(
      promptSelect({
        message: 'Pick',
        choices: [{ value: 'a', label: 'Alpha' }],
        io,
      }),
    ).rejects.toMatchObject({ exitCode: 130 })
    expect(raw).toBe(false)
  })
})
