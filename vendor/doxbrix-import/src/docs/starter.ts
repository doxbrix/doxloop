/** Invisible marker added to page scaffolds until researched content replaces them. */
export const STARTER_PAGE_MARKER = '<!-- doxbrix:starter-page -->'

/** Detect current marked scaffolds and legacy starter text created by older CLI builds. */
export function hasStarterPageContent(body: string): boolean {
  const normalized = body.replace(/\r\n/g, '\n').trim()
  if (normalized.includes(STARTER_PAGE_MARKER)) return true

  return (
    /^#\s+Introduction\s*\n+\s*Welcome to (?:\*\*)?.+?(?:\*\*)?\.\s*$/i.test(normalized) ||
    /^#\s+Quickstart\s*\n+\s*Get started in a few minutes\.\s*$/i.test(normalized) ||
    /^#\s+.+?\s*\n+\s*Start writing here\.\s*$/i.test(normalized)
  )
}
