import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  MAX_ASSET_BYTES,
  decodeUpload,
  deleteAsset,
  pageAssetReferences,
  readAssetLibrary,
  safeAssetName,
  updateAssetAlt,
  uploadAsset,
} from './assets.js'
import { listRequests } from './history.js'
import { pathExists } from './fs.js'
import { scaffoldProject } from './project.js'

const roots: string[] = []
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1])
const PNG = PNG_BYTES.toString('base64')

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function scaffold(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), 'doxloop-assets-'))
  roots.push(parent)
  return scaffoldProject({ directory: join(parent, 'docs'), title: 'Pulse', sources: [], generator: 'doxbrix' })
}

describe('asset library', () => {
  test('uploads into the generator asset directory and lists references with alt text', async () => {
    const root = await scaffold()
    const uploaded = await uploadAsset(root, { name: 'Team settings.png', data: `data:image/png;base64,${PNG}` })
    expect(uploaded).toMatchObject({ path: 'assets/Team-settings.png', name: 'Team-settings.png', publicPath: '/assets/Team-settings.png', kind: 'image', bytes: PNG_BYTES.length, references: [] })
    await writeFile(join(root, 'quickstart.mdx'), '---\ntitle: "Quickstart"\ndescription: "Reach your first successful result with verified product instructions."\n---\n\n# Quickstart\n\n![Old alt](/assets/Team-settings.png)\n\n<Frame><img src="/assets/Team-settings.png" alt="Old alt" /></Frame>\n\nMore text.\n', 'utf8')
    const library = await readAssetLibrary(root)
    expect(library.directory).toBe('assets')
    expect(library.maxBytes).toBe(MAX_ASSET_BYTES)
    expect(library.assets).toHaveLength(1)
    expect(library.assets[0]!.references).toEqual([{ page: 'quickstart.mdx', alt: 'Old alt' }, { page: 'quickstart.mdx', alt: 'Old alt' }])
    expect((await listRequests(root))[0]).toMatchObject({ kind: 'asset', status: 'completed', requestText: 'Uploaded assets/Team-settings.png' })
  })

  test('rewrites alt text in every referencing page and refuses to delete a used asset without force', async () => {
    const root = await scaffold()
    await uploadAsset(root, { name: 'diagram.png', data: PNG })
    await writeFile(join(root, 'quickstart.mdx'), '---\ntitle: "Quickstart"\ndescription: "Reach your first successful result with verified product instructions."\n---\n\n# Quickstart\n\n![Old alt](/assets/diagram.png)\n\n<img src="/assets/diagram.png" />\n\nMore text.\n', 'utf8')
    const updated = await updateAssetAlt(root, { path: 'assets/diagram.png', alt: 'The team settings page with the invite form open' })
    expect(updated.references.map((reference) => reference.alt)).toEqual(['The team settings page with the invite form open', 'The team settings page with the invite form open'])
    const page = await readFile(join(root, 'quickstart.mdx'), 'utf8')
    expect(page).toContain('![The team settings page with the invite form open](/assets/diagram.png)')
    expect(page).toContain('<img src="/assets/diagram.png" alt="The team settings page with the invite form open" />')
    await expect(deleteAsset(root, { path: 'assets/diagram.png' })).rejects.toThrow('still used by quickstart.mdx')
    expect(await pathExists(join(root, 'assets/diagram.png'))).toBe(true)
    await expect(updateAssetAlt(root, { path: 'assets/diagram.png', alt: 'Bad [alt]' })).rejects.toThrow('cannot contain')
    await writeFile(join(root, 'quickstart.mdx'), '---\ntitle: "Quickstart"\ndescription: "Reach your first successful result with verified product instructions."\n---\n\n# Quickstart\n\nNo images any more.\n', 'utf8')
    expect(await deleteAsset(root, { path: 'assets/diagram.png' })).toEqual({ removed: 'assets/diagram.png' })
    expect(await pathExists(join(root, 'assets/diagram.png'))).toBe(false)
    expect((await listRequests(root))[0]).toMatchObject({ kind: 'asset', status: 'completed', requestText: 'Deleted assets/diagram.png' })
  })

  test('keeps uploads inside the project and rejects unsafe names, directories, sizes, and content', async () => {
    const root = await scaffold()
    const escaped = await uploadAsset(root, { name: '../../escape.png', data: PNG })
    expect(escaped.path).toBe('assets/escape.png')
    await expect(uploadAsset(root, { name: 'x.png', data: PNG, directory: '../outside' })).rejects.toThrow('escapes the project')
    await expect(uploadAsset(root, { name: 'x.png', data: PNG, directory: '.doxloop' })).rejects.toThrow('not part of the documentation')
    await expect(uploadAsset(root, { name: 'escape.png', data: PNG })).rejects.toThrow('already exists')
    const replaced = await uploadAsset(root, { name: 'escape.png', data: PNG, replace: true })
    expect(replaced.path).toBe('assets/escape.png')
    expect(() => safeAssetName('script.exe')).toThrow('not an accepted asset type')
    expect(() => safeAssetName('.png')).toThrow('not an accepted asset type')
    expect(() => decodeUpload(Buffer.from('GIF89a').toString('base64'), 'photo.png')).toThrow('does not look like a PNG')
    expect(() => decodeUpload(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64'), 'icon.svg')).toThrow('no scripts')
    expect(decodeUpload(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>').toString('base64'), 'icon.svg').length).toBeGreaterThan(0)
    expect(() => decodeUpload('not base64!!', 'a.png')).toThrow('base64')
    expect(() => decodeUpload(Buffer.alloc(MAX_ASSET_BYTES + 1, 1).toString('base64'), 'big.png')).toThrow('10 MB or smaller')
    await expect(deleteAsset(root, { path: '../docs.json' })).rejects.toThrow('cannot leave the project')
    await expect(deleteAsset(root, { path: 'docs.json' })).rejects.toThrow('not an asset')
  })

  test('recognises markdown and component image references', () => {
    expect(pageAssetReferences('![A](/assets/a.png) ![](./b.jpg "title") <img alt="C" src="/assets/c.webp"> <Frame src="/d.png"/> ![X](https://cdn.example.com/x.png)')).toEqual([
      { reference: '/assets/a.png', alt: 'A' },
      { reference: './b.jpg', alt: '' },
      { reference: '/assets/c.webp', alt: 'C' },
      { reference: '/d.png', alt: '' },
    ])
  })
})
