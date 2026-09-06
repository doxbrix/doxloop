import { describe, expect, test } from 'vitest'
import { generatorPreflight } from './generator-preflight.js'
import { GENERATOR_CATALOG, GENERATOR_TIERS } from './generators.js'

const nothingInstalled = {
  findExecutable: async () => undefined,
  runVersion: async () => undefined,
  nodeVersion: '22.20.0',
}

describe('generator pre-flight', () => {
  test('every catalog entry carries a tier and a labelled toolchain', () => {
    for (const entry of GENERATOR_CATALOG) {
      expect(Object.keys(GENERATOR_TIERS)).toContain(entry.tier)
      expect(Array.isArray(entry.toolchain)).toBe(true)
    }
    expect(GENERATOR_CATALOG.filter((entry) => entry.tier === 'full').map((entry) => entry.id)).toEqual(['doxbrix', 'docusaurus', 'mkdocs'])
    expect(GENERATOR_CATALOG.filter((entry) => entry.tier === 'supported').map((entry) => entry.id).sort()).toEqual(['hugo', 'sphinx', 'starlight', 'vitepress'])
    expect(GENERATOR_CATALOG.filter((entry) => entry.tier === 'basic').map((entry) => entry.id).sort()).toEqual(['jekyll', 'markdoc', 'nextra', 'static'])
  })

  test('Doxbrix needs no toolchain', async () => {
    const result = await generatorPreflight('doxbrix', nothingInstalled)
    expect(result).toMatchObject({ tier: 'full', ready: true })
    expect(result.checks).toHaveLength(1)
  })

  test('Node generators fail without a package manager and pass with one', async () => {
    const missing = await generatorPreflight('vitepress', nothingInstalled)
    expect(missing.ready).toBe(false)
    expect(missing.checks.map((check) => check.status)).toEqual(['pass', 'fail'])

    const present = await generatorPreflight('vitepress', {
      ...nothingInstalled,
      findExecutable: async (name) => (name === 'pnpm' ? '/usr/bin/pnpm' : undefined),
    })
    expect(present.ready).toBe(true)
    expect(present.checks[1]?.label).toBe('Package manager: pnpm')
  })

  test('Python generators check the interpreter version and venv support', async () => {
    const old = await generatorPreflight('mkdocs', {
      ...nothingInstalled,
      findExecutable: async (name) => (name === 'python3' ? '/usr/bin/python3' : undefined),
      runVersion: async (_command, args) => (args[0] === '--version' ? 'Python 3.8.10' : 'ok'),
    })
    expect(old.ready).toBe(false)
    expect(old.checks[0]).toMatchObject({ status: 'fail', label: 'Python 3.8.10 is too old' })

    const current = await generatorPreflight('sphinx', {
      ...nothingInstalled,
      findExecutable: async (name) => (name === 'python3' ? '/usr/bin/python3' : undefined),
      runVersion: async (_command, args) => (args[0] === '--version' ? 'Python 3.12.4' : 'ModuleNotFoundError'),
    })
    expect(current.ready).toBe(true)
    expect(current.checks.map((check) => check.status)).toEqual(['pass', 'warning'])
  })

  test('Hugo and Jekyll report the missing binary with an install hint', async () => {
    const hugo = await generatorPreflight('hugo', nothingInstalled)
    expect(hugo.ready).toBe(false)
    expect(hugo.checks[0]?.detail).toContain('gohugo.io')

    const jekyll = await generatorPreflight('jekyll', {
      ...nothingInstalled,
      findExecutable: async (name) => (name === 'ruby' ? '/usr/bin/ruby' : undefined),
      runVersion: async () => 'ruby 3.3.0',
    })
    expect(jekyll.ready).toBe(false)
    expect(jekyll.checks.map((check) => check.status)).toEqual(['pass', 'fail'])
  })

  test('Hugo extended edition is recognised', async () => {
    const result = await generatorPreflight('hugo', {
      ...nothingInstalled,
      findExecutable: async () => '/usr/local/bin/hugo',
      runVersion: async () => 'hugo v0.147.0+extended darwin/arm64',
    })
    expect(result.ready).toBe(true)
    expect(result.checks).toEqual([{ status: 'pass', label: 'Hugo v0.147.0 (extended)' }])
  })
})
