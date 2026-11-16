# Offline Voice Remediation — 2026-11-16

Defect under repair: on installed build `D-ASK-20261116T210103` physical offline voice input failed completely. The level ring stayed flat, normal speech never triggered recording, and when it did trigger (shouting or tapping) the start of the utterance was clipped and the HUD silently reset to an empty command box.

Scope: the HUD voice capture front end only. Whisper, the native `/api/stt`, the agent, approvals, the emergency stop and IPC are unchanged.

Result labels: **PASS** = executed and passed · **FAIL** = executed and failed · **NOT TESTED** = not executed · **SIMULATED** = fixture or synthetic evidence only · **BLOCKED** = cannot be executed because of a known constraint.

**Physical microphone acceptance with a person speaking has NOT been performed on the new build.** It is the user's step (section 9). Nothing in this report certifies it.

---

## 1. Confirmed root causes

| QA finding | Verdict | Evidence |
|---|---|---|
| **A. AudioContext suspended** | **Confirmed, plus a related defect.** The context was created *after* `await getUserMedia()`. That is outside the click/V-key gesture, which is what the autoplay policy honours, and `resume()` was never called. A suspended context means no analyser data, no `onaudioprocess`, a flat ring and nothing recorded. Separately, disarming never closed the context, so every arm leaked one. | `components/JarvisOrb.tsx` (old lines 959–970, 942–953) |
| **B. VAD unsuitable** | **Confirmed.** `fftSize = 256` at the context rate (48 kHz on this laptop) gives 128 bins of 187.5 Hz. The old code averaged *all* 128 bins (0–24 kHz) with `getByteFrequencyData` and compared the result to a fixed 0.05. Speech (300–4500 Hz) sits in bins 2–24, about 18 % of the average. The decision also ran on `requestAnimationFrame`, which stops when the WebView is hidden or occluded. | old `checkVolume()` |
| **C. No pre-roll** | **Confirmed.** `PcmRecorder.start()` discarded everything before the trigger, and the trigger needed loud frames first. | old `lib/pcmRecorder.ts` |
| **D. WAV too quiet for Whisper** | **Partly NOT reproduced.** A local SAPI utterance attenuated to the level QA measured (96/32768, −50.7 dBFS peak), 16-bit quantised and mixed with real ambient noise recorded from this laptop's microphone was transcribed **correctly by whisper even without normalisation** (test W, section 6). Whisper's log-mel front end is largely level-invariant when SNR is adequate. QA's `[BLANK_AUDIO]` is better explained by A–C: little or no real speech reached Whisper. Normalisation is still added as defence in depth (the Windows SAPI fallback *is* level-sensitive). It sits behind a quality gate so noise is never amplified into "speech". | `results/voice-remediation-20261116/voice-capture.test.log`, `quiet-before.wav`, `quiet-after.wav` |
| **E. Empty transcription silently ignored** | **Confirmed.** An empty `text` cleared the command box with no message, a fetch error was only `console.error`-ed, and microphone failures were all reported as "permission denied". | old `onstop` handler |

Additional measurements made in this session:

| Measurement | Value |
|---|---|
| Default capture endpoint (Core Audio) | `Microphone Array (Intel Smart Sound Technology for Digital Microphones)`, volume 0.83 (+19 dB), **not muted** |
| Raw WinMM ambient capture, 4 s, no speech | frame levels −97 to −81 dBFS, isolated click peak −44 dBFS. Consistent with QA's "−80 dBFS RMS" |
| 42 earlier HUD (WebView2) recordings, `results/offline-voice*` | real requests: p90 frame level −14 to −38 dBFS, SNR 26–53 dB. Noise-only segments that Whisper turned into "you"/"of"/"."/"\*fart\*": SNR 6–24 dB |

So the WebView2 capture path (with browser auto-gain) has delivered good speech levels from this microphone before. The physical failure is explained by the capture front end (A, B, C), not by the microphone hardware or by Whisper.

## 2. Files modified

