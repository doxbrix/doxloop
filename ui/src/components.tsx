import { createPortal } from 'preact/compat'
import { toChildArray } from 'preact'
import type { ComponentChildren, JSX, VNode } from 'preact'
import { useEffect, useId, useRef, useState } from 'preact/hooks'
import { Icon } from './icons'

/**
 * The shared surface for every screen: a bordered white panel with an optional
 * header row. Panels carry the whole page structure, so section titles stay one
 * size and one weight across the product.
 */
export function Panel(props: {
  title?: string
  description?: string
  icon?: string
  actions?: ComponentChildren
  footer?: ComponentChildren
  children: ComponentChildren
  flush?: boolean
  class?: string
}) {
  return <section class={`panel ${props.class ?? ''}`}>
    {(props.title || props.actions) && <header class="panel-head">
      {props.icon && <span class="panel-icon"><Icon name={props.icon} size={17} /></span>}
      <div class="panel-title">{props.title && <h2>{props.title}</h2>}{props.description && <p>{props.description}</p>}</div>
      {props.actions && <div class="panel-actions">{props.actions}</div>}
    </header>}
    <div class={`panel-body ${props.flush ? 'flush' : ''}`}>{props.children}</div>
    {props.footer && <footer class="panel-foot">{props.footer}</footer>}
  </section>
}

export function PageHeader({ title, description, icon, actions, meta }: {
  title: string
  description?: string
  icon?: string
  actions?: ComponentChildren
  meta?: ComponentChildren
}) {
  return <header class="page-head">
    {icon && <span class="page-head-icon"><Icon name={icon} size={30} /></span>}
    <div class="page-head-copy"><h1>{title}</h1>{description && <p>{description}</p>}{meta && <div class="page-meta">{meta}</div>}</div>
    {actions && <div class="page-head-actions">{actions}</div>}
  </header>
}

export function Tabs<T extends string>({ value, onChange, items }: {
  value: T
  onChange: (value: T) => void
  items: ReadonlyArray<readonly [T, string]>
}) {
  return <div class="tabs" role="tablist">{items.map(([id, label]) =>
    <button key={id} role="tab" aria-selected={value === id} class={value === id ? 'active' : ''} onClick={() => onChange(id)}>{label}</button>)}</div>
}

export function Button(props: JSX.ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?: 'primary' | 'secondary' | 'danger' | 'ghost' | 'link'
  size?: 'sm' | 'md'
  icon?: string
  busy?: boolean
}) {
  const { tone = 'secondary', size = 'md', icon, busy, children, class: className, ...button } = props
  return <button {...button} class={`btn ${tone} ${size} ${className ?? ''}`} disabled={Boolean(button.disabled || busy)} aria-busy={busy}>
    {busy ? <span class="spinner" /> : icon && <Icon name={icon} size={size === 'sm' ? 14 : 16} />}
    {busy ? 'Working…' : children}
  </button>
}

/**
 * Stat tiles double as the page summary. They keep the label above the value so
 * a row of them scans as a single line of numbers.
 */
export function Stat({ label, value, detail, icon, tone, active, onClick }: {
  label: string
  value: ComponentChildren
  detail?: string
  icon?: string
  tone?: 'good' | 'warn' | 'bad'
  active?: boolean
  onClick?: () => void
}) {
  const content = <>
    {icon && <span class="stat-icon"><Icon name={icon} size={19} /></span>}
    <span class="stat-copy"><span class="stat-label">{label}</span><strong class={`stat-value ${tone ?? ''}`}>{value}</strong>{detail && <small>{detail}</small>}</span>
  </>
  const className = `stat ${icon ? 'with-icon' : ''} ${active ? 'active' : ''}`
  return onClick
    ? <button type="button" class={className} onClick={onClick}>{content}</button>
    : <div class={className}>{content}</div>
}

export function Badge({ tone = 'neutral', icon, children }: { tone?: string; icon?: string; children: ComponentChildren }) {
  return <span class={`badge ${tone}`}>{icon && <Icon name={icon} size={12} />}{children}</span>
}

export function Field(props: { label: string; hint?: string; children: ComponentChildren; wide?: boolean }) {
  return <label class={`field ${props.wide ? 'wide' : ''}`}>
    <span class="field-label">{props.label}</span>
    {props.children}
    {props.hint && <small>{props.hint}</small>}
  </label>
}

export function Input(props: JSX.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} class={`input ${props.class ?? ''}`} />
}

