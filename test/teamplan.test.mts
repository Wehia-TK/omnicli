import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  clipWords,
  extractPlan,
  hiringRights,
  isBlockedModel,
  managerPlanPrompt,
  managerReviewPrompt,
  modelWeight,
  normalizeAssignments,
  workerPrompt,
  type ReportRef
} from '../src/core/teamplan.ts'
import type { TeamModelOption } from '../src/shared/types.ts'

const catalog: TeamModelOption[] = [
  { key: 'claude:claude-opus-5-5', cli: 'claude', cliName: 'Claude Code', model: 'claude-opus-5-5', name: 'Claude Opus 5.5', weight: 1, ready: true },
  { key: 'claude:claude-sonnet-4-6', cli: 'claude', cliName: 'Claude Code', model: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', weight: 0.6, ready: true },
  { key: 'claude:claude-haiku-4-5', cli: 'claude', cliName: 'Claude Code', model: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', weight: 0.2, ready: true }
]

const reports: ReportRef[] = [
  { id: 2, title: 'Backend Dev', kind: 'worker', job: 'Server code', command: '', locked: false, cli: 'claude', model: 'claude-sonnet-4-6' },
  { id: 3, title: 'Security Lead', kind: 'manager', job: 'Security review', command: '', locked: true, cli: 'claude', model: 'claude-opus-5-5' },
  { id: 4, title: 'Test Runner', kind: 'script', job: 'Runs checks', command: 'npm test', locked: false, cli: '', model: '' }
]

describe('modelWeight & isBlockedModel', () => {
  it('ranks Opus highest and Haiku/Flash/Mini lowest', () => {
    assert.equal(modelWeight('claude-opus-5-5'), 1)
    assert.equal(modelWeight('claude-sonnet-4-6'), 0.6)
    assert.equal(modelWeight('claude-haiku-4-5'), 0.2)
    assert.equal(modelWeight('gemini-3-flash'), 0.2)
  })
  it('blocks Fable models', () => {
    assert.equal(isBlockedModel('claude-fable-1'), true)
    assert.equal(isBlockedModel('claude-opus-5-5'), false)
  })
  it('computes hiring rights by depth', () => {
    assert.deepEqual(hiringRights(0, 3), { canHire: true, canHireManagers: true })
    assert.deepEqual(hiringRights(1, 3), { canHire: true, canHireManagers: false })
    assert.deepEqual(hiringRights(2, 3), { canHire: false, canHireManagers: false })
  })
})

describe('extractPlan', () => {
  it('extracts a fenced json plan and strips the fence from prose', () => {
    const reply = 'Here is the plan.\n\n```json\n{"assignments":[{"to":"#2","brief":"fix bug"}]}\n```'
    const plan = extractPlan(reply)
    assert.ok(plan)
    assert.equal(plan.assignments.length, 1)
    assert.equal(plan.prose, 'Here is the plan.')
  })

  it('extracts an unfenced json plan at the end with braces inside strings', () => {
    const reply = 'Done thinking. {"assignments":[],"report":"Handled {edge} case"}'
    const plan = extractPlan(reply)
    assert.ok(plan)
    assert.equal(plan.report, 'Handled {edge} case')
    assert.equal(plan.prose, 'Done thinking.')
  })

  it('returns null when no plan object is present', () => {
    assert.equal(extractPlan('Just a normal markdown answer with {"other":1}.'), null)
  })
})

describe('normalizeAssignments', () => {
  it('resolves existing reports, respects locked models, and forces managers to read-only', () => {
    const { assignments, warnings } = normalizeAssignments(
      [
        { to: '#2', model: 'claude:claude-haiku-4-5', access: 'write', brief: 'Add endpoint' },
        { to: 'Security Lead', model: 'claude:claude-haiku-4-5', access: 'write', brief: 'Audit endpoint' },
        { to: '#4' }
      ],
      { reports, allowed: catalog, hiresLeft: 5, canHire: true, canHireManagers: true }
    )
    assert.equal(warnings.length, 0)
    assert.equal(assignments.length, 3)
    assert.equal(assignments[0].roleId, 2)
    assert.equal(assignments[0].model, 'claude-haiku-4-5')
    assert.equal(assignments[0].access, 'write')
    // Security Lead is locked to opus and is a manager (read-only)
    assert.equal(assignments[1].roleId, 3)
    assert.equal(assignments[1].model, 'claude-opus-5-5')
    assert.equal(assignments[1].access, 'read')
    // Script role needs no brief
    assert.equal(assignments[2].roleId, 4)
    assert.equal(assignments[2].kind, 'script')
  })

  it('enforces hire limits, level limits, and substitutes unknown models with cheapest', () => {
    const { assignments, warnings } = normalizeAssignments(
      [
        { to: 'new', title: 'QA Lead', kind: 'manager', model: 'unknown:model', brief: 'Check UI' },
        { to: 'new', title: 'Extra Worker', kind: 'worker', brief: 'Too many hires' }
      ],
      { reports, allowed: catalog, hiresLeft: 1, canHire: true, canHireManagers: false }
    )
    assert.equal(assignments.length, 1)
    assert.equal(assignments[0].title, 'QA Lead')
    assert.equal(assignments[0].kind, 'worker') // downgraded because canHireManagers is false
    assert.equal(assignments[0].model, 'claude-haiku-4-5') // cheapest fallback
    assert.ok(warnings.some((w) => w.includes('hired as a worker')))
    assert.ok(warnings.some((w) => w.includes('size limit')))
  })
})

describe('clipWords & prompts', () => {
  it('clips reports past the word cap', () => {
    assert.equal(clipWords('one two three', 5), 'one two three')
    assert.match(clipWords('one two three four five six', 3), /^one two three\n…\(report cut at 3 words\)$/)
  })

  it('builds manager plan, review, and worker prompts', () => {
    const planP = managerPlanPrompt({
      title: 'CTO',
      job: 'Owns engineering',
      parentTitle: null,
      reports,
      allowed: catalog,
      hiresLeft: 3,
      canHire: true,
      canHireManagers: true,
      budgetPct: 12,
      kb: 'KB',
      brief: 'Build feature X',
      reportWords: 200
    })
    assert.ok(planP.includes('You are the CTO'))
    assert.ok(planP.includes('#2 Backend Dev'))

    const revP = managerReviewPrompt({
      title: 'CTO',
      parentTitle: null,
      briefRecap: 'Build feature X',
      round: 1,
      results: [{ roleId: 2, title: 'Backend Dev', state: 'done', model: 'claude-haiku-4-5', tokens: 1200, report: 'Done.', error: '' }],
      notes: [],
      budgetPct: 30,
      roundsLeft: 1,
      final: false,
      reportWords: 200
    })
    assert.ok(revP.includes('#2 Backend Dev — done'))

    const workP = workerPrompt({
      title: 'Backend Dev',
      job: 'Server code',
      managerTitle: 'CTO',
      access: 'write',
      kb: '',
      brief: 'Implement route',
      reportWords: 200
    })
    assert.ok(workP.includes('You report to CTO'))
  })
})
