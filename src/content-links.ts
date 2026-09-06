/** Literal links in Markdown/MDX, HTML and reStructuredText. Never execute components. */
export function contentLinks(raw: string): string[] {
  const text = raw.replace(/```[^\n]*\n[\s\S]*?```|~~~[^\n]*\n[\s\S]*?~~~/g, '').replace(/<!--[\s\S]*?-->/g, '').replace(/<(?:script|style)\b[^>]*>[\s\S]*?<\/(?:script|style)>/gi, '')
  const links = new Set<string>()
  const patterns = [
    /!?\[[^\]]*\]\(<?([^\s)>]+)>?(?:\s+["'][^"']*["'])?\)/g,
    /^\s{0,3}\[[^\]]+\]:\s*<?([^\s>]+)>?/gm,
    /\b(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"'=]+))/gi,
    /<(https?:\/\/[^>\s]+)>/gi,
    /`[^`<>]*<([^<>]+)>`_?_/g,
    /^\s*\.\.\s+_[^:]+:\s+(\S+)/gm,
    /^\s*\.\.\s+(?:image|figure)::\s+(\S+)/gm,
    /:doc:`(?:[^`<>]*<)?([^`<>]+)>?`/g,
  ]
  for (const pattern of patterns) for (const match of text.matchAll(pattern)) {
    const value = (match[1] ?? match[2] ?? match[3])?.trim().replace(/&amp;/g, '&')
    if (value && !value.startsWith('{')) links.add(value)
  }
  return [...links]
}
