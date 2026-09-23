/** Literal links in Markdown/MDX, HTML and reStructuredText. Never execute components. */
export function contentLinks(raw: string): string[] {
  const text = raw.replace(/```[^\n]*\n[\s\S]*?```|~~~[^\n]*\n[\s\S]*?~~~/g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/<(?:script|style)\b[^>]*>[\s\S]*?<\/(?:script|style)>/gi, '')
  // Inline code is literal text: `[a-z]([a-z0-9-]{0,34}[a-z0-9])` is a
  // pattern, not a link. The reStructuredText forms below are written with
  // backticks themselves, so they read the unmasked text.
  const markdown = text.replace(/(`+)(?:(?!\1)[^\n])+?\1/g, '')
  const links = new Set<string>()
  const markdownPatterns = [
    /!?\[[^\]]*\]\(<?([^\s)>]+)>?(?:\s+["'][^"']*["'])?\)/g,
    /^\s{0,3}\[[^\]]+\]:\s*<?([^\s>]+)>?/gm,
    /\b(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"'=]+))/gi,
    /<(https?:\/\/[^>\s]+)>/gi,
  ]
  const restructuredPatterns = [
    /`[^`<>]*<([^<>]+)>`_?_/g,
    /^\s*\.\.\s+_[^:]+:\s+(\S+)/gm,
    /^\s*\.\.\s+(?:image|figure)::\s+(\S+)/gm,
    /:doc:`(?:[^`<>]*<)?([^`<>]+)>?`/g,
  ]
  const collect = (source: string, patterns: RegExp[]): void => {
    for (const pattern of patterns) for (const match of source.matchAll(pattern)) {
      const value = (match[1] ?? match[2] ?? match[3])?.trim().replace(/&amp;/g, '&')
      if (value && looksLikeLinkTarget(value)) links.add(value)
    }
  }
  collect(markdown, markdownPatterns)
  collect(text, restructuredPatterns)
  return [...links]
}

/**
 * A link target is a URL or a path. Text that only looks like `[x](y)`
 * because it is a regular expression, a JSX expression, or a template —
 * `[a-z]([a-z0-9-]{0,34})`, `{props.href}`, `${base}/x` — is not one, and
 * reporting it as a broken link sent a real run's page to a fix session.
 */
export function looksLikeLinkTarget(value: string): boolean {
  if (value.startsWith('{')) return false
  if (/\s/.test(value)) return false
  // Brackets, braces, pipes, backslashes, carets and backticks never appear
  // unescaped in a URL a writer means as a link; they are regex or template
  // syntax.
  return !/[[\]{}|\\^`]/.test(value)
}
