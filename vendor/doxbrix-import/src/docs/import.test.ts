import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { collectSourceAssets, collectSourceFiles, writeConvertResult } from './import.js'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('source asset collection', () => {
  it('copies documentation resources but excludes source-platform tooling', () => {
    const root = mkdtempSync(join(tmpdir(), 'doxbrix-assets-'))
    temporaryDirectories.push(root)
    mkdirSync(join(root, 'images'), { recursive: true })
    mkdirSync(join(root, '.github', 'workflows'), { recursive: true })
    writeFileSync(join(root, 'images', 'diagram.png'), 'image')
    writeFileSync(join(root, 'openapi.json'), '{}')
    writeFileSync(join(root, 'package.json'), '{}')
    writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9')
    writeFileSync(join(root, 'style.css'), '.vendor-shell{}')
    writeFileSync(join(root, '.github', 'workflows', 'docs.yaml'), 'name: docs')

    expect(collectSourceAssets(root).sort()).toEqual(['images/diagram.png', 'openapi.json'])
  })

  it('collects only code modules explicitly imported by documentation', () => {
    const root = mkdtempSync(join(tmpdir(), 'doxbrix-import-sources-'))
    temporaryDirectories.push(root)
    mkdirSync(join(root, 'snippets', 'icons'), { recursive: true })
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'docs.json'), '{"navigation":{"pages":["intro"]}}')
    writeFileSync(
      join(root, 'intro.mdx'),
      'import { IconChain } from "/snippets/icons/icon-chain.jsx";\n<Card icon={<IconChain />}>Chain</Card>',
    )
    writeFileSync(
      join(root, 'snippets', 'icons', 'icon-chain.jsx'),
      'import { size } from "./size.ts";\nexport const IconChain = () => <svg width={size} />;',
    )
    writeFileSync(join(root, 'snippets', 'icons', 'size.ts'), 'export const size = 24;')
    writeFileSync(join(root, 'src', 'private.ts'), 'export const internal = true;')
    writeFileSync(join(root, 'style.css'), '[data-component-part="card-icon"] svg path { fill: currentColor; }')

    expect(collectSourceFiles(root).map((file) => file.path).sort()).toEqual([
      'docs.json',
      'intro.mdx',
      'snippets/icons/icon-chain.jsx',
      'snippets/icons/size.ts',
      'style.css',
    ])
  })
})

describe('converted output', () => {
  it('removes only obsolete starter pages from an initialized destination', () => {
    const root = mkdtempSync(join(tmpdir(), 'doxbrix-import-output-'))
    temporaryDirectories.push(root)
    mkdirSync(join(root, 'guides'), { recursive: true })
    writeFileSync(join(root, 'introduction.mdx'), '# Introduction\n\nWelcome to **Example Documentation**.\n')
    writeFileSync(join(root, 'guides', 'quickstart.mdx'), '# Quickstart\n\n<!-- doxbrix:starter-page -->\n')
    writeFileSync(join(root, 'keep.mdx'), '# Keep\n\nUser-authored content.\n')

    writeConvertResult(root, {
      manifest: { version: 1, spaces: [{ name: 'Imported', nav: [{ type: 'page', file: 'overview' }] }] },
      pages: [{ path: 'overview.mdx', markdown: '---\ntitle: Overview\n---\n\nImported content.\n' }],
    })

    expect(existsSync(join(root, 'introduction.mdx'))).toBe(false)
    expect(existsSync(join(root, 'guides', 'quickstart.mdx'))).toBe(false)
    expect(existsSync(join(root, 'keep.mdx'))).toBe(true)
    expect(existsSync(join(root, 'overview.mdx'))).toBe(true)
  })
})
