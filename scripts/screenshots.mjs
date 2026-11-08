#!/usr/bin/env node
/**
 * Regenerates the README screenshots in docs/screenshots/.
 *
 * Launches the built app in a throw-away profile with a fake home folder (so no real logins, projects or tokens are
 * ever shown), seeds a small demo project with a conversation, knowledge-base notes and queued tasks, then captures
 * each view over the Chrome DevTools Protocol. No AI runs are started.
 *
 *   npm run build && node scripts/screenshots.mjs
 */
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(REPO, 'docs', 'screenshots')
const isWin = process.platform === 'win32'
const ROOT = mkdtempSync(join(tmpdir(), 'omni-shots-'))
const PROFILE = join(ROOT, 'profile')
const PROJ = join(ROOT, 'acme-storefront')
const PORT = 9300 + Math.floor(Math.random() * 600)
const W = 1440
const H = 900
const only = process.argv.slice(2).filter((a) => !a.startsWith('--'))

if (!existsSync(join(REPO, 'out', 'main', 'index.js'))) {
  console.error('Build first: npm run build')
  process.exit(2)
}
mkdirSync(OUT, { recursive: true })

const git = (...args) => spawnSync('git', ['-C', PROJ, ...args], { encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_AUTHOR_NAME: 'Demo', GIT_AUTHOR_EMAIL: 'demo@example.com', GIT_COMMITTER_NAME: 'Demo', GIT_COMMITTER_EMAIL: 'demo@example.com' } })
const put = (rel, text) => {
  mkdirSync(dirname(join(PROJ, rel)), { recursive: true })
  writeFileSync(join(PROJ, rel), text)
}

// ── Demo project: a small storefront with history and some uncommitted work
put('package.json', JSON.stringify({ name: 'acme-storefront', private: true, scripts: { dev: 'vite', test: 'vitest run' }, dependencies: { react: '^19.0.0', 'react-dom': '^19.0.0' }, devDependencies: { vite: '^8.0.0', vitest: '^4.0.0' } }, null, 2))
put('README.md', '# Acme Storefront\n\nA small React storefront used as an Omni CLI demo.\n')
put('src/main.tsx', "import { createRoot } from 'react-dom/client'\nimport { App } from './App'\n\ncreateRoot(document.getElementById('root')!).render(<App />)\n")
put('src/App.tsx', "import { Cart } from './cart/Cart'\nimport { ProductGrid } from './products/ProductGrid'\n\nexport function App() {\n  return (\n    <main>\n      <ProductGrid />\n      <Cart />\n    </main>\n  )\n}\n")
put('src/cart/cart.ts', "export interface Line { sku: string; price: number; qty: number }\n\nexport function total(lines: Line[]): number {\n  return lines.reduce((sum, l) => sum + l.price * l.qty, 0)\n}\n")
put('src/cart/Cart.tsx', "export function Cart() {\n  return <aside>Cart</aside>\n}\n")
put('src/products/ProductGrid.tsx', "export function ProductGrid() {\n  return <section>Products</section>\n}\n")
put('src/api/client.ts', "export async function get<T>(path: string): Promise<T> {\n  const r = await fetch(`/api${path}`)\n  return r.json()\n}\n")
git('init', '-q', '-b', 'main')
git('add', '-A')
git('commit', '-q', '-m', 'Initial storefront skeleton')
put('src/cart/cart.test.ts', "import { expect, test } from 'vitest'\nimport { total } from './cart'\n\ntest('sums lines', () => {\n  expect(total([{ sku: 'a', price: 5, qty: 2 }])).toBe(10)\n})\n")
git('add', '-A')
git('commit', '-q', '-m', 'test: cover cart totals')
// Uncommitted: the change the demo conversation talks about
put('src/cart/cart.ts', "export interface Line { sku: string; price: number; qty: number }\n\n/** Prices are in cents; discounts are applied per line and never go below zero. */\nexport function total(lines: Line[], discountPct = 0): number {\n  const pct = Math.min(Math.max(discountPct, 0), 100)\n  return lines.reduce((sum, l) => sum + Math.round(l.price * l.qty * (1 - pct / 100)), 0)\n}\n")
put('src/cart/cart.test.ts', "import { expect, test } from 'vitest'\nimport { total } from './cart'\n\ntest('sums lines', () => {\n  expect(total([{ sku: 'a', price: 500, qty: 2 }])).toBe(1000)\n})\n\ntest('applies a percentage discount', () => {\n  expect(total([{ sku: 'a', price: 500, qty: 2 }], 10)).toBe(900)\n})\n\ntest('clamps discounts to 0–100%', () => {\n  expect(total([{ sku: 'a', price: 500, qty: 1 }], 150)).toBe(0)\n})\n")

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

