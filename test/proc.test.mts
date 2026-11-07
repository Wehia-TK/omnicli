import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { execCli, quoteCmdArg, resolveCliCommand } from '../src/core/proc.ts'

const isWin = process.platform === 'win32'

/** Arguments that would break out of naive cmd.exe quoting or get mangled on the way. */
const NASTY = [
  'hello" & echo PWNED & "',
  'a%PATH%b',
  '%COMSPEC%',
  'multi\nline',
  '^caret!bang',
  'back\\slash\\',
  '"quoted"',
  '<>|&',
  'semi;colon,comma',
  '',
  'C:\\Program Files\\x y\\',
  'unicode — ✓ 日本'
]

describe('quoteCmdArg', () => {
  it('quotes and caret-escapes cmd metacharacters', () => {
    assert.equal(quoteCmdArg('plain'), '^^^"plain^^^"')
    assert.ok(!/(?<!\^)&/.test(quoteCmdArg('a & b')), 'every & is escaped')
  })
  it('turns newlines into spaces (cmd.exe cannot carry them)', () => {
    assert.ok(!quoteCmdArg('a\nb').includes('\n'))
  })
})

describe('resolveCliCommand', () => {
  it('runs non-batch executables directly', () => {
    assert.deepEqual(resolveCliCommand('/usr/bin/claude', ['-p']), { file: '/usr/bin/claude', args: ['-p'], verbatim: false })
  })
})

describe('Windows batch shims', { skip: !isWin && 'Windows only' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'omni-proc-'))
  const echo = 'process.stdout.write(JSON.stringify(process.argv.slice(2)))'
  mkdirSync(join(dir, 'node_modules', 'fake'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', 'fake', 'cli.js'), echo)
  writeFileSync(join(dir, 'echo.js'), echo)
  // Exactly what npm's cmd-shim generates for a global install
  writeFileSync(
    join(dir, 'fake.cmd'),
    [
      '@ECHO off',
      'GOTO start',
      ':find_dp0',
      'SET dp0=%~dp0',
      'EXIT /b',
      ':start',
      'SETLOCAL',
      'CALL :find_dp0',
      'IF EXIST "%dp0%\\node.exe" (',
      '  SET "_prog=%dp0%\\node.exe"',
      ') ELSE (',
      '  SET "_prog=node"',
      '  SET PATHEXT=%PATHEXT:;.JS;=;%',
      ')',
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\fake\\cli.js" %*',
      ''
    ].join('\r\n')
  )
  // A hand-written batch file that is not an npm shim → cmd.exe fallback path
  writeFileSync(join(dir, 'plain.bat'), '@node "%~dp0echo.js" %*\r\n')

  const run = (exe: string): Promise<string[]> =>
    new Promise((resolve, reject) => execCli(exe, NASTY, {}, (err, out) => (err ? reject(err) : resolve(JSON.parse(out) as string[]))))

  it('npm shims run the wrapped script directly, every byte intact', async () => {
    assert.equal(resolveCliCommand(join(dir, 'fake.cmd'), []).verbatim, false)
    assert.deepEqual(await run(join(dir, 'fake.cmd')), NASTY)
  })

  it('other batch files go through cmd.exe without injection', async () => {
    assert.equal(resolveCliCommand(join(dir, 'plain.bat'), []).verbatim, true)
    assert.deepEqual(
      await run(join(dir, 'plain.bat')),
      NASTY.map((a) => a.replace(/\n/g, ' '))
    )
  })
})
