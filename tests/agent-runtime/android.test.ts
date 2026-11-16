/**
 * Android through adb, agent side (2026-11-15). Run with: npx tsx tests/agent-runtime/android.test.ts
 *   G. grammar: natural language -> exactly one android.* request with the request's own arguments (or nothing)
 *   E. end to end through the real AgentRuntime with a scripted model and a fake daemon
 * The daemon side (authorization states, approvals, SHA-256 verified transfers) is AndroidTests.cs; a REAL phone needs DASK_LIVE_ANDROID=1.
 */
import path from "node:path";
import { AgentRuntime } from "../../agent/runtime/runtime";
import { createDefaultRegistry, DEFAULT_GRANTS } from "../../agent/runtime/defaults";
import { actuationRefusal, type DesktopBridge, type DesktopReply } from "../../agent/runtime/tools/desktop";
import { androidRequest } from "../../agent/runtime/tools/android";
import { systemRequest } from "../../agent/runtime/tools/systemAdmin";
import type { LanguageModel, StructuredRequest, ToolPermission } from "../../agent/runtime/types";

let passed = 0, failed = 0;
function check(cond: boolean, label: string, detail?: unknown): void {
  if (cond) { passed++; console.log("  PASS: " + label); }
  else { failed++; console.error("  FAIL: " + label + (detail !== undefined ? ` | ${JSON.stringify(detail)}` : "")); }
}
const ROOT = path.resolve(__dirname, "..", "..");
class FakeDaemon implements DesktopBridge {
  available = true;
  calls: { tool: string; args: Record<string, unknown> }[] = [];
  constructor(private replies: DesktopReply[], private notOffered: string[] = []) {}
  offers(tool: string) { return !this.notOffered.includes(tool); }
  async call(_t: string, tool: string, args: Record<string, unknown>) { this.calls.push({ tool, args }); return structuredClone(this.replies.length > 1 ? this.replies.shift()! : this.replies[0]!); }
}
const plan = (steps: { id: string; tool: string; input: Record<string, unknown> }[]) => ({ intent: "task", goal: "g", successCriteria: ["done"], steps: steps.map((s) => ({ description: s.tool, dependsOn: [], ...s })) });
class Scripted implements LanguageModel {
  readonly name = "scripted";
  constructor(private plans: unknown[]) {}
  async generateJson(req: StructuredRequest) { return structuredClone(req.purpose === "plan" ? this.plans[0] : { criteriaSatisfied: true, missing: [], needsMoreSteps: false, reason: "ok" }); }
}
const GRANTS = new Set<ToolPermission>([...DEFAULT_GRANTS, "read:desktop", "request:desktop_action"]);
const run = (bridge: DesktopBridge, model: LanguageModel, objective: string) =>
  new AgentRuntime({ model, registry: createDefaultRegistry(ROOT, { desktop: bridge }), granted: GRANTS }).run({ taskId: `t${Math.random()}`.replace(".", ""), objective });
/** The model is asked to plan (request-derived plans off): tests that a MODEL's different values never reach the daemon. */
const runModel = (bridge: DesktopBridge, model: LanguageModel, objective: string) =>
  new AgentRuntime({ model, registry: createDefaultRegistry(ROOT, { desktop: bridge }), granted: GRANTS, requestPlans: false }).run({ taskId: `t${Math.random()}`.replace(".", ""), objective });

