import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { packageStaticOutput } from './artifact-deploy.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function site(pages: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'doxloop-artifact-'))
  roots.push(root)
  for (const [path, content] of Object.entries(pages)) {
    await mkdir(join(root, path, '..'), { recursive: true })
    await writeFile(join(root, path), content, 'utf8')
  }
  return root
}

describe('static output secret scan', () => {
  test('deploys a page that documents the dxb_ token error, whose heading anchor spells dxb_ in a slug', async () => {
    const root = await site({
      'index.html': '<h1>Docs</h1>',
      'developers/troubleshooting/index.html': '<h3 id="unauthorized-provide-a-dxb_-personal-access-token-via-authorization-bearer">Unauthorized: provide a dxb_ Personal Access Token</h3><p>Tokens look like <code>dxb_…</code>.</p>',
    })

    await expect(packageStaticOutput(root)).resolves.toMatchObject({ files: 2 })
  })

  test('still refuses a page holding a real-format Doxbrix token', async () => {
    const root = await site({
      'index.html': `<pre>DOXBRIX_TOKEN=dxb_${'a1'.repeat(24)}</pre>`,
    })

    await expect(packageStaticOutput(root)).rejects.toThrow('appears to contain a deployment access token: index.html')
  })
})