| File | Change |
|---|---|
| `components/JarvisOrb.tsx` | Voice input rewritten: a synchronous gesture start, one session at a time, VAD driven by the audio callback, the pre-roll segmenter, quality gate + normalisation, serial transcription queue, specific visible errors, a real level ring (the fake 0.4 placeholder height is removed), a status label (OPENING MIC / LISTENING / RECORDING / TRANSCRIBING / VOICE ERROR) and a `#voice-notice` status line |
| `lib/pcmRecorder.ts` | Kept `encodeWav`, `downsample` (now with a 3-tap moving-average anti-alias before 48→16 kHz). New: `PreRollBuffer`, `analyzeSignal`, `prepareForStt`. Removed the `PcmRecorder` class (its only user was JarvisOrb) |
| `lib/voiceActivity.ts` (new) | `SpeechBandMeter` (4th-order 300 Hz HP + 4th-order 4.5 kHz LP biquads at the real sample rate), `AdaptiveVad`, `VoiceSegmenter` |
| `lib/micSession.ts` (new) | `beginMicSession` lifecycle, `classifyMicError`, user messages, `interpretSttResponse` |
| `app/api/stt/route.ts` | Groq forwarding **removed**. The dev-only route answers 400 (no file) or 503 "runs only in the native HUD (offline whisper)". It never sends audio anywhere. The auth contract is unchanged (security suite 220/220) |
| `app/globals.css` | Styles for the new states and the notice line |
| `scripts/hud/voice-live.ps1` | Also records the HUD's `voice-notice` text (listening / rejections / recognizer errors) in `voice-records.json` |
| `tests/hud-agent/voice-capture.test.ts` (new) | 65 checks (section 6) |

Not changed: `src/hud-native` (Whisper invocation, `/api/stt`, `[BLANK_AUDIO]` stripping, the voice gate), the agent runtime, the daemon, approvals, the emergency stop.

## 3. Audio lifecycle

`beginMicSession(env, onFrame)` in `lib/micSession.ts`:

1. **Inside the gesture, synchronously:** `new AudioContext()` and `ctx.resume()`. `toggleVoiceInput` is no longer `async` and contains no `await` before this call. A test (B9) inspects the source to keep it that way.
2. `getUserMedia({audio:{channelCount:1, echoCancellation, noiseSuppression, autoGainControl: true}})`. These are the browser defaults that produced the good recordings, now stated explicitly. Echo cancellation keeps D-ASK's own voice out.
3. If the context is not `running`, `resume()` is retried with a 2 s limit. If it is still not running, the session fails with **"Audio processing could not start (the audio engine stayed suspended)"**.
4. Graph: `source → ScriptProcessor(2048) → Gain(0) → destination`. The zero gain guarantees nothing is played back.
5. The first audio frame must arrive within 2.5 s. Otherwise: **"The microphone opened but delivered no audio"**.
6. While armed, `onstatechange` re-resumes an interrupted context. A microphone track `ended` event reports "microphone stopped" and disarms.
7. `dispose()` is idempotent: it detaches the callback, disconnects the nodes, stops the tracks and **closes the context**. Every failure path above also releases everything.
8. Concurrency: `voiceArmingRef` ignores presses while opening (the button is disabled), and a generation counter discards a session that finishes opening after disarm or unmount. Utterances are transcribed one after another (a promise queue).

Error classification: `NotAllowedError`/`SecurityError` → permission denied. `NotFoundError`/`OverconstrainedError` → no microphone. `NotReadableError`/`AbortError` → in use / cannot open. No `mediaDevices` → voice not available. No `AudioContext` → audio processing unavailable.

## 4. VAD, noise floor, pre-roll

- **Speech band, computed for the real rate:** two cascaded RBJ biquads on each side (300 Hz high-pass, 4500 Hz low-pass, Q 0.707), driven by `audioCtx.sampleRate`. They work in the time domain, so there are no FFT-bin indices to get wrong. 50/60 Hz hum, DC and rumble do not count (test C2: −26 dBFS 50 Hz hum never triggers).
- **Decision per 20 ms frame** inside the audio callback, so it also works when the HUD is occluded (it used to depend on `requestAnimationFrame`).
- **Adaptive noise floor (dB):** the first 300 ms after arming learn the room (minimum). Then the floor falls fast (α = 0.5) and rises slowly (α = 0.02, about 1 s; 0.005 while speech is in progress). The gaps between words keep the floor honest during speech, and a steady new noise (a fan) is absorbed within a few seconds.
- **Start:** 3 consecutive frames (60 ms) ≥ max(floor + 10 dB, −80 dBFS). **Continue:** ≥ floor + 5 dB. **End:** 1.2 s below that (a pause after "D-ASK," does not split the request; test C6).
- **Too short:** under 200 ms of active speech is discarded without calling Whisper (taps, clicks; tests C5).
- **Level ring:** (band level − floor) / 40 dB, so it moves for a −50 dBFS raw microphone and for an AGC'd −3 dBFS signal alike (test C1).
- **Pre-roll:** a `PreRollBuffer` ring of 500 ms at the capture rate. Every buffer goes to the ring until the VAD fires. The recording then starts with `ring.drain()`, which already contains the triggering buffer, and continues with later buffers. Each sample is in exactly one place, so nothing is duplicated, missing or reordered. Test D2 checks this sample by sample against the original capture.

