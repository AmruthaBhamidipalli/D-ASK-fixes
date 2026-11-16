/**
 * Offline voice CAPTURE (2026-11-16 physical-microphone remediation). Run with: npx tsx tests/hud-agent/voice-capture.test.ts
 *
 *   A  level normalisation + signal-quality gate (lib/pcmRecorder.ts prepareForStt)           pure, synthetic audio
 *   B  microphone / AudioContext lifecycle (lib/micSession.ts beginMicSession)                 fakes of the Web Audio API
 *   C  speech-band VAD with adaptive noise floor (lib/voiceActivity.ts)                         pure, synthetic audio
 *   D  500 ms pre-roll: order, no duplicates, no gaps, onset kept                               pure
 *   E  /api/stt answers -> user-visible outcome (interpretSttResponse)                          pure
 *   R  REAL HUD recordings from this laptop (results/offline-*), if present: speech kept, noise-only segments rejected
 *   W  REAL offline whisper (src/hud-native, cargo ignored test): a local SAPI utterance attenuated to the level QA measured on
 *      this laptop's array microphone (-50 dBFS peak), 16-bit quantised, with microphone-like noise, pushed through the HUD's
 *      VAD + pre-roll + normaliser, then transcribed.  SIMULATED physical input (not a person at a microphone).
 *      DASK_SKIP_LIVE_STT=1 skips W.  DASK_AMBIENT_WAV=<16 kHz WAV recorded from the real microphone> uses real room noise.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { analyzeSignal, downsample, encodeWav, prepareForStt, PreRollBuffer, STT_TARGET_PEAK, TARGET_RATE } from "../../lib/pcmRecorder";
import { AdaptiveVad, VoiceSegmenter, type SegmentEvent } from "../../lib/voiceActivity";
import { beginMicSession, classifyMicError, interpretSttResponse, VoiceError, type ContextLike, type MicEnvironment } from "../../lib/micSession";

let passed = 0, failed = 0;
const check = (c: boolean, n: string, d?: unknown) => { if (c) { passed++; console.log(`  PASS: ${n}`); } else { failed++; console.log(`  FAIL: ${n}${d !== undefined ? ` | ${JSON.stringify(d)}` : ""}`); } };
const dbOf = (x: number) => 20 * Math.log10(Math.max(x, 1e-12));
const peakOf = (x: Float32Array) => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

// ── Synthetic audio ──────────────────────────────────────────────────────────────────────────────────────────────────
function rng(seed: number) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
/** White-ish noise with the given RMS. */
function noise(rate: number, seconds: number, rms: number, seed = 1) {
  const r = rng(seed), n = Math.round(rate * seconds), out = new Float32Array(n);
  for (let i = 0; i < n; i++) { const u = r() + r() + r() - 1.5; out[i] = u * 2 * rms; }   // var(sum of 3 U(0,1)) = 1/4
  return out;
}
/** Voiced, syllabic "speech": a 130 Hz harmonic series (energy 300–3500 Hz) in 220 ms syllables with 110 ms gaps. Peak-normalised. */
function speech(rate: number, seconds: number, peak: number, seed = 7) {
  const n = Math.round(rate * seconds), out = new Float32Array(n), r = rng(seed);
  const syl = 0.22, gap = 0.11, f0 = 130;
  const amps = Array.from({ length: 26 }, (_, k) => { const f = f0 * (k + 1); return f < 250 ? 0.2 : f < 3600 ? 1 / Math.sqrt(k + 1) : 0.05; });
  const phase = amps.map(() => r() * Math.PI * 2);
  for (let i = 0; i < n; i++) {
    const t = i / rate, p = t % (syl + gap);
    if (p >= syl) continue;
    const env = Math.sin((Math.PI * p) / syl);
    let v = 0;
    for (let k = 0; k < amps.length; k++) v += amps[k]! * Math.sin(2 * Math.PI * f0 * (k + 1) * t * (1 + 0.03 * Math.sin(2 * Math.PI * 3 * t)) + phase[k]!);
    out[i] = v * env;
  }
  const pk = peakOf(out);
  for (let i = 0; i < n; i++) out[i] = (out[i]! / pk) * peak;
  return out;
}
const concat = (...xs: Float32Array[]) => { const o = new Float32Array(xs.reduce((s, x) => s + x.length, 0)); let p = 0; for (const x of xs) { o.set(x, p); p += x.length; } return o; };
const mix = (a: Float32Array, b: Float32Array, at = 0) => { const o = new Float32Array(a); for (let i = 0; i < b.length && at + i < o.length; i++) o[at + i]! += b[i]!; return o; };
const quantise16 = (x: Float32Array) => x.map((v) => Math.round(v * 32768) / 32768);

