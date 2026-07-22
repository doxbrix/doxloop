import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { resolvePublicAsset } from './generator-runtime.js'
import {
  GENERATOR_CATALOG,
  generatorCatalogEntry,
  generatorSkillName,
  loadGeneratorAdapter,
  parseGenerator,
} from './generators.js'
import { generatorPackageInvocation } from './generator-manager.js'

describe('generator packages', () => {
  test('resolves public assets without allowing directory traversal', () => {
    const root = resolve('/tmp', 'doxloop-generator-assets')

    expect(resolvePublicAsset(root, 'static', '/img/guide.png')).toBe(
      resolve(root, 'static', 'img', 'guide.png'),
    )
    expect(resolvePublicAsset(root, 'static', '../../private.txt')).toBeUndefined()
    expect(resolvePublicAsset(root, 'static', '/../../private.txt')).toBeUndefined()
  })

  test('parses every official generator and rejects unsupported names', () => {
    for (const entry of GENERATOR_CATALOG) {
      expect(parseGenerator(entry.id)).toBe(entry.id)
    }
    expect(() => parseGenerator('unknown')).toThrow('static')
  })

  test('loads versioned Docusaurus and MkDocs adapters', async () => {
    const docusaurus = await loadGeneratorAdapter(
      process.cwd(),
      'docusaurus',
    )
    const mkdocs = await loadGeneratorAdapter(process.cwd(), 'mkdocs')

    expect(docusaurus).toMatchObject({
      apiVersion: 1,
      packageName: '@doxbrix/doxloop-generator-docusaurus',
      build: { command: 'npm run build', outputDir: 'build' },
    })
    expect(mkdocs).toMatchObject({
      apiVersion: 1,
      packageName: '@doxbrix/doxloop-generator-mkdocs',
      build: { command: 'mkdocs build --strict', outputDir: 'site' },
    })
    expect(docusaurus.authoring.skillName).toBe('doxloop-docusaurus')
    expect(mkdocs.authoring.skillName).toBe('doxloop-mkdocs')
  })

  test('maps format skills and official packages without generator conditionals', () => {
    expect(generatorSkillName('mkdocs')).toBe('doxloop-mkdocs')
    expect(generatorCatalogEntry('docusaurus')?.packageName).toBe(
      '@doxbrix/doxloop-generator-docusaurus',
    )
  })

  test('reports an actionable error when a configured package is absent', async () => {
    await expect(
      loadGeneratorAdapter(
        process.cwd(),
        'mkdocs',
        '@example/missing-doxloop-generator',
      ),
    ).rejects.toThrow('npm install --save-dev @example/missing-doxloop-generator')
  })

  test('uses the selected package manager for add and remove', () => {
    expect(
      generatorPackageInvocation(
        'pnpm',
        'add',
        '@doxbrix/doxloop-generator-mkdocs',
      ).args,
    ).toEqual([
      'add',
      '--save-dev',
      '@doxbrix/doxloop-generator-mkdocs',
    ])
    expect(
      generatorPackageInvocation(
        'yarn',
        'remove',
        '@doxbrix/doxloop-generator-mkdocs',
      ).args,
    ).toEqual(['remove', '@doxbrix/doxloop-generator-mkdocs'])
    expect(
      generatorPackageInvocation(
        'npm',
        'add',
        '@doxbrix/doxloop-generator-docusaurus',
      ).args,
    ).toEqual([
      'install',
      '--save-dev',
      '@doxbrix/doxloop-generator-docusaurus',
    ])
  })
})
