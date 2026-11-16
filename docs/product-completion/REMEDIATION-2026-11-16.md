# D-ASK remediation — 2026-11-16

Base: `main` @ `2fbae54` (audit docs only on top of RC `6c3113b`). Changes are **uncommitted**. Installed build: `dist/desktop/D-ASK-20261116T151233`
(manifest `f5803a00…687b`, 218 files, unsigned) at `%LOCALAPPDATA%\Programs\D-ASK`. Previous RC kept in `dist/desktop/D-ASK-20261115T023936`.
Evidence: `results/remediation-20261116/`.

## What changed

| Area | Change | Files |
|---|---|---|
| Compound requests | "open <any installed app> and type <text>" (`anyAppSession`), "type <text> in Word/Notepad" (`typeInAppRequest`); browsers, consoles and run-on instructions excluded | `agent/runtime/tools/desktop.ts` |
| Typing into Word | `element: { role: "editor" }`: the keyboard-focused Document of the window D-ASK opened for the task (or of the named app's single window); resolved directly through UIA (Word's tree exceeds the bounded inspection), re-resolved after approval, focus checked before every key, verified by reading the document text (ValuePattern, else TextPattern); AutoCorrect changes reported as such; consoles/browsers denied | `GuardedInputRequestService.cs`, `Win32GuardedInput.cs`, `GuardedInput.cs` |
| Word opens ready for typing | `launch_app { newDocument: true }` → the daemon's fixed switch `WINWORD.EXE /w` (shown on the card) | `AppLaunchRequestService.cs` |
| HUD approval cards | **Pre-existing defect:** the HUD validator accepted only the fixed-list launch card, so every installed-app launch (Word, Chrome, any catalog app) was refused in the HUD. Now validated and summarised with its exact program and arguments | `hooks/approvalLifecycle.ts` |
| Planning without the model | A request that a tool claims, or whose every word is explained by detected parts, is planned from the request itself (`Plan.source = "request"`) and verified by the daemon's observations only (no model call). Works under the memory guard. `requestPlans: false` keeps model planning | `agent/runtime/runtime.ts`, `verifier.ts`, `types.ts` |
| Web search vs network | `web_search_disabled` (a D-ASK setting, with how to enable) vs `no_network` (Windows reports none) vs results page not loading; "offline mode" wording removed. Product profile enables `DASK_AgentHost__WebSearch`; the Safe profile does not | `AppLaunchRequestService.cs`, `ChromeService.cs`, `build-package.mjs` |
| Extension first run | `extension_missing` names the installed extension folder and says that opening/searching works without it | `ChromeService.cs` |
| Low memory | Memory guard unchanged. Planning/answer failures caused by it now say so and name what still works | `runtime.ts` |
| Refusal text | The catch-all no longer claims D-ASK "can't launch or type anything"; input switched off is reported as a setting | `desktop.ts` |

## Tests
- Daemon (non-live): **669 passed, 0 failed** (incl. new `EditorRoleInputTests` 15, launch tests 3).
- TypeScript: all 45 suites pass (new `any-app-session.test.ts` 36; `approval-lifecycle` 100). `offline-integration` failed only while starved of RAM by a concurrent run; passes alone 9/9.
- Tests that validate a *model's* wrong plan now run with `requestPlans: false` (android E3/E5, chrome E2, app-launch D5, system-admin E2, desktop suite, browser-actions suite).

## Real-HUD acceptance (harness clicks the cards, not a person)
| Run | Result |
|---|---|
| `word-approve` (package 150634) | FAIL → found the HUD card-validator defect |
| `word-approve-2` "Open Microsoft Word and type hello" | 9/9, document reads exactly `hello` |
| `word-decline` (DENY on the typing card) | 9/9, outcome PARTIAL, document empty |
| `chrome-search` "Open Chrome and search for news" (no extension) | 5/5, Chrome window "news - Google Search" |
| `word-installed` (installed app) "open word and type 'Hello from D-ASK'" | 9/9 |
| `stt-engines` (synthetic speech, no microphone) | 6/6; whisper.cpp ~1.8–2.1 s/utterance |
| Notepad regression | NOT RUN: the user has unsaved Notepad tabs; the script refuses to touch them |

## Measurements
Free memory during the session: 2.4–4.1 GB of 16 GB. Model admission (estimate + 2,000 MB headroom): 0.5B ≥ 2,973 MB free, 1.5B ≥ 3,634 MB, 3B ≥ 4,608 MB.
Word request: first card ~10–20 s after submission (stack start included), task 28–37 s including two approvals, typing step ~3 s.

## Still open
- Human-in-the-loop HUD session (person clicking), live microphone, Android phone, trusted code-signing certificate, loading the Chrome extension once.
- Chrome page reading/clicking needs the extension. "search for X in Chrome" uses the extension path; "open Chrome and search for X" does not.
- Typing into other apps via the editor role works only where the app shows one focused Document (or a single text field). Excel cells, multi-document apps: refused, not guessed.
- Requests the grammar does not cover still need the local model; the model is refused when free memory is below the thresholds above.
- Wi-Fi-off Chrome run not performed live (covered by unit test `no_network`).
