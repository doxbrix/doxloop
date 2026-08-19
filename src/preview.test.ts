import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  doxbrixDocument,
  previewErrorPage,
} from './preview.js'
import {
  docusaurusInstallInvocation,
  docusaurusPreviewInvocation,
} from '@doxbrix/doxloop-generator-docusaurus'
import { mkdocsPreviewInvocation } from '@doxbrix/doxloop-generator-mkdocs'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('generator preview', () => {
  test('installs Docusaurus dependencies with the package manager the lockfile selects', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doxloop-preview-'))
    roots.push(root)

    expect((await docusaurusInstallInvocation(root)).command).toMatch(/^npm/)
    await writeFile(join(root, 'yarn.lock'), '', 'utf8')
    expect((await docusaurusInstallInvocation(root)).command).toMatch(/^yarn/)
    await writeFile(join(root, 'pnpm-lock.yaml'), '', 'utf8')
    expect((await docusaurusInstallInvocation(root)).command).toMatch(/^pnpm/)
    expect((await docusaurusInstallInvocation(root)).args).toEqual(['install'])
  })

  test('uses the local Docusaurus development server and forwards options', () => {
    const invocation = docusaurusPreviewInvocation({
      root: '/tmp/example-docs',
      host: '0.0.0.0',
      port: 4567,
      open: false,
    })

    expect(invocation.command).toContain('node_modules')
    expect(invocation.command).toContain('.bin')
    expect(invocation.args).toEqual([
      'start',
      '--host',
      '0.0.0.0',
      '--port',
      '4567',
      '--no-open',
    ])
  })

  test('allows Docusaurus to open the browser when requested', () => {
    const invocation = docusaurusPreviewInvocation({
      root: '/tmp/example-docs',
      host: '127.0.0.1',
      port: 4321,
      open: true,
    })

    expect(invocation.args).not.toContain('--no-open')
  })

  test('uses the isolated MkDocs virtual environment and forwards the address', () => {
    const invocation = mkdocsPreviewInvocation({
      root: '/tmp/example-docs',
      host: '0.0.0.0',
      port: 8123,
      open: false,
    })

    expect(invocation.command).toContain('.doxloop')
    expect(invocation.command).toContain('venv')
    expect(invocation.args).toEqual([
      'serve',
      '--dev-addr',
      '0.0.0.0:8123',
    ])
  })

  test('applies Doxbrix brand colors, fonts, logos, and local font sources', () => {
    const html = doxbrixDocument({
      site: {
        version: 1,
        name: 'Branded docs',
        spaces: [
          {
            name: 'Docs',
            nav: [{ type: 'page', file: 'index', title: 'Overview' }],
          },
        ],
        theme: {
          primaryColor: '#123456',
          lightColor: '#234567',
          darkColor: '#abcdef',
          mode: 'dark',
          font: 'Brand Sans',
          headingFont: 'Brand Display',
          codeFont: 'Brand Mono',
          logoLight: '/assets/logo-light.svg',
          logoDark: '/assets/logo-dark.svg',
          favicon: '/assets/favicon.svg',
          backgroundColorLight: '#fafafa',
          backgroundColorDark: '#101010',
          fontSources: [
            {
              family: 'Brand Sans',
              source: '/fonts/brand-sans.woff2',
              format: 'woff2',
              weight: 400,
            },
          ],
        },
      },
      title: 'Overview',
      current: 'index',
      rendered: { html: '<p>Content</p>', toc: [] },
    })

    expect(html).toContain('--project-primary:#123456')
    expect(html).toContain('--dxb-primary-light:#234567')
    expect(html).toContain("--project-font-family:'Brand Sans'")
    expect(html).toContain("@font-face{font-family:'Brand Sans'")
    expect(html).toContain('src="/assets/logo-light.svg"')
    expect(html).toContain('src="/assets/logo-dark.svg"')
    expect(html).toContain('rel="icon" href="/assets/favicon.svg"')
    expect(html).toContain('data-color-theme="dark"')
  })

  test('uses the Atlas shell by default, hides a lone space tab, and renders navigation icons', () => {
    const html = doxbrixDocument({
      site: {
        version: 1,
        name: 'Atlas docs',
        spaces: [
          {
            name: 'Internal',
            icon: 'key',
            nav: [
              {
                type: 'page',
                file: 'internal',
                title: 'Internal',
                hidden: true,
              },
            ],
          },
          {
            name: 'Documentation',
            icon: 'book',
            tag: 'NEW',
            nav: [
              {
                type: 'group',
                label: 'Get started',
                icon: 'rocket',
                items: [
                  {
                    type: 'page',
                    file: 'index',
                    title: 'Overview',
                    icon: 'compass',
                  },
                  {
                    type: 'link',
                    title: 'Status',
                    href: 'https://status.example.com',
                    icon: '🌐',
                  },
                  {
                    type: 'api',
                    title: 'HTTP API',
                    spec: 'openapi.yaml',
                    icon: '/assets/api.svg',
                  },
                  {
                    type: 'link',
                    title: 'Unsafe link',
                    href: 'javascript:alert(1)',
                  },
                ],
              },
            ],
          },
        ],
        theme: { mode: 'light' },
      },
      title: 'Overview',
      description: 'Start building with Atlas.',
      current: 'index',
      rendered: {
        html: '<h2 class="dp-h2" id="next">Next steps</h2>',
        toc: [{ id: 'next', level: 2, title: 'Next steps' }],
      },
    })

    expect(html).toContain('data-shell-theme="atlas"')
    expect(html).toContain('data-code-theme="auto"')
    expect(html).toContain('class="dxb-atlas-header"')
    expect(html).toContain('class="dp-topnav-logo" href="/index"')
    expect(html).not.toContain('class="dxb-atlas-tabs-bar"')
    expect(html).not.toContain('class="dxb-atlas-tab active"')
    expect(html).toContain('--dxb-tabs-height:0px')
    expect(html).not.toContain('>Internal</span>')
    expect(html).not.toContain('class="dxb-atlas-tab-tag">NEW</span>')
    expect(html).toContain('class="dxb-atlas-title-row"')
    expect(html).toContain('data-preview-search')
    expect(html).toContain('data-preview-search-dialog')
    expect(html).toContain("fetch('/__doxloop/search-index')")
    expect(html).toContain("event.metaKey || event.ctrlKey")
    expect(html).toContain("event.key === 'ArrowDown'")
    expect(html).toContain('async function sendApiTryRequest')
    expect(html).toContain('modal.hidden = false')
    expect(html).toContain("allows requests from ' + location.origin + ' (CORS)")
    expect(html).toContain('data-preview-assistant')
    expect(html).toContain('class="dxb-atlas-assistant-wrap"')
    expect(html).toContain('Ask Assistant isn’t available in preview.')
    expect(html).toContain('<code>doxloop deploy</code>')
    expect(html).toContain('deployment is free')
    expect(html).toContain("addEventListener('scroll', scheduleTocUpdate")
    expect(html).toContain("addEventListener('pagehide', closePreviewEvents")
    expect(html).toContain("target.origin === location.origin")
    expect(html).toContain('closePreviewEvents();')
    expect(html).toContain("link.setAttribute('aria-current', 'location')")
    expect(html).toContain('class="dxb-atlas-eyebrow">Get started</div>')
    expect(html).toContain('class="dxb-atlas-description">Start building with Atlas.</p>')
    expect(html).not.toContain('class="dp-breadcrumb"')
    expect(html).toContain('--dxb-shell-max-width:1400px')
    expect(html).toContain('--dxb-sidebar-width:256px')
    expect(html).toContain('--dxb-content-max-width:800px')
    expect(html).toContain('--dxb-toc-width:248px')
    expect(html).toContain('--dxb-content-padding:4px')
    expect(html).toContain('--dxb-nav-padding:24px')
    expect(html).toContain('class="dp-nav-root-block active-branch"')
    expect(html).toContain(
      'family=Inter:ital,wght@0,100..900;1,100..900',
    )
    expect(html).toContain('class="dp-nav-item active dp-nav-d1"')
    expect(html).toContain('class="dp-nav-item-icon dxb-atlas-nav-icon"')
    expect(html).toContain('🌐')
    expect(html).toContain('<img src="/assets/api.svg" alt="" width="15" height="15">')
    expect(html).toContain(
      'href="/openapi.yaml" target="_blank" rel="noreferrer"',
    )
    expect(html).toContain('href="#"><span class="dp-nav-item-label">Unsafe link</span>')
    expect(html).not.toContain('javascript:')
  })

  test('renders the Atlas tabs row when multiple spaces are visible', () => {
    const html = doxbrixDocument({
      site: {
        version: 1,
        name: 'Atlas docs',
        spaces: [
          { name: 'Guides', nav: [{ type: 'page', file: 'index' }] },
          { name: 'API', nav: [{ type: 'page', file: 'api' }] },
        ],
        theme: { mode: 'light' },
      },
      title: 'Overview',
      current: 'index',
      rendered: { html: '<p>Welcome</p>', toc: [] },
    })

    expect(html).toContain('class="dxb-atlas-tabs-bar"')
    expect(html).toContain('class="dxb-atlas-tab active"')
    expect(html).toContain('--dxb-tabs-height:48px')
  })

  test('bundles the standalone Atlas reader stylesheet', async () => {
    const css = await readFile(
      new URL('../assets/doxbrix-preview.css', import.meta.url),
      'utf8',
    )

    expect(css).toContain(".dp-root--published[data-shell-theme='atlas']")
    expect(css).toContain('.dxb-atlas-header')
    expect(css).toContain(
      "grid-template-columns: var(--dxb-sidebar-width, 256px) minmax(0, 1fr) var(--dxb-toc-width, 248px)",
    )
    expect(css).toContain(
      'padding: 28px var(--dxb-nav-padding, 24px) 80px',
    )
    expect(css).toContain('padding: 40px 0 72px')
    expect(css).toContain('padding: 40px var(--dxb-content-padding, 4px) 96px')
    expect(css).toContain('background-color: var(--dxb-background-light, #fff)')
    expect(css).toContain('.dxb-atlas-nav-icon img')
    expect(css).toContain('object-fit: contain')
    expect(css).toContain('.tryit-overlay[hidden]')
    expect(css).toContain('padding: 7px 12px 7px 0')
    expect(css).toContain(
      "[data-shell-theme='atlas'] .dp-nav-item:hover {",
    )
    expect(css).toContain('width: calc(100% + 12px)')
    expect(css).toContain('margin-left: -12px')
    expect(css).toContain('padding-left: 12px')
    expect(css).toContain('-webkit-font-smoothing: antialiased')
    expect(css).toContain('font-size: 36px')
    expect(css).toContain('font-weight: 600')
    expect(css).toContain('font-size: 18px')
    expect(css).toContain('letter-spacing: -0.0125rem')
    expect(css).toContain('background: var(--dp-surface-soft)')
    expect(css).toContain('color: var(--dp-page-text)')
    expect(css).toContain(
      "[data-shell-theme='atlas'] .dp-leftnav:hover .dp-nav-tree::-webkit-scrollbar-thumb",
    )
    expect(css).not.toContain(
      "[data-shell-theme='atlas'] .dp-nav-tree::-webkit-scrollbar { display: none; }",
    )
    expect(css).not.toContain("data-imported-source='mintlify'")
    expect(css).not.toContain('.dxb-mint-')
  })

  test('shows actionable content failures without exposing a raw runtime error', () => {
    const html = previewErrorPage(
      new TypeError(
        "docs/docs.json: Cannot read properties of undefined (reading 'replaceAll')",
      ),
    )

    expect(html).toContain('This page could not be rendered')
    expect(html).toContain('<code>docs/docs.json</code>')
    expect(html).toContain('A required content value is missing or has the wrong type.')
    expect(html).toContain('<code>doxloop test</code>')
    expect(html).toContain("new EventSource('/__doxloop/events')")
    expect(html).not.toContain('replaceAll')
  })
})
