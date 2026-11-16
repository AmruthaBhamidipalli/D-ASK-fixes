// Offline voice input, recording side: 16 kHz mono 16-bit PCM WAV (what whisper.cpp and the Windows recognizer read).
// Nothing is uploaded anywhere: the WAV goes to the native HUD's /api/stt, is transcribed on this computer, then discarded.
//
// 2026-11-16 physical-microphone remediation:
//  * PreRollBuffer: the last 500 ms before the voice-activity decision are kept, so "D-ASK, open ..." is not clipped.
//  * prepareForStt: the laptop's array microphone delivers speech as quiet as -50 dBFS peak; whisper returned [BLANK_AUDIO]
//    for it. A recording is now measured (DC offset, peak, noise floor, speech level, SNR, active speech time), REJECTED with a
//    reason when it is digital silence or only background noise (gain would turn noise into hallucinated "speech"), and
//    otherwise brought to a conservative level (-1 dBFS peak, gain capped at +50 dB) without clipping.
//  The capture/VAD logic is in lib/voiceActivity.ts; the AudioContext lifecycle in lib/micSession.ts.

export const TARGET_RATE = 16000;
export const MAX_SECONDS = 30;

/** Linear-interpolation downsampling to `to` Hz (mono). A short moving average first limits aliasing (48 k -> 16 k). */
export function downsample(input: Float32Array, from: number, to = TARGET_RATE): Float32Array {
  if (from === to) return input;
  const ratio = from / to;
  let src = input;
  const taps = Math.floor(ratio);
  if (taps >= 2) {
    src = new Float32Array(input.length);
    let acc = 0;
    for (let i = 0; i < input.length; i++) {
      acc += input[i]!;
      if (i >= taps) acc -= input[i - taps]!;
      src[i] = acc / Math.min(i + 1, taps);
    }
  }
  const out = new Float32Array(Math.floor(input.length / ratio));
  // The moving average delays the signal by (taps-1)/2 samples; read that much later so timing is preserved.
  const shift = taps >= 2 ? (taps - 1) / 2 : 0;
  for (let i = 0; i < out.length; i++) {
    const x = Math.min(i * ratio + shift, src.length - 1), i0 = Math.floor(x), i1 = Math.min(i0 + 1, src.length - 1), f = x - i0;
    out[i] = src[i0]! * (1 - f) + src[i1]! * f;
  }
  return out;
}

/** 16-bit PCM WAV (RIFF) bytes for mono samples in [-1, 1]. */
export function encodeWav(samples: Float32Array, rate = TARGET_RATE): Uint8Array<ArrayBuffer> {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF"); v.setUint32(4, 36 + samples.length * 2, true); str(8, "WAVE"); str(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, "data"); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) { const s = Math.max(-1, Math.min(1, samples[i]!)); v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true); }
  return new Uint8Array(buf);
}

/** Fixed-capacity ring of the most recent samples (the pre-roll). drain() returns them oldest-first and empties the ring. */
export class PreRollBuffer {
  private readonly buf: Float32Array;
  private write = 0;
  private filled = 0;
  constructor(readonly capacity: number) { this.buf = new Float32Array(Math.max(1, capacity)); }
  get length() { return this.filled; }
  push(samples: Float32Array) {
    const cap = this.buf.length;
    // Only the last `cap` samples of a long input can survive.
    const start = Math.max(0, samples.length - cap);
    for (let i = start; i < samples.length; i++) {
      this.buf[this.write] = samples[i]!;
      this.write = (this.write + 1) % cap;
    }
    this.filled = Math.min(cap, this.filled + (samples.length - start));
  }
  drain(): Float32Array {
    const cap = this.buf.length, out = new Float32Array(this.filled);
    const first = (this.write - this.filled + cap) % cap;
    for (let i = 0; i < this.filled; i++) out[i] = this.buf[(first + i) % cap]!;
    this.clear();
    return out;
  }
  clear() { this.write = 0; this.filled = 0; }
}

// ── Signal quality and level ───────────────────────────────────────────────────────────────────────────────────────

export const STT_TARGET_PEAK = 0.89;          // -1 dBFS
export const STT_MAX_GAIN_DB = 50;            // enough for -50 dBFS speech peaks; never unbounded
export const STT_SILENCE_PEAK = 3 / 32768;    // below ~3 LSB the recording is digital silence (muted / disconnected microphone)
export const STT_MIN_SPEECH_DBFS = -75;       // speech frames quieter than this cannot be told from 16-bit quantisation noise
// Calibrated on 42 real HUD recordings from this laptop (results/offline-voice*): every multi-word request measured >= 26 dB;
// the noise-only segments whisper turned into "you" / "of" / "." measured 6–24 dB. 16 dB keeps a 10 dB margin for quieter rooms
// and distant speech; what still slips through is caught by the transcript filter (lib/micSession.ts) or ignored as too short.
export const STT_MIN_SNR_DB = 16;             // speech frames (p90) vs the quiet frames (p10) of the same recording
export const STT_ACTIVE_MARGIN_DB = 12;
export const STT_MIN_ACTIVE_MS = 250;         // time above noise + 12 dB: a click or a tap is not a request
const FRAME_MS = 20;
const db = (x: number) => 20 * Math.log10(Math.max(x, 1e-10));