export function Select({ icon, ...props }: JSX.SelectHTMLAttributes<HTMLSelectElement> & { icon?: string }) {
  const { children, class: className, disabled, name, onChange, value } = props
  const root = useRef<HTMLSpanElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const listboxId = useId()
  const [open, setOpen] = useState(false)
  const [highlighted, setHighlighted] = useState(0)
  const [position, setPosition] = useState({ left: 0, top: 0, width: 0 })
  const options = toChildArray(children).flatMap((child) => {
    if (!child || typeof child !== 'object' || (child as VNode).type !== 'option') return []
    const option = child as VNode<JSX.OptionHTMLAttributes<HTMLOptionElement>>
    const label = toChildArray(option.props.children).join('')
    return [{ value: String(option.props.value ?? label), label, disabled: Boolean(option.props.disabled) }]
  })
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === String(value ?? '')))
  const selected = options[selectedIndex]
  const openMenu = () => {
    if (disabled || !root.current) return
    const rect = root.current.getBoundingClientRect()
    const menuHeight = Math.min(248, options.length * 39 + 10)
    const spaceBelow = innerHeight - rect.bottom - 8
    const above = spaceBelow < Math.min(180, menuHeight) && rect.top > spaceBelow
    setPosition({ left: rect.left, top: above ? Math.max(8, rect.top - menuHeight - 4) : rect.bottom + 4, width: rect.width })
    setHighlighted(selectedIndex)
    setOpen(true)
  }
  const choose = (nextValue: string, optionDisabled = false) => {
    if (optionDisabled) return
    onChange?.({ currentTarget: { value: nextValue }, target: { value: nextValue } } as unknown as JSX.TargetedEvent<HTMLSelectElement, Event>)
    setOpen(false)
    root.current?.querySelector('button')?.focus()
  }
  const move = (direction: 1 | -1) => {
    if (!options.length) return
    let next = highlighted
    do next = (next + direction + options.length) % options.length
    while (options[next]?.disabled && next !== highlighted)
    setHighlighted(next)
  }
  const onKeyDown = (event: JSX.TargetedKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!open) openMenu()
      else move(event.key === 'ArrowDown' ? 1 : -1)
      return
    }
    if (event.key === 'Home' && open) { event.preventDefault(); setHighlighted(0); return }
    if (event.key === 'End' && open) { event.preventDefault(); setHighlighted(Math.max(0, options.length - 1)); return }
    if ((event.key === 'Enter' || event.key === ' ') && open) { event.preventDefault(); const option = options[highlighted]; if (option) choose(option.value, option.disabled); return }
    if (event.key === 'Escape' && open) { event.preventDefault(); setOpen(false) }
  }
  useEffect(() => {
    if (!open) return
    const closeOutside = (event: MouseEvent) => {
      const target = event.target as Node
      if (!root.current?.contains(target) && !menu.current?.contains(target)) setOpen(false)
    }
    const close = () => setOpen(false)
    const closeOnExternalScroll = (event: Event) => {
      const target = event.target
      if (target instanceof Node && menu.current?.contains(target)) return
      setOpen(false)
    }
    addEventListener('mousedown', closeOutside)
    addEventListener('resize', close)
    addEventListener('scroll', closeOnExternalScroll, true)
    return () => {
      removeEventListener('mousedown', closeOutside)
      removeEventListener('resize', close)
      removeEventListener('scroll', closeOnExternalScroll, true)
    }
  }, [open])
  return <span ref={root} class={`select-wrap custom-select ${icon ? 'with-icon' : ''}`}>
    {icon && <Icon name={icon} size={15} class="lead-icon" />}
    <button type="button" class={`input custom-select-trigger ${className ?? ''}`} disabled={disabled} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listboxId : undefined} aria-activedescendant={open ? `${listboxId}-${highlighted}` : undefined} onClick={() => open ? setOpen(false) : openMenu()} onKeyDown={onKeyDown}>
      <span>{selected?.label || 'Select an option'}</span><Icon name="chevronDown" size={14} />
    </button>
    {name && <input type="hidden" name={name} value={String(value ?? '')} />}
    {open && typeof document !== 'undefined' && createPortal(<div ref={menu} id={listboxId} class="custom-select-menu" role="listbox" style={`left:${position.left}px;top:${position.top}px;width:${position.width}px`}>
      {options.map((option, index) => <button key={`${option.value}-${index}`} type="button" id={`${listboxId}-${index}`} role="option" aria-selected={index === selectedIndex} class={`${index === selectedIndex ? 'selected' : ''} ${index === highlighted ? 'highlighted' : ''}`} disabled={option.disabled} onMouseEnter={() => setHighlighted(index)} onClick={() => choose(option.value, option.disabled)}><span>{option.label}</span>{index === selectedIndex && <Icon name="check" size={14} />}</button>)}
    </div>, document.body)}
  </span>
}

