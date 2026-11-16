# D-ASK — remediation of the independent QA findings (2026-11-16)

Audited build: `D-ASK-20261116T151233`. Base: `main` @ `2fbae54` plus the earlier uncommitted 2026-11-16 remediation (kept intact).
Nothing was committed, pushed, reset, cleaned or stashed. The QA reports (`DASK_*.md`) and all earlier evidence are untouched; new evidence is in
`results/remediation-qa-20261116/`.

**This is not a release-readiness statement.** Automated tests pass; the items in "Still requires a person" are unverified.

## 1. Findings: root cause and fix

### BUG-001: `npm run test:security` crashed (`ENOENT main.js`)
- **Root cause:** section D of `tests/security/api-auth.test.ts` still read the Electron launcher `main.js` (deleted when D-ASK moved to the native host) to check that the web server binds loopback and holds no auth logic. The read threw before any summary.
- **Fix:** the obsolete assertions were replaced by the same properties checked against the current architecture (new section E). Nothing was removed from sections A–C (unit, route-handler subprocess, route-coverage guard) or the rest of D.
  - The HUD host opens no TCP/UDP listener and depends on no HTTP server crate. It loads the frontend only from its in-process `dask://localhost` protocol.
  - Camera and microphone permissions are granted only to D-ASK's own origin; anything else is explicitly denied.
  - The HUD holds no API-token or Authorization-header logic.
  - The daemon opens no TCP/HTTP listener (named-pipe IPC only).
  - The local model server address is restricted to literal loopback.
  - `main.js` must not exist (Electron stays excluded).
  - The secret-hygiene scan now covers the HUD, daemon, Chrome relay and protocol sources.
  - Added coverage: tokens are compared in constant time (SHA-256 digests + `timingSafeEqual`, both scopes evaluated), and no direct `===` comparison of token material.
- **Files:** `tests/security/api-auth.test.ts`.

### BUG-002: screen capture failed in headless sessions; the 2 failing .NET tests
- **The two failing tests** (from the QA output): `ScreenObservationTests.DedicatedTestWindow_FullObservation_Capture_And_UIA_Verification` and `ScreenObservationTests.RepeatedScreenCapture_ResourceStability_Test`. Both read the real screen.
- **Root cause:** in a session without an interactive desktop (service or background window station, locked or secure desktop, disconnected session), `BitBlt` from the screen DC fails. The service reported only "BitBlt failed for both capture modes", indistinguishable from a genuine GDI fault, and the real-screen tests had no way to tell the two apart. Two further issues were found while reproducing:
  - On an invisible window station a blit can also *succeed* and return a blank frame. That would have been published as an observation.
  - With no display surface, DIB allocation threw instead of returning a failure.
- **Fix (production):**
  - New `InteractiveDesktop.Probe()` checks the window-station visibility flag, whether the input desktop can be opened, and whether its name is "Default".
  - `CaptureAsync` refuses up front, with `Status/RejectionCode = DesktopUnavailable` and the probe's reason, when there is no interactive desktop or no display surface. No buffer and no thumbnail are produced, and `Success=false`.
  - A blit failure on an interactive desktop stays `CaptureFailed`, worded as a genuine capture failure.
  - Real failures remain failures in every case.
- **Fix (tests):**
  - The two real-screen tests use `[InteractiveDesktopFact]`: they run on an interactive desktop and are *skipped with the probe's reason* (never passed) without one.
  - New `ScreenCaptureHeadlessTests`:
    - A **synthetic** frame painted through the existing `Blit` seam drives the real buffer, thumbnail and release pipeline (pixel bytes checked).
    - Repeated synthetic captures check that GDI objects and memory don't leak (non-parallel collection).
    - The headless classification is checked through seams.
    - A real-probe test (`[NonInteractiveDesktopFact]`) requires the real service to refuse with `DesktopUnavailable`.
  - `run-headless-observation.ps1` runs the observation tests inside a freshly created non-interactive window station: a real reproduction of the QA condition.
  - The existing genuine-failure test keeps asserting `CaptureFailed` by declaring its desktop interactive.
