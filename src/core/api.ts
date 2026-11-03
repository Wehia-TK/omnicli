import { clis } from './clis'
import { gitops } from './gitops'
import { knowledge } from './knowledge'
import { projects } from './projects'
import { getSettings, updateSettings } from './settings'
import { skills } from './skills'
import { terminal } from './terminal'

export const coreApi = {
  projects,
  clis,
  knowledge,
  terminal,
  skills,
  git: gitops,
  settings: {
    get: () => getSettings(),
    update: (patch: Parameters<typeof updateSettings>[0]) => updateSettings(patch)
  }
}
