import { describe, expect, test } from 'vitest'
import { decodeEntities, parseHtml, summarizeHtmlDocument } from './html-markdown.js'

const page = `<!doctype html><html lang="en"><head><title>Install &amp; run | Memos</title>
<meta name="generator" content="Docusaurus v3.1"><meta name="description" content="How to install.">
<link rel="canonical" href="https://docs.example.com/install"></head>
<body><nav class="navbar"><a href="/">Home</a><a href="/api">API</a></nav>
<aside class="sidebar"><ul><li><a href="/install">Install</a></li></ul></aside>
<main><article class="theme-doc-markdown"><h1>Install &amp; run</h1>
<p>Use <code>docker run</code> to start <strong>Memos</strong>. See <a href="/config">config</a>.</p>
<pre><code class="language-bash">docker run -d \\
  -p 5230:5230 neosmemo/memos</code></pre>
<h2>Options</h2><ul><li>First <em>item</em><ul><li>Nested</li></ul></li><li>Second</li></ul>
<table><thead><tr><th>Flag</th><th>Meaning</th></tr></thead><tbody><tr><td><code>--port</code></td><td>Port | number</td></tr></tbody></table>
<img src="/img/shot.png" alt="Screenshot"><blockquote><p>Note this.</p></blockquote>
<script>var x = "<p>not content</p>"</script><div style="display:none">hidden text</div></article></main>
<footer>© 2026</footer></body></html>`

describe('HTML to Markdown', () => {
  test('keeps the main content and drops navigation chrome, scripts, and hidden elements', () => {
    const summary = summarizeHtmlDocument(page)
    expect(summary.title).toBe('Install & run | Memos')
    expect(summary.generator).toBe('Docusaurus v3.1')
    expect(summary.description).toBe('How to install.')
    expect(summary.canonical).toBe('https://docs.example.com/install')
    expect(summary.language).toBe('en')
    expect(summary.markdown).toContain('# Install & run')
    expect(summary.markdown).toContain('Use `docker run` to start **Memos**. See [config](/config).')
    expect(summary.markdown).toContain('```bash\ndocker run -d \\\n  -p 5230:5230 neosmemo/memos\n```')
    expect(summary.markdown).toContain('- First *item*\n  - Nested\n- Second')
    expect(summary.markdown).toContain('| Flag | Meaning |\n| --- | --- |\n| `--port` | Port \\| number |')
    expect(summary.markdown).toContain('![Screenshot](/img/shot.png)')
    expect(summary.markdown).toContain('> Note this.')
    expect(summary.markdown).not.toContain('not content')
    expect(summary.markdown).not.toContain('hidden text')
    expect(summary.markdown).not.toContain('Home')
    expect(summary.markdown).not.toContain('© 2026')
    expect(summary.headings).toEqual([{ level: 1, text: 'Install & run' }, { level: 2, text: 'Options' }])
    expect(summary.images).toEqual(['/img/shot.png'])
  })

  test('collects links from the whole body so navigation still feeds discovery', () => {
    const summary = summarizeHtmlDocument(page)
    expect(summary.links).toEqual(['/', '/api', '/install', '/config'])
  })

  test('falls back to the body when no main landmark exists', () => {
    const summary = summarizeHtmlDocument('<html><body><h1>Plain</h1><p>Text here.</p></body></html>')
    expect(summary.markdown).toBe('# Plain\n\nText here.')
    expect(summary.words).toBe(3)
  })

  test('tolerates unclosed tags, attributes without quotes, and raw text elements', () => {
    const root = parseHtml('<div class=box><p>one<p>two<ul><li>a<li>b</ul><style>p{}</style>')
    const div = root.children[0]!
    expect(div.name).toBe('div')
    expect(div.attributes.class).toBe('box')
    const names = div.children.map((child) => child.name)
    expect(names).toEqual(['p', 'p', 'ul', 'style'])
    expect(div.children[2]!.children.map((child) => child.name)).toEqual(['li', 'li'])
  })

  test('decodes named, decimal, and hexadecimal entities', () => {
    expect(decodeEntities('a &amp; b &lt;c&gt; &#169; &#x1F600; &nbsp;x &unknown;')).toBe('a & b <c> © 😀  x &unknown;')
  })
})
