import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, it } from 'node:test'
import { canOpenPath, isAllowedWebviewSrc, isAppUrl, isValidApiPath, resolveApiMethod, safeExternalUrl, samePath } from '../src/main/security.ts'

const html = join(tmpdir(), 'Omni App', 'out', 'renderer', 'index.html')

describe('isAppUrl', () => {
  it('accepts the built index.html (with hash/query)', () => {
    assert.equal(isAppUrl(pathToFileURL(html).href, html), true)
    assert.equal(isAppUrl(`${pathToFileURL(html).href}#/projects/1`, html), true)
  })
  it('accepts the dev server origin only when one is configured', () => {
    assert.equal(isAppUrl('http://localhost:5173/src/x', html, 'http://localhost:5173/'), true)
    assert.equal(isAppUrl('http://localhost:5173/', html), false)
    assert.equal(isAppUrl('http://localhost:5174/', html, 'http://localhost:5173/'), false)
  })
  it('rejects other files and remote pages', () => {
    assert.equal(isAppUrl(pathToFileURL(join(tmpdir(), 'evil.html')).href, html), false)
    assert.equal(isAppUrl('https://example.com/', html), false)
    assert.equal(isAppUrl('not a url', html), false)
  })
})

describe('safeExternalUrl', () => {
  it('allows web and mail links', () => {
    assert.equal(safeExternalUrl('https://github.com/x'), 'https://github.com/x')
    assert.equal(safeExternalUrl('http://localhost:3000'), 'http://localhost:3000/')
    assert.equal(safeExternalUrl('mailto:a@b.c'), 'mailto:a@b.c')
  })
  it('refuses file, script and custom schemes', () => {
    for (const u of ['file:///C:/Windows/System32/calc.exe', 'javascript:alert(1)', 'ms-settings:', 'smb://host/share', 'nonsense']) {
      assert.equal(safeExternalUrl(u), null, u)
    }
  })
})

describe('isAllowedWebviewSrc', () => {
  it('only http(s) and about:blank', () => {
    assert.equal(isAllowedWebviewSrc('http://127.0.0.1:5173'), true)
    assert.equal(isAllowedWebviewSrc('https://example.com'), true)
    assert.equal(isAllowedWebviewSrc('about:blank'), true)
    assert.equal(isAllowedWebviewSrc('file:///etc/passwd'), false)
    assert.equal(isAllowedWebviewSrc('data:text/html,<script>1</script>'), false)
    assert.equal(isAllowedWebviewSrc('javascript:1'), false)
  })
})

describe('canOpenPath', () => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-open-'))
  const img = join(dir, 'a.png')
  const exe = join(dir, 'a.exe')
  writeFileSync(img, 'x')
  writeFileSync(exe, 'x')
  it('opens folders and images', () => {
    assert.equal(canOpenPath(dir), true)
    assert.equal(canOpenPath(img), true)
  })
  it('never opens executables or missing paths', () => {
    assert.equal(canOpenPath(exe), false)
    assert.equal(canOpenPath(join(dir, 'missing.png')), false)
    assert.equal(canOpenPath(process.execPath), false)
  })
})

describe('API method resolution', () => {
  const api = { projects: { list: () => 'ok', nested: { deep: () => 'deep' } } }
  it('resolves own methods', () => {
    assert.equal(resolveApiMethod(api, 'projects.list')?.(), 'ok')
    assert.equal(resolveApiMethod(api, 'projects.nested.deep')?.(), 'deep')
  })
  it('never walks into prototypes or non-functions', () => {
    for (const p of ['projects.constructor', 'projects.toString', 'projects.hasOwnProperty', 'projects.nested', 'projects.missing', 'constructor.constructor']) {
      assert.equal(resolveApiMethod(api, p), null, p)
    }
  })
  it('validates the path shape', () => {
    for (const p of ['__proto__.x', 'projects', 'projects..list', 'projects.list()', '', 42, null]) assert.equal(isValidApiPath(p), false, String(p))
    assert.equal(isValidApiPath('app.openPath'), true)
  })
})

describe('samePath', () => {
  it('is case-insensitive on Windows only', () => {
    assert.equal(samePath('C:\\A\\b.js', 'c:\\a\\B.js', 'win32'), true)
    assert.equal(samePath('/a/b.js', '/a/../a/b.js', 'linux'), true)
    assert.equal(samePath('/a/B.js', '/a/b.js', 'linux'), false)
  })
})
