/**
 * 2026-11-16 remediation: "Open Microsoft Word and type hello" (any installed application, typed into its main editor) and request-derived
 * planning (a request a tool claims as a whole is planned from the request itself, without the local model). Through the real AgentRuntime,
 * Planner, grounding and verifier with a fake daemon; the daemon side is covered by EditorRoleInputTests.cs / UniversalAppLaunchTests.cs.
 * Run with: npx tsx tests/agent-runtime/any-app-session.test.ts
 */
import path from "node:path";
import { AgentRuntime } from "../../agent/runtime/runtime";
import { createDefaultRegistry, DEFAULT_GRANTS } from "../../agent/runtime/defaults";
import { anyAppSession, typeInAppRequest, actuationRefusal, requestedInputActions, MAIN_EDITOR, type DesktopBridge, type DesktopReply } from "../../agent/runtime/tools/desktop";
import type { LanguageModel, StructuredRequest, ToolPermission } from "../../agent/runtime/types";

let passed = 0, failed = 0;
function check(cond: boolean, label: string, detail?: unknown) {
  if (cond) { passed++; console.log("  PASS: " + label); } else { failed++; console.error("  FAIL: " + label + (detail !== undefined ? ` | ${JSON.stringify(detail)}` : "")); }
}
const ROOT = path.resolve(__dirname, "..", "..");
const GRANTED = new Set<ToolPermission>([...DEFAULT_GRANTS, "read:desktop", "request:desktop_action"]);

type Call = { tool: string; args: Record<string, any> };
class Daemon implements DesktopBridge {
  available = true;
  calls: Call[] = [];
  typeReply: DesktopReply = { status: "ok", result: { executed: true, verified: true, observed: "the document now contains exactly the typed text, inserted once",
    control: { controlType: "Document", name: "Document1", automationId: "" }, target: { process: "WINWORD.EXE", title: "Document1 - Word", pid: 7100 } } };
  constructor(private notOffered: string[] = []) {}
  offers(tool: string) { return !this.notOffered.includes(tool); }
  async call(_taskId: string, tool: string, args: Record<string, unknown>): Promise<DesktopReply> {
    this.calls.push({ tool, args });
    if (tool === "desktop.launch_app") return { status: "ok", result: { launched: true, verified: true, executed: true, app: "Word", newWindow: true,
      observed: 'a new Word window titled "Document1 - Word" (WINWORD.EXE, process 7100) is open' } };
    if (tool === "desktop.type_text") return structuredClone(this.typeReply);
    if (tool === "desktop.open_settings") return { status: "ok", result: { opened: true, verified: true, executed: true, page: "Display", observed: "the Settings window shows Display" } };
    return { status: "error", error: { code: "unexpected", message: `unexpected ${tool}` } };
  }
}

/** A model that must not be needed: any call is recorded (and fails the planning it was asked for). */
class NoModel implements LanguageModel {
  readonly name = "must-not-be-called";
  calls: StructuredRequest[] = [];
  async generateJson(req: StructuredRequest): Promise<unknown> { this.calls.push(req); throw new Error("the local model is not available (insufficient memory)"); }
}

let n = 0;
const run = (objective: string, d: DesktopBridge, m: LanguageModel = new NoModel()) =>
  new AgentRuntime({ model: m, registry: createDefaultRegistry(ROOT, { desktop: d }), granted: GRANTED }).run({ taskId: `w${++n}`, objective });

