import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Voice input.
 *
 * Preferred engine: NVIDIA Parakeet TDT 0.6B (int8, via sherpa-onnx) — near-Whisper-large accuracy and ~0.5 s
 * per utterance on CPU. It reuses the model + Python venv that Voice Studio already downloaded, so nothing new
 * is fetched. The renderer records the mic (16 kHz mono) and sends the samples here; a persistent Python worker
 * keeps the model loaded between dictations.
 *
 * Fallback (Windows only, when Parakeet isn't installed): the built-in offline System.Speech recognizer —
 * much less accurate. Electron's Web Speech API has no backend, so it can't be used.
 */

export type VoiceEngine = 'parakeet' | 'system' | 'none'

const VOICE_STUDIO_ROOTS = [
  process.env.OMNI_VOICE_STUDIO,
  'D:\\Voice Studio\\VoiceStudio',
  'C:\\Voice Studio\\VoiceStudio',
  join(homedir(), 'Voice Studio', 'VoiceStudio')
].filter((p): p is string => Boolean(p))

interface ParakeetSetup {
  python: string
  modelDir: string
}

let setupCache: ParakeetSetup | null | undefined

function findParakeet(): ParakeetSetup | null {
  if (setupCache !== undefined) return setupCache
  setupCache = null
  for (const root of VOICE_STUDIO_ROOTS) {
    const python =
      process.platform === 'win32' ? join(root, 'project', '.venv', 'Scripts', 'python.exe') : join(root, 'project', '.venv', 'bin', 'python')
    const snapshots = join(root, 'models', 'models--csukuangfj--sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8', 'snapshots')
    if (!existsSync(python) || !existsSync(snapshots)) continue
    for (const snap of readdirSync(snapshots)) {
      const dir = join(snapshots, snap)
      if (['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt'].every((f) => existsSync(join(dir, f)))) {
        setupCache = { python, modelDir: dir }
        return setupCache
      }
    }
  }
  return setupCache
}

// ── Parakeet worker (persistent Python process, newline-delimited JSON over stdio) ──────────────────────────

const WORKER_PY = `
import sys, json, base64, os
sys.stdout.reconfigure(encoding='utf-8')
import numpy as np
import sherpa_onnx
d = sys.argv[1]
rec = sherpa_onnx.OfflineRecognizer.from_transducer(
    encoder=os.path.join(d, 'encoder.int8.onnx'), decoder=os.path.join(d, 'decoder.int8.onnx'),
    joiner=os.path.join(d, 'joiner.int8.onnx'), tokens=os.path.join(d, 'tokens.txt'),
    model_type='nemo_transducer', num_threads=max(1, min(8, (os.cpu_count() or 4) // 2)))
print(json.dumps({'ready': True}), flush=True)
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    req = {}
    try:
        req = json.loads(line)
        pcm = np.frombuffer(base64.b64decode(req['pcm']), dtype=np.float32)
        # 0.3 s of trailing silence helps the transducer finalize the last word
        pcm = np.concatenate([pcm, np.zeros(4800, dtype=np.float32)])
        s = rec.create_stream()
        s.accept_waveform(16000, pcm)
        rec.decode_stream(s)
        print(json.dumps({'id': req.get('id'), 'text': s.result.text.strip()}), flush=True)
    except Exception as e:
        print(json.dumps({'id': req.get('id'), 'error': str(e)}), flush=True)
`

let worker: ChildProcess | null = null
let workerReady: Promise<void> | null = null
let nextId = 1
const pending = new Map<number, { resolve: (t: string) => void; reject: (e: Error) => void }>()

function workerScriptPath(): string {
  const dir = join(tmpdir(), 'omni-cli')
  mkdirSync(dir, { recursive: true })
  const p = join(dir, 'parakeet_worker.py')
  writeFileSync(p, WORKER_PY)
  return p
}

function startWorker(setup: ParakeetSetup): Promise<void> {
  if (workerReady) return workerReady
  workerReady = new Promise<void>((resolve, reject) => {
    const child = spawn(setup.python, ['-u', workerScriptPath(), setup.modelDir], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONWARNINGS: 'ignore' }
    })
    worker = child
    let buf = ''
    let errTail = ''
    let ready = false
    child.stdout?.on('data', (d) => {
      buf += d.toString()
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line.startsWith('{')) continue
        try {
          const msg = JSON.parse(line) as { ready?: boolean; id?: number; text?: string; error?: string }
          if (msg.ready) {
            ready = true
            resolve()
            continue
          }
          const p = msg.id != null ? pending.get(msg.id) : undefined
          if (!p) continue
          pending.delete(msg.id!)
          if (msg.error) p.reject(new Error(`Transcription failed: ${msg.error}`))
          else p.resolve(msg.text ?? '')
        } catch {
          /* ignore non-JSON output */
        }
      }
    })
    child.stderr?.on('data', (d) => (errTail = (errTail + d.toString()).slice(-2000)))
    child.stdin?.on('error', () => undefined)
    const fail = (why: string): void => {
      if (worker === child) {
        worker = null
        workerReady = null
      }
      const err = new Error(why)
      for (const p of pending.values()) p.reject(err)
      pending.clear()
      if (!ready) reject(err)
    }
    child.on('error', (e) => fail(`Could not start the speech model: ${e.message}`))
    child.on('close', (code) => {
      const last = errTail.trim().split(/\r?\n/).filter(Boolean).pop() ?? ''
      fail(`Speech model stopped (exit ${code})${last ? `: ${last}` : ''}`)
    })
  })
  return workerReady
}

