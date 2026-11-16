// Offline voice input, microphone lifecycle (2026-11-16 physical-microphone remediation).
//
// The defect: the HUD created its AudioContext AFTER `await getUserMedia()` (outside the click/key gesture) and never called
// resume(). Under WebView2's dask://localhost/ origin such a context can stay "suspended": the clock does not advance, the
// analyser reads zeros, the ScriptProcessor never runs, the level ring stays flat and nothing is ever recorded.
//
// Now: the context is created and resume() is called SYNCHRONOUSLY inside the user gesture (beginMicSession must be called
// from the click/key handler before any await); after the microphone opens, the context must actually reach "running" and
// deliver audio frames within a deadline, or the session fails with a specific, visible reason. A session owns its stream,
// nodes and context and releases all of them exactly once.
//
// Web Audio is reached only through the small interfaces below, so the lifecycle is unit-tested with fakes
// (tests/hud-agent/voice-capture.test.ts).

export type VoiceIssue =
  | "unsupported" | "no-microphone" | "permission-denied" | "mic-busy" | "audio-context-unavailable" | "audio-suspended"
  | "no-audio-frames" | "mic-lost" | "silent" | "too-quiet" | "no-speech" | "own-voice" | "whisper-unavailable"
  | "stt-failed" | "stt-unreachable" | "bad-recording" | "empty-transcript" | "withheld";

export const VOICE_MESSAGES: Record<VoiceIssue, string> = {
  "unsupported": "Voice input is not available in this window (no microphone API).",
  "no-microphone": "No microphone detected. Connect or enable a microphone in Windows Settings > Sound.",
  "permission-denied": "Microphone permission denied. Allow microphone access for desktop apps in Windows Settings > Privacy > Microphone.",
  "mic-busy": "The microphone is in use by another application or could not be opened.",
  "audio-context-unavailable": "Audio processing is unavailable in this window (no AudioContext).",
  "audio-suspended": "Audio processing could not start (the audio engine stayed suspended). Click the microphone button again.",
  "no-audio-frames": "The microphone opened but delivered no audio. Check the input device in Windows Settings > Sound.",
  "mic-lost": "The microphone stopped (disconnected or taken by another app). Voice input disarmed.",
  "silent": "The microphone recorded silence. Check that it is not muted in Windows.",
  "too-quiet": "Audio too quiet. Speak closer to the microphone or louder.",
  "no-speech": "No speech detected, only background noise. Speak closer to the microphone or louder.",
  "own-voice": "Ignored audio recorded while D-ASK was speaking.",
  "whisper-unavailable": "The offline speech model (whisper) is unavailable and the Windows recognizer also failed.",
  "stt-failed": "Speech recognition failed.",
  "stt-unreachable": "The local speech recognizer did not answer.",
  "bad-recording": "The recording was rejected by the speech recognizer.",
  "empty-transcript": "No words recognised. Speak closer to the microphone or louder.",
  "withheld": "Transcript withheld by the acceptance-test gate.",
};

export class VoiceError extends Error {
  constructor(readonly issue: VoiceIssue, detail?: string) { super(detail ? `${VOICE_MESSAGES[issue]} (${detail})` : VOICE_MESSAGES[issue]); }
}

/** getUserMedia / AudioContext failures to a specific reason (DOMException names per the Media Capture spec). */
export function classifyMicError(e: unknown): VoiceIssue {
  if (e instanceof VoiceError) return e.issue;
  const name = (e as { name?: string } | null)?.name ?? "";
  if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError") return "permission-denied";
  if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") return "no-microphone";
  if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError") return "mic-busy";
  return "mic-busy";
}

// ── Minimal Web Audio surface (structural, so tests can supply fakes) ─────────────────────────────────────────────────
export interface TrackLike { stop(): void; readyState?: string; addEventListener?(t: "ended", f: () => void): void; label?: string }
export interface StreamLike { getTracks(): TrackLike[]; getAudioTracks?(): TrackLike[] }
export interface NodeLike { connect(n: unknown): unknown; disconnect(): void }
export interface ProcessorLike extends NodeLike { onaudioprocess: ((e: { inputBuffer: { getChannelData(c: number): Float32Array } }) => void) | null }
export interface GainLike extends NodeLike { gain: { value: number } }
export interface ContextLike {
  state: string;
  sampleRate: number;
  destination: unknown;
  resume(): Promise<void>;
  close(): Promise<void>;
  createMediaStreamSource(s: StreamLike): NodeLike;
  createScriptProcessor(size: number, inCh: number, outCh: number): ProcessorLike;
  createGain(): GainLike;
  onstatechange?: (() => void) | null;
}
export interface MicEnvironment {
  getUserMedia?: (c: MediaStreamConstraints) => Promise<StreamLike>;
  createContext?: () => ContextLike;
}

