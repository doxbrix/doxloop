import { describe, expect, test } from 'vitest'
import { createStepList, formatDuration } from './progress.js'

function captureStream(): { stream: NodeJS.WriteStream; lines: () => string[] } {
  let buffer = ''
  const stream = {
    isTTY: false,
    write(chunk: string) {
      buffer += chunk
      return true
    },
  } as unknown as NodeJS.WriteStream
  return { stream, lines: () => buffer.split('\n').filter(Boolean) }
}

describe('step list', () => {
  test('prints completed steps as plain lines on non-TTY streams', () => {
    const { stream, lines } = captureStream()
    const steps = createStepList(stream)
    steps.start('Validating documentation').done('Validated documentation')
    steps.start('Building bundle').done('Built bundle', '2 pages, 1.2 KiB')
    expect(lines()).toEqual([
      '  ✓ Validated documentation',
      '  ✓ Built bundle · 2 pages, 1.2 KiB',
    ])
  })

  test('prints nothing while a step is still running on non-TTY streams', () => {
    const { stream, lines } = captureStream()
    const steps = createStepList(stream)
    steps.start('Publishing to Doxbrix')
    expect(lines()).toEqual([])
  })

  test('failActive marks the running step and further completions are ignored', () => {
    const { stream, lines } = captureStream()
    const steps = createStepList(stream)
    const step = steps.start('Publishing to Doxbrix')
    steps.failActive()
    step.done('Published')
    steps.failActive()
    expect(lines()).toEqual(['  ✗ Publishing to Doxbrix'])
  })

  test('done keeps the starting label when no replacement is given', () => {
    const { stream, lines } = captureStream()
    const steps = createStepList(stream)
    steps.start('Locating project').done()
    expect(lines()).toEqual(['  ✓ Locating project'])
  })
})

describe('formatDuration', () => {
  test('formats sub-minute durations as seconds', () => {
    expect(formatDuration(400)).toBe('1s')
    expect(formatDuration(21_000)).toBe('21s')
  })

  test('formats longer durations as minutes and seconds', () => {
    expect(formatDuration(60_000)).toBe('1m')
    expect(formatDuration(65_000)).toBe('1m 5s')
  })
})
