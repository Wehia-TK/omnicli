import { ipcRenderer } from 'electron'

/**
 * Injected into the browser-preview <webview>. When the host turns picking on, hovering highlights an element and
 * clicking sends a compact description (selector, text, outerHTML, size) back to AI Hub to attach to a prompt.
 */
let picking = false
let box: HTMLDivElement | null = null
let label: HTMLDivElement | null = null

function ensureOverlay(): void {
  if (box) return
  box = document.createElement('div')
  label = document.createElement('div')
  Object.assign(box.style, {
    position: 'fixed',
    pointerEvents: 'none',
    zIndex: '2147483647',
    border: '2px solid #6366f1',
    background: 'rgba(99,102,241,0.12)',
    borderRadius: '3px',
    transition: 'all 60ms ease'
  })
  Object.assign(label.style, {
    position: 'fixed',
    pointerEvents: 'none',
    zIndex: '2147483647',
    background: '#6366f1',
    color: '#fff',
    font: '11px/1.4 ui-monospace, Consolas, monospace',
    padding: '1px 6px',
    borderRadius: '3px'
  })
  document.documentElement.append(box, label)
}

function selectorOf(el: Element): string {
  if (el.id) return `#${CSS.escape(el.id)}`
  const parts: string[] = []
  let cur: Element | null = el
  while (cur && cur.nodeType === 1 && parts.length < 5) {
    let part = cur.tagName.toLowerCase()
    const cls = [...cur.classList].filter((c) => !/^(hover|focus|active)/.test(c)).slice(0, 2)
    if (cls.length) part += `.${cls.map((c) => CSS.escape(c)).join('.')}`
    const parent: Element | null = cur.parentElement
    if (parent) {
      const same = [...parent.children].filter((c) => c.tagName === cur!.tagName)
      if (same.length > 1) part += `:nth-of-type(${same.indexOf(cur) + 1})`
    }
    parts.unshift(part)
    if (cur.id) break
    cur = parent
  }
  return parts.join(' > ')
}

function onMove(e: MouseEvent): void {
  if (!picking) return
  const el = document.elementFromPoint(e.clientX, e.clientY)
  if (!el || el === box || el === label) return
  ensureOverlay()
  const r = el.getBoundingClientRect()
  Object.assign(box!.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`, display: 'block' })
  label!.textContent = `${el.tagName.toLowerCase()} ${Math.round(r.width)}×${Math.round(r.height)}`
  Object.assign(label!.style, { left: `${r.left}px`, top: `${Math.max(0, r.top - 18)}px`, display: 'block' })
}

function onClick(e: MouseEvent): void {
  if (!picking) return
  e.preventDefault()
  e.stopPropagation()
  const el = document.elementFromPoint(e.clientX, e.clientY)
  if (!el) return
  const r = el.getBoundingClientRect()
  const cs = getComputedStyle(el)
  ipcRenderer.sendToHost('element-picked', {
    selector: selectorOf(el),
    tag: el.tagName.toLowerCase(),
    text: (el as HTMLElement).innerText?.trim().slice(0, 300) ?? '',
    html: el.outerHTML.slice(0, 1500),
    size: `${Math.round(r.width)}×${Math.round(r.height)}`,
    styles: `color ${cs.color}; background ${cs.backgroundColor}; font ${cs.fontSize} ${cs.fontFamily.split(',')[0]}; padding ${cs.padding}; margin ${cs.margin}`,
    url: location.href
  })
  setPicking(false)
}

function setPicking(on: boolean): void {
  picking = on
  document.documentElement.style.cursor = on ? 'crosshair' : ''
  if (!on && box && label) {
    box.style.display = 'none'
    label.style.display = 'none'
  }
}

ipcRenderer.on('picker', (_e, on: boolean) => setPicking(Boolean(on)))
window.addEventListener('mousemove', onMove, true)
window.addEventListener('click', onClick, true)
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && picking) {
    setPicking(false)
    ipcRenderer.sendToHost('element-picked', null)
  }
})
