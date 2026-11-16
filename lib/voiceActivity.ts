// Offline voice input, voice-activity side (2026-11-16 physical-microphone remediation).
//
// Why this exists: the HUD used to average ALL 128 analyser bins (0 Hz – Nyquist) and compare the result with a fixed 0.05.
// Most of those bins never carry speech, and on this laptop's array microphone (Intel Smart Sound, raw speech peaks near
// -50 dBFS) normal speech never crossed the fixed threshold. Here the decision is made on the SPEECH BAND only (a 300 Hz
// high-pass and a 4.5 kHz low-pass, computed for the real sample rate), relative to an ADAPTIVE noise floor, so the same
// code works whether the browser's automatic gain control delivers speech at -15 dBFS or the raw microphone delivers -60.
//
// Everything here is pure (no Web Audio), so it is unit-tested with synthetic and recorded audio (tests/hud-agent/voice-capture.test.ts).

import { PreRollBuffer } from "./pcmRecorder";

export const SPEECH_BAND_LOW_HZ = 300;
export const SPEECH_BAND_HIGH_HZ = 4500;

/** RBJ-cookbook biquad (direct form I). */
class Biquad {
  private x1 = 0; private x2 = 0; private y1 = 0; private y2 = 0;
  private constructor(private b0: number, private b1: number, private b2: number, private a1: number, private a2: number) {}
  static make(kind: "lowpass" | "highpass", freq: number, rate: number, q = Math.SQRT1_2): Biquad {
    const f = Math.min(freq, rate * 0.45);
    const w = (2 * Math.PI * f) / rate, cos = Math.cos(w), alpha = Math.sin(w) / (2 * q), a0 = 1 + alpha;
    const b1 = kind === "lowpass" ? 1 - cos : -(1 + cos);
    const b0 = kind === "lowpass" ? (1 - cos) / 2 : (1 + cos) / 2;
    return new Biquad(b0 / a0, b1 / a0, b0 / a0, (-2 * cos) / a0, (1 - alpha) / a0);
  }
  step(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

/** Speech-band (300–4500 Hz) energy of successive samples. Stateful across calls (no edge effects between buffers). */
export class SpeechBandMeter {
  private readonly hp: Biquad[]; private readonly lp: Biquad[];
  constructor(readonly sampleRate: number) {
    // Two cascaded sections each side (4th order) so 50/60 Hz hum, DC offset and fan rumble do not count as speech.
    this.hp = [Biquad.make("highpass", SPEECH_BAND_LOW_HZ, sampleRate), Biquad.make("highpass", SPEECH_BAND_LOW_HZ, sampleRate)];
    this.lp = [Biquad.make("lowpass", SPEECH_BAND_HIGH_HZ, sampleRate), Biquad.make("lowpass", SPEECH_BAND_HIGH_HZ, sampleRate)];
  }
  /** Mean square of the band-limited signal over samples[from, to). */
  meanSquare(samples: Float32Array, from = 0, to = samples.length): number {
    let sum = 0;
    for (let i = from; i < to; i++) {
      let v = samples[i]!;
      v = this.hp[1]!.step(this.hp[0]!.step(v));
      v = this.lp[1]!.step(this.lp[0]!.step(v));
      sum += v * v;
    }
    return to > from ? sum / (to - from) : 0;
  }
}

export const toDb = (rms: number) => 20 * Math.log10(Math.max(rms, 1e-10));

export interface VadOptions {
  frameMs: number;          // decision granularity
  startMarginDb: number;    // speech starts this far above the noise floor ...
  stayMarginDb: number;     // ... and continues while above floor + this (hysteresis)
  absoluteMinDb: number;    // never trigger below this band level (16-bit dither, a near-silent DMIC)
  startFrames: number;      // consecutive loud frames needed to start (a single click is not speech)
  hangoverMs: number;       // quiet time that ends an utterance (a pause between "D-ASK," and the command does not)
  calibrationMs: number;    // the first moments after arming learn the room
  levelRangeDb: number;     // UI level: floor .. floor + this maps to 0 .. 1
}

export const DEFAULT_VAD: VadOptions = {
  frameMs: 20, startMarginDb: 10, stayMarginDb: 5, absoluteMinDb: -80, startFrames: 3, hangoverMs: 1200, calibrationMs: 300, levelRangeDb: 40,
};

export type VadEvent = "start" | "end" | null;
export interface VadResult { level: number; bandDb: number; floorDb: number; speaking: boolean; event: VadEvent; activeFrames: number }

/**
 * Speech-band VAD with an adaptive noise floor. The floor follows quiet frames quickly downwards and slowly upwards (and very
 * slowly while speech is in progress, so a fan switching on mid-utterance cannot hold the recording open forever).
 */
export class AdaptiveVad {
  readonly opts: VadOptions;
  private readonly meter: SpeechBandMeter;
  private readonly frameLen: number;
  private pending = new Float32Array(0);
  private floorDb = Number.NaN;
  private elapsedMs = 0;
  private loudRun = 0;
  private quietMs = 0;
  private speaking = false;
  private active = 0;          // frames above floor + stay margin in the current utterance
  private lastDb = -200;

  constructor(readonly sampleRate: number, opts: Partial<VadOptions> = {}) {
    this.opts = { ...DEFAULT_VAD, ...opts };
    this.meter = new SpeechBandMeter(sampleRate);
    this.frameLen = Math.max(1, Math.round((sampleRate * this.opts.frameMs) / 1000));
  }

  get noiseFloorDb() { return this.floorDb; }
  get isSpeaking() { return this.speaking; }

  /** Feeds one capture buffer (any length). At most one start or end is reported per call (the first that happened). */
  process(buf: Float32Array): VadResult {
    let data = buf;
    if (this.pending.length) { data = new Float32Array(this.pending.length + buf.length); data.set(this.pending); data.set(buf, this.pending.length); }
    let event: VadEvent = null;
    let o = 0;
    for (; o + this.frameLen <= data.length; o += this.frameLen) {
      const e = this.frame(toDb(Math.sqrt(this.meter.meanSquare(data, o, o + this.frameLen))));
      if (e && !event) event = e;
    }
    this.pending = data.slice(o);
    const o2 = this.opts;
    const level = Number.isNaN(this.floorDb) ? 0 : Math.max(0, Math.min(1, (this.lastDb - this.floorDb) / o2.levelRangeDb));
    return { level, bandDb: this.lastDb, floorDb: this.floorDb, speaking: this.speaking, event, activeFrames: this.active };
  }

  private frame(db: number): VadEvent {
    const o = this.opts;
    this.lastDb = db;
    this.elapsedMs += o.frameMs;
    if (Number.isNaN(this.floorDb)) { this.floorDb = db; return null; }
    if (this.elapsedMs <= o.calibrationMs) { this.floorDb = Math.min(this.floorDb, db); return null; }

    // Noise floor: fast down, slow up (time constants ~40 ms down, ~1 s up; ~4 s while speaking). During real speech the gaps
    // between words pull the floor straight back down; a steady new noise (a fan switching on) has no gaps, so the floor catches
    // up with it and the false segment ends (and is then rejected as "no speech" by prepareForStt).
    const upRate = this.speaking ? 0.005 : 0.02;
    this.floorDb += db < this.floorDb ? 0.5 * (db - this.floorDb) : upRate * (db - this.floorDb);
    this.floorDb = Math.max(this.floorDb, -110);

    const startAt = Math.max(this.floorDb + o.startMarginDb, o.absoluteMinDb);
    const stayAt = Math.max(this.floorDb + o.stayMarginDb, o.absoluteMinDb - o.startMarginDb + o.stayMarginDb);
    if (!this.speaking) {
      this.loudRun = db >= startAt ? this.loudRun + 1 : 0;
      if (this.loudRun >= o.startFrames) {
        this.speaking = true; this.quietMs = 0; this.active = this.loudRun; this.loudRun = 0;
        return "start";
      }
      return null;
    }
    if (db >= stayAt) { this.quietMs = 0; this.active++; }
    else {
      this.quietMs += o.frameMs;
      if (this.quietMs >= o.hangoverMs) { this.speaking = false; this.quietMs = 0; return "end"; }
    }
    return null;
  }

  /** Ends any utterance in progress (disarm / max length); the noise floor is kept. */
  reset() { this.speaking = false; this.loudRun = 0; this.quietMs = 0; this.active = 0; }
}

export interface SegmenterOptions { preRollMs: number; maxSeconds: number; minSpeechMs: number; vad?: Partial<VadOptions> }
export const DEFAULT_SEGMENTER: SegmenterOptions = { preRollMs: 500, maxSeconds: 30, minSpeechMs: 200 };

export type SegmentEvent =
  | { type: "start" }
  | { type: "utterance"; samples: Float32Array; sampleRate: number; speechMs: number; noiseFloorDb: number; truncated: boolean }
  | { type: "discard"; reason: "too-short"; speechMs: number };

export interface SegmentResult { level: number; speaking: boolean; event: SegmentEvent | null }

/**
 * Turns a continuous capture into utterances. While armed every buffer goes into a 500 ms pre-roll ring; when the VAD fires,
 * the recording starts WITH the ring's contents (which already include the triggering buffer), so the wake word and the first
 * consonants recorded before the decision are kept. Each sample is in exactly one place (ring OR recording), so nothing is
 * duplicated or reordered.
 */
export class VoiceSegmenter {
  readonly opts: SegmenterOptions;
  readonly vad: AdaptiveVad;
  private readonly ring: PreRollBuffer;
  private chunks: Float32Array[] = [];
  private length = 0;
  private recording = false;

  constructor(readonly sampleRate: number, opts: Partial<SegmenterOptions> = {}) {
    this.opts = { ...DEFAULT_SEGMENTER, ...opts };
    this.vad = new AdaptiveVad(sampleRate, this.opts.vad);
    this.ring = new PreRollBuffer(Math.round((sampleRate * this.opts.preRollMs) / 1000));
  }

  get isRecording() { return this.recording; }

  push(input: Float32Array): SegmentResult {
    const buf = new Float32Array(input);   // the capture buffer is reused by the audio engine: always copy
    const v = this.vad.process(buf);
    let event: SegmentEvent | null = null;
    if (!this.recording) {
      this.ring.push(buf);
      if (v.event === "start") {
        const pre = this.ring.drain();
        this.chunks = [pre]; this.length = pre.length; this.recording = true;
        event = { type: "start" };
      }
    } else {
      this.chunks.push(buf); this.length += buf.length;
      const truncated = this.length >= this.sampleRate * this.opts.maxSeconds;
      if (v.event === "end" || truncated) {
        if (truncated) this.vad.reset();
        event = this.finish(v.activeFrames, truncated);
      }
    }
    return { level: v.level, speaking: v.speaking, event };
  }

  /** Disarm: drops whatever was being recorded. */
  clear() { this.chunks = []; this.length = 0; this.recording = false; this.ring.clear(); this.vad.reset(); }

  private finish(activeFrames: number, truncated: boolean): SegmentEvent {
    const samples = new Float32Array(this.length);
    let o = 0;
    for (const c of this.chunks) { samples.set(c, o); o += c.length; }
    this.chunks = []; this.length = 0; this.recording = false;
    const speechMs = activeFrames * this.vad.opts.frameMs;
    if (speechMs < this.opts.minSpeechMs) return { type: "discard", reason: "too-short", speechMs };
    return { type: "utterance", samples, sampleRate: this.sampleRate, speechMs, noiseFloorDb: this.vad.noiseFloorDb, truncated };
  }
}