async function main() {
  console.log("\n[G] Grammar");
  const cases: [string, unknown][] = [
    ["List my Android devices", { tool: "android.list_devices", args: {} }],
    ["Is my phone connected?", { tool: "android.list_devices", args: {} }],
    ["What phones are connected", { tool: "android.list_devices", args: {} }],
    ["Show my phone's battery", { tool: "android.device_info", args: {} }],
    ["What's my phone's Android version?", { tool: "android.device_info", args: {} }],
    ["Connect to my phone at 192.168.1.20:5555", { tool: "android.connect", args: { host: "192.168.1.20", port: 5555 } }],
    ["Connect to my phone at 192.168.1.20 over Wi-Fi", { tool: "android.connect", args: { host: "192.168.1.20" } }],
    ["Copy C:\\Users\\me\\Documents\\D-ASK\\report.pdf to my phone", { tool: "android.push", args: { file: "C:\\Users\\me\\Documents\\D-ASK\\report.pdf" } }],
    ["Send \"C:\\Docs\\My notes.txt\" to my phone into /sdcard/Documents", { tool: "android.push", args: { file: "C:\\Docs\\My notes.txt", toFolder: "/sdcard/Documents" } }],
    ["Copy /sdcard/DCIM/Camera/IMG_1.jpg from my phone to C:\\Users\\me\\Pictures", { tool: "android.pull", args: { remotePath: "/sdcard/DCIM/Camera/IMG_1.jpg", toFolder: "C:\\Users\\me\\Pictures" } }],
    ["Open https://example.com/ on my phone", { tool: "android.command", args: { action: "open_url", url: "https://example.com/" } }],
    ["Go home on my phone", { tool: "android.command", args: { action: "home" } }],
    ["On my phone, turn the volume down", { tool: "android.command", args: { action: "volume_down" } }],
    ["Lock my phone", { tool: "android.command", args: { action: "lock" } }],
    // Not Android requests / not allowed commands:
    ["Reboot my phone", null],
    ["On my phone, uninstall WhatsApp", null],
    ["Open http://example.com on my phone", null],
    ["Copy /data/data/com.bank/db from my phone to C:\\x", null],
    ["Open https://a.com on my phone and lock my phone", null],
    ["Turn off Wi-Fi", null],
    ["What's the volume?", null],
  ];
  for (const [o, want] of cases) { const got = androidRequest(o); check(JSON.stringify(got) === JSON.stringify(want), `"${o}" -> ${JSON.stringify(want)}`, got); }
  check(systemRequest("Lock my phone") === null && systemRequest("List my Android devices") === null, "G Android requests are not Windows administration requests");

  console.log("\n[R] Refusal gate");
  check(actuationRefusal("Go home on my phone", () => true) === null, "R1 an offered Android command is not refused before planning");
  check(actuationRefusal("Lock my phone", (t) => t !== "android.command") !== null || androidRequest("Lock my phone") !== null, "R2 when not offered it falls through to the normal handling");

  console.log("\n[E] End to end");
  {
    const d = new FakeDaemon([{ status: "ok", result: { verified: true, count: 1, devices: [{ serial: "R58M", state: "device", model: "SM_A525F" }], observed: "1 device(s) seen by adb" } } as any]);
    const r = await run(d, new Scripted([plan([{ id: "s1", tool: "android.list_devices", input: {} }])]), "List my Android devices");
    check(r.outcome === "completed" && d.calls.length === 1 && /SM_A525F/.test(r.response), "E1 list devices: one read; the device is reported", { o: r.outcome, r: r.response });
  }
  {
    const d = new FakeDaemon([{ status: "ok", result: { executed: true, verified: true, remote: "/sdcard/Download/report.pdf", observed: "the copy on the device has the same SHA-256 as the original" } } as any]);
    const f = "C:\\Users\\me\\Documents\\D-ASK\\report.pdf";
    const r = await run(d, new Scripted([plan([{ id: "s1", tool: "android.push", input: { file: f } }])]), `Copy ${f} to my phone`);
    check(r.outcome === "completed" && d.calls.length === 1 && (d.calls[0]!.args as any).file === f && /SHA-256/.test(r.response), "E2 push: exactly the named file; completed only when verified", { o: r.outcome, r: r.response });
    const d2 = new FakeDaemon([{ status: "ok", result: { verified: true } } as any]);
    const r2 = await runModel(d2, new Scripted([plan([{ id: "s1", tool: "android.push", input: { file: "C:\\Windows\\System32\\config\\SAM" } }])]), `Copy ${f} to my phone`);
    check(r2.outcome !== "completed" && d2.calls.length === 0, "E3 a different file planned by the model never reaches the daemon");
  }
  {
    const d = new FakeDaemon([{ status: "error", error: { code: "unauthorized", message: "The phone has not authorized this computer for USB debugging. Unlock the phone and accept the \"Allow USB debugging?\" prompt; D-ASK never bypasses it." } } as any]);
    const r = await run(d, new Scripted([plan([{ id: "s1", tool: "android.device_info", input: {} }])]), "Show my phone's battery");
    check(r.outcome !== "completed" && /Allow USB debugging/.test(r.response), "E4 an unauthorized phone is explained, not reported as done", { o: r.outcome, r: r.response });
  }
  {
    const d = new FakeDaemon([{ status: "ok", result: { verified: true } } as any]);
    const r = await runModel(d, new Scripted([plan([{ id: "s1", tool: "android.command", input: { action: "lock" } }])]), "Go home on my phone");
    check(r.outcome !== "completed" && d.calls.length === 0, "E5 a different command planned by the model never reaches the daemon");
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
