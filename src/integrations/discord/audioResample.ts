/**
 * Minimal, dependency-free PCM16 resampling between Discord's fixed 48kHz
 * stereo voice format and the 16kHz/24kHz mono formats Gemini Live speaks.
 *
 * These are deliberately simple (box-car decimation on the way down,
 * sample-duplication on the way up) — good enough for voice intelligibility,
 * not broadcast-quality. Swap in a proper resampler (e.g. a libsamplerate
 * binding) if audio quality here becomes a problem in practice.
 */

const BYTES_PER_STEREO_FRAME = 4; // 2 channels * 2 bytes (Int16)

/** Discord receive: 48kHz stereo PCM16 → Gemini input: 16kHz mono PCM16 (3:1). */
export function discord48kStereoToGemini16kMono(input: Buffer): Buffer {
  const framesIn = Math.floor(input.length / BYTES_PER_STEREO_FRAME);
  const framesOut = Math.floor(framesIn / 3);
  const out = Buffer.alloc(framesOut * 2); // mono Int16

  for (let i = 0; i < framesOut; i++) {
    let sum = 0;
    for (let j = 0; j < 3; j++) {
      const byteOffset = (i * 3 + j) * BYTES_PER_STEREO_FRAME;
      const l = input.readInt16LE(byteOffset);
      const r = input.readInt16LE(byteOffset + 2);
      sum += (l + r) / 2;
    }
    const avg = Math.round(sum / 3);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, avg)), i * 2);
  }
  return out;
}

/** Gemini output: 24kHz mono PCM16 → Discord playback: 48kHz stereo PCM16 (1:2, mono→stereo). */
export function gemini24kMonoToDiscord48kStereo(input: Buffer): Buffer {
  const samplesIn = Math.floor(input.length / 2);
  const out = Buffer.alloc(samplesIn * 8); // 2x frames * 2 channels * 2 bytes

  for (let i = 0; i < samplesIn; i++) {
    const sample = input.readInt16LE(i * 2);
    const base = i * 8;
    out.writeInt16LE(sample, base);     // frame0 L
    out.writeInt16LE(sample, base + 2); // frame0 R
    out.writeInt16LE(sample, base + 4); // frame1 L
    out.writeInt16LE(sample, base + 6); // frame1 R
  }
  return out;
}

/** Peak amplitude of a PCM16 buffer, normalized 0–1. Used purely for
 *  diagnostics — logging this tells us whether audio reaching Gemini
 *  actually contains signal or is silence/near-silence, which is otherwise
 *  invisible (a byte count alone doesn't tell you if the bytes are real). */
export function pcm16PeakLevel(buf: Buffer): number {
  let peak = 0;
  for (let i = 0; i + 1 < buf.length; i += 2) {
    const s = Math.abs(buf.readInt16LE(i));
    if (s > peak) peak = s;
  }
  return peak / 32768;
}