/** Runs a capture through the segmenter in `buf`-sample buffers (like the ScriptProcessor). */
function runSegmenter(x: Float32Array, rate: number, buf = 2048) {
  const seg = new VoiceSegmenter(rate);
  const events: { ev: SegmentEvent; endIndex: number }[] = [];
  let maxLevel = 0;
  for (let o = 0; o < x.length; o += buf) {
    const r = seg.push(x.subarray(o, Math.min(x.length, o + buf)));
    maxLevel = Math.max(maxLevel, r.level);
    if (r.event) events.push({ ev: r.event, endIndex: Math.min(x.length, o + buf) });
  }
  return { seg, events, maxLevel, utterances: events.filter((e) => e.ev.type === "utterance").map((e) => e.ev as Extract<SegmentEvent, { type: "utterance" }>) };
}

async function main() {
  // ── A: normalisation and signal quality ──────────────────────────────────────────────────────────────────────────────
  console.log("A  normalisation / signal quality");
  {
    const quiet = concat(noise(16000, 0.5, 2e-5, 2), mix(speech(16000, 2, 0.003), noise(16000, 2, 2e-5, 3)), noise(16000, 1, 2e-5, 4));
    const p = prepareForStt(quiet);
    check(p.ok, "A1 quiet speech (peak 0.003 = -50 dBFS, as QA measured) is accepted", p.ok ? undefined : p.reason);
    if (p.ok) {
      const pk = peakOf(p.samples);
      check(pk >= 0.8 && pk <= STT_TARGET_PEAK + 1e-6, "A1 output peak approaches the -1 dBFS target without exceeding it", { pk });
      check(p.gainDb > 45 && p.gainDb <= 50.01, "A1 gain is ~+49 dB and within the +50 dB cap", { gainDb: p.gainDb });
      const before = analyzeSignal(quiet), after = analyzeSignal(p.samples);
      check(Math.abs(before.snrDb - after.snrDb) < 0.5, "A1 gain does not change the speech-to-noise ratio", { before: before.snrDb, after: after.snrDb });
      check(encodeWav(p.samples).length === 44 + p.samples.length * 2, "A1 normalised audio encodes as 16-bit PCM WAV");
    }
    const silence = prepareForStt(new Float32Array(16000 * 3));
    check(!silence.ok && silence.reason === "silent", "A2 digital silence is rejected as 'silent' (no gain applied)", silence.ok ? "accepted" : silence.reason);
    const lsb = prepareForStt(noise(16000, 3, 1 / 32768, 5).map((v) => Math.round(v * 32768) / 32768));
    check(!lsb.ok, "A2 one-LSB dither is not amplified into a recording", lsb.ok ? "accepted" : lsb.reason);
    const fan = prepareForStt(noise(16000, 3, 0.001, 6));
    check(!fan.ok && fan.reason === "no-speech", "A3 steady background noise (-60 dBFS) is rejected as 'no-speech', never amplified", fan.ok ? `accepted gain ${fan.gainDb}` : fan.reason);
    const tap = prepareForStt(mix(noise(16000, 2, 0.0005, 7), noise(16000, 0.03, 0.2, 8), 16000));
    check(!tap.ok && tap.reason === "no-speech", "A4 a desk tap in background noise is rejected (too little voiced time)", tap.ok ? "accepted" : tap.reason);
    const loud = concat(noise(16000, 0.3, 0.001, 9), speech(16000, 2, 0.95), noise(16000, 0.5, 0.001, 10));
    const pl = prepareForStt(loud);
    check(pl.ok && pl.gainDb >= 0 && pl.gainDb < 0.5 && peakOf(pl.samples) <= STT_TARGET_PEAK + 1e-6, "A5 loud speech (peak 0.95) is not boosted and not clipped", pl.ok ? { gainDb: pl.gainDb, pk: peakOf(pl.samples) } : pl.reason);
    // A transient far louder than the speech: the speech is still raised; the transient is soft-limited, never clipped.
    const tapped = mix(concat(noise(16000, 0.4, 2e-5, 11), mix(speech(16000, 2, 0.003), noise(16000, 2, 2e-5, 12)), noise(16000, 0.6, 2e-5, 13)), noise(16000, 0.005, 0.15, 14), 3000);
    const pt = prepareForStt(tapped);
    check(pt.ok && pt.limited && peakOf(pt.samples) <= STT_TARGET_PEAK + 1e-6 && analyzeSignal(pt.samples).speechDb > -30,
      "A6 quiet speech plus a loud tap: speech raised to a usable level, the tap soft-limited, output never above -1 dBFS",
      pt.ok ? { limited: pt.limited, pk: peakOf(pt.samples), speechDb: analyzeSignal(pt.samples).speechDb } : pt.reason);
    const dc = mix(speech(16000, 2, 0.01), new Float32Array(32000).fill(0.02));
    const pd = prepareForStt(concat(new Float32Array(4000).fill(0.02).map((v, i) => v + (i % 2 ? 1e-5 : -1e-5)), dc));
    check(pd.ok && Math.abs(analyzeSignal(pd.samples).dcOffset) < 1e-3, "A7 a DC offset is removed before levelling", pd.ok ? analyzeSignal(pd.samples).dcOffset : pd.reason);
    const w = encodeWav(new Float32Array([0, 0.5, -0.5, 1, -1]));
    const dv = new DataView(w.buffer);
    check(String.fromCharCode(...w.slice(0, 4)) === "RIFF" && dv.getUint16(20, true) === 1 && dv.getUint16(22, true) === 1 && dv.getUint32(24, true) === 16000
      && dv.getUint16(34, true) === 16 && dv.getUint32(40, true) === 10 && dv.getInt16(44 + 3 * 2, true) === 32767 && dv.getInt16(44 + 4 * 2, true) === -32768,
      "A8 WAV: PCM, mono, 16 kHz, 16-bit, correct sizes and full-scale values");
    const tone = new Float32Array(48000).map((_, i) => Math.sin((2 * Math.PI * 1000 * i) / 48000) * 0.5);
    const ds = downsample(tone, 48000);
    check(ds.length === 16000 && Math.abs(peakOf(ds.subarray(100, 15900)) - 0.5) < 0.05, "A9 48 kHz -> 16 kHz keeps length and in-band level", { len: ds.length, pk: peakOf(ds) });
    const alias = downsample(new Float32Array(48000).map((_, i) => Math.sin((2 * Math.PI * 15000 * i) / 48000) * 0.5), 48000);
    check(peakOf(alias.subarray(100, 15900)) < 0.25, "A9 15 kHz (above the 8 kHz Nyquist) is attenuated, not folded into the speech band at full level", peakOf(alias));
  }

  // ── B: microphone / AudioContext lifecycle ───────────────────────────────────────────────────────────────────────────
  console.log("B  AudioContext lifecycle");
  {
    type Fake = { env: MicEnvironment; contexts: FakeCtx[]; tracks: FakeTrack[]; procs: FakeProc[] };
    class FakeTrack { stopped = 0; readyState = "live"; label = "Microphone Array (Intel(R) Smart Sound Technology)"; ended?: () => void; stop() { this.stopped++; this.readyState = "ended"; } addEventListener(_t: "ended", f: () => void) { this.ended = f; } }
    class FakeProc { onaudioprocess: ((e: { inputBuffer: { getChannelData(c: number): Float32Array } }) => void) | null = null; disconnected = 0; connect() { return undefined; } disconnect() { this.disconnected++; } }
    class FakeCtx implements ContextLike {
      state = "suspended"; sampleRate = 48000; destination = {}; resumeCalls = 0; closeCalls = 0; onstatechange: (() => void) | null = null; proc?: FakeProc;
      constructor(private readonly resumable: boolean, private readonly deliversFrames: boolean, private readonly fakeRef: Fake) {}
      resume() { this.resumeCalls++; if (this.resumable && this.state !== "closed") this.state = "running"; return Promise.resolve(); }
      close() { this.closeCalls++; this.state = "closed"; return Promise.resolve(); }
      createMediaStreamSource() { return { connect() { return undefined; }, disconnect() {} }; }
      createGain() { return { gain: { value: 1 }, connect() { return undefined; }, disconnect() {} }; }
      createScriptProcessor() {
        const p = new FakeProc(); this.proc = p; this.fakeRef.procs.push(p);
        // The audio clock runs only while the context is running, as in Chromium.
        if (this.deliversFrames) setTimeout(() => { if (this.state === "running") p.onaudioprocess?.({ inputBuffer: { getChannelData: () => new Float32Array(2048).fill(0.01) } }); }, 5);
        return p;
      }
    }
    const fake = (o: { resumable?: boolean; frames?: boolean; gum?: () => Promise<never> } = {}): Fake => {
      const f: Fake = { contexts: [], tracks: [], procs: [], env: {} };
      f.env = {
        createContext: () => { const c = new FakeCtx(o.resumable ?? true, o.frames ?? true, f); f.contexts.push(c); return c; },
        getUserMedia: o.gum ?? (async () => { const t = new FakeTrack(); f.tracks.push(t); return { getTracks: () => [t], getAudioTracks: () => [t] }; }),
      };
      return f;
    };

    const f1 = fake();
    let frames = 0, nonZero = false;
    const p1 = beginMicSession(f1.env, (x) => { frames++; nonZero ||= x.some((v) => v !== 0); }, { firstFrameTimeoutMs: 500 });
    check(f1.contexts.length === 1 && f1.contexts[0]!.resumeCalls === 1, "B1 the AudioContext is created and resume() is requested synchronously, inside the user gesture");
    const s1 = await p1;
    check(s1.contextState() === "running", "B2 after arming the context state is 'running'", s1.contextState());
    check(frames >= 1 && nonZero && s1.framesReceived() >= 1, "B2 audio frames actually reach the processing callback (non-zero samples)", { frames });
    check(s1.deviceLabel.includes("Smart Sound"), "B2 the microphone's name is reported for the status line", s1.deviceLabel);
    await s1.dispose(); await s1.dispose();
    check(f1.contexts[0]!.closeCalls === 1 && f1.tracks[0]!.stopped === 1 && f1.procs[0]!.onaudioprocess === null && f1.procs[0]!.disconnected === 1,
      "B3 disarm releases everything exactly once: context closed, track stopped, processor detached (dispose is idempotent)");

    const f2 = fake({ resumable: false });
    const e2 = await beginMicSession(f2.env, () => {}, { resumeTimeoutMs: 50 }).then(() => null, (e) => e);
    check(e2 instanceof VoiceError && e2.issue === "audio-suspended" && /suspended/.test(e2.message), "B4 a context that stays suspended fails visibly ('audio-suspended')", String(e2));
    check(f2.contexts[0]!.closeCalls === 1 && f2.tracks[0]!.stopped === 1, "B4 ... and leaves no microphone or context open");

    const f3 = fake({ frames: false });
    const e3 = await beginMicSession(f3.env, () => {}, { firstFrameTimeoutMs: 60 }).then(() => null, (e) => e);
    check(e3 instanceof VoiceError && e3.issue === "no-audio-frames" && f3.contexts[0]!.closeCalls === 1 && f3.tracks[0]!.stopped === 1, "B5 a running context that delivers no audio fails visibly ('no-audio-frames') and cleans up", String(e3));

    for (const [name, want] of [["NotAllowedError", "permission-denied"], ["NotFoundError", "no-microphone"], ["NotReadableError", "mic-busy"]] as const) {
      const f = fake({ gum: async () => { const e = new Error(name); e.name = name; throw e; } });
      const e = await beginMicSession(f.env, () => {}).then(() => null, (x) => x);
      check(e instanceof VoiceError && e.issue === want && f.contexts[0]!.closeCalls === 1, `B6 getUserMedia ${name} -> '${want}', context closed`, String(e));
    }
    const eU = await beginMicSession({ createContext: fake().env.createContext }, () => {}).then(() => null, (x) => x);
    const eA = await beginMicSession({ getUserMedia: fake().env.getUserMedia }, () => {}).then(() => null, (x) => x);
    check(classifyMicError(eU) === "unsupported" && classifyMicError(eA) === "audio-context-unavailable", "B6 no microphone API -> 'unsupported'; no AudioContext -> 'audio-context-unavailable'");

    const f4 = fake();
    for (let i = 0; i < 25; i++) { const s = await beginMicSession(f4.env, () => {}, { firstFrameTimeoutMs: 500 }); await s.dispose(); }
    check(f4.contexts.length === 25 && f4.contexts.every((c) => c.closeCalls === 1 && c.state === "closed") && f4.tracks.every((t) => t.stopped === 1) && f4.procs.every((p) => p.onaudioprocess === null),
      "B7 25 arm/disarm cycles: every context closed, every track stopped, every processor detached (no leak)");

    const f5 = fake();
    const issues: string[] = [];
    const s5 = await beginMicSession(f5.env, () => {}, { onIssue: (i) => issues.push(i), firstFrameTimeoutMs: 500 });
    f5.tracks[0]!.ended?.();
    check(issues.includes("mic-lost"), "B8 a microphone that disappears while armed is reported ('mic-lost')", issues);
    await s5.dispose();

    // The component must start the session synchronously from the gesture (no await before beginMicSession).
    const src = fs.readFileSync(path.join(process.cwd(), "components", "JarvisOrb.tsx"), "utf8");
    const body = src.slice(src.indexOf("const toggleVoiceInput = useCallback("), src.indexOf("beginMicSession(browserMicEnvironment()"));
    check(/const toggleVoiceInput = useCallback\(\(\) =>/.test(src) && body.length > 0 && !/\bawait\b/.test(body),
      "B9 JarvisOrb: toggleVoiceInput is synchronous up to beginMicSession (the context starts inside the click/V-key gesture)");
    check(src.includes("if (voiceArmingRef.current) return;") && !src.includes("new AudioCtx()"), "B9 JarvisOrb: a second arm while the microphone is opening is ignored (one session at a time)");
  }

  // ── C: VAD ───────────────────────────────────────────────────────────────────────────────────────────────────────────
  console.log("C  speech-band VAD / adaptive noise floor");
  {
    const R = 48000;
    for (const [label, pk, nrms] of [["raw array-mic level (peak -50 dBFS)", 0.003, 2e-5], ["normal level (peak -20 dBFS)", 0.1, 3e-4], ["AGC level (peak -3 dBFS)", 0.7, 1e-3]] as const) {
      const x = mix(concat(new Float32Array(R * 1), speech(R, 2.5, pk), new Float32Array(R * 2)), noise(R, 5.5, nrms, 21));
      const r = runSegmenter(x, R);
      check(r.utterances.length === 1 && r.maxLevel > 0.3, `C1 speech at ${label} is detected as exactly one utterance and the level meter moves`, { n: r.utterances.length, events: r.events.map((e) => e.ev.type), maxLevel: r.maxLevel.toFixed(2) });
    }
    const fanOnly = runSegmenter(noise(R, 20, 0.003, 22), R);
    check(fanOnly.events.length === 0, "C2 20 s of steady background noise (-50 dBFS): never triggers", fanOnly.events.map((e) => e.ev.type));
    const hum = runSegmenter(mix(noise(R, 10, 1e-4, 23), new Float32Array(R * 10).map((_, i) => 0.05 * Math.sin((2 * Math.PI * 50 * i) / R))), R);
    check(hum.events.length === 0, "C2 loud 50 Hz mains hum (-26 dBFS) is outside the speech band: never triggers", hum.events.map((e) => e.ev.type));
    // A fan switching on: at most one false segment while the floor adapts, and that segment is rejected as "no speech".
    const step = runSegmenter(concat(noise(R, 3, 1e-4, 24), noise(R, 20, 0.003, 25)), R);
    const stepRejected = step.utterances.every((u) => !prepareForStt(downsample(u.samples, R)).ok);
    check(step.utterances.length <= 1 && stepRejected && step.seg.isRecording === false, "C3 noise floor adapts to a fan switching on (+30 dB): at most one segment, rejected by the quality gate", { n: step.utterances.length, events: step.events.map((e) => e.ev.type) });
    for (const floor of [3e-5, 1e-4, 3e-3]) {   // -90 dBFS (raw DMIC, ~1 LSB) .. -50 dBFS (noisy room)
      const x = mix(concat(new Float32Array(R * 1.5), speech(R, 2, floor * 30), new Float32Array(R * 2)), noise(R, 5.5, floor, 26));
      const r = runSegmenter(x, R);
      check(r.utterances.length === 1, `C4 adaptive floor: speech ~25 dB over a ${dbOf(floor).toFixed(0)} dBFS room is detected`, r.events.map((e) => e.ev.type));
    }
    const knock = runSegmenter(mix(noise(R, 4, 1e-4, 27), noise(R, 0.004, 0.3, 28), R * 2), R);
    check(knock.utterances.length === 0, "C5 a single click/tap never becomes an utterance", knock.events.map((e) => e.ev.type));
    const bump = runSegmenter(mix(noise(R, 4, 1e-4, 29), speech(R, 0.12, 0.05, 30), R * 2), R);
    check(bump.utterances.length === 0, "C5 a 120 ms bump is discarded as too short (not sent to whisper)", bump.events.map((e) => e.ev.type));
    // Two words with a 700 ms pause ("D-ASK, ... open") stay one utterance.
    const pause = runSegmenter(mix(concat(new Float32Array(R), speech(R, 0.5, 0.05), new Float32Array(R * 0.7), speech(R, 1.5, 0.05), new Float32Array(R * 2)), noise(R, 5.7, 1e-4, 31)), R);
    check(pause.utterances.length === 1, "C6 a 700 ms pause after the wake word does not split the request", pause.events.map((e) => e.ev.type));
    const v = new AdaptiveVad(16000);
    v.process(noise(16000, 1, 1e-4, 32));
    check(Math.abs(v.noiseFloorDb - dbOf(1e-4 * Math.sqrt(4200 / 8000))) < 4, "C7 the learned floor matches the room's speech-band noise level", { floor: v.noiseFloorDb.toFixed(1) });
  }

  // ── D: pre-roll ──────────────────────────────────────────────────────────────────────────────────────────────────────
  console.log("D  pre-roll");
  {
    const ring = new PreRollBuffer(8000);
    let next = 0;
    for (const n of [1000, 3000, 2048, 4096, 100, 7, 5000]) { ring.push(new Float32Array(n).map(() => next++)); }
    const got = ring.drain();
    check(got.length === 8000 && got.every((v, i) => v === next - 8000 + i), "D1 ring keeps exactly the last 500 ms (8000 samples @16 kHz), oldest first, consecutive");
    check(ring.length === 0 && ring.drain().length === 0, "D1 drain empties the ring");
    const big = new PreRollBuffer(10); big.push(new Float32Array(25).map((_, i) => i));
    check(big.drain().join(",") === "15,16,17,18,19,20,21,22,23,24", "D1 a push longer than the ring keeps its last samples");

    const R = 48000, onsetAt = R * 1;   // speech begins exactly 1.0 s in
    const sp = speech(R, 2, 0.003);
    for (let i = 0; i < 20; i++) sp[i] = 0;
    const x = mix(concat(new Float32Array(onsetAt), sp, new Float32Array(R * 2)), noise(R, 5, 2e-5, 41));
    const seg = new VoiceSegmenter(R);
    let startEnd = -1, utt: Float32Array | null = null;
    for (let o = 0; o < x.length; o += 2048) {
      const r = seg.push(x.subarray(o, Math.min(x.length, o + 2048)));
      if (r.event?.type === "start") startEnd = Math.min(x.length, o + 2048);
      if (r.event?.type === "utterance") utt = r.event.samples;
    }
    const firstIdx = startEnd - Math.round(R * 0.5);
    let exact = utt !== null && firstIdx >= 0 && firstIdx + utt.length <= x.length;
    if (exact && utt) for (let i = 0; i < utt.length; i++) if (utt[i] !== x[firstIdx + i]) { exact = false; break; }
    check(exact, "D2 the utterance is EXACTLY the capture from 500 ms before the trigger to the end: no duplicated, missing or reordered sample", { startEnd, firstIdx, len: utt?.length });
    check(firstIdx <= onsetAt && startEnd - onsetAt < R * 0.5, "D3 the speech onset (the wake word's first consonant) is inside the recording", { triggerAfterOnsetMs: Math.round(((startEnd - onsetAt) / R) * 1000), prerollStartsBeforeOnsetMs: Math.round(((onsetAt - firstIdx) / R) * 1000) });
  }

  // ── E: what /api/stt answered -> what the user sees ──────────────────────────────────────────────────────────────────
  console.log("E  STT outcome");
  {
    const ok = interpretSttResponse(200, { text: " open the notes window and type hello ", engine: "whisper-local" });
    check(ok.kind === "text" && ok.text === "open the notes window and type hello" && ok.engine === "whisper-local", "E1 a transcript is delivered with its engine (whisper-local)");
    const empty = interpretSttResponse(200, { text: "", engine: "whisper-local" });
    check(empty.kind === "issue" && empty.issue === "empty-transcript", "E2 an empty transcript ([BLANK_AUDIO] is stripped to \"\" natively) is reported, not silently dropped");
    for (const h of ["you", "Thank you.", " . ", "*fart*"]) {
      const r = interpretSttResponse(200, { text: h, engine: "whisper-local" });
      check(r.kind === "issue" && r.issue === "no-speech", `E3 whisper's noise output "${h}" is 'no speech', never a request`);
    }
    const nw = interpretSttResponse(500, { error: "transcription failed", reason: "speech could not be recognised: whisper is not available (model missing), and the Windows recognizer failed (x)" });
    check(nw.kind === "issue" && nw.issue === "whisper-unavailable", "E4 whisper unavailable + recognizer failure -> 'whisper-unavailable' with the reason");
    const sf = interpretSttResponse(500, { error: "transcription failed", reason: "the Windows recognizer failed (timeout)" });
    check(sf.kind === "issue" && sf.issue === "stt-failed" && Boolean(sf.detail?.includes("timeout")), "E4 other recognizer failure -> 'stt-failed' with the reason");
    const br = interpretSttResponse(400, { error: "not a 16-bit PCM WAV" });
    check(br.kind === "issue" && br.issue === "bad-recording", "E5 a rejected WAV -> 'bad-recording'");
    const wh = interpretSttResponse(200, { text: "", engine: "whisper-local", gate: "withheld", reason: "no open step" });
    check(wh.kind === "issue" && wh.issue === "withheld", "E6 acceptance-gate withheld text is reported as such");
  }

  // ── R: real recordings made by the HUD on this laptop (evidence folders; skipped where absent) ───────────────────────
  console.log("R  real HUD recordings (results/offline-voice*, if present)");
  {
    const dirs = ["results/offline-voice-chain", "results/offline-voice"].map((d) => path.join(process.cwd(), d)).filter((d) => fs.existsSync(d));
    const files: string[] = [];
    const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith(".wav") && fs.existsSync(p.replace(/\.wav$/, ".txt"))) files.push(p); } };
    dirs.forEach(walk);
    if (!files.length) console.log("  (no real recordings on this machine: R skipped)");
    else {
      let speechN = 0, speechKept = 0, junkN = 0, junkRejected = 0;
      for (const f of files) {
        const b = fs.readFileSync(f), n = (b.length - 44) >> 1, x = new Float32Array(n);
        for (let i = 0; i < n; i++) x[i] = b.readInt16LE(44 + i * 2) / 32768;
        const said = (fs.readFileSync(f.replace(/\.wav$/, ".txt"), "utf8").split("\t")[1] ?? "").trim();
        const isSpeech = said.split(/\s+/).filter((w) => /[a-z]{2,}/i.test(w)).length >= 2;
        const p = prepareForStt(x);
        if (isSpeech) { speechN++; if (p.ok) speechKept++; } else { junkN++; if (!p.ok) junkRejected++; }
      }
      console.log(`  (${files.length} recordings: ${speechKept}/${speechN} multi-word speech kept, ${junkRejected}/${junkN} noise-only segments rejected before whisper)`);
      check(speechKept === speechN, "R1 every real multi-word speech recording passes the quality gate", { speechKept, speechN });
      check(junkN === 0 || junkRejected / junkN >= 0.5, "R2 most real noise-only segments (which whisper turned into 'you', 'of', '.') are rejected before transcription", { junkRejected, junkN });
    }
  }

  // ── W: real offline whisper ──────────────────────────────────────────────────────────────────────────────────────────
  if (process.env.DASK_SKIP_LIVE_STT === "1") console.log("W  (skipped: DASK_SKIP_LIVE_STT=1)");
  else {
    console.log("W  real offline whisper on a quiet, microphone-like capture (SIMULATED physical input)");
    const root = process.cwd();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dask-voice-capture-"));
    const expect = "open the notes window and type hello";
    const src = path.join(tmp, "sapi.wav");
    const ps = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono); $s.SetOutputToWaveFile('${src}', $f); $s.Speak('${expect}'); $s.Dispose()`;
    if (spawnSync("powershell", ["-NoProfile", "-Command", ps]).status !== 0 || !fs.existsSync(src)) check(false, "W0 could not synthesise the local fixture");
    else {
      const raw = fs.readFileSync(src), n16 = (raw.length - 44) >> 1, v16 = new Float32Array(n16);
      for (let i = 0; i < n16; i++) v16[i] = raw.readInt16LE(44 + i * 2) / 32768;
      // 48 kHz like the WebView2 capture; peak 96/32768 (-50.7 dBFS) as QA measured on the Intel Smart Sound array microphone.
      const R = 48000, up = new Float32Array(n16 * 3);
      for (let i = 0; i < up.length; i++) { const x = i / 3, i0 = Math.floor(x), i1 = Math.min(i0 + 1, n16 - 1), f = x - i0; up[i] = v16[i0]! * (1 - f) + v16[i1]! * f; }
      const pk = peakOf(up);
      for (let i = 0; i < up.length; i++) up[i] = (up[i]! / pk) * (96 / 32768);
      let room: Float32Array;
      const amb = process.env.DASK_AMBIENT_WAV;
      if (amb && fs.existsSync(amb)) {
        const a = fs.readFileSync(amb), na = (a.length - 44) >> 1, a16 = new Float32Array(na);
        for (let i = 0; i < na; i++) a16[i] = a.readInt16LE(44 + i * 2) / 32768;
        const total = up.length + R * 3; room = new Float32Array(total);
        for (let i = 0; i < total; i++) room[i] = a16[Math.floor(i / 3) % na]!;
        console.log(`  (room noise: real microphone recording ${amb})`);
      } else room = noise(R, up.length / R + 3, 10 ** (-85 / 20), 51);
      const capture = quantise16(mix(room, up, R * 1.2));
      const engine = (wav: string, want: string) => {
        const r = spawnSync("cargo", ["test", "--quiet", "real_engine_transcribes_a_local_fixture", "--", "--ignored", "--nocapture"], {
          cwd: path.join(root, "src", "hud-native"), encoding: "utf8", shell: true, timeout: 600000,
          env: { ...process.env, DASK_STT_FIXTURE: wav, DASK_STT_ROOT: root, DASK_STT_EXPECT: want, DASK_STT_EXPECT_ENGINE: "whisper-local" },
        });
        const t = /TRANSCRIPT \[(\d+) ms\] \[([^\]]+)\]: (.*)/.exec(r.stdout ?? "");
        return { ok: r.status === 0, ms: t?.[1], engine: t?.[2], text: (t?.[3] ?? "").trim(), tail: `${r.stdout ?? ""}${r.stderr ?? ""}`.slice(-600) };
      };
      // Before the fix: the whole capture, only resampled and encoded (what the old HUD sent once something triggered it).
      const before = path.join(tmp, "before.wav");
      fs.writeFileSync(before, encodeWav(downsample(capture, R)));
      const b = engine(before, expect);
      console.log(`  (unnormalised capture -> ${b.engine ?? "?"}: "${b.text}" in ${b.ms ?? "?"} ms)`);
      // After: the HUD's own VAD + pre-roll + normaliser.
      const r = runSegmenter(capture, R);
      check(r.utterances.length === 1, "W1 the quiet capture triggers the VAD exactly once", r.events.map((e) => e.ev.type));
      const u = r.utterances[0];
      if (u) {
        const prep = prepareForStt(downsample(u.samples, R));
        check(prep.ok, "W2 the utterance passes the quality gate", prep.ok ? { gainDb: prep.gainDb.toFixed(1), snrDb: prep.stats.snrDb.toFixed(1) } : prep.reason);
        if (prep.ok) {
          const after = path.join(tmp, "after.wav");
          fs.writeFileSync(after, encodeWav(prep.samples));
          if (process.env.DASK_VOICE_EVIDENCE_DIR) { fs.mkdirSync(process.env.DASK_VOICE_EVIDENCE_DIR, { recursive: true }); fs.copyFileSync(before, path.join(process.env.DASK_VOICE_EVIDENCE_DIR, "quiet-before.wav")); fs.copyFileSync(after, path.join(process.env.DASK_VOICE_EVIDENCE_DIR, "quiet-after.wav")); }
          const a = engine(after, expect);
          console.log(`  (VAD + pre-roll + normalised -> ${a.engine ?? "?"}: "${a.text}" in ${a.ms ?? "?"} ms, gain +${prep.gainDb.toFixed(1)} dB)`);
          check(a.ok && a.engine === "whisper-local", "W3 offline whisper (engine 'whisper-local') transcribes the command (>= 70 % of words)", a.ok ? a.text : a.tail);
          check(/^\s*open\b/i.test(a.text), "W4 the first word ('open') survived the VAD decision (pre-roll)", a.text);
        }
      }
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