/** A searchable picker that also accepts values outside its suggestion list. */
export function Combo({ value, options, placeholder, disabled, onValueChange }: {
  value: string
  options: ReadonlyArray<readonly [string, string]>
  placeholder?: string
  disabled?: boolean
  onValueChange: (value: string) => void
}) {
  const root = useRef<HTMLSpanElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const listboxId = useId()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlighted, setHighlighted] = useState(0)
  const [position, setPosition] = useState({ left: 0, top: 0, width: 0 })
  const normalizedQuery = query.trim().toLowerCase()
  const filtered = normalizedQuery
    ? options.filter(([optionValue, label]) => `${label} ${optionValue}`.toLowerCase().includes(normalizedQuery))
    : options
  const openMenu = (filter = '') => {
    if (disabled || !root.current) return
    const rect = root.current.getBoundingClientRect()
    const menuHeight = Math.min(248, Math.max(44, options.length * 45 + 10))
    const spaceBelow = innerHeight - rect.bottom - 8
    const above = spaceBelow < Math.min(180, menuHeight) && rect.top > spaceBelow
    setPosition({ left: rect.left, top: above ? Math.max(8, rect.top - menuHeight - 4) : rect.bottom + 4, width: rect.width })
    setQuery(filter)
    setHighlighted(0)
    setOpen(true)
  }
  const choose = (nextValue: string) => {
    onValueChange(nextValue)
    setQuery('')
    setOpen(false)
    input.current?.focus()
  }
  const onKeyDown = (event: JSX.TargetedKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!open) openMenu()
      else if (filtered.length) setHighlighted((current) => (current + (event.key === 'ArrowDown' ? 1 : -1) + filtered.length) % filtered.length)
      return
    }
    if (event.key === 'Enter' && open && filtered[highlighted]) {
      event.preventDefault()
      choose(filtered[highlighted]![0])
      return
    }
    if (event.key === 'Escape' && open) { event.preventDefault(); setOpen(false) }
  }
  useEffect(() => {
    if (!open) return
    const closeOutside = (event: MouseEvent) => {
      const target = event.target as Node
      if (!root.current?.contains(target) && !menu.current?.contains(target)) setOpen(false)
    }
    const close = () => setOpen(false)
    const closeOnExternalScroll = (event: Event) => {
      const target = event.target
      if (target instanceof Node && menu.current?.contains(target)) return
      setOpen(false)
    }
    addEventListener('mousedown', closeOutside)
    addEventListener('resize', close)
    addEventListener('scroll', closeOnExternalScroll, true)
    return () => {
      removeEventListener('mousedown', closeOutside)
      removeEventListener('resize', close)
      removeEventListener('scroll', closeOnExternalScroll, true)
    }
  }, [open])
  return <span ref={root} class="select-wrap editable-select">
    <input ref={input} class="input" role="combobox" value={value} placeholder={placeholder} disabled={disabled} aria-autocomplete="list" aria-expanded={open} aria-controls={open ? listboxId : undefined} aria-activedescendant={open && filtered[highlighted] ? `${listboxId}-${highlighted}` : undefined} onFocus={() => { if (!open) openMenu() }} onInput={(event) => { const next = event.currentTarget.value; onValueChange(next); openMenu(next) }} onKeyDown={onKeyDown} />
    <button type="button" tabindex={-1} disabled={disabled} aria-label={open ? 'Close suggestions' : 'Show suggestions'} onMouseDown={(event) => event.preventDefault()} onClick={() => open ? setOpen(false) : openMenu()}><Icon name="chevronDown" size={14} /></button>
    {open && typeof document !== 'undefined' && createPortal(<div ref={menu} id={listboxId} class="editable-select-menu" role="listbox" style={`left:${position.left}px;top:${position.top}px;width:${position.width}px`}>
      {filtered.length ? filtered.map(([optionValue, label], index) => <button key={optionValue} type="button" id={`${listboxId}-${index}`} role="option" aria-selected={value === optionValue} class={`${value === optionValue ? 'selected' : ''} ${highlighted === index ? 'highlighted' : ''}`} onMouseEnter={() => setHighlighted(index)} onClick={() => choose(optionValue)}><span><strong>{label}</strong>{label !== optionValue && <small>{optionValue}</small>}</span>{value === optionValue && <Icon name="check" size={14} />}</button>) : <span class="editable-select-empty">No suggestion found. Your custom value will be used.</span>}
    </div>, document.body)}
  </span>
}

export function Textarea(props: JSX.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} class={`input textarea ${props.class ?? ''}`} />
}

export function Toggle({ checked, disabled, onChange, label }: {
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
  label: string
}) {
  return <label class="toggle">
    <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.currentTarget.checked)} />
    <span class="toggle-track" /><span class="toggle-text">{label}</span>
  </label>
}

