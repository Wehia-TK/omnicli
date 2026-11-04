/** Records the microphone as 16 kHz mono float32 PCM (what the Parakeet speech model expects). */
export interface MicRecording {
  /** Stop recording and return all captured samples. */
  stop: () => Float32Array
  /** Discard the recording. */
  cancel: () => void
}

const SAMPLE_RATE = 16000
const MAX_SECONDS = 120

export async function startMicRecording(onAutoStop?: () => void): Promise<MicRecording> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
  })
  // Chromium resamples the mic to the context rate, so we get 16 kHz directly
  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE })
  const source = ctx.createMediaStreamSource(stream)
  const proc = ctx.createScriptProcessor(4096, 1, 1)
  const chunks: Float32Array[] = []
  let total = 0
  let done = false

  proc.onaudioprocess = (e) => {
    if (done) return
    const data = e.inputBuffer.getChannelData(0)
    chunks.push(new Float32Array(data))
    total += data.length
    if (total >= SAMPLE_RATE * MAX_SECONDS) onAutoStop?.()
  }
  source.connect(proc)
  proc.connect(ctx.destination) // ScriptProcessor only runs while connected; it outputs silence

  const teardown = (): void => {
    if (done) return
    done = true
    proc.disconnect()
    source.disconnect()
    stream.getTracks().forEach((t) => t.stop())
    void ctx.close()
  }

  return {
    stop: () => {
      teardown()
      const out = new Float32Array(total)
      let off = 0
      for (const c of chunks) {
        out.set(c, off)
        off += c.length
      }
      return out
    },
    cancel: teardown
  }
}
