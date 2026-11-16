using System.Text.Json;
using DAsk.Daemon.Automation.Desktop;
using DAsk.Daemon.Automation.Input;
using DAsk.Daemon.Automation.Observation;
using DAsk.Daemon.Automation.Policy;
using DAsk.Daemon.Research;
using DAsk.Protocol.IPC.Messages.ComputerUse;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;
using static DAsk.Daemon.Tests.Phase7B1bTests;

namespace DAsk.Daemon.Tests;

/// <summary>
/// "Open Word and type hello" (2026-11-16): typing into the MAIN EDITOR of the window D-ASK opened for the same task
/// (element { role: "editor" }). Real pathway (policy, digest-bound approval, consumption, revalidation, audit, per-event gate,
/// verification by the document's text); the OS is a recording fake. No real input is sent by these tests.
/// </summary>
[Collection("AgentHost")]
public class EditorRoleInputTests
{
    private const string Owner = "hud-session-owner";
    private const long Hwnd = 300;
    private static readonly int[] DocId = { 77, 1 };

    private static ControlIdentity Doc(int[]? id = null, string name = "Document1") =>
        new(id ?? DocId, "Document", "", name, "PATHHASHPATHHASHPATHHASH", false, new[] { 150, 150, 450, 350 }, true, false, true, new[] { "Text" });

    private sealed class Monitor : IUserInputMonitor { public string? Interruption { get; set; } public void Dispose() { } }

    /// <summary>A Word-like window: a focused Document with TextPattern only; typed characters land in its text (optionally AutoCorrected).</summary>
    private sealed class Os : IDesktopInputPlatform, IInputInjector
    {
        public readonly List<InputEvent> Sent = new();
        public long Foreground = 999;
        public int[]? Focused;
        public string Text = "\r";
        public ControlIdentity? Editor = Doc();
        public Func<ControlIdentity?>? EditorAfterApproval;
        public bool CapitaliseFirst;
        public int FindCalls;
        public IInputInjector Injector => this;
        public IUserInputMonitor StartMonitor() => new Monitor();
        public long ForegroundRoot() => Foreground;
        public bool BringToForeground(long hwnd) { Foreground = hwnd; Focused = Editor?.RuntimeId; return true; }   // focus returns to the document
        public (int X, int Y)? CursorPos() => (0, 0);
        public long RootWindowAt(int x, int y) => Hwnd;
        public int[]? RuntimeIdAt(int x, int y) => null;
        public int[]? FocusedRuntimeId() => Focused;
        public bool FocusElement(long hwnd, int[] runtimeId) { Focused = runtimeId; return true; }
        public (bool Ok, string Value, bool ReadOnly) ReadValue(long hwnd, int[] runtimeId) => (false, "", true);   // no ValuePattern (Word)
        public ControlIdentity? FindEditor(long hwnd, int pid)
        {
            FindCalls++;
            return FindCalls > 1 && EditorAfterApproval != null ? EditorAfterApproval() : hwnd == Hwnd ? Editor : null;
        }
        public (bool Ok, string Text) ReadEditorText(long hwnd, int[] runtimeId) => (true, Text);
        public int Send(IReadOnlyList<InputEvent> events)
        {
            foreach (var e in events)
            {
                lock (Sent) Sent.Add(e);
                if (e is UnicodeChar { Down: true } c)
                {
                    string body = Text[..^1] + c.Unit;
                    if (CapitaliseFirst && body.Length > 0) body = char.ToUpperInvariant(body[0]) + body[1..];
                    Text = body + "\r";
                }
            }
            return events.Count;
        }
    }

    private sealed class Rig : IDisposable
    {
        public readonly FakeWindows Windows = new();
        public readonly FakeUia Uia = new();
        public readonly Os Os = new();
        public readonly ActionPolicyEngine Policy;
        public readonly GuardedInputRequestService Service;
        public readonly LaunchedWindowRegistry Launched = new();
        public readonly List<ActionApprovalRequest> Delivered = new();
        public readonly SqliteEvidenceRecorder Recorder;
        private readonly string _db = Path.Combine(Path.GetTempPath(), $"dask-editor-{Guid.NewGuid():N}.db");

