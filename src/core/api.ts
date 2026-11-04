import { approvals } from './approvals'
import { clis } from './clis'
import { gitops } from './gitops'
import { refreshGraphWatchers } from './graphwatch'
import { knowledge } from './knowledge'
import { mcp } from './mcp'
import { projects } from './projects'
import { schedules } from './scheduler'
import { getSettings, updateSettings } from './settings'
import { skills } from './skills'
import { terminal } from './terminal'
import { updater } from './updater'
import { attachments, github, history, review, rules } from './workspace'

export const coreApi = {
  projects,
  clis,
  knowledge,
  terminal,
  skills,
  approvals,
  rules,
  attachments,
  history,
  github,
  review,
  schedules,
  mcp,
  git: gitops,
  updates: updater,
  settings: {
    get: () => getSettings(),
    update: (patch: Parameters<typeof updateSettings>[0]) => {
      const s = updateSettings(patch)
      refreshGraphWatchers()
      return s
    }
  }
}