/** Radio group rendered as bordered cards; used wherever a mode is chosen. */
export function Options<T extends string>({ value, onChange, items, columns }: {
  value: T
  onChange: (value: T) => void
  items: ReadonlyArray<readonly [T, string, string] | readonly [T, string, string, string]>
  columns?: number
}) {
  return <div class="options" style={columns ? `--option-columns:${columns}` : undefined}>{items.map(([id, label, detail, icon]) =>
    <button key={id} type="button" class={`option ${value === id ? 'selected' : ''}`} aria-pressed={value === id} onClick={() => onChange(id)}>
      <span class="option-check"><Icon name="check" size={12} /></span>
      <span class="option-head">{icon && <Icon name={icon} size={17} />}<strong>{label}</strong></span>
      <small>{detail}</small>
    </button>)}</div>
}

export function Segmented<T extends string>({ value, onChange, items }: {
  value: T
  onChange: (value: T) => void
  items: ReadonlyArray<readonly [T, string]>
}) {
  return <div class="segmented">{items.map(([id, label]) =>
    <button key={id} type="button" class={value === id ? 'active' : ''} aria-pressed={value === id} onClick={() => onChange(id)}>{label}</button>)}</div>
}

export function Empty({ title, detail, icon = 'file', action }: { title: string; detail?: string; icon?: string; action?: ComponentChildren }) {
  return <div class="empty"><span class="empty-icon"><Icon name={icon} size={20} /></span><strong>{title}</strong>{detail && <p>{detail}</p>}{action}</div>
}

export function Note({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'bad'; children: ComponentChildren }) {
  return <p class={`note ${tone}`}><Icon name={tone === 'info' ? 'shield' : 'alert'} size={14} />{children}</p>
}

export function Table({ head, children, class: className }: { head: ComponentChildren; children: ComponentChildren; class?: string }) {
  return <div class={`table-wrap ${className ?? ''}`}><table class="table"><thead><tr>{head}</tr></thead><tbody>{children}</tbody></table></div>
}

export function KeyValues({ items }: { items: Array<readonly [string, ComponentChildren]> }) {
  return <dl class="keyvalues">{items.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
}

export function Lines({ value, onInput, placeholder }: { value: string[]; onInput: (value: string[]) => void; placeholder?: string }) {
  return <Textarea class="mono-input" rows={5} value={value.join('\n')} placeholder={placeholder} onInput={(event) => onInput(event.currentTarget.value.split('\n').map((item) => item.trim()).filter(Boolean))} />
}

const JOB_TONE: Record<string, string> = { running: 'info', succeeded: 'good', failed: 'bad', cancelled: 'neutral' }
const JOB_ICON: Record<string, string> = { running: 'refresh', succeeded: 'check', failed: 'alert', cancelled: 'minus' }

/**
 * Activity is a table first and a log second: the row answers what happened and
 * when, and the output stays folded until someone asks for it.
 */
export function JobTable({ jobs, onCancel }: {
  jobs: Array<{ id: string; type: string; status: string; lines: string[]; startedAt: string }>
  onCancel: (id: string) => void
}) {
  if (jobs.length === 0) return <Empty icon="clock" title="No activity yet" detail="Runs started from this workspace appear here." />
  return <Table class="job-table" head={<><th>Task</th><th>Status</th><th>Started</th><th class="right" /></>}>
    {jobs.map((job) => <tr key={job.id} class="job-row">
      <td>
        <div class="job-name"><Icon name={JOB_ICON[job.status] ?? 'clock'} size={14} class={job.status === 'running' ? 'spin' : ''} /><span>{job.type.replaceAll(':', ' · ')}</span></div>
        {job.lines.length > 0 && <details class="job-output"><summary>{job.lines.length} recent output line{job.lines.length === 1 ? '' : 's'}</summary><pre class="terminal">{job.lines.join('\n')}</pre><a class="job-full-log" href={`/api/jobs/${job.id}/log`} target="_blank" rel="noreferrer">Open full log</a></details>}
      </td>
      <td><Badge tone={JOB_TONE[job.status] ?? 'neutral'}>{job.status}</Badge></td>
      <td class="muted-cell">{timeText(job.startedAt)}</td>
      <td class="right">{job.status === 'running' && <Button size="sm" onClick={() => onCancel(job.id)}>Cancel</Button>}</td>
    </tr>)}
  </Table>
}

export function timeText(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export function splitComma(value: string): string[] {
  return value.split(',').map((item) => item.trim()).filter(Boolean)
}

export function termText(value: Record<string, string>): string {
  return Object.entries(value).map(([term, replacement]) => `${term} = ${replacement}`).join('\n')
}

export function parseTerms(value: string): Record<string, string> {
  const terms: Record<string, string> = {}
  for (const line of value.split('\n')) {
    const [key, ...rest] = line.split('=')
    if (key?.trim() && rest.join('=').trim()) terms[key.trim()] = rest.join('=').trim()
  }
  return terms
}
