import { createInterface } from 'node:readline/promises'

const PUBLIC_DEPLOY_PROMPT =
  'You selected --public. This site will be deployed publicly and anyone can access it. Continue? (y/N) '

export async function confirmPublicDeployment(options: {
  input?: NodeJS.ReadableStream
  output?: NodeJS.WritableStream
} = {}): Promise<boolean> {
  const input = options.input ?? process.stdin
  const output = options.output ?? process.stdout
  const prompt = createInterface({ input, output })
  output.write(PUBLIC_DEPLOY_PROMPT)
  return new Promise((resolve) => {
    let answered = false
    prompt.once('line', (answer) => {
      answered = true
      resolve(/^(?:y|yes)$/i.test(answer.trim()))
      prompt.close()
    })
    prompt.once('SIGINT', () => prompt.close())
    prompt.once('close', () => {
      if (!answered) resolve(false)
    })
  })
}