export interface SignalStats {
  durationMs: number;
  dcOffset: number;
  peak: number; peakDb: number;
  rmsDb: number;
  noiseDb: number;      // 10th percentile 20 ms frame level (the recording's own background)
  speechDb: number;     // 90th percentile 20 ms frame level
  snrDb: number;
  activeMs: number;     // frames at least STT_ACTIVE_MARGIN_DB above the background
}

/** Level statistics after DC removal. */
export function analyzeSignal(samples: Float32Array, rate = TARGET_RATE): SignalStats {
  const n = samples.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += samples[i]!;
  mean = n ? mean / n : 0;
  let peak = 0, ss = 0;
  for (let i = 0; i < n; i++) { const v = samples[i]! - mean; ss += v * v; const a = Math.abs(v); if (a > peak) peak = a; }
  const fl = Math.max(1, Math.round((rate * FRAME_MS) / 1000));
  const frames: number[] = [];
  for (let o = 0; o + fl <= n; o += fl) {
    let s = 0;
    for (let i = o; i < o + fl; i++) { const v = samples[i]! - mean; s += v * v; }
    frames.push(Math.sqrt(s / fl));
  }
  if (!frames.length) frames.push(n ? Math.sqrt(ss / n) : 0);
  const sorted = [...frames].sort((a, b) => a - b);
  const pct = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  const noise = pct(0.1), speech = pct(0.9);
  const noiseDb = db(noise), speechDb = db(speech);
  const activeMs = frames.filter((f) => db(f) >= noiseDb + STT_ACTIVE_MARGIN_DB).length * FRAME_MS;
  return {
    durationMs: (n / rate) * 1000, dcOffset: mean, peak, peakDb: db(peak), rmsDb: db(n ? Math.sqrt(ss / n) : 0),
    noiseDb, speechDb, snrDb: speechDb - noiseDb, activeMs,
  };
}

export type SttRejection = "silent" | "too-quiet" | "no-speech";
export type PreparedAudio =
  | { ok: true; samples: Float32Array; gainDb: number; limited: boolean; stats: SignalStats }
  | { ok: false; reason: SttRejection; stats: SignalStats };

/**
 * Decides whether a recording is worth transcribing and, if so, levels it for whisper.
 *  1. DC offset removed (array microphones often carry one; it wastes headroom and biases peak measurements).
 *  2. Rejected, with NO gain applied, when it is digital silence, when even its loudest frames are at quantisation-noise level,
 *     or when nothing in it stands out from its own background (SNR / active-time). Amplifying those is how hallucinated
 *     words ("you", "thank you") are produced.
 *  3. Gain = target peak / peak, capped at +50 dB and never below 1 (loud speech is left as it is). If a single transient
 *     (a tap, a click) limits that gain so much that the speech itself would stay very quiet, the speech is raised to about
 *     -20 dBFS and the transient is soft-limited (tanh knee) instead of clipped. The output never exceeds the target peak.
 * Gain does not change the SNR, so whisper sees the same speech-to-noise ratio, just at a level it can read.
 */
export function prepareForStt(samples: Float32Array, rate = TARGET_RATE): PreparedAudio {
  const stats = analyzeSignal(samples, rate);
  if (stats.peak < STT_SILENCE_PEAK) return { ok: false, reason: "silent", stats };
  if (stats.speechDb < STT_MIN_SPEECH_DBFS) return { ok: false, reason: "too-quiet", stats };
  if (stats.snrDb < STT_MIN_SNR_DB || stats.activeMs < STT_MIN_ACTIVE_MS) return { ok: false, reason: "no-speech", stats };

  const maxGain = 10 ** (STT_MAX_GAIN_DB / 20);
  const speechRms = 10 ** (stats.speechDb / 20);
  let gain = Math.max(1, Math.min(maxGain, STT_TARGET_PEAK / stats.peak));
  let limited = false;
  const wantSpeech = 0.1;   // about -20 dBFS for the loud speech frames, as in the recordings whisper handled well
  if (speechRms * gain < wantSpeech * 0.3) {
    const g2 = Math.max(1, Math.min(maxGain, wantSpeech / speechRms));
    if (g2 > gain) { gain = g2; limited = true; }
  }
  const out = new Float32Array(samples.length);
  const knee = 0.6, room = STT_TARGET_PEAK - knee;
  for (let i = 0; i < samples.length; i++) {
    let v = (samples[i]! - stats.dcOffset) * gain;
    if (limited) {
      const a = Math.abs(v);
      if (a > knee) v = Math.sign(v) * (knee + room * Math.tanh((a - knee) / room));
    } else if (v > STT_TARGET_PEAK) v = STT_TARGET_PEAK;      // rounding only: gain was computed from the true peak
    else if (v < -STT_TARGET_PEAK) v = -STT_TARGET_PEAK;
    out[i] = v;
  }
  return { ok: true, samples: out, gainDb: db(gain), limited, stats };
}
