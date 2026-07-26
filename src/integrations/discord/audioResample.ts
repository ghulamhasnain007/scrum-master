/**
 * PCM16 audio resampling between Discord's 48kHz stereo and Gemini Live's
 * 16kHz/24kHz mono formats. Uses lightweight FIR filtering for anti-aliasing
 * on downsampling and linear interpolation on upsampling.
 *
 * Also exports applyGainPcm16 for dynamic echo-gate attenuation.
 */

const BYTES_PER_STEREO_FRAME = 4;

/**
 * Discord receive: 48kHz stereo PCM16 → Gemini input: 16kHz mono PCM16.
 * Applies a 3-tap moving-average filter (coefficients [1,2,1]/4) before 3:1
 * decimation to reduce aliasing from components above 8 kHz.
 */
export function discord48kStereoToGemini16kMono(input: Buffer): Buffer {
  const framesIn = Math.floor(input.length / BYTES_PER_STEREO_FRAME);
  const framesOut = Math.floor(framesIn / 3);
  if (framesOut === 0) return Buffer.alloc(0);

  // Convert stereo → mono Int16 array
  const mono: number[] = new Array(framesIn);
  for (let i = 0; i < framesIn; i++) {
    const o = i * BYTES_PER_STEREO_FRAME;
    mono[i] = Math.round((input.readInt16LE(o) + input.readInt16LE(o + 2)) / 2);
  }

  // 3-tap moving average (binomial [1,2,1]/4) — gentle low-pass
  const filtered: number[] = new Array(framesIn);
  for (let i = 0; i < framesIn; i++) {
    const a = i > 0 ? mono[i - 1] : mono[i];
    const b = mono[i];
    const c = i + 1 < framesIn ? mono[i + 1] : mono[i];
    filtered[i] = (a + 2 * b + c) / 4;
  }

  // 3:1 decimation — pick every third sample
  const out = Buffer.alloc(framesOut * 2);
  for (let i = 0; i < framesOut; i++) {
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(filtered[i * 3]))), i * 2);
  }
  return out;
}

/**
 * Gemini output: 24kHz mono PCM16 → Discord playback: 48kHz stereo PCM16.
 * Uses linear interpolation between adjacent samples (rather than sample
 * duplication) for a smoother reconstructed signal.
 */
export function gemini24kMonoToDiscord48kStereo(input: Buffer): Buffer {
  const samplesIn = Math.floor(input.length / 2);
  if (samplesIn === 0) return Buffer.alloc(0);
  const out = Buffer.alloc(samplesIn * 8);

  for (let i = 0; i < samplesIn; i++) {
    const current = input.readInt16LE(i * 2);
    const next = i + 1 < samplesIn ? input.readInt16LE((i + 1) * 2) : current;
    const interp = Math.round((current + next) / 2);

    const base = i * 8;
    out.writeInt16LE(current, base);
    out.writeInt16LE(current, base + 2);
    out.writeInt16LE(interp, base + 4);
    out.writeInt16LE(interp, base + 6);
  }
  return out;
}

/**
 * Peak amplitude of a PCM16 buffer, normalized 0–1.
 */
export function pcm16PeakLevel(buf: Buffer): number {
  let peak = 0;
  for (let i = 0; i + 1 < buf.length; i += 2) {
    const s = Math.abs(buf.readInt16LE(i));
    if (s > peak) peak = s;
  }
  return peak / 32768;
}

/**
 * Apply a linear gain to a PCM16 mono buffer. Clamps to Int16 range.
 * Used by the echo gate to attenuate (gain < 1) the mic feed while
 * the bot is speaking, letting Gemini's VAD detect barge-in without
 * full acoustic feedback.
 */
export function applyGainPcm16(input: Buffer, gain: number): Buffer {
  const out = Buffer.alloc(input.length);
  for (let i = 0; i < input.length; i += 2) {
    const scaled = Math.round(input.readInt16LE(i) * gain);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, scaled)), i);
  }
  return out;
}
