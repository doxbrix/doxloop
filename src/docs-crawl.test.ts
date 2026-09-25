import { describe, expect, test } from 'vitest'
import { crawlDocumentationSite, docsSiteScope } from './docs-crawl.js'

type Route = { status?: number; type?: string; body?: string; location?: string }

function site(routes: Record<string, Route>): { fetch: typeof globalThis.fetch; requests: string[] } {
  const requests: string[] = []
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    requests.push(url)
    if (init?.signal?.aborted) throw new Error('aborted')
    const pathname = new URL(url).pathname
    const route = routes[pathname]
    if (!route) return new Response('missing', { status: 404, headers: { 'content-type': 'text/html' } })
    if (route.location) return new Response('', { status: route.status ?? 301, headers: { location: route.location } })
    return new Response(route.body ?? '', { status: route.status ?? 200, headers: { 'content-type': route.type ?? 'text/html; charset=utf-8' } })
  }) as typeof globalThis.fetch
  return { fetch, requests }
}

const html = (title: string, body: string) => `<html><head><title>${title}</title><meta name="generator" content="Docusaurus v3"></head><body><nav><a href="/docs/">Docs</a></nav><main>${body}</main></body></html>`
const publicHost = async () => ['93.184.216.34']

describe('documentation site crawler', () => {
  test('normalizes the entry URL into a same-host path scope', () => {
    expect(docsSiteScope('https://example.com/docs/intro.html#top')).toEqual({ origin: 'https://example.com', scope: '/docs/', entry: 'https://example.com/docs/intro.html' })
    expect(docsSiteScope('https://example.com')).toEqual({ origin: 'https://example.com', scope: '/', entry: 'https://example.com/' })
    expect(() => docsSiteScope('ftp://example.com')).toThrow('HTTP or HTTPS')
    expect(() => docsSiteScope('https://user:pw@example.com/docs')).toThrow('embedded credentials')
  })

  test('discovers pages through the sitemap and links, stays in scope, and records broken links', async () => {
    const { fetch, requests } = site({
      '/robots.txt': { type: 'text/plain', body: 'User-agent: *\nDisallow: /docs/private/\nSitemap: https://example.com/sitemap.xml\n' },
      '/sitemap.xml': { type: 'application/xml', body: '<urlset><url><loc>https://example.com/docs/</loc></url><url><loc>https://example.com/docs/guide/install</loc></url><url><loc>https://example.com/blog/post</loc></url></urlset>' },
      '/docs': { body: html('Docs home | Site', '<h1>Welcome</h1><p>Start with <a href="/docs/guide/install">install</a> or the <a href="/docs/guide/missing">missing page</a>. Private: <a href="/docs/private/secret">secret</a>. External: <a href="https://other.example/">other</a>.</p><img src="/img/a.png" alt="a">') },
      '/docs/guide/install': { body: html('Install | Site', '<h1>Install</h1><p>Run <code>make</code>. Back to <a href="/docs/">home</a>. Also <a href="/docs/guide/config/">config</a>.</p>') },
      '/docs/guide/config': { body: html('Config | Site', '<h1>Config</h1><p>Set <code>PORT</code>.</p>') },
      '/docs/private/secret': { body: html('Secret', '<p>hidden</p>') },
      '/blog/post': { body: html('Blog', '<p>blog</p>') },
      '/docs/guide/missing': { status: 404 },
    })
    const snapshot = await crawlDocumentationSite('https://example.com/docs/', { fetch, resolveHostname: publicHost, concurrency: 1 })
    expect(snapshot.origin).toBe('https://example.com')
    expect(snapshot.scope).toBe('/docs/')
    expect(snapshot.generator).toBe('docusaurus')
    expect(snapshot.discovery).toEqual(['sitemap', 'links'])
    expect(snapshot.pages.map((page) => page.path)).toEqual(['', 'guide/config', 'guide/install'])
    expect(snapshot.pages[0]).toMatchObject({ title: 'Docs home', url: 'https://example.com/docs', words: expect.any(Number) })
    expect(snapshot.pages[0]!.externalLinks).toEqual(['https://other.example/'])
    expect(snapshot.pages[0]!.images).toEqual(['https://example.com/img/a.png'])
    expect(snapshot.brokenLinks).toEqual([{ url: 'https://example.com/docs/guide/missing', from: 'https://example.com/docs', status: 404 }])
    expect(requests).not.toContain('https://example.com/docs/private/secret')
    expect(requests).not.toContain('https://example.com/blog/post')
    expect(snapshot.truncated).toBe(false)
    expect(snapshot.totals).toEqual({ pages: 3, words: expect.any(Number), images: 1, discovered: 4 })
  })

  test('reads client-rendered sites (Mintlify) from their Markdown sources', async () => {
    const shell = '<html><head><title>Hoppscotch</title><meta name="generator" content="Mintlify"></head><body><div id="root"></div></body></html>'
    const markdown = (title: string, body: string) => `> ## Documentation Index\n> Fetch the complete documentation index at: https://docs.example.com/llms.txt\n\n# ${title}\n\n> ${title} in one line.\n\n${body}\n`
    const { fetch } = site({
      '/llms.txt': { type: 'text/plain', body: '# Docs\n- [CLI](https://docs.example.com/cli/overview.md)\n- [Home](https://docs.example.com/index.md)\n' },
      '/': { body: shell },
      '/index.md': { type: 'text/markdown; charset=utf-8', body: markdown('Welcome', 'Hoppscotch is an open source API development ecosystem that helps you create and test requests quickly, share collections with your team, and automate checks in CI. Read the [CLI guide](/cli/overview) to begin.') },
      '/cli/overview': { body: shell },
      '/cli/overview.md': { type: 'text/markdown; charset=utf-8', body: markdown('Hoppscotch CLI', 'Install the CLI with npm and run a collection against an environment from your terminal or a CI pipeline.\n\n```bash\nnpm i -g @hoppscotch/cli\n```\n\n![Run](/img/run.png)') },
    })
    const snapshot = await crawlDocumentationSite('https://docs.example.com/', { fetch, resolveHostname: publicHost, concurrency: 1 })
    const byPath = Object.fromEntries(snapshot.pages.map((page) => [page.path, page]))
    expect(Object.keys(byPath).sort()).toEqual(['', 'cli/overview'])
    expect(byPath['cli/overview']).toMatchObject({ title: 'Hoppscotch CLI', description: 'Hoppscotch CLI in one line.' })
    expect(byPath['cli/overview']!.words).toBeGreaterThan(15)
    expect(byPath['cli/overview']!.markdown).not.toContain('Documentation Index')
    expect(byPath['']!.words).toBeGreaterThan(30)
    expect(snapshot.skipped).toEqual([])
  })

  test('uses llms.txt when there is no sitemap and stops at the page limit', async () => {
    const routes: Record<string, Route> = {
      '/llms.txt': { type: 'text/plain', body: '# Site\n\n- [One](https://example.com/one)\n- [Two](/two)\n- [Three](/three)\n' },
    }
    for (const name of ['one', 'two', 'three']) routes[`/${name}`] = { body: html(name, `<h1>${name}</h1><p>${name} body</p>`) }
    routes['/'] = { body: html('Home', '<h1>Home</h1>') }
    const { fetch } = site(routes)
    const snapshot = await crawlDocumentationSite('https://example.com/', { fetch, resolveHostname: publicHost, pageLimit: 2, concurrency: 1 })
    expect(snapshot.discovery).toContain('llms-txt')
    expect(snapshot.pages).toHaveLength(2)
    expect(snapshot.truncated).toBe(true)
    expect(snapshot.warnings[0]).toMatch(/2-page limit/)
  })

  test('keeps a page whose links include mailto, javascript, and anchor hrefs', async () => {
    const { fetch } = site({
      '/docs': { body: html('Docs', '<h1>Docs</h1><p><a href="mailto:hi@example.com">mail</a> <a href="javascript:void(0)">js</a> <a href="#top">top</a> <a href="/docs/next">next</a></p>') },
      '/docs/next': { body: html('Next', '<h1>Next</h1>') },
    })
    const snapshot = await crawlDocumentationSite('https://example.com/docs', { fetch, resolveHostname: publicHost, concurrency: 1 })
    expect(snapshot.pages.map((page) => page.path)).toEqual(['', 'next'])
    expect(snapshot.pages[0]!.internalLinks).toContain('https://example.com/docs/next')
  })

  test('keeps parallel workers alive while linked pages are still loading', async () => {
    const routes: Record<string, Route> = { '/docs': { body: html('Docs', '<h1>Docs</h1><a href="/docs/a">a</a>') } }
    // A chain: each page links only to the next, so link-only discovery never has more than one URL queued.
    for (let index = 0; index < 6; index += 1) routes[`/docs/${String.fromCharCode(97 + index)}`] = { body: html(`Page ${index}`, `<h1>Page ${index}</h1><a href="/docs/${String.fromCharCode(98 + index)}">next</a>`) }
    const { fetch } = site(routes)
    const snapshot = await crawlDocumentationSite('https://example.com/docs', { fetch, resolveHostname: publicHost, concurrency: 4 })
    expect(snapshot.pages).toHaveLength(7)
    expect(snapshot.discovery).toEqual(['links'])
  })

  test('follows redirects inside the scope and skips non-HTML responses', async () => {
    const { fetch } = site({
      '/docs': { body: html('Docs', '<h1>Docs</h1><a href="/docs/old">old</a><a href="/docs/spec.json">spec</a><a href="/docs/pdf">pdf</a>') },
      '/docs/old': { location: 'https://example.com/docs/new' },
      '/docs/new': { body: html('New', '<h1>New</h1>') },
      '/docs/pdf': { type: 'application/pdf', body: '%PDF' },
    })
    const snapshot = await crawlDocumentationSite('https://example.com/docs', { fetch, resolveHostname: publicHost, concurrency: 1 })
    expect(snapshot.pages.map((page) => page.url)).toEqual(['https://example.com/docs', 'https://example.com/docs/new'])
    expect(snapshot.skipped).toEqual([{ url: 'https://example.com/docs/pdf', reason: 'Unsupported content type application/pdf' }])
  })

  test('refuses private hosts and fails when no page can be read', async () => {
    await expect(crawlDocumentationSite('http://localhost:3000/docs', { fetch: site({}).fetch })).rejects.toThrow('private networks')
    await expect(crawlDocumentationSite('https://example.com/docs', { fetch: site({}).fetch, resolveHostname: async () => ['10.0.0.4'] })).rejects.toThrow('private networks')
    await expect(crawlDocumentationSite('https://example.com/docs', { fetch: site({}).fetch, resolveHostname: publicHost })).rejects.toThrow('No documentation pages could be read')
  })

  test('sends the recorded session cookie only to the crawled host', async () => {
    const headers: string[] = []
    const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      headers.push(String(new Headers(init?.headers).get('cookie')))
      return new Response(html('Docs', '<h1>Docs</h1>'), { status: 200, headers: { 'content-type': 'text/html' } })
    }) as typeof globalThis.fetch
    await crawlDocumentationSite('https://example.com/docs', { fetch, resolveHostname: publicHost, cookieHeader: 'session=abc', concurrency: 1 })
    expect(headers.every((value) => value === 'session=abc')).toBe(true)
  })
})
