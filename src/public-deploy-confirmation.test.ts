import { Readable, Writable } from 'node:stream'
import { describe, expect, test } from 'vitest'
import { confirmPublicDeployment } from './public-deploy-confirmation.js'

function confirmation(answer: string): {
  result: Promise<boolean>
  output: () => string
} {
  let written = ''
  const output = new Writable({
    write(chunk, _encoding, callback) {
      written += String(chunk)
      callback()
    },
  })
  return {
    result: confirmPublicDeployment({
      input: Readable.from([`${answer}\n`]),
      output,
    }),
    output: () => written,
  }
}

describe('public deployment confirmation', () => {
  test.each(['y', 'yes', 'YES'])('accepts %s', async (answer) => {
    const prompt = confirmation(answer)

    await expect(prompt.result).resolves.toBe(true)
    expect(prompt.output()).toContain(
      'This site will be deployed publicly and anyone can access it.',
    )
  })

  test.each(['', 'n', 'no', 'anything else'])('declines %j', async (answer) => {
    await expect(confirmation(answer).result).resolves.toBe(false)
  })

  test('declines when input closes without an answer', async () => {
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        callback()
      },
    })

    await expect(
      confirmPublicDeployment({ input: Readable.from([]), output }),
    ).resolves.toBe(false)
  })
})