// Fake home with a fake Claude login, and a mock of Anthropic's usage endpoint
const HOME = join(ROOT, 'home')
mkdirSync(join(HOME, '.claude'), { recursive: true })
writeFileSync(join(HOME, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'demo-token', expiresAt: Date.now() + 3600_000 } }))
const web = createServer((q, r) => {
  if (q.url === '/api/oauth/usage')
    return r.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        five_hour: { utilization: 38, resets_at: new Date(Date.now() + 2.6 * 3600_000).toISOString() },
        seven_day: { utilization: 21, resets_at: new Date(Date.now() + 4.3 * 86400_000).toISOString() },
        seven_day_opus: null
      })
    )
  r.writeHead(200, { 'content-type': 'text/html' }).end(
    '<html><head><title>Acme</title><style>body{font-family:system-ui;margin:0;background:#fafafa}header{padding:20px 32px;background:#111;color:#fff;font-weight:600}main{display:grid;grid-template-columns:repeat(3,1fr);gap:20px;padding:32px}div{background:#fff;border-radius:12px;padding:20px;box-shadow:0 1px 3px #0002}b{display:block;height:120px;border-radius:8px;background:linear-gradient(135deg,#c7d2fe,#fbcfe8);margin-bottom:12px}</style></head><body><header>Acme Storefront</header><main><div><b></b>Desk lamp · $49</div><div><b></b>Notebook · $12</div><div><b></b>Headphones · $129</div></main></body></html>'
  )
})
await new Promise((r) => web.listen(0, '127.0.0.1', r))
const webUrl = `http://127.0.0.1:${web.address().port}/`