- **Files:**
  - `src/DAsk.Daemon/Automation/Observation/Win32ScreenObservationService.cs`
  - `src/DAsk.Daemon/Automation/Observation/InteractiveDesktop.cs` (new)
  - `tests/DAsk.Daemon.Tests/ScreenObservationTests.cs`
  - `tests/DAsk.Daemon.Tests/ScreenCaptureHeadlessTests.cs` (new)
  - `tests/DAsk.Daemon.Tests/Phase7B1bTests.cs`
  - `tests/DAsk.Daemon.Tests/run-headless-observation.ps1` (new)

### BUG-003: SAPI misrecognised "Pune"
- **Facts verified:**
  - The installed build at `%LOCALAPPDATA%\Programs\D-ASK` contains whisper.cpp b5454: 41 pinned files, **0 hash mismatches**. The model `ggml-base.en-q5_1.bin` (57 MB) is hash-verified.
  - The Windows recognizer present is "Microsoft Speech Recognizer 8.0 for Windows (English - US)".
  - The HUD already preferred whisper only after hashing every pinned file, so on the installed build voice input uses whisper. SAPI misrecognises "Pune" ("include a"). That is SAPI's acoustic model; code cannot fix it.
- **Root cause of the actual defect:** the fallback was silent. The reason whisper was not used was logged at debug level only, nothing could report which engine was really usable, and a total failure returned the bare text "transcription failed".
- **Fix:**
  - `stt::transcribe_detailed` returns the engine that *answered* plus `fallback_reason` (whisper unavailable / failed / unsuitable audio), logged as a warning. If both engines fail, the error names both causes.
  - New read-only `/api/stt/status` on the HUD hashes the pinned files *now* and reports `active`, `whisper.verified`, `whisper.reason` and `fallback`. It is never derived from configuration.
  - `/api/stt` returns `fallbackReason` and, on failure, `reason`.
  - The HUD shows a one-time "VOICE ENGINE" notice when the Windows recognizer answered instead of whisper, and a "VOICE INPUT FAILED" entry with the reason.
  - Offline operation is unchanged (no network anywhere).
- **Files:** `src/hud-native/src/stt.rs` (+3 Rust tests), `src/hud-native/src/main.rs`, `components/JarvisOrb.tsx`.

### Found during the regression run: Chrome search false negative
- **Symptom:** `chrome-regression` reported FAILED although Chrome showed "weather - Google Search". D-ASK didn't over-claim, but it was a false negative.
- **Root cause:** with Chrome already open, the search opens as a new tab in the existing window. The only accepted evidence for an existing window was "it is in the foreground", and Windows' focus rules kept Chrome behind this time.
- **Fix:** for a search, also accept an existing window of that browser whose title **changed to show the search after the start**. A window that already showed it before the start is not accepted, and existing windows are never registered as typing targets.
- **Files:** `src/DAsk.Daemon/Automation/Desktop/AppLaunchRequestService.cs`, `tests/DAsk.Daemon.Tests/UniversalAppLaunchTests.cs` (+2 tests).

### Noted, not changed (outside the confirmed findings)
- Preview thumbnails: at the maximum requested size (160×90) a 24-bit BMP is ~43 KB, over the 32 KB guardrail, so the thumbnail is silently omitted. This is pre-existing; the real-screen test tolerates a null thumbnail.
- BUG-004/005/006 of the QA report (headless browser voices, Node `DEP0190` warning, harness fails closed without a foreground window) were not in the remediation brief and were not changed.

## 2. Commands executed and results
All logs are in `results/remediation-qa-20261116/`.