export function browserMicEnvironment(): MicEnvironment {
  const w = typeof window !== "undefined" ? (window as unknown as { AudioContext?: new () => ContextLike; webkitAudioContext?: new () => ContextLike }) : undefined;
  const Ctor = w?.AudioContext ?? w?.webkitAudioContext;
  const md = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
  return {
    getUserMedia: md?.getUserMedia ? (c) => md.getUserMedia(c) as unknown as Promise<StreamLike> : undefined,
    createContext: Ctor ? () => new Ctor() : undefined,
  };
}

/** Browser processing kept ON (as in the recordings whisper handled well): echo cancellation removes D-ASK's own voice,
 *  automatic gain control raises a quiet array microphone. Mono. */
export const MIC_CONSTRAINTS: MediaStreamConstraints = {
  audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  video: false,
};

export interface MicSessionOptions {
  bufferSize?: number;            // ScriptProcessor buffer (2048 = ~43 ms at 48 kHz)
  resumeTimeoutMs?: number;
  firstFrameTimeoutMs?: number;
  onIssue?: (issue: VoiceIssue) => void;   // problems AFTER the session started (microphone unplugged, context interrupted)
}

export interface MicSession {
  readonly sampleRate: number;
  readonly contextState: () => string;
  readonly deviceLabel: string;
  readonly framesReceived: () => number;
  dispose(): Promise<void>;
  readonly disposed: () => boolean;
}

const withTimeout = <T,>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<"timeout">((r) => setTimeout(() => r("timeout"), ms))]);

/**
 * Opens the microphone and starts audio processing. MUST be called synchronously from the user gesture (click / key): the
 * AudioContext is created and resume() is requested before the first await. Resolves only once the context is "running" and
 * the first audio frame has arrived; otherwise rejects with a VoiceError and leaves nothing open.
 */
export function beginMicSession(env: MicEnvironment, onFrame: (samples: Float32Array) => void, opts: MicSessionOptions = {}): Promise<MicSession> {
  if (!env.getUserMedia) return Promise.reject(new VoiceError("unsupported"));
  if (!env.createContext) return Promise.reject(new VoiceError("audio-context-unavailable"));
  let ctx: ContextLike;
  try { ctx = env.createContext(); } catch (e) { return Promise.reject(new VoiceError("audio-context-unavailable", String(e))); }
  // Inside the gesture: this is the call that the autoplay policy honours.
  const firstResume = ctx.resume().catch(() => undefined);
  const getUserMedia = env.getUserMedia;
  return (async () => {
    let stream: StreamLike | null = null;
    let processor: ProcessorLike | null = null, source: NodeLike | null = null, sink: GainLike | null = null;
    let disposed = false, frames = 0;
    const release = async () => {
      if (disposed) return;
      disposed = true;
      if (processor) processor.onaudioprocess = null;
      for (const n of [source, processor, sink]) { try { n?.disconnect(); } catch { /* not connected */ } }
      stream?.getTracks().forEach((t) => { try { t.stop(); } catch { /* already */ } });
      ctx.onstatechange = null;
      try { if (ctx.state !== "closed") await ctx.close(); } catch { /* already closed */ }
    };
    try {
      try { stream = await getUserMedia(MIC_CONSTRAINTS); }
      catch (e) { throw new VoiceError(classifyMicError(e), (e as Error)?.name); }
      const tracks = stream.getAudioTracks?.() ?? stream.getTracks();
      if (!tracks.length) throw new VoiceError("no-microphone");

      await firstResume;
      if (ctx.state !== "running") await withTimeout(ctx.resume().catch(() => undefined), opts.resumeTimeoutMs ?? 2000);
      if (ctx.state !== "running") throw new VoiceError("audio-suspended", `state=${ctx.state}`);

      source = ctx.createMediaStreamSource(stream);
      processor = ctx.createScriptProcessor(opts.bufferSize ?? 2048, 1, 1);
      // The processor only runs while connected to the destination; a zero gain guarantees nothing is ever played back.
      sink = ctx.createGain();
      sink.gain.value = 0;
      let firstFrame: () => void = () => {};
      const gotFrame = new Promise<void>((r) => { firstFrame = r; });
      processor.onaudioprocess = (e) => {
        if (disposed) return;
        frames++;
        if (frames === 1) firstFrame();
        onFrame(e.inputBuffer.getChannelData(0));
      };
      source.connect(processor); processor.connect(sink); sink.connect(ctx.destination);

      if ((await withTimeout(gotFrame, opts.firstFrameTimeoutMs ?? 2500)) === "timeout") throw new VoiceError("no-audio-frames", `state=${ctx.state}`);

      // After start: a context the OS interrupts is resumed; a microphone that disappears is reported.
      ctx.onstatechange = () => {
        if (disposed) return;
        if (ctx.state === "suspended" || ctx.state === "interrupted") {
          void ctx.resume().catch(() => undefined).then(() => { if (!disposed && ctx.state !== "running") opts.onIssue?.("audio-suspended"); });
        }
      };
      for (const t of tracks) t.addEventListener?.("ended", () => { if (!disposed) opts.onIssue?.("mic-lost"); });

      return {
        sampleRate: ctx.sampleRate,
        contextState: () => ctx.state,
        deviceLabel: tracks[0]?.label ?? "",
        framesReceived: () => frames,
        dispose: release,
        disposed: () => disposed,
      } satisfies MicSession;
    } catch (e) {
      await release();
      throw e instanceof VoiceError ? e : new VoiceError(classifyMicError(e), String(e));
    }
  })();
}

