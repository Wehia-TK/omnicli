import { statSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Pure security rules for the main process (no Electron imports, so they are unit-tested in test/security.test.mts).
 */

/** Same file path, case-insensitive on Windows. */
export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b)
}

/** True only for Omni CLI's own UI: the built index.html, or the electron-vite dev server origin. */
export function isAppUrl(raw: string, rendererHtml: string, devUrl?: string): boolean {
  try {
    const u = new URL(raw)
    if (devUrl && u.origin === new URL(devUrl).origin) return true
    const own = decodeURIComponent(pathToFileURL(rendererHtml).pathname).toLowerCase()
    return u.protocol === 'file:' && decodeURIComponent(u.pathname).toLowerCase() === own
  } catch {
    return false
  }
}

/** The normalized link if it may be handed to the system browser (web and mail links only), else null. */
export function safeExternalUrl(raw: string): string | null {
  try {
    const u = new URL(raw)
    return ['https:', 'http:', 'mailto:'].includes(u.protocol) ? u.href : null
  } catch {
    return null
  }
}

/** URLs the browser-preview <webview> may load. */
export const isAllowedWebviewSrc = (src: string): boolean => !src || /^(https?:|about:blank$)/i.test(src)

/** Folders, images and plain-text files only: never hand an executable or shortcut to the OS shell. */
const OPENABLE_FILE = /\.(png|jpe?g|gif|webp|bmp|md|txt|log|json)$/i
export function canOpenPath(target: string): boolean {
  try {
    return statSync(target).isDirectory() || (OPENABLE_FILE.test(target) && statSync(target).isFile())
  } catch {
    return false
  }
}

/** Shape of an IPC method name: `group.method` (letters only, so no `__proto__`, paths or empty segments). */
export const isValidApiPath = (path: unknown): path is string => typeof path === 'string' && /^[A-Za-z]+(\.[A-Za-z]+)+$/.test(path)

/** Look up an API function by walking own properties only — never into prototypes (constructor, __proto__, …). */
export function resolveApiMethod(api: object, path: string): ((...a: unknown[]) => unknown) | null {
  if (!isValidApiPath(path)) return null
  let cur: unknown = api
  for (const p of path.split('.')) {
    if (!cur || typeof cur !== 'object' || !Object.prototype.hasOwnProperty.call(cur, p)) return null
    cur = (cur as Record<string, unknown>)[p]
  }
  return typeof cur === 'function' ? (cur as (...a: unknown[]) => unknown) : null
}