| Command | Result | Kind |
|---|---|---|
| `npm run test:security` (before the fix) | crashed: `ENOENT main.js` (reproduced) | real |
| `npm run test:security` (final) | **220 passed, 0 failed, exit 0** (`security-final.log`) | real (static + subprocess route handlers) |
| `dotnet test` (complete suite, no filter, after the BUG-002 fix) | 699 passed, 0 failed, 8 skipped (`dotnet-full.log`) | real |
| `dotnet test` (complete suite, final, after the Chrome fix) | **701 passed, 0 failed, 8 skipped** (`dotnet-full-2.log`) | real |
| ↳ the 8 skipped | 7 opt-in live tests (`DASK_LIVE_*` not set) + `RealCapture_WithoutAnInteractiveDesktop…` (runs only headless; passed in the headless run) | not executed here |
| ↳ the 2 QA failures | `DedicatedTestWindow_FullObservation…` and `RepeatedScreenCapture_ResourceStability…` **passed** (interactive desktop) | real screen |
| `run-headless-observation.ps1` (tests inside a new non-interactive window station `Service-0x0-…$`) | 21 tests: **19 passed, 2 skipped** with the probe's reason, **0 failed** (`headless-observation-2.log`) | real headless condition; capture frames synthetic |
| Observation + launch focused runs | 60 (59 passed, 1 headless-only skipped); launch 76/76 | real + synthetic |
| TypeScript, all 43 suite files | **43/43 exit 0, 2,316 checks** (incl. local-inference 103, offline-integration 9/9, approval-lifecycle 100, any-app-session 36, native-agent 102) (`ts-full.txt`) | real logic; model/daemon faked where stated in each suite |
| `cargo test --release` (src/hud-native) | **74 passed, 0 failed, 4 ignored** (+3 new STT tests; the ignored ones are real-engine fixtures run by the STT script) | real |
| `npx tsc -p tsconfig.json --noEmit` (frontend) | clean | real |
| `tests/hud-agent/stt-engines.ps1` | 6/6 (whisper 3/3 exact incl. "Pune"; SAPI 3/3 at the ≥70 % word rule, "Pune" → "include a") (`stt-engines/`) | synthesised speech (no microphone) |
| Installed whisper verification (hash of every pinned file) | 41 files, 0 mismatches; model verified | real |
| Package build | `D-ASK-20261116T205058` (superseded), then **`D-ASK-20261116T210103`** (manifest `a242578b…9bf1`, 218 files, unsigned) | real |
| `verify-chrome-search.ps1` on 205058 | 4/5: results page shown, HUD FAILED → false negative, fixed above | real HUD, harness-approved |
| `verify-chrome-search.ps1` on **210103** ("cricket scores") | **5/5** | real HUD, harness-approved |
| `verify-word.ps1` on 205058 | 9/9 | real HUD, harness-approved |
| `verify-word.ps1` on **210103** approve / decline | **9/9 / 9/9** (document exactly `hello`; after DENY empty, PARTIAL) | real HUD, harness-approved |

**New build: `dist/desktop/D-ASK-20261116T210103`.** It is NOT installed. The installed app is still `D-ASK-20261116T151233` (the audited build). To install: run `Install-D-ASK.ps1` from that folder with D-ASK closed.

## 3. Still requires a person / not executed
- Human-in-the-loop HUD session. All real-HUD runs above were harness-approved: a script clicked the cards, not a person.
- Live microphone input. The speech tests use synthesised audio, which is synthetic.
- The emergency stop hotkey pressed by a person. It is covered by the daemon protocol/state tests and the earlier live input tests, which were not re-run (opt-in, they drive the real mouse and keyboard).
- The opt-in live .NET tests (Chrome, input, system admin, display mode, Office, app launch) were skipped; they need `DASK_LIVE_*` flags and real side effects.
- Notepad acceptance: not re-run (the user has unsaved Notepad tabs; the script refuses to touch them).
- Android phone, code-signing certificate, loading the Chrome extension once.

## 4. Confirmation
- No existing work was discarded: no reset, clean, stash, branch switch, commit or push. Earlier changes, the QA reports and earlier evidence are unchanged.
- No safety control was weakened:
  - Approvals, the approval-card validation, emergency stop, IPC authentication and API authentication are unchanged.
  - Screen capture is *stricter* (refuses without an interactive desktop).
  - The Chrome verification accepts only a title that changed after the approved start.
  - The security suite gained assertions (none removed).
  - No test was deleted or disabled. The two real-screen tests are skipped only when the desktop probe proves there is no screen, with the reason shown.