        public Rig(string image = "WINWORD.EXE", bool launched = true)
        {
            Recorder = new SqliteEvidenceRecorder(NullLogger<SqliteEvidenceRecorder>.Instance, _db);
            Policy = new ActionPolicyEngine(NullLogger<ActionPolicyEngine>.Instance, Recorder, Windows);
            Policy.SetSessionLivenessGate(s => s == Owner);
            Policy.ApprovalRequested += (_, r) => { lock (Delivered) Delivered.Add(r); };
            var w = W(Hwnd, 5100, image, "Document1 - Word");
            Windows.Windows.Add(w);
            if (launched) Launched.Record("t1", new LaunchedWindow(w.Hwnd, w.ProcessId, w.ProcessCreationFileTime, w.ImageName));
            Service = new GuardedInputRequestService(new DesktopReadService(Windows, Uia), Uia, Policy, () => false, () => 1, Recorder, s => s == Owner, Os,
                new GuardedInputOptions { KeyboardEnabled = true, VerifyTimeoutMs = 300, InterEventDelayMs = 0 }, null, Launched);
        }

        public Task<DesktopCallResult> Ask(string tool, object args) =>
            Service.ExecuteAsync(tool, JsonSerializer.SerializeToElement(args), new DesktopActionContext("t1", "c1", Owner), default);

        public async Task<ActionApprovalRequest?> DeliveredAsync(int ms = 3000)
        {
            var until = DateTime.UtcNow.AddMilliseconds(ms);
            while (DateTime.UtcNow < until) { lock (Delivered) if (Delivered.Count > 0) return Delivered[^1]; await Task.Delay(5); }
            return null;
        }

        public bool Decide(ActionApprovalRequest r, bool approved) =>
            Policy.SubmitApprovalDecision(new ActionApprovalResponse
            {
                ApprovalId = r.ApprovalId, ActionId = r.ActionId, ActionType = r.ActionType, ParametersSha256 = r.ParametersSha256,
                ActionDigest = r.ActionDigest, Approved = approved, DecisionSource = "UserExplicitConfirmation",
            }, Owner, () => false, () => 1);

        public void Dispose() { SqliteConnection.ClearAllPools(); try { File.Delete(_db); } catch { } }
    }

    private static object TypeEditor(string text) => new { element = new { role = "editor" }, text };
    private static JsonElement J(DesktopCallResult r) => JsonSerializer.SerializeToElement(r.Result);

    [Fact]
    public async Task Approved_TypesIntoTheLaunchedWindowsDocument_AndVerifiesTheExactText()
    {
        using var rig = new Rig();
        await rig.Recorder.InitializeAsync();
        var call = rig.Ask(GuardedInputTools.TypeText, TypeEditor("hello"));
        var card = await rig.DeliveredAsync();
        Assert.NotNull(card);
        Assert.Equal("WINWORD.EXE", card!.TargetProcessName);
        Assert.Equal(Hwnd, card.TargetHwnd);
        Assert.Equal("Document1", card.ActionParameters["controlName"]);
        Assert.Equal("hello", card.ActionParameters["text"]);   // the user approves the exact text
        Assert.True(rig.Decide(card, true));
        var res = await call;
        Assert.Equal("ok", res.Status);
        Assert.True(J(res).GetProperty("verified").GetBoolean());
        Assert.False(J(res).GetProperty("autoCorrected").GetBoolean());
        Assert.Equal("hello\r", rig.Os.Text);
        Assert.Equal(5, rig.Os.Sent.OfType<UnicodeChar>().Count(c => c.Down));
        Assert.True((await rig.Recorder.VerifyAuditChainAsync()).Ok);
    }

    [Fact]
    public async Task AutoCorrect_IsReportedAsSuch_NeverAsAnExactMatch()
    {
        using var rig = new Rig();
        await rig.Recorder.InitializeAsync();
        rig.Os.CapitaliseFirst = true;
        var call = rig.Ask(GuardedInputTools.TypeText, TypeEditor("hello world"));
        Assert.True(rig.Decide((await rig.DeliveredAsync())!, true));
        var res = await call;
        Assert.Equal("ok", res.Status);
        Assert.True(J(res).GetProperty("autoCorrected").GetBoolean());
        Assert.Contains("AutoCorrect", J(res).GetProperty("observed").GetString());
    }

    [Fact]
    public async Task WithoutAWindowOpenedForThisTask_NothingIsAsked()
    {
        using var rig = new Rig(launched: false);
        var res = await rig.Ask(GuardedInputTools.TypeText, TypeEditor("hello"));
        Assert.Equal("editor_needs_launch", res.Error!.Code);
        Assert.Null(await rig.DeliveredAsync(200));
        Assert.Empty(rig.Os.Sent);
    }

