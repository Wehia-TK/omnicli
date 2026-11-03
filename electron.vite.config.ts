import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const shared = { '@shared': resolve(__dirname, 'src/shared') }

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
    plugins: [react(), tailwindcss()]
  }
})
