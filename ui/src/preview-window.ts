export type PreviewNotice =
  | { state: 'starting' }
  | { state: 'ready'; url: string; blocked: boolean }
  | { state: 'failed'; error: string }

export const PREVIEW_NOTICE_EVENT = 'doxloop:preview-notice'

/** Tell the workspace shell what a preview request is doing, from any screen. */
export function announcePreview(notice: PreviewNotice): void {
  dispatchEvent(new CustomEvent<PreviewNotice>(PREVIEW_NOTICE_EVENT, { detail: notice }))
}

/**
 * Open a preview in a new tab without tripping the popup blocker. The tab is
 * opened synchronously inside the click, before any request, and pointed at
 * the preview once the server answers. When the browser refuses the tab, the
 * notice carries the address so the reader can open it with a normal link.
 */
export async function openPreviewTab(start: (openServerSide: boolean) => Promise<{ url: string }>, onNotice: (notice: PreviewNotice) => void = announcePreview): Promise<string | undefined> {
  let tab: Window | null = null
  try { tab = window.open('about:blank', '_blank') } catch { tab = null }
  if (tab) {
    try { tab.opener = null } catch { /* Some browsers expose opener as read-only. */ }
    try {
      tab.document.title = 'Starting preview…'
      tab.document.body.style.font = '15px system-ui, sans-serif'
      tab.document.body.style.padding = '32px'
      tab.document.body.textContent = 'Starting the Doxloop preview… This tab opens the documentation as soon as it is ready.'
    } catch { /* A tab we cannot write to still navigates below. */ }
  }
  onNotice({ state: 'starting' })
  try {
    // The server opens the system browser only when this page could not open a tab itself.
    const { url } = await start(!tab)
    const reachable = Boolean(tab && !tab.closed)
    if (reachable) tab!.location.replace(url)
    onNotice({ state: 'ready', url, blocked: !reachable })
    return url
  } catch (cause) {
    try { tab?.close() } catch { /* already closed */ }
    onNotice({ state: 'failed', error: cause instanceof Error ? cause.message : String(cause) })
    return undefined
  }
}