    [Fact]
    public async Task NamedApplication_AlreadyOpen_IsResolvedToItsOneWindow_AndTypedIntoAfterApproval()
    {
        using var rig = new Rig(launched: false);
        await rig.Recorder.InitializeAsync();
        var call = rig.Ask(GuardedInputTools.TypeText, new { process = "WINWORD.EXE", element = new { role = "editor" }, text = "hi" });
        var card = await rig.DeliveredAsync();
        Assert.Equal("Document1 - Word", card!.TargetWindowTitle);
        Assert.True(rig.Decide(card, true));
        Assert.Equal("ok", (await call).Status);
        Assert.Equal("hi\r", rig.Os.Text);
    }

    [Fact]
    public async Task NamedApplication_WithTwoWindows_IsNeverGuessed()
    {
        using var rig = new Rig(launched: false);
        rig.Windows.Windows.Add(W(301, 5101, "WINWORD.EXE", "Report - Word"));
        var res = await rig.Ask(GuardedInputTools.TypeText, new { process = "WINWORD.EXE", element = new { role = "editor" }, text = "hi" });
        Assert.NotEqual("ok", res.Status);
        Assert.Null(await rig.DeliveredAsync(200));
        Assert.Empty(rig.Os.Sent);
    }

    [Theory]
    [InlineData("cmd.exe")]
    [InlineData("powershell.exe")]
    [InlineData("WindowsTerminal.exe")]
    [InlineData("chrome.exe")]
    public async Task ConsolesAndBrowsers_AreNeverTypedIntoThroughTheEditorRole(string image)
    {
        using var rig = new Rig(image);
        var res = await rig.Ask(GuardedInputTools.TypeText, TypeEditor("dir"));
        Assert.Equal("target_forbidden", res.Error!.Code);
        Assert.Null(await rig.DeliveredAsync(200));
        Assert.Empty(rig.Os.Sent);
    }

    [Fact]
    public async Task NoEditorInTheWindow_IsReported_BeforeAnyApproval()
    {
        using var rig = new Rig();
        rig.Os.Editor = null;   // e.g. still on a start screen
        var res = await rig.Ask(GuardedInputTools.TypeText, TypeEditor("hello"));
        Assert.Equal("target_not_found", res.Error!.Code);
        Assert.Null(await rig.DeliveredAsync(200));
    }

    [Fact]
    public async Task EditorChangedAfterTheApproval_NothingIsTyped()
    {
        using var rig = new Rig();
        await rig.Recorder.InitializeAsync();
        rig.Os.EditorAfterApproval = () => Doc(new[] { 77, 9 }, "Document2");
        var call = rig.Ask(GuardedInputTools.TypeText, TypeEditor("hello"));
        Assert.True(rig.Decide((await rig.DeliveredAsync())!, true));
        var res = await call;
        Assert.Equal("target_changed", res.Error!.Code);
        Assert.Empty(rig.Os.Sent);
    }

    [Fact]
    public async Task Declined_NothingIsTyped()
    {
        using var rig = new Rig();
        await rig.Recorder.InitializeAsync();
        var call = rig.Ask(GuardedInputTools.TypeText, TypeEditor("hello"));
        Assert.True(rig.Decide((await rig.DeliveredAsync())!, false));
        Assert.Equal("approval_denied", (await call).Error!.Code);
        Assert.Empty(rig.Os.Sent);
        Assert.Equal("\r", rig.Os.Text);
    }

    [Fact]
    public async Task TheRole_IsOnlyForTyping_AndIsGivenAlone()
    {
        using var rig = new Rig();
        var keys = await rig.Ask(GuardedInputTools.PressKeys, new { element = new { role = "editor" }, keys = "Enter" });
        Assert.Equal("invalid_args", keys.Error!.Code);
        var mixed = await rig.Ask(GuardedInputTools.TypeText, new { element = new { role = "editor", name = "Document1" }, text = "x" });
        Assert.Equal("invalid_args", mixed.Error!.Code);
        var other = await rig.Ask(GuardedInputTools.TypeText, new { element = new { role = "anything" }, text = "x" });
        Assert.Equal("invalid_args", other.Error!.Code);
    }

    [Fact]
    public void AutoCorrectFolding_AllowsCaseAndTypographicQuotes_Only()
    {
        Assert.True(TextRules.IsInsertionAllowingAutoCorrect("\r", "Hello world\r", "hello world"));
        Assert.True(TextRules.IsInsertionAllowingAutoCorrect("\r", "It’s fine\r", "it's fine"));
        Assert.False(TextRules.IsInsertionAllowingAutoCorrect("\r", "Hello there\r", "hello world"));
        Assert.False(TextRules.IsInsertionAllowingAutoCorrect("\r", "hello hello\r", "hello"));
    }
}
