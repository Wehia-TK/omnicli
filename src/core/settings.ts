import type { Settings } from '@shared/types'
import { all, run, transaction } from './db'

export const DEFAULT_SETTINGS: Settings = {
  theme: 'dark',
  defaultCli: 'claude',
  defaultModel: 'claude-opus-5-5',
  defaultEffort: 'medium',
  kbPromptMode: 'compact',
  useGraphify: true,
  graphifyWatch: true,
  ntfyTopic: '',
  agyFamilyFallback: true,
  defaultPermissionMode: 'default',
  defaultCheckoutMode: 'local',
  cliHandover: true,
  autoUpdateKb: true,
  syncKbToDisk: true,
  claudePath: '',
  agyPath: '',
  codexPath: '',
  geminiPath: '',
  copilotPath: '',
  claudeTier: 'pro',
  agyTier: 'pro',
  codexTier: 'plus',
  geminiTier: 'advanced',
  copilotTier: 'pro'
}

export function getSettings(): Settings {
  const rows = all<{ key: string; value: string }>('SELECT key, value FROM settings')
  const s: Record<string, unknown> = { ...DEFAULT_SETTINGS }
  for (const r of rows) {
    if (r.key in DEFAULT_SETTINGS) {
      try {
        s[r.key] = JSON.parse(r.value)
      } catch {
        // ignore invalid json
      }
    }
  }
  return s as unknown as Settings
}

export function updateSettings(patch: Partial<Settings>): Settings {
  transaction(() => {
    for (const [key, value] of Object.entries(patch)) {
      if (!(key in DEFAULT_SETTINGS)) continue
      run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value))
    }
  })
  return getSettings()
}
