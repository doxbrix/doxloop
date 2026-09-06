import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { uploadAsset } from './assets.js'
import { listRequests } from './history.js'
import { readPageMetadata, updatePageMetadata } from './page-metadata.js'
import { scaffoldProject } from './project.js'

const roots: string[] = []
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]).toString('base64')

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function scaffold(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), 'doxloop-metadata-'))
  roots.push(parent)
  return scaffoldProject({ directory: join(parent, 'docs'), title: 'Pulse', sources: [], generator: 'doxbrix' })
}

describe('page metadata', () => {
  test('reads the editable frontmatter fields and names the keys it leaves alone', async () => {
    const root = await scaffold()
    await writeFile(join(root, 'quickstart.mdx'), '---\ntitle: "Quickstart"\ndescription: "Reach your first successful result."\nicon: bolt\nsidebarOrder: 3\n---\n\n# Quickstart\n\nBody.\n', 'utf8')
    const metadata = await readPageMetadata(root, 'quickstart.mdx')
    expect(metadata.editable).toBe(true)
    expect(metadata.fields).toEqual({ title: 'Quickstart', description: 'Reach your first successful result.', icon: 'bolt' })
    expect(metadata.otherKeys).toEqual(['sidebarOrder'])
    await expect(readPageMetadata(root, '../outside.mdx')).rejects.toThrow('not an existing documentation page')
  })

  test('writes SEO fields, preserves other frontmatter, and records history', async () => {
    const root = await scaffold()
    await uploadAsset(root, { name: 'social.png', data: PNG })
    await writeFile(join(root, 'quickstart.mdx'), '---\ntitle: "Quickstart"\ndescription: "Reach your first successful result."\nicon: bolt\nsidebarOrder: 3\n---\n\n# Quickstart\n\nBody.\n', 'utf8')
    const before = await readPageMetadata(root, 'quickstart.mdx')
    const after = await updatePageMetadata(root, {
      path: 'quickstart.mdx',
      fingerprint: before.fingerprint,
      fields: { title: 'Quick start', canonical: 'https://docs.example.com/quickstart', socialImage: '/assets/social.png', icon: null },
    })
    expect(after.fields).toEqual({ title: 'Quick start', description: 'Reach your first successful result.', canonical: 'https://docs.example.com/quickstart', socialImage: '/assets/social.png' })
    expect(after.otherKeys).toEqual(['sidebarOrder'])
    const raw = await readFile(join(root, 'quickstart.mdx'), 'utf8')
    expect(raw).toContain('sidebarOrder: 3')
    expect(raw).toMatch(/canonical: '?https:\/\/docs\.example\.com\/quickstart'?\n/)
    expect(raw).not.toContain('icon:')
    expect(raw).toContain('# Quickstart\n\nBody.')
    expect((await listRequests(root))[0]).toMatchObject({ kind: 'metadata', status: 'completed', pagesChanged: 1 })
  })

  test('rejects stale fingerprints, empty titles, bad URLs, and missing images without touching the page', async () => {
    const root = await scaffold()
    const original = await readFile(join(root, 'index.mdx'), 'utf8')
    const { fingerprint } = await readPageMetadata(root, 'index.mdx')
    await expect(updatePageMetadata(root, { path: 'index.mdx', fingerprint: 'stale', fields: { title: 'X' } })).rejects.toThrow('changed on disk')
    await expect(updatePageMetadata(root, { path: 'index.mdx', fingerprint, fields: { title: '' } })).rejects.toThrow('Title cannot be empty')
    await expect(updatePageMetadata(root, { path: 'index.mdx', fingerprint, fields: { canonical: 'ftp://x' } })).rejects.toThrow('HTTPS address')
    await expect(updatePageMetadata(root, { path: 'index.mdx', fingerprint, fields: { socialImage: '/assets/nope.png' } })).rejects.toThrow('not a file')
    await expect(updatePageMetadata(root, { path: 'index.mdx', fingerprint, fields: { socialImage: '/../secret.png' } })).rejects.toThrow('root-relative path')
    await expect(updatePageMetadata(root, { path: 'index.mdx', fingerprint, fields: { layout: 'wide' } })).rejects.toThrow('not an editable metadata field')
    expect(await readFile(join(root, 'index.mdx'), 'utf8')).toBe(original)
  })
})
