import { clis } from './clis'
import { knowledge } from './knowledge'
import { projects } from './projects'
import { getSettings, updateSettings } from './settings'
import { terminal } from './terminal'

export const coreApi = {
  projects,
  clis,
  knowledge,
  terminal,
  settings: {
    get: () => getSettings(),
    update: (patch: Parameters<typeof updateSettings>[0]) => updateSettings(patch)
  }
}