## 5. Normalisation and signal-quality checks (`prepareForStt`)

On the 16 kHz utterance:

1. DC offset removed.
2. Statistics: peak, RMS, 20 ms frame levels; noise = 10th percentile, speech = 90th percentile, SNR = speech − noise, active time = frames ≥ noise + 12 dB.
3. **Rejected without gain** (with a reason shown in the HUD, including the measured levels):
   - peak < 3 LSB → *"The microphone recorded silence. Check that it is not muted"*
   - speech < −75 dBFS → *"Audio too quiet. Speak closer to the microphone or louder."*
   - SNR < 16 dB or active < 250 ms → *"No speech detected, only background noise. Speak closer…"*

   Calibration on 42 real HUD recordings from this laptop: all 23 multi-word requests pass (lowest SNR 26 dB, so a 10 dB margin), and 12 of 19 noise-only segments are rejected before Whisper.
4. **Gain** = −1 dBFS / peak, at least 1× (loud speech is never boosted) and at most +50 dB. If a transient (a tap) would keep the speech below about −30 dBFS, the speech is raised to about −20 dBFS and the transient is soft-limited (tanh knee from 0.6 to 0.89). The output never exceeds −1 dBFS, so there is no clipping. Gain does not change the SNR (test A1).
5. After transcription, Whisper's known noise outputs ("you", "thank you", ".", "\*…\*", …) are reported as "no speech" and never become a request.

## 6. Whisper invocation and fallback

Unchanged and authoritative: the HUD POSTs 16 kHz mono 16-bit WAV to the native `dask://localhost/api/stt`. That runs `whisper-cli` (`ggml-base.en-q5_1.bin`, hash-verified) and falls back to the local Windows recognizer only if Whisper fails (the fallback is reported once in the history). No network is involved. The HUD now shows every outcome: transcript with engine, empty transcript, Whisper unavailable, recognizer failure (with the native reason), rejected WAV, recognizer unreachable, or acceptance gate withheld.

## 7. Tests run (all on this laptop, 2026-11-16)

| Command | Result | Class |
|---|---|---|
| `npx tsx tests/hud-agent/voice-capture.test.ts` (with `DASK_AMBIENT_WAV`=real mic ambient) | **65 passed, 0 failed** | see the rows below |
| — A normalisation (−50 dBFS speech → peak 0.8–0.89, +49 dB; silence, LSB dither, −60 dBFS noise and a tap rejected; loud speech not boosted; tap soft-limited; DC removed; WAV header; resampler) | 15/15 PASS | SIMULATED (synthetic signals) |
| — B lifecycle (resume inside gesture; `running`; non-zero frames; suspended → visible error + cleanup; no frames → error; permission / no device / busy; 25 arm/disarm cycles with no leak; device lost; source guard for the synchronous gesture path and single session) | 16/16 PASS | SIMULATED (Web Audio fakes) |
| — C VAD (speech at −50/−20/−3 dBFS peak → exactly one utterance; 20 s of noise and 50 Hz hum never trigger; a fan step gives ≤ 1 segment, then rejected; floors −90/−80/−50 dBFS; click and 120 ms bump ignored; 700 ms pause not split; floor estimate) | 12/12 PASS | SIMULATED |
| — D pre-roll (ring order and capacity; sample-exact utterance; onset inside the recording) | 5/5 PASS | SIMULATED |
| — E STT outcomes | 11/11 PASS | unit |
| — R 42 real HUD recordings from this laptop: 23/23 speech kept, 12/19 noise segments rejected | 2/2 PASS | real recordings (earlier sessions), offline |
| — W real offline Whisper: SAPI phrase "open the notes window and type hello" at −50.7 dBFS peak, 16-bit, in **real** ambient from this laptop's microphone → VAD (1 utterance) → pre-roll → +43.4 dB → `whisper-local`: **"open the notes window and type hello"** (2.0 s); first word "open" kept | 4/4 PASS | **SIMULATED** physical input, real engine |
| `npx tsx tests/hud-agent/voice.test.ts` (incl. live SAPI round trip through the changed resampler) | 7 passed, 0 failed | PASS |
| `npx tsx tests/hud-agent/voice-command.test.ts` | 14 passed, 0 failed | PASS |
| `npx tsx tests/hud-agent/spoken-text.test.ts` | 25 passed, 0 failed | PASS |
| `npx tsx tests/hud-agent/approval-lifecycle.test.ts` | 100 passed, 0 failed | PASS |
| `npx tsx tests/security/api-auth.test.ts` | 220 passed, 0 failed | PASS |
| `npx tsc --noEmit -p tsconfig.json` | no errors | PASS |
| `cargo test` in `src/hud-native` (no Rust source changed) | 74 passed, 0 failed, 4 ignored (same as the RC baseline) | PASS |
| .NET daemon suite, TypeScript agent-runtime suite | not re-run: no daemon or agent-runtime file was touched | NOT TESTED |
| Physical microphone, person speaking, Wi-Fi off, new build | — | **NOT TESTED** (user step, section 9) |