// ── Windows System.Speech fallback ─────────────────────────────────────────────────────────────────────────

let sysProc: ChildProcess | null = null
let sysKillTimer: NodeJS.Timeout | null = null

const SYSTEM_SCRIPT = `
$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Speech
  $r = New-Object System.Speech.Recognition.SpeechRecognitionEngine
  $r.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
  $r.SetInputToDefaultAudioDevice()
  Register-ObjectEvent -InputObject $r -EventName SpeechRecognized -SourceIdentifier omniSr | Out-Null
  $r.RecognizeAsync([System.Speech.Recognition.RecognizeMode]::Multiple)
  $stopLine = [Console]::In.ReadLineAsync()
  $deadline = (Get-Date).AddMinutes(2)
  function Flush { foreach ($ev in @(Get-Event -SourceIdentifier omniSr -ErrorAction SilentlyContinue)) { [Console]::Out.WriteLine($ev.SourceEventArgs.Result.Text); [Console]::Out.Flush(); Remove-Event -EventIdentifier $ev.EventIdentifier } }
  while (-not $stopLine.IsCompleted -and (Get-Date) -lt $deadline) { Flush; Start-Sleep -Milliseconds 150 }
  $r.RecognizeAsyncStop()
  Start-Sleep -Milliseconds 900
  Flush
  exit 0
} catch {
  [Console]::Error.Write($_.Exception.Message)
  exit 2
}
`

export const voice = {
  /** Which engine voice input will use on this machine. */
  engine: (): VoiceEngine => (findParakeet() ? 'parakeet' : process.platform === 'win32' ? 'system' : 'none'),

  /** Load the Parakeet model ahead of time (called when the user starts recording, so it's warm by the time they stop). */
  warmup: async (): Promise<true> => {
    const setup = findParakeet()
    if (!setup) throw new Error('Parakeet speech model not found')
    await startWorker(setup)
    return true
  },

  /** Transcribe 16 kHz mono float32 PCM recorded by the renderer. */
  transcribe: async (pcm: Float32Array | ArrayBuffer | Uint8Array): Promise<string> => {
    const setup = findParakeet()
    if (!setup) throw new Error('Parakeet speech model not found')
    await startWorker(setup)
    const bytes =
      pcm instanceof ArrayBuffer ? Buffer.from(pcm) : Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)
    if (bytes.byteLength < 16000 * 4 * 0.2) return '' // < 0.2 s — nothing said
    const id = nextId++
    return new Promise<string>((resolve, reject) => {
      pending.set(id, { resolve, reject })
      worker?.stdin?.write(JSON.stringify({ id, pcm: bytes.toString('base64') }) + '\n')
    })
  },

  /** Fallback engine: start Windows dictation; resolves with everything heard once stop() is called. */
  listen: (): Promise<string> =>
    new Promise((resolve, reject) => {
      if (process.platform !== 'win32') return reject(new Error('Native voice input is only available on Windows'))
      if (sysProc) {
        sysProc.kill()
        sysProc = null
      }
      const encoded = Buffer.from(SYSTEM_SCRIPT, 'utf16le').toString('base64')
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      })
      sysProc = child
      let out = ''
      let err = ''
      child.stdout?.on('data', (d) => (out += d.toString()))
      child.stderr?.on('data', (d) => (err += d.toString()))
      child.stdin?.on('error', () => undefined)
      child.on('error', (e) => reject(e))
      child.on('close', (code) => {
        if (sysProc === child) {
          sysProc = null
          if (sysKillTimer) clearTimeout(sysKillTimer)
          sysKillTimer = null
        }
        const text = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join(' ')
        if (code === 2 && !text) {
          const detail = err.replace(/#< CLIXML[\s\S]*/, '').trim().split(/\r?\n/)[0] || 'unknown error'
          return reject(
            new Error(
              /audio|microphone|device|input/i.test(detail)
                ? `No usable microphone: ${detail}. Check Settings → Privacy & security → Microphone (allow desktop apps).`
                : `Voice input failed: ${detail}`
            )
          )
        }
        resolve(text)
      })
    }),

  /** Fallback engine: finish dictation (the script finalizes the last phrase and exits). */
  stop: (): true => {
    const child = sysProc
    if (child) {
      try {
        child.stdin?.write('stop\n')
      } catch {
        /* already closed */
      }
      if (sysKillTimer) clearTimeout(sysKillTimer)
      sysKillTimer = setTimeout(() => {
        if (sysProc === child) child.kill()
      }, 4000)
    }
    return true
  },

  /** Kill the background speech worker (app shutdown). */
  shutdown: (): void => {
    worker?.kill()
    worker = null
    workerReady = null
    sysProc?.kill()
    sysProc = null
  }
}