async function main() {
  console.log("[G] grammar: any installed application, then typing");
  const cases: [string, { name: string; text: string } | null][] = [
    ["Open Microsoft Word and type hello", { name: "Microsoft Word", text: "hello" }],
    ["open word and type hello", { name: "word", text: "hello" }],
    ["Please launch Microsoft Word, then write \"Dear Sam,\" in it.", { name: "Microsoft Word", text: "Dear Sam," }],
    ["open a new Word document and type hello there", { name: "Word", text: "hello there" }],
    ["open WordPad and type abc into the document", { name: "WordPad", text: "abc" }],
    ["Open Chrome and type hello", null],                          // a browser's focus is its address bar
    ["open powershell and type dir", null],                         // consoles run typed text
    ["open command prompt and type dir", null],
    ["open windows terminal and type ls", null],
    ["Open Notepad and type hello", null],                          // the fixed Notepad session owns it
    ["Open Calculator and type 2+2", null],                         // no typing target for Calculator
    ["open word and type hello then save it", null],                // runs on into another instruction: never guessed
    ["open word and type hello and close it", null],
    ["open the file report.docx and type hello", null],
  ];
  for (const [q, want] of cases) check(JSON.stringify(anyAppSession(q)) === JSON.stringify(want), `G ${q}`, anyAppSession(q));
  const steps = requestedInputActions("Open Microsoft Word and type hello");
  check(steps.length === 1 && steps[0]!.controlType === MAIN_EDITOR.controlType && steps[0]!.text === "hello", "G the typing step targets the main editor", steps);
  check(actuationRefusal("Open Microsoft Word and type hello") === null, "G not refused when the daemon offers launch, catalog and typing");
  check(/switched off/.test(actuationRefusal("Open Microsoft Word and type hello", (t) => t !== "desktop.type_text") ?? ""), "G refused honestly when typing is not offered");

  console.log("[W] 'Open Microsoft Word and type hello' through the runtime, without the model");
  {
    const d = new Daemon(); const m = new NoModel();
    const r = await run("Open Microsoft Word and type hello", d, m);
    check(d.calls.map((c) => c.tool).join() === "desktop.launch_app,desktop.type_text", "W1 launch first, then typing", d.calls.map((c) => c.tool));
    check(JSON.stringify(d.calls[0]?.args) === JSON.stringify({ app: "Microsoft Word", newDocument: true }), "W2 the launch names exactly the user's application, ready for typing", d.calls[0]?.args);
    check(JSON.stringify(d.calls[1]?.args) === JSON.stringify({ element: { role: "editor" }, text: "hello" }), "W3 the typing has NO window selector (the daemon binds it to the window it opened) and exactly the text", d.calls[1]?.args);
    check(m.calls.length === 0, "W4 the local model was never needed (planned and verified from the request)", m.calls.map((c) => c.purpose));
    check(r.outcome === "completed" && r.plan?.source === "request", "W5 completed only on the daemon's verified results", { o: r.outcome, resp: r.response });
  }
  {
    const d = new Daemon();
    d.typeReply = { status: "error", error: { code: "approval_denied", message: "You declined. Nothing was done." } };
    const r = await run("open word and type hello", d);
    check(r.outcome === "partial" && /declined/i.test(r.response), "W6 a declined typing step is reported as such (Word opened, nothing typed)", { o: r.outcome, resp: r.response });
  }
  {
    const d = new Daemon();
    d.typeReply = { status: "ok", result: { executed: true, verified: false } };
    const r = await run("open word and type hello", d);
    check(r.outcome !== "completed", "W7 typing that was not verified is never reported as done", { o: r.outcome });
  }
  {
    const d = new Daemon(["desktop.list_apps"]);
    const r = await run("open word and type hello", d);
    check(r.outcome === "refused" && d.calls.length === 0, "W8 without the installed-apps catalog: refused up front, nothing sent", { o: r.outcome, resp: r.response });
  }

  console.log("[T] 'type hello in Word': the application's open window, its main editor");
  check(JSON.stringify(typeInAppRequest("type hello in Word")) === JSON.stringify({ process: "WINWORD.EXE", text: "hello" }), "T1 type hello in Word");
  check(JSON.stringify(typeInAppRequest("Write 'Dear Sam,' into the Notepad window.")) === JSON.stringify({ process: "notepad.exe", text: "Dear Sam," }), "T2 quoted text into Notepad");
  check(typeInAppRequest("type hello in Word then save it") === null && typeInAppRequest("type hello in chrome") === null, "T3 run-on and other applications are not taken");
  {
    const d = new Daemon(); const m = new NoModel();
    const r = await run("type hello in Word", d, m);
    check(d.calls.length === 1 && JSON.stringify(d.calls[0]!.args) === JSON.stringify({ process: "WINWORD.EXE", element: { role: "editor" }, text: "hello" }),
      "T4 one typing request: Word's window by its process, its main editor, exactly the text", d.calls);
    check(r.outcome === "completed" && m.calls.length === 0, "T5 completed from the daemon's verification, no model needed", { o: r.outcome });
  }

  console.log("[R] request-derived planning in general");
  {
    const d = new Daemon(); const m = new NoModel();
    const r = await run("Open Windows Settings and navigate to Display", d, m);
    check(r.outcome === "completed" && m.calls.length === 0 && d.calls[0]?.tool === "desktop.open_settings", "R1 a claimed request completes without the model", { o: r.outcome, m: m.calls.length });
  }
  {
    const d = new Daemon(); const m = new NoModel();
    d.call = async (_t, tool, args) => { d.calls.push({ tool, args }); return { status: "ok", result: { windows: [], total: 0, returned: 0, truncated: false, complete: true, filter: {},
      capturedAtUtc: new Date().toISOString(), completedAtUtc: new Date().toISOString(), expiresAtUtc: new Date(Date.now() + 5000).toISOString() } } as DesktopReply; };
    const r = await run("What windows are open?", d, m);
    check(d.calls[0]?.tool === "desktop.list_windows" && m.calls.length === 0 && r.plan?.source === "request", "R3 an unclaimed request whose every word is accounted for is planned from the request", { o: r.outcome, m: m.calls.length, c: d.calls });
  }
  {
    const d = new Daemon(); const m = new NoModel();
    d.call = async (_t, tool, args) => { d.calls.push({ tool, args }); return { status: "ok", result: { executed: true, verified: true, observed: "done", control: { controlType: "Button", name: "Go" }, target: { process: "fixture.exe", title: "Fixture" } } } as DesktopReply; };
    const r = await run(`Click the Go button in the window titled "Fixture"`, d, m);
    check(m.calls.length === 0 && d.calls.length === 1 && JSON.stringify(d.calls[0]!.args) === JSON.stringify({ titleContains: "Fixture", element: { controlType: "Button", name: "Go" } }) && r.outcome === "completed",
      "R5 one element-bound click in a named window: exactly the request's window and control, no model", { o: r.outcome, c: d.calls });
  }
  {
    const d = new Daemon(); const m = new NoModel();
    d.call = async (_t, tool, args) => { d.calls.push({ tool, args }); return { status: "ok", result: { executed: true, verified: true, observed: "done", control: { controlType: "Edit", name: "Notes" }, target: { process: "fixture.exe", title: "Fixture" } } } as DesktopReply; };
    const r = await run(`Type "abc" into the Notes field in the window titled "Fixture", then press Enter`, d, m);
    check(m.calls.length === 0 && d.calls.map((c) => c.tool).join() === "desktop.type_text,desktop.press_keys" && (d.calls[0]!.args as any).text === "abc" && (d.calls[1]!.args as any).keys === "Enter",
      "R6 an ordered input request runs in the request's order with the request's values, no model", { o: r.outcome, c: d.calls });
  }
  {
    const d = new Daemon(); const m = new NoModel();
    const r = await run("What windows are open and summarise my week", d, m);
    check(r.plan?.source !== "request", "R4 a request with an unaccounted part is NOT planned from the request (nothing may be left out)", { o: r.outcome });
  }
  {
    const d = new Daemon(); const m = new NoModel();
    const r = await run("How do I make my laptop battery last longer and what should I avoid?", d, m);
    check(d.calls.length === 0 && r.plan?.source !== "request", "R2 an unclaimed request is never planned from the request (the model is asked)", { o: r.outcome, calls: d.calls.length });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