Logs: `results/voice-remediation-20261116/` (`voice-capture.test.log`, the other suite logs, `ambient-real-mic-winmm.wav`, `quiet-before.wav` / `quiet-after.wav`, `build-package.log`).

## 8. Package

New package: **`D-ASK-20261116T223649`** in `dist\desktop\D-ASK-20261116T223649` (unsigned, like every earlier build). Built with `node scripts/package/build-package.mjs --out dist/desktop/<id>` (exit 0); manifest SHA-256 `989aa74c4af311c7bb4694ef23596cd6a7496e7a636b7ffc41a26d1be944abde` (218 files); `build-package.mjs --verify` re-verified all 218 files (PASS). The folder was first written with a UTC stamp (`D-ASK-20261116T170649`) and renamed to the local-time stamp that earlier builds use; no file content changed. The packaged frontend contains the new voice code (`voice-notice`) and no Groq audio endpoint. **Not yet installed.** The installed `D-ASK-20261116T210103` is untouched.

## 9. Physical acceptance (user)

1. Install the new build (close any running D-ASK first):
   `powershell -ExecutionPolicy Bypass -File dist\desktop\D-ASK-20261116T223649\Install-D-ASK.ps1`
2. **Disconnect Wi-Fi.** Launch `%LOCALAPPDATA%\Programs\D-ASK\Start-D-ASK.cmd` and wait for the HUD.
3. Press **V** or click **ARM VOICE**. Expected: status *OPENING MIC* and then *LISTENING*; the line under the command box reads *"Listening on Microphone Array (Intel® Smart Sound…). Speak normally."* If instead it shows an error (suspended, no audio, permission), note the exact text. That is now the diagnosis.
4. Stay quiet for about 1 s (the room is learned), then at 50–70 cm say: **"D-ASK, open the notes window and type hello."**
5. Expected: the equalizer rises while you speak; the status changes to *RECORDING* (amber), then *TRANSCRIBING* about 1.2 s after you stop; the line reads *Heard (whisper-local): "D-ASK, open the notes window and type hello."*; the wake sound plays; the request runs.
6. Expected approval: D-ASK asks to approve opening the notes window (Notepad), then typing "hello". Nothing opens or types before you approve. Approve both, and check that Notepad shows `hello` and the HUD reports the verified result.
7. If it is rejected, the line says why with levels, e.g. *"No speech detected… [speech −52 dBFS, noise −60 dBFS, SNR 8 dB …]"*. Record that text.

Evidence harness (repo stack, keeps the recordings, transcripts and status lines):
`powershell -ExecutionPolicy Bypass -File scripts\hud\voice-live.ps1 -OutDir results\voice-local\hud-verify -Count 2`

## 10. Remaining limitations

- Physical acceptance with a person speaking: **NOT TESTED** (requires the user).
- Thresholds are calibrated on this laptop's recordings and synthetic signals. A very noisy room (SNR under 16 dB) is rejected with an explicit message rather than guessed at.
- Some Whisper noise outputs that are not on the filter list (e.g. "yeah") can still appear as a transcript. Single words are not run as requests (existing `parseVoiceTranscript` rule).
- `ScriptProcessorNode` is deprecated but supported in WebView2. An AudioWorklet would need a module served from `dask://`, which is out of scope here.
- The package is unsigned (separate requirement). Android: NOT TESTED (no device).
