#!/usr/bin/env node
/**
 * End-to-end security + functional smoke test.
 *
 * Launches the built app in a throw-away profile (its own --user-data-dir, so a running Omni CLI is never touched),
 * drives it over the Chrome DevTools Protocol and checks the security boundaries and the main IPC API.
 * No AI runs are started, so it costs nothing.
 *
 *   npm run build && node scripts/e2e.mjs                       # the source checkout (out/)
 *   node scripts/e2e.mjs --exe "release/win-unpacked/Omni CLI.exe"   # a packaged build
 *   node scripts/e2e.mjs --dev                                   # `npm run dev` (dev server; no CSP in dev)
 */
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const exeArg = process.argv.indexOf('--exe')
const PACKAGED = exeArg > 0 ? resolve(process.argv[exeArg + 1]) : ''
const DEV = process.argv.includes('--dev')
const isWin = process.platform === 'win32'
const ROOT = mkdtempSync(join(tmpdir(), 'omni-e2e-'))
const PROFILE = join(ROOT, 'profile')
const PROJ = join(ROOT, 'proj')
const PORT = 9300 + Math.floor(Math.random() * 600)
const THIS_FILE = fileURLToPath(import.meta.url)

if (!PACKAGED && !DEV && !existsSync(join(REPO, 'out', 'main', 'index.js'))) {
  console.error('Build first: npm run build')
  process.exit(2)
}

// A tiny project to work on
mkdirSync(join(PROJ, 'src'), { recursive: true })
writeFileSync(join(PROJ, 'package.json'), JSON.stringify({ name: 'smoke', scripts: { test: 'node src/index.js' }, dependencies: { react: '^19' } }))
writeFileSync(join(PROJ, 'src', 'index.js'), 'export const hello = () => 1\n')
writeFileSync(join(PROJ, 'README.md'), '# Smoke\n')
const evil = join(ROOT, 'evil.js')
writeFileSync(evil, "try { document.title = 'EVIL' } catch {}; document.addEventListener('DOMContentLoaded', () => { document.title = 'EVIL' })")

// On Windows the app (re)writes its Start Menu / taskbar shortcuts on launch: keep the user's exactly as they were
const shortcuts = isWin
  ? [
      join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Omni CLI.lnk'),
      join(process.env.APPDATA || '', 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar', 'Omni CLI.lnk'),
      join(REPO, 'Omni CLI.lnk')
    ].map((path, i) => {
      const backup = join(ROOT, `shortcut-${i}.lnk`)
      const had = existsSync(path)
      if (had) copyFileSync(path, backup)
      return { path, backup, had }
    })
  : []
const restoreShortcuts = () => {
  for (const s of shortcuts) {
    try {
      if (s.had) copyFileSync(s.backup, s.path)
      else if (existsSync(s.path)) unlinkSync(s.path)
    } catch {
      // best effort
    }
  }
}

// Fake home: a fake Claude login, so the app never reads (or sends) the real token and never touches ~/.claude
const HOME = join(ROOT, 'home')
mkdirSync(join(HOME, '.claude'), { recursive: true })
writeFileSync(join(HOME, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'e2e-token', expiresAt: Date.now() + 3600_000 } }))

// Local page for the preview webview + a mock of Anthropic's usage endpoint (answers once, then rate limits)
let usageCalls = 0
const fiveReset = new Date(Date.now() + 3 * 3600_000).toISOString()
const web = createServer((q, r) => {
  if (q.url === '/api/oauth/usage') {
    usageCalls++
    if (q.headers.authorization !== 'Bearer e2e-token') return r.writeHead(401).end()
    if (usageCalls > 1) return r.writeHead(429, { 'content-type': 'application/json' }).end('{"error":{"type":"rate_limit_error"}}')
    return r
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ five_hour: { utilization: 42, resets_at: fiveReset }, seven_day: { utilization: 27, resets_at: new Date(Date.now() + 3 * 86400_000).toISOString() }, seven_day_opus: null }))
  }
  r.writeHead(200, { 'content-type': 'text/html' }).end('<html><head><title>preview</title></head><body><h1>hello</h1></body></html>')
})
await new Promise((r) => web.listen(0, '127.0.0.1', r))
const webUrl = `http://127.0.0.1:${web.address().port}/`

