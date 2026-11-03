import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { TerminalOutputEvent } from '@shared/types'

contextBridge.exposeInMainWorld('aihub', {
  call: (path: string, ...args: unknown[]) => ipcRenderer.invoke('api', path, args),
  onChanged: (cb: () => void) => {
    const listener = (): void => cb()
    ipcRenderer.on('changed', listener)
    return () => ipcRenderer.removeListener('changed', listener)
  },
  onNavigate: (cb: (route: string) => void) => {
    const listener = (_e: unknown, route: string): void => cb(route)
    ipcRenderer.on('navigate', listener)
    return () => ipcRenderer.removeListener('navigate', listener)
  },
  onTerminalOutput: (cb: (ev: TerminalOutputEvent) => void) => {
    const listener = (_e: unknown, ev: TerminalOutputEvent): void => cb(ev)
    ipcRenderer.on('terminal-output', listener)
    return () => ipcRenderer.removeListener('terminal-output', listener)
  },
  pathForFile: (file: File) => webUtils.getPathForFile(file)
})