// ── What the native /api/stt answered ─────────────────────────────────────────────────────────────────────────────────

/** Whisper's well-known outputs for audio that holds no words (noise, breath, a tap). Treated as "no speech", never as a request. */
const NOISE_HALLUCINATIONS = new Set(["you", "thank you", "thanks", "thank you for watching", "thanks for watching", "bye", "oh", "of", "um", "uh", "hmm", "mm", "mmm", "mm-hmm", "so"]);

export type SttOutcome =
  | { kind: "text"; text: string; engine: string; fallbackReason?: string }
  | { kind: "issue"; issue: VoiceIssue; detail?: string; engine?: string };

export function interpretSttResponse(status: number, body: unknown): SttOutcome {
  const b = (body && typeof body === "object" ? body : {}) as { text?: unknown; engine?: unknown; fallbackReason?: unknown; reason?: unknown; error?: unknown; gate?: unknown };
  const engine = typeof b.engine === "string" ? b.engine : undefined;
  const reason = typeof b.reason === "string" ? b.reason : typeof b.error === "string" ? b.error : undefined;
  if (status >= 200 && status < 300) {
    if (b.gate === "withheld") return { kind: "issue", issue: "withheld", detail: reason, engine };
    const text = typeof b.text === "string" ? b.text.trim() : "";
    if (!text) return { kind: "issue", issue: "empty-transcript", engine };
    const bare = text.toLowerCase().replace(/[^a-z\s-]/g, "").replace(/\s+/g, " ").trim();
    // "*fart*", "*coughs*": whisper's sound annotations ([...] and (...) are already removed natively).
    if (!bare || NOISE_HALLUCINATIONS.has(bare) || /^\*[^*]*\*$/.test(text)) return { kind: "issue", issue: "no-speech", detail: `recognizer heard only "${text}"`, engine };
    return { kind: "text", text, engine: engine ?? "unknown", fallbackReason: typeof b.fallbackReason === "string" ? b.fallbackReason : undefined };
  }
  if (status === 400) return { kind: "issue", issue: "bad-recording", detail: reason };
  if (reason && /whisper is not available|whisper failed/i.test(reason)) return { kind: "issue", issue: "whisper-unavailable", detail: reason };
  return { kind: "issue", issue: "stt-failed", detail: reason ?? `HTTP ${status}` };
}

export function voiceMessage(issue: VoiceIssue, detail?: string) {
  return detail ? `${VOICE_MESSAGES[issue]} [${detail}]` : VOICE_MESSAGES[issue];
}