const env = { ...process.env, HOME, USERPROFILE: HOME, OMNI_CLAUDE_USAGE_URL: `${webUrl}api/oauth/usage` }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
const app = spawn(createRequire(import.meta.url)('electron'), [REPO, `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`], { env, cwd: REPO, windowsHide: true, detached: !isWin })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let ok = true
try {
  let page
  for (let i = 0; i < 120 && !page; i++) {
    await sleep(500)
    try {
      page = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page' && t.url.includes('renderer/index.html'))
    } catch {
      // not up yet
    }
  }
  if (!page) throw new Error('the app window never appeared')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((r, j) => (ws.addEventListener('open', r), ws.addEventListener('error', j)))
  let seq = 0
  const pending = new Map()
  ws.addEventListener('message', (m) => {
    const d = JSON.parse(m.data)
    if (d.id && pending.has(d.id)) pending.get(d.id)(d), pending.delete(d.id)
  })
  const cdp = (method, params = {}) => new Promise((r) => {
    const id = ++seq
    pending.set(id, r)
    ws.send(JSON.stringify({ id, method, params }))
  })
  const ev = async (code) => {
    const r = await cdp('Runtime.evaluate', { expression: `(async () => { ${code} })()`, awaitPromise: true, returnByValue: true })
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? 'exception')
    return r.result?.result?.value
  }
  const A = 'window.aihub.call'
  /** Click the first visible button/element whose text contains `text` */
  const click = (text, sel = 'button') =>
    ev(`const el = [...document.querySelectorAll(${JSON.stringify(sel)})].find((b) => b.offsetParent && b.innerText.includes(${JSON.stringify(text)})); if (!el) throw new Error('no ${sel} with text ${text}'); el.click(); return true`)
  /** Hide machine-specific paths (temp folder, user name) from the shots */
  const mask = () =>
    ev(`const subs = [[${JSON.stringify(PROJ)}, '~/code/acme-storefront'], [${JSON.stringify(homedir())}, '~']]
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
      for (let n; (n = w.nextNode()); ) for (const [a, b] of subs) if (n.nodeValue.includes(a)) n.nodeValue = n.nodeValue.split(a).join(b)
      return 1`)
  const tab = (text) => click(text, '.segmented button')
  const shoot = async (name) => {
    await sleep(900)
    await mask()
    const r = await cdp('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(OUT, `${name}.png`), Buffer.from(r.result.data, 'base64'))
    console.log(`saved docs/screenshots/${name}.png`)
  }
  await cdp('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1.5, mobile: false })
  await sleep(1500)

  // ── Seed
  const P = JSON.stringify(PROJ)
  const pid = (await ev(`return (await ${A}('projects.save', { name: 'Acme Storefront', folder: ${P}, check_cmd: 'npm test' })).id`))
  await ev(`return (await ${A}('knowledge.scanRepo', ${pid})).length`)
  const notes = [
    ['conventions', 'Money is always in cents', 'All prices and totals are integers in cents. Format only at the edge (`formatPrice`). Never use floats for money.'],
    ['decisions', 'Vitest over Jest', 'Chosen for native ESM + Vite config reuse. Tests live next to the code as `*.test.ts`.'],
    ['architecture', 'Cart module', '`src/cart/cart.ts` holds the pure pricing logic; `Cart.tsx` only renders. Discounts are per-line and clamped to 0–100%.']
  ]
  for (const [category, title, content] of notes) await ev(`return await ${A}('knowledge.save', { project_id: ${pid}, title: ${JSON.stringify(title)}, content: ${JSON.stringify(content)}, category: '${category}' })`)
  await ev(`return await ${A}('rules.save', ${pid}, '- Keep money in integer cents\\n- Add a test for every bug fix\\n- Run npm test before finishing')`)

  const mk = (o) => ev(`return (await ${A}('projects.createAndRun', ${JSON.stringify({ projectId: pid, permissionMode: 'accept-edits', checkoutMode: 'local', startImmediately: false, ...o })})).id`)
  const thread = await mk({ prompt: 'Add percentage discounts to the cart total', kind: 'thread', cli: 'claude', model: 'claude-opus-5-5' })
  await mk({ prompt: 'Add a currency formatter and use it in Cart.tsx', kind: 'task', cli: 'codex', model: '' })
  await mk({ prompt: 'Write e2e tests for checkout with Playwright', kind: 'task', cli: 'claude', model: 'claude-sonnet-5-5' })
  await mk({ prompt: 'Audit dependencies and bump anything outdated', kind: 'task', cli: 'agy', model: '' })

  const now = new Date()
  const at = (s) => new Date(now.getTime() - s * 1000).toLocaleString('sv-SE').replace('T', ' ')
  const m = 'claude-opus-5-5 (high)'
  const log = [
    { at: at(140), kind: 'you', text: 'Add percentage discounts to the cart total. Clamp them to 0–100% and keep everything in cents.' },
    { at: at(138), kind: 'info', text: 'Claude Code (claude-opus-5-5 · high effort) started in local checkout', cli: 'claude', model: m },
    { at: at(135), kind: 'thinking', text: 'The knowledge base says money is in integer cents, so I should round per line rather than on the final sum. I will add an optional discountPct argument to total() so existing callers keep working, then extend the existing Vitest file.', cli: 'claude', model: m },
    { at: at(130), kind: 'tool', text: 'Read src/cart/cart.ts', cli: 'claude', model: m },
    { at: at(128), kind: 'tool', text: 'Read src/cart/cart.test.ts', cli: 'claude', model: m },
    { at: at(110), kind: 'tool', text: 'Edit src/cart/cart.ts', cli: 'claude', model: m },
    { at: at(100), kind: 'tool', text: 'Edit src/cart/cart.test.ts', cli: 'claude', model: m },
    { at: at(90), kind: 'tool', text: '$ npm test', cli: 'claude', model: m },
    { at: at(80), kind: 'info', text: 'Checks passed ✓', cli: 'claude', model: m },
    {
      at: at(78),
      kind: 'text',
      text: 'Done. `total()` now takes an optional `discountPct`:\n\n- The discount is clamped to **0–100%** and applied per line, rounding to whole cents so totals stay integers.\n- Existing calls are unchanged (the default is `0`).\n- Added two tests: a 10% discount and an out-of-range value. All 3 tests pass.\n\nI also fixed the first test, which used dollars instead of cents.',
      cli: 'claude',
      model: m
    }
  ]
  mkdirSync(join(PROFILE, 'data', 'project-logs'), { recursive: true })
  writeFileSync(join(PROFILE, 'data', 'project-logs', `task-${thread}.log`), log.map((l) => JSON.stringify(l)).join('\n') + '\n')
  await ev(`await ${A}('projects.saveTask', { id: ${thread}, title: 'Add percentage discounts to the cart', notes: '' }); return await ${A}('projects.setStatus', ${thread}, 'done')`)
  await ev('location.reload(); return 1')
  await sleep(3500)
  await cdp('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1.5, mobile: false })

  for (let i = 0; i < 40 && !(await ev("return document.body.innerText.includes('Limits')")); i++) await sleep(500)
  const want = (n) => !only.length || only.includes(n)
  if (process.argv.includes('--dump')) console.log(await ev('return document.body.innerText'))

  // ── Scenes
  await click('Acme Storefront').catch(() => {})
  await click('Add percentage discount').catch(() => {})
  const toBottom = () => ev("for (const el of document.querySelectorAll('*')) if (el.scrollHeight > el.clientHeight + 40 && getComputedStyle(el).overflowY.match(/auto|scroll/) && el.closest('main, .flex-1')) el.scrollTop = el.scrollHeight; return 1")
  if (want('workspace')) {
    await sleep(800)
    await toBottom()
    await shoot('workspace')
  }
  if (want('changes')) {
    await click('Changes (')
    await sleep(600)
    await click('src/cart/cart.ts', 'button, [role=button], div.cursor-pointer, li').catch((e) => console.log(String(e)))
    await shoot('changes')
    await click('Live Stream (')
  }
  if (want('queue')) {
    await tab('Task Queue')
    await shoot('task-queue')
  }
  if (want('knowledge')) {
    await tab('Knowledge Base')
    await click('Conventions', 'button').catch(() => {})
    await shoot('knowledge-base')
    await click('All (', 'button').catch(() => {})
  }
  if (want('limits')) {
    await tab('Agent Workspace')
    await click('Limits')
    await shoot('live-limits')
  }
  ws.close()
} catch (e) {
  ok = false
  console.error(e)
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
  for (const s of shortcuts) {
    try {
      if (s.had) copyFileSync(s.backup, s.path)
      else if (existsSync(s.path)) unlinkSync(s.path)
    } catch {
      // best effort
    }
  }
  rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  process.exit(ok ? 0 : 1)
}