const env = {
  ...process.env,
  HOME,
  USERPROFILE: HOME,
  OMNI_CLAUDE_USAGE_URL: `${webUrl}api/oauth/usage`,
  GIT_AUTHOR_NAME: 'Omni E2E',
  GIT_AUTHOR_EMAIL: 'e2e@example.com',
  GIT_COMMITTER_NAME: 'Omni E2E',
  GIT_COMMITTER_EMAIL: 'e2e@example.com'
}
// A stand-in `claude` on PATH, so the Claude limits path runs on machines (CI) without Claude Code installed
const fakeBin = join(ROOT, 'bin')
mkdirSync(fakeBin, { recursive: true })
if (isWin) writeFileSync(join(fakeBin, 'claude.cmd'), '@echo 0.0.0-e2e\r\n')
else writeFileSync(join(fakeBin, 'claude'), '#!/bin/sh\necho 0.0.0-e2e\n', { mode: 0o755 })
const pathKey = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH'
env[pathKey] = `${fakeBin}${isWin ? ';' : ':'}${env[pathKey] ?? ''}`
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
const appFlags = [`--user-data-dir=${PROFILE}`, '--enable-logging']
const [bin, args] = DEV
  ? [process.execPath, [join(REPO, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js'), 'dev', '--remoteDebuggingPort', String(PORT), '--', ...appFlags]]
  : [PACKAGED || createRequire(import.meta.url)('electron'), [...(PACKAGED ? [] : [REPO]), `--remote-debugging-port=${PORT}`, ...appFlags]]
const log = createWriteStream(join(ROOT, 'electron.log'))
const app = spawn(bin, args, { env, cwd: REPO, windowsHide: true, detached: !isWin })
app.stdout.pipe(log)
app.stderr.pipe(log)

const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `  (${String(detail).slice(0, 300)})` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const targets = async () => {
  try {
    return await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  } catch {
    return []
  }
}

try {
  let page
  const isAppPage = (t) => t.type === 'page' && (DEV ? /^http:\/\/(localhost|127\.0\.0\.1):\d+\//.test(t.url) : t.url.startsWith('file:') && t.url.includes('renderer/index.html'))
  for (let i = 0; i < 120 && !page; i++) {
    await sleep(500)
    page = (await targets()).find(isAppPage)
  }
  const appOrigin = new URL(page?.url ?? 'file:///').origin
  if (!page) throw new Error(`the app window never appeared (log: ${join(ROOT, 'electron.log')})`)

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r, j) => (ws.addEventListener('open', r), ws.addEventListener('error', j)))
  let seq = 0
  const pending = new Map()
  ws.addEventListener('message', (m) => {
    const d = JSON.parse(m.data)
    if (d.id && pending.has(d.id)) pending.get(d.id)(d), pending.delete(d.id)
  })
  const cdp = (method, params = {}) =>
    new Promise((r) => {
      const id = ++seq
      pending.set(id, r)
      ws.send(JSON.stringify({ id, method, params }))
    })
  /** Evaluate in the app page; errors come back as { error } */
  const ev = async (code) => {
    const r = await cdp('Runtime.evaluate', {
      expression: `(async () => { try { ${code} } catch (e) { return { error: String(e && e.message || e) } } })()`,
      awaitPromise: true,
      returnByValue: true
    })
    return r.result?.exceptionDetails ? { error: r.result.exceptionDetails.exception?.description ?? 'exception' } : r.result?.result?.value
  }
  const T = async (name, code, ok) => {
    const v = await ev(code)
    check(name, ok(v), JSON.stringify(v))
    return v
  }
  const A = 'window.aihub.call'
  const errMatch = (re) => (v) => Boolean(v && re.test(v.error || ''))
  await sleep(1500)

  console.log('\n── Security boundaries')
  check('isolated profile in use', existsSync(join(PROFILE, 'data')))
  await T('sandboxed preload exposes the bridge', 'return typeof window.aihub + "/" + window.aihub.platform', (v) => v === `object/${process.platform}`)
  await T('no Node globals in the renderer', 'return typeof require + typeof process', (v) => v === 'undefinedundefined')
  await T('fresh install: empty project list, UI rendered', `return [(await ${A}('projects.list')).length, document.body.innerText.trim().length]`, (v) => v?.[0] === 0 && v?.[1] > 20)
  await T('fresh install: no ntfy topic', `return (await ${A}('settings.get')).ntfyTopic`, (v) => v === '')
  await T('prototype walk blocked', `return await ${A}('projects.constructor')`, errMatch(/Unknown API method/))
  await T('__proto__ path rejected', `return await ${A}('__proto__.x')`, errMatch(/Invalid API method/))
  await T('openPath refuses executables', `return await ${A}('app.openPath', ${JSON.stringify(process.execPath)})`, errMatch(/Only folders/))
  if (!DEV) await T('CSP blocks string eval', 'try { setTimeout("window.__ev = 1", 0) } catch {} await new Promise(r => setTimeout(r, 200)); return String(window.__ev)', (v) => v === 'undefined')
  if (!DEV) await T('CSP blocks injected inline script', 'const s = document.createElement("script"); s.textContent = "window.__inl = 1"; document.head.append(s); await new Promise(r => setTimeout(r, 100)); return String(window.__inl)', (v) => v === 'undefined')
  const fileUrl = pathToFileURL(THIS_FILE).href
  const before = (await targets()).length
  const popup = await ev(`return String(window.open(${JSON.stringify(fileUrl)}))`)
  await sleep(800)
  check('window.open denied', popup === 'null' && (await targets()).length === before, popup)
  await ev(`location.href = ${JSON.stringify(fileUrl)}; return 1`)
  await sleep(1000)
  await T('off-app navigation blocked', 'return location.href', (v) => typeof v === 'string' && (DEV ? v.startsWith(appOrigin) : v.includes('renderer/index.html')))

  const picker = await ev(`return await ${A}('app.pickerPreload')`)
  const mkView = (src, preload, id) => `
    const w = document.createElement('webview'); w.id = '${id}'
    w.setAttribute('partition', 'persist:aihub-preview')
    ${preload ? `w.setAttribute('preload', ${JSON.stringify(preload)})` : ''}
    w.setAttribute('src', ${JSON.stringify(src)}); w.style.cssText = 'position:fixed;left:0;top:0;width:300px;height:200px'
    const ready = new Promise(r => { w.addEventListener('dom-ready', () => r('ready'), { once: true }); setTimeout(() => r('timeout'), 6000) })
    document.body.append(w); return await ready`
  const v1 = await T('preview webview loads http pages under the CSP', mkView(webUrl, picker, 'v1'), (v) => v === 'ready')
  if (v1 === 'ready') {
    await T('preview page has no bridge / Node', "return await document.getElementById('v1').executeJavaScript('typeof window.aihub + typeof require + typeof process')", (v) => v === 'undefinedundefinedundefined')
    await T('element-picker preload runs sandboxed', "const w = document.getElementById('v1'); w.send('picker', true); await new Promise(r => setTimeout(r, 300)); return await w.executeJavaScript('document.documentElement.style.cursor')", (v) => v === 'crosshair')
  }
  const v2 = await ev(mkView(webUrl, pathToFileURL(evil).href, 'v2'))
  await T('foreign webview preloads are stripped', v2 === 'ready' ? "await new Promise(r => setTimeout(r, 300)); return await document.getElementById('v2').executeJavaScript('document.title')" : `return ${JSON.stringify(v2)}`, (v) => v === 'preview')
  await T('webview refuses file:// pages', mkView(fileUrl, '', 'v3'), (v) => v === 'timeout')
  await ev("document.querySelectorAll('webview').forEach(w => w.remove()); return 1")

  console.log('\n── Functional API')
  const P = JSON.stringify(PROJ)
  const proj = await T('projects.save', `return await ${A}('projects.save', { name: 'Smoke', folder: ${P} })`, (v) => v?.id > 0)
  const pid = proj?.id
  await T('git.status (not a repo yet)', `return await ${A}('git.status', ${pid})`, (v) => v?.isRepo === false)
  await T('git.init', `return await ${A}('git.init', ${pid})`, (v) => v?.isRepo === true && v?.hasCommits === true)
  await T('git.setRemote rejects ext:: URLs', `return await ${A}('git.setRemote', ${pid}, 'ext::sh -c calc')`, errMatch(/does not look like/))
  await T('projects.files', `return await ${A}('projects.files', ${pid})`, (v) => Array.isArray(v) && v.some((f) => /index\.js/.test(f)))
  await T('knowledge.scanRepo', `return (await ${A}('knowledge.scanRepo', ${pid})).length`, (v) => v >= 1)
  await T('knowledge save/list/delete', `const e = await ${A}('knowledge.save', { project_id: ${pid}, title: 'Note', content: 'hello', category: 'notes' }); const n = (await ${A}('knowledge.list', ${pid})).length; await ${A}('knowledge.delete', e.id); return n`, (v) => v >= 2)
  await T('rules save/get', `await ${A}('rules.save', ${pid}, '- be nice'); return (await ${A}('rules.get', ${pid})).text`, (v) => v === '- be nice')
  await T('projects.estimate', `return await ${A}('projects.estimate', { projectId: ${pid}, cli: 'claude', prompt: 'add a test' })`, (v) => v?.tokens > 0)
  const task = await T('projects.createAndRun (queued, not started)', `return await ${A}('projects.createAndRun', { projectId: ${pid}, prompt: 'say hi', kind: 'task', cli: 'claude', model: 'claude-opus-5-5', permissionMode: 'plan', checkoutMode: 'local', startImmediately: false })`, (v) => v?.id > 0 && !v.run_state)
  if (task?.id) {
    await T('projects.saveTask', `return (await ${A}('projects.saveTask', { id: ${task.id}, title: 'Renamed', notes: 'n' })).title`, (v) => v === 'Renamed')
    await T('projects.setStatus', `return (await ${A}('projects.setStatus', ${task.id}, 'done')).status`, (v) => v === 'done')
    await T('projects.log', `return Array.isArray(await ${A}('projects.log', ${task.id}))`, (v) => v === true)
    await T('projects.deleteTask', `return await ${A}('projects.deleteTask', ${task.id})`, (v) => v === true)
  }
  await T('schedules save/toggle/delete', `const s = await ${A}('schedules.save', { project_id: ${pid}, title: 'Nightly', prompt: 'x', kind: 'daily', time_of_day: '03:00', cli: 'claude', model: '', effort: 'medium', permission_mode: 'plan' }); await ${A}('schedules.toggle', s.id); await ${A}('schedules.delete', s.id); return s.next_run_at > Date.now()`, (v) => v === true)
  await T('accounts add/list/remove', `const a = await ${A}('accounts.add', 'claude', 'Second'); const n = (await ${A}('accounts.list')).length; await ${A}('accounts.remove', a.id); return [n, a.authenticated, (await ${A}('accounts.list')).length]`, (v) => v?.[0] === 1 && v?.[1] === false && v?.[2] === 0)
  await T('accounts.add rejects unsupported CLIs', `return await ${A}('accounts.add', 'agy', 'x')`, errMatch(/supported/))
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
  await T('attachments save/read (file name sanitised)', `const p = await ${A}('attachments.saveImage', '${png}', '../../evil name'); const d = await ${A}('attachments.readImage', p); return [p, d.startsWith('data:image/png')]`, (v) => v?.[1] === true && !/\.\.[\\/]/.test(v[0]))
  await T('attachments reject non-images', `return await ${A}('attachments.saveImage', 'data:text/html;base64,PGgxPg==')`, errMatch(/Only PNG/))
  await T('readImage refuses non-image files', `return await ${A}('attachments.readImage', ${JSON.stringify(THIS_FILE)})`, errMatch(/not found/))
  await T('history.search', `return Array.isArray(await ${A}('history.search', 'hello'))`, (v) => v === true)
  await T('settings roundtrip, unknown keys ignored', `const s = await ${A}('settings.update', { kbPromptMode: 'full', evil: 1 }); await ${A}('settings.update', { kbPromptMode: 'compact' }); return [s.kbPromptMode, 'evil' in s]`, (v) => v?.[0] === 'full' && v?.[1] === false)
  await T('ntfy rejects invalid topics', `await ${A}('settings.update', { ntfyTopic: 'bad topic!' }); try { await ${A}('schedules.testPhone') } finally { await ${A}('settings.update', { ntfyTopic: '' }) }`, errMatch(/not a valid ntfy topic/))
  await T('skills.list', `return Array.isArray(await ${A}('skills.list', ${pid}))`, (v) => v === true)
  await T('skills.install rejects http:// and ..', `const r = []; for (const u of ['http://example.com/SKILL.md', 'https://github.com/a/b/tree/main/../../x']) { try { await ${A}('skills.install', u, ['claude']); r.push('installed') } catch (e) { r.push(e.message) } } return r`, (v) => /https/.test(v?.[0]) && /not valid/.test(v?.[1]))
  await T('skills.remove refuses folders outside skill dirs', `return await ${A}('skills.remove', ${JSON.stringify(join(PROJ, 'SKILL.md'))})`, errMatch(/Only installed/))
  await T('mcp.add rejects bad env var names', `return await ${A}('mcp.add', { name: 'x', type: 'stdio', command: 'node', env: { 'A = 1\\n[evil]': 'v' } }, ['codex'])`, errMatch(/not a valid environment variable/))
  await T('mcp.list', `return Array.isArray(await ${A}('mcp.list'))`, (v) => v === true)
  const st = await T('clis.statusAll', `return (await ${A}('clis.statusAll')).map((c) => c.id + ':' + (c.installed ? 'installed' : 'missing') + ':' + (c.authenticated ? 'signed-in' : 'signed-out'))`, (v) => Array.isArray(v) && v.length === 4)
  console.log(`      detected: ${JSON.stringify(st)}`)
  // Provider usage endpoints are rate limited: a repeat (even forced) refresh must be served from cache, not refetched
  const claudeLimit = `const l = (await ${A}('clis.statusAll', FORCE)).find((c) => c.id === 'claude').limit; return [l.source, l.utilizationPct, l.weeklyUtilizationPct ?? null, l.liveNote ?? '']`
  const first = await ev(claudeLimit.replace('FORCE', 'false'))
  check('Claude live limits read from the usage endpoint', first?.[0] === 'live' && first[1] === 42 && first[2] === 27 && /Live from Anthropic · updated just now/.test(first[3]), JSON.stringify(first))
  const again = await ev(claudeLimit.replace('FORCE', 'true'))
  const again2 = await ev(claudeLimit.replace('FORCE', 'false'))
  check('repeat and forced refreshes are served from cache (no refetch)', usageCalls === 1 && JSON.stringify(first) === JSON.stringify(again) && JSON.stringify(again) === JSON.stringify(again2), `${usageCalls} calls ${JSON.stringify([again, again2])}`)
  console.log(`      claude limit: ${JSON.stringify(first)}`)
  await T('updates.check', `return await ${A}('updates.check', false)`, (v) => (PACKAGED ? v?.supported === false && /installed build/.test(v.reason) : v?.supported === true))
  await T('terminal start/send/output/stop', `
    let out = ''; const off = window.aihub.onTerminalOutput((e) => { if (e.sessionId === 'smoke') out += e.data })
    await ${A}('terminal.start', 'smoke', ${P}, '', 100, 30)
    await new Promise(r => setTimeout(r, 2500))
    await ${A}('terminal.send', 'smoke', 'echo OMNI_SMOKE_OK')
    for (let i = 0; i < 60 && !/OMNI_SMOKE_OK[\\s\\S]*OMNI_SMOKE_OK/.test(out); i++) await new Promise(r => setTimeout(r, 250))
    await ${A}('terminal.stop', 'smoke'); off(); return /OMNI_SMOKE_OK[\\s\\S]*OMNI_SMOKE_OK/.test(out)`, (v) => v === true)
  await T('projects archive + delete', `await ${A}('projects.archive', ${pid}, true); return await ${A}('projects.delete', ${pid})`, (v) => v === true)
  ws.close()
} catch (e) {
  check('harness', false, e.message)
} finally {
  if (isWin) spawnSync('taskkill', ['/pid', String(app.pid), '/T', '/F'], { windowsHide: true })
  else {
    try {
      process.kill(-app.pid, 'SIGKILL')
    } catch {
      app.kill('SIGKILL')
    }
  }
  web.close()
  await sleep(1000)
  restoreShortcuts()
  const failed = results.filter((ok) => !ok).length
  console.log(`\n${results.length - failed}/${results.length} passed${failed ? `  (app log: ${join(ROOT, 'electron.log')})` : ''}`)
  if (!failed) rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  process.exit(failed ? 1 : 0)
}
