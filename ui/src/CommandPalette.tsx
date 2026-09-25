import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { Icon } from './icons'

export interface PaletteCommand {
  id: string
  group: 'Actions' | 'Go to' | 'Pages'
  label: string
  icon: string
  hint?: string
  run: () => void
}

/**
 * The ⌘K palette: one search box over every screen, page, and action in the
 * workspace. Arrow keys move, Enter runs, Escape closes. The list is built by
 * the shell so it always reflects the current project.
 */
export function CommandPalette({ open, commands, onClose }: { open: boolean; commands: PaletteCommand[]; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const matches = needle
      ? commands.filter((command) => `${command.label} ${command.hint ?? ''} ${command.group}`.toLowerCase().includes(needle))
      : commands
    // Pages are the long tail; without a query only a few show so the palette stays short.
    return needle ? matches.slice(0, 40) : matches.filter((command, index) => command.group !== 'Pages' || index < 200).slice(0, 14)
  }, [commands, query])

  useEffect(() => {
    if (!open) return
    setQuery('')
    setActive(0)
    const timer = setTimeout(() => input.current?.focus(), 0)
    return () => clearTimeout(timer)
  }, [open])

  useEffect(() => { setActive(0) }, [query])

  useEffect(() => {
    const item = list.current?.querySelector<HTMLElement>('.command-palette-item.active')
    item?.scrollIntoView({ block: 'nearest' })
  }, [active, filtered])

  if (!open) return null

  const run = (command: PaletteCommand | undefined) => {
    if (!command) return
    onClose()
    command.run()
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); setActive((value) => filtered.length ? (value + 1) % filtered.length : 0) }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setActive((value) => filtered.length ? (value - 1 + filtered.length) % filtered.length : 0) }
    else if (event.key === 'Enter') { event.preventDefault(); run(filtered[active]) }
    else if (event.key === 'Escape') { event.preventDefault(); onClose() }
  }

  const groups: Array<[string, Array<[PaletteCommand, number]>]> = []
  filtered.forEach((command, index) => {
    const group = groups.find(([name]) => name === command.group)
    if (group) group[1].push([command, index])
    else groups.push([command.group, [[command, index]]])
  })

  return <div class="command-palette-scrim" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <div class="command-palette" role="dialog" aria-modal="true" aria-label="Search or jump to">
      <div class="command-palette-input">
        <Icon name="search" size={18} />
        <input ref={input} type="text" autofocus value={query} placeholder="Search pages, screens, and actions…" aria-label="Search pages, screens, and actions" onInput={(event) => setQuery(event.currentTarget.value)} onKeyDown={onKeyDown} />
        <kbd>esc</kbd>
      </div>
      <div ref={list} class="command-palette-list" role="listbox">
        {filtered.length === 0 && <div class="command-palette-empty">Nothing matches “{query}”.</div>}
        {groups.map(([name, items]) => <div key={name}>
          <span class="kicker command-palette-group">{name}</span>
          {items.map(([command, index]) => <button key={command.id} type="button" role="option" aria-selected={index === active} class={`command-palette-item ${index === active ? 'active' : ''}`} onMouseEnter={() => setActive(index)} onClick={() => run(command)}>
            <Icon name={command.icon} size={16} /><span>{command.label}</span>{command.hint && <small>{command.hint}</small>}
          </button>)}
        </div>)}
      </div>
      <div class="command-palette-foot"><span>↑↓ move</span><span>↵ open</span><span>esc close</span></div>
    </div>
  </div>
}

/** Opens the palette on ⌘K / Ctrl+K anywhere in the workspace. */
export function useCommandPaletteShortcut(onOpen: () => void): void {
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        onOpen()
      }
    }
    addEventListener('keydown', listener)
    return () => removeEventListener('keydown', listener)
  }, [onOpen])
}
