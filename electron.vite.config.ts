import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const shared = { '@shared': resolve(__dirname, 'src/shared') }

/**
 * Content-Security-Policy for the packaged UI. Only added to production builds: the dev server needs inline
 * scripts for React Fast Refresh. No remote code can ever run in the window that holds the app's bridge.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' blob: data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ')

const cspPlugin = (): Plugin => ({
  name: 'omni-csp',
  apply: 'build',
  transformIndexHtml: (html) => html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`)
})

export default defineConfig({
  main: {
    resolve: { alias: shared }
  },
  preload: {
    resolve: { alias: shared },
    build: {
      rollupOptions: {
        // index = app bridge; picker = injected into the browser-preview <webview> for element picking
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          picker: resolve(__dirname, 'src/preload/picker.ts')
        }
      }
    }
  },
  renderer: {
    resolve: {
      alias: { ...shared, '@': resolve(__dirname, 'src/renderer/src') }
    },
    plugins: [react(), tailwindcss(), cspPlugin()]
  }
})
