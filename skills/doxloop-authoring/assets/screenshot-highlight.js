(() => {
  const overlayId = 'doxloop-screenshot-highlight'

  const remove = () => {
    document.getElementById(overlayId)?.remove()
  }

  globalThis.__doxloopRemoveScreenshotHighlight = remove
  globalThis.__doxloopScreenshotHighlight = ({
    selector,
    step = 1,
    dim = true,
  }) => {
    remove()
    const target = document.querySelector(selector)
    if (!(target instanceof Element)) {
      throw new Error(`Screenshot highlight target not found: ${selector}`)
    }
    target.scrollIntoView({ block: 'center', inline: 'center' })
    const rect = target.getBoundingClientRect()
    const clearance = 6
    const left = Math.max(2, rect.left - clearance)
    const top = Math.max(2, rect.top - clearance)
    const width = Math.max(
      4,
      Math.min(rect.width + clearance * 2, window.innerWidth - left - 2),
    )
    const height = Math.max(
      4,
      Math.min(rect.height + clearance * 2, window.innerHeight - top - 2),
    )
    const overlay = document.createElement('div')
    overlay.id = overlayId
    overlay.setAttribute('aria-hidden', 'true')
    Object.assign(overlay.style, {
      position: 'fixed',
      boxSizing: 'border-box',
      left: `${left}px`,
      top: `${top}px`,
      width: `${width}px`,
      height: `${height}px`,
      border: '3px solid #ffbf47',
      borderRadius: '8px',
      outline: '2px solid #172033',
      outlineOffset: '1px',
      boxShadow: dim ? '0 0 0 9999px rgb(15 23 42 / 18%)' : 'none',
      pointerEvents: 'none',
      zIndex: '2147483646',
    })

    const marker = document.createElement('span')
    marker.textContent = String(step)
    Object.assign(marker.style, {
      position: 'absolute',
      display: 'grid',
      placeItems: 'center',
      boxSizing: 'border-box',
      minWidth: '28px',
      height: '28px',
      padding: '0 7px',
      top: '-17px',
      left: '-17px',
      border: '2px solid #ffbf47',
      borderRadius: '999px',
      background: '#172033',
      color: '#ffffff',
      font: '700 14px/1 system-ui, sans-serif',
      boxShadow: '0 2px 8px rgb(15 23 42 / 35%)',
    })
    overlay.append(marker)
    document.documentElement.append(overlay)
    return {
      selector,
      step,
      bounds: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
    }
  }
})()
