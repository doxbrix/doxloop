import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { uploadAsset } from './assets.js'
import { readBranding, writeBranding } from './branding.js'
import { listRequests } from './history.js'
import { scaffoldProject } from './project.js'

const roots: string[] = []
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1]).toString('base64')

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function scaffold(generator: 'doxbrix' | 'mkdocs' = 'doxbrix'): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), 'doxloop-branding-'))
  roots.push(parent)
  return scaffoldProject({ directory: join(parent, 'docs'), title: 'Pulse', sources: [], generator })
}

describe('branding panel', () => {
  test('reads the Doxbrix theme block, site identity, and image assets', async () => {
    const root = await scaffold()
    await uploadAsset(root, { name: 'logo.png', data: PNG })
    const branding = await readBranding(root)
    expect(branding.editable).toBe(true)
    expect(branding.configFile).toBe('docs.json')
    expect(branding.site).toEqual({ name: 'Pulse', description: 'Documentation for Pulse.' })
    expect(branding.theme).toEqual({ primaryColor: '#6366f1', mode: 'system', font: 'Inter', headingFont: 'Inter', codeFont: 'ui-monospace' })
    expect(branding.assets).toEqual([{ path: 'assets/logo.png', name: 'logo.png', publicPath: '/assets/logo.png' }])
  })

  test('writes colours, fonts, mode, logo, and identity into docs.json and records history', async () => {
    const root = await scaffold()
    await uploadAsset(root, { name: 'logo.png', data: PNG })
    const before = await readBranding(root)
    const after = await writeBranding(root, {
      fingerprint: before.fingerprint,
      site: { name: 'Pulse Docs', description: 'Everything about Pulse.' },
      theme: { primaryColor: '#112233', darkColor: '#AABBCC', mode: 'dark', headingFont: null, codeFont: 'JetBrains Mono', logoLight: '/assets/logo.png', logoHref: 'https://pulse.example.com' },
    })
    expect(after.site).toEqual({ name: 'Pulse Docs', description: 'Everything about Pulse.' })
    expect(after.theme).toEqual({ primaryColor: '#112233', darkColor: '#aabbcc', mode: 'dark', font: 'Inter', codeFont: 'JetBrains Mono', logoLight: '/assets/logo.png', logoHref: 'https://pulse.example.com' })
    expect(after.fingerprint).not.toBe(before.fingerprint)
    const config = JSON.parse(await readFile(join(root, 'docs.json'), 'utf8')) as { name: string; theme: Record<string, string>; spaces: unknown[] }
    expect(config.name).toBe('Pulse Docs')
    expect(config.theme.headingFont).toBeUndefined()
    expect(config.spaces).toHaveLength(1)
    expect((await listRequests(root))[0]).toMatchObject({ kind: 'branding', status: 'completed' })
  })

  test('validates every field before touching disk', async () => {
    const root = await scaffold()
    const original = await readFile(join(root, 'docs.json'), 'utf8')
    const { fingerprint } = await readBranding(root)
    await expect(writeBranding(root, { fingerprint, theme: { primaryColor: 'blue' } })).rejects.toThrow('six-digit hex colour')
    await expect(writeBranding(root, { fingerprint, theme: { mode: 'sepia' } })).rejects.toThrow('light, dark, or system')
    await expect(writeBranding(root, { fingerprint, theme: { font: '<script>' } })).rejects.toThrow('font family name')
    await expect(writeBranding(root, { fingerprint, theme: { logoLight: 'http://example.com/logo.png' } })).rejects.toThrow('HTTPS address or a root-relative path')
    await expect(writeBranding(root, { fingerprint, theme: { logoLight: '/../secret.png' } })).rejects.toThrow('cannot leave')
    await expect(writeBranding(root, { fingerprint, theme: { favicon: '/assets/missing.png' } })).rejects.toThrow('missing "/assets/missing.png"')
    await expect(writeBranding(root, { fingerprint, theme: { accent: '#000000' } })).rejects.toThrow('not a branding field')
    await expect(writeBranding(root, { fingerprint: 'stale', theme: { primaryColor: '#000000' } })).rejects.toThrow('changed on disk')
    await expect(writeBranding(root, { fingerprint, site: { name: '   ' } })).rejects.toThrow('cannot be empty')
    expect(await readFile(join(root, 'docs.json'), 'utf8')).toBe(original)
  })

  test('names the theme configuration for generators Doxloop cannot edit', async () => {
    const root = await scaffold('mkdocs')
    const branding = await readBranding(root)
    expect(branding.editable).toBe(false)
    expect(branding.configFile).toBe('mkdocs.yml')
    expect(branding.reason).toContain('mkdocs.yml')
    await expect(writeBranding(root, { fingerprint: '', theme: { primaryColor: '#000000' } })).rejects.toThrow('mkdocs.yml')
  })
})
