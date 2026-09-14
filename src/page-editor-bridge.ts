/** Runs inside the isolated editor iframe. Keep this function self-contained. */
export function installPageEditorBridge() {
  const originals = new WeakMap<Node, { html: string; markdown: string }>()
  const elements = [...document.querySelectorAll<HTMLElement>('[data-edit-start]')]
  const linkLabels: HTMLElement[] = []
  const children = (node: Node): string => [...node.childNodes].map(serialize).join('')
  function serialize(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? '').replaceAll('\u00a0', ' ')
    if (!(node instanceof HTMLElement)) return ''
    const original = originals.get(node)
    if (original && node.innerHTML === original.html) return original.markdown
    if (node.dataset.mdAtom !== undefined) return node.dataset.mdAtom
    const text = children(node)
    switch (node.tagName) {
      case 'STRONG': case 'B': return text ? `**${text}**` : ''
      case 'EM': case 'I': return text ? `*${text}*` : ''
      case 'S': case 'STRIKE': return text ? `~~${text}~~` : ''
      case 'CODE': return text ? '`' + (node.textContent ?? '') + '`' : ''
      case 'A': return '[' + text + (node.dataset.mdSuffix ?? `](${node.getAttribute('href') ?? ''})`)
      case 'BR': return '\n'
      case 'DIV': case 'P': return (node.previousSibling ? '\n' : '') + text
      default: return text
    }
  }
  const publish = (el: HTMLElement) => {
    let text: string
    const original = originals.get(el)
    if (original && el.innerHTML === original.html) text = original.markdown
    else if (el.dataset.editFormat === 'yaml') text = JSON.stringify(el.innerText.replace(/\n/g, ' '))
    else if (el.dataset.editFormat === 'plain') text = el.innerText
    else text = children(el).replace(/\n/g, ' ')
    // Preserve the document's line-ending convention when editing fenced code.
    if (el.dataset.editSource?.includes('\r\n')) text = text.replace(/\r?\n/g, '\r\n')
    parent.postMessage({ type: 'doxloop:edit-block', start: Number(el.dataset.editStart), end: Number(el.dataset.editEnd), text }, '*')
  }
  elements.forEach(el => {
    const plain = el.dataset.editFormat !== 'markdown'
    // Give links a dedicated editing host. Chromium otherwise moves the caret
    // outside the anchor after replacing its label's final character.
    el.querySelectorAll<HTMLAnchorElement>('a').forEach(link => {
      const label = document.createElement('span')
      label.dataset.editLinkLabel = ''
      label.contentEditable = 'true'
      link.contentEditable = 'false'
      while (link.firstChild) label.append(link.firstChild)
      link.append(label)
      linkLabels.push(label)
    })
    el.contentEditable = plain ? 'plaintext-only' : 'true'
    el.setAttribute('role', 'textbox')
    el.setAttribute('aria-label', 'Edit ' + (el.tagName === 'CODE' ? 'code' : /^H\d$/.test(el.tagName) ? 'heading' : el.tagName === 'LI' ? 'list item' : /^(TH|TD)$/.test(el.tagName) ? 'table cell' : 'paragraph'))
    // Cache nested mark serialization so changing nearby words leaves their source intact.
    Array.from(el.querySelectorAll<HTMLElement>('strong,em,s,code,a,[data-md-atom]')).reverse().forEach(node => {
      originals.set(node, { html: node.innerHTML, markdown: serialize(node) })
    })
    originals.set(el, { html: el.innerHTML, markdown: el.dataset.editSource ?? '' })
    el.addEventListener('input', () => publish(el))
    el.addEventListener('beforeinput', event => {
      const input = event as InputEvent
      if (el.dataset.editFormat !== 'plain' && (input.inputType === 'insertParagraph' || input.inputType === 'insertLineBreak')) {
        // Each region owns one Markdown block; a newline must not split its list/table syntax.
        event.preventDefault()
        document.execCommand('insertText', false, ' ')
      }
    })
    el.addEventListener('paste', event => {
      event.preventDefault()
      const text = event.clipboardData?.getData('text/plain') ?? ''
      document.execCommand('insertText', false, el.dataset.editFormat === 'plain' ? text : text.replace(/\r?\n/g, ' '))
    })
    el.addEventListener('drop', event => event.preventDefault())
  })
  addEventListener('message', event => {
    if (event.source === parent && event.data?.type === 'doxloop:editor-lock') {
      linkLabels.forEach(label => { label.contentEditable = event.data.locked ? 'false' : 'true' })
      elements.forEach(el => { el.contentEditable = event.data.locked ? 'false' : el.dataset.editFormat !== 'markdown' ? 'plaintext-only' : 'true' })
    }
  })
  // Prevent selection/replacement across separate source regions.
  document.addEventListener('beforeinput', event => {
    const selection = getSelection()
    const region = (node: Node | null) => (node instanceof Element ? node : node?.parentElement)?.closest('[data-edit-start]')
    if (selection && region(selection.anchorNode) !== region(selection.focusNode)) event.preventDefault()
  })
  document.addEventListener('click', event => { if ((event.target as Element).closest('a')) event.preventDefault() })
  document.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.key === 's') {
      event.preventDefault(); parent.postMessage({ type: 'doxloop:save-draft' }, '*')
    }
  })
}
