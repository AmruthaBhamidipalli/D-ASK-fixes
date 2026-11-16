using System.Diagnostics;
using System.IO.MemoryMappedFiles;
using System.Runtime.InteropServices;
using DAsk.Daemon.Automation.Observation;
using DAsk.Protocol.IPC.Messages.ComputerUse;
using Xunit;
using static DAsk.Daemon.Tests.Phase7B1bTests;

namespace DAsk.Daemon.Tests;

/// <summary>
/// QA BUG-002 (2026-11-16). Screen capture without a real screen read:
///   - SYNTHETIC frames: the Blit seam paints a known colour into the memory DC (works with or without an interactive desktop), so the whole
///     pipeline after the blit (shared buffer, thumbnail, release, resource stability) is tested deterministically. These are NOT observations
///     of the real screen and say so.
///   - Headless classification: a failed blit on a session without an interactive desktop is reported as DesktopUnavailable (still a failure).
/// The real-screen tests are in ScreenObservationTests and run only when an interactive desktop exists.
/// </summary>
[Collection(GdiCounterCollection.Name)]   // process-wide GDI counts: never measured while other tests run
public class ScreenCaptureHeadlessTests
{
    private const uint Colour = 0x00563412;   // COLORREF 0x00BBGGRR: R=0x12 G=0x34 B=0x56 -> BGRA bytes 56 34 12 00

    [DllImport("gdi32.dll")] private static extern IntPtr CreateSolidBrush(uint color);
    [DllImport("gdi32.dll")] private static extern IntPtr SelectObject(IntPtr hdc, IntPtr obj);
    [DllImport("gdi32.dll")] private static extern bool DeleteObject(IntPtr obj);
    [DllImport("gdi32.dll")] private static extern bool PatBlt(IntPtr hdc, int x, int y, int w, int h, int rop);
    [DllImport("user32.dll")] private static extern uint GetGuiResources(IntPtr hProcess, uint uiFlags);
    private const int PATCOPY = 0x00F00021;

    /// <summary>Paints the synthetic frame into the destination memory DC instead of reading the screen.</summary>
    private sealed class SyntheticFrameService : Win32ScreenObservationService
    {
        public int Blits;
        public SyntheticFrameService(ObservationBufferManager b) : base(b, new FakeUia()) { }
        protected override bool Blit(IntPtr hdcDest, int width, int height, IntPtr hdcSrc, int x, int y, int rop)
        {
            Blits++;
            var brush = CreateSolidBrush(Colour);
            var old = SelectObject(hdcDest, brush);
            try { return PatBlt(hdcDest, 0, 0, width, height, PATCOPY); }
            finally { SelectObject(hdcDest, old); DeleteObject(brush); }
        }
        // Synthetic: no real screen is read, so the session's desktop does not matter for these frames.
        protected override InteractiveDesktop.State ProbeDesktop() => new(true, null);
    }

    private sealed class HeadlessService : Win32ScreenObservationService
    {
        public int Blits;
        public HeadlessService(ObservationBufferManager b) : base(b, new FakeUia()) { }
        protected override bool Blit(IntPtr hdcDest, int width, int height, IntPtr hdcSrc, int x, int y, int rop) { Blits++; return true; }   // would "succeed" (a blank frame)
        protected override InteractiveDesktop.State ProbeDesktop() => new(false, "this process runs in a non-interactive window station (test)");
    }

    private static readonly CaptureObservationRequest Plain = new() { IncludeUiAutomation = false, GeneratePreviewThumbnail = true, PreviewMaxWidth = 96, PreviewMaxHeight = 54, TargetDisplayIndex = 0 };   // fits the 32 KB thumbnail guardrail

    [Fact]
    public async Task SyntheticFrame_IsPublishedExactly_ThroughTheRealBufferPipeline()
    {
        using var buffers = new ObservationBufferManager();
        var svc = new SyntheticFrameService(buffers);
        var r = await svc.CaptureAsync(Plain);   // no client process: the buffer is published by name, so the test can open it
        Assert.True(r.Success, r.ErrorMessage);
        Assert.Equal("Captured", r.Status);
        Assert.Equal(1, svc.Blits);
        Assert.True(r.DataSizeBytes >= r.PhysicalWidth * r.PhysicalHeight * 4);
        Assert.NotNull(r.PreviewThumbnailBase64);
        var bmp = Convert.FromBase64String(r.PreviewThumbnailBase64!);
        Assert.True(bmp[0] == (byte)'B' && bmp[1] == (byte)'M' && bmp.Length <= 32 * 1024);
        Assert.Equal(new byte[] { 0x56, 0x34, 0x12 }, bmp[54..57]);   // the thumbnail shows the synthetic colour (24-bit BGR)
        using (var mmf = MemoryMappedFile.OpenExisting(r.SharedMemoryName, MemoryMappedFileRights.Read))
        using (var view = mmf.CreateViewAccessor(0, r.DataSizeBytes, MemoryMappedFileAccess.Read))
        {
            foreach (long at in new long[] { 0, (r.DataSizeBytes / 8) * 4, r.DataSizeBytes - 4 })
            {
                Assert.Equal(0x56, view.ReadByte(at));
                Assert.Equal(0x34, view.ReadByte(at + 1));
                Assert.Equal(0x12, view.ReadByte(at + 2));
            }
        }
        Assert.True(buffers.TryReleaseBuffer(r.ObservationId));
    }

    [Fact]
    public async Task SyntheticFrames_Repeated_ReleaseEveryBuffer_AndLeakNoGdiObjects()
    {
        using var buffers = new ObservationBufferManager();
        var svc = new SyntheticFrameService(buffers);
        var warm = await svc.CaptureAsync(new CaptureObservationRequest { IncludeUiAutomation = false, TargetDisplayIndex = 0 });
        Assert.True(warm.Success, warm.ErrorMessage);
        Assert.True(buffers.TryReleaseBuffer(warm.ObservationId));
        IntPtr self = Process.GetCurrentProcess().Handle;
        uint gdiBefore = GetGuiResources(self, 0);
        long memBefore = GC.GetTotalMemory(true);
        for (int i = 0; i < 30; i++)
        {
            var r = await svc.CaptureAsync(new CaptureObservationRequest { IncludeUiAutomation = false, TargetDisplayIndex = 0 });
            Assert.True(r.Success, r.ErrorMessage);
            Assert.True(buffers.TryReleaseBuffer(r.ObservationId));
            Assert.False(buffers.TryReleaseBuffer(r.ObservationId));
        }
        Assert.True(GetGuiResources(self, 0) - gdiBefore <= 2, "GDI objects leaked over 30 synthetic captures");
        Assert.True(GC.GetTotalMemory(true) - memBefore < 32L * 1024 * 1024, "managed memory retained frames");
    }

    [Fact]
    public async Task WithoutAnInteractiveDesktop_TheFailureSaysSo_AndIsNeverSuccess()
    {
        using var buffers = new ObservationBufferManager();
        var svc = new HeadlessService(buffers);
        var r = await svc.CaptureAsync(Plain);
        Assert.Equal(0, svc.Blits);   // refused before any blit: a blank frame of an invisible desktop is never published as an observation
        Assert.False(r.Success);
        Assert.Equal("DesktopUnavailable", r.Status);
        Assert.Equal("DesktopUnavailable", r.RejectionCode);
        Assert.Equal("desktop_unavailable", r.CaptureStatus);
        Assert.Contains("No interactive desktop", r.ErrorMessage);
        Assert.Contains("non-interactive window station", r.ErrorMessage);
        Assert.True(string.IsNullOrEmpty(r.SharedMemoryName));
        Assert.Null(r.PreviewThumbnailBase64);
        Assert.Equal(0, r.DataSizeBytes);
    }

    [NonInteractiveDesktopFact]
    public async Task RealCapture_WithoutAnInteractiveDesktop_IsRefusedAsDesktopUnavailable()
    {
        // The REAL service and the REAL probe, run only where there is no interactive desktop (run-headless-observation.ps1).
        using var buffers = new ObservationBufferManager();
        var r = await new Win32ScreenObservationService(buffers, new FakeUia()).CaptureAsync(Plain);
        Assert.False(r.Success);
        Assert.Equal("DesktopUnavailable", r.RejectionCode);
        Assert.Equal(0, r.DataSizeBytes);
        Assert.True(string.IsNullOrEmpty(r.SharedMemoryName));
    }

    [Fact]
    public void TheProbe_AgreesWithThisSession()
    {
        // Not a fake: the real probe. It must return a reason exactly when it reports no interactive desktop.
        var s = InteractiveDesktop.Probe();
        Assert.Equal(s.Interactive, s.Reason == null);
    }
}

[CollectionDefinition(GdiCounterCollection.Name, DisableParallelization = true)]
public sealed class GdiCounterCollection { public const string Name = "GDI counters (not parallel)"; }

/// <summary>A real-screen test: skipped, with the probe's reason, only when this session has no interactive desktop.</summary>
public sealed class InteractiveDesktopFactAttribute : FactAttribute
{
    public InteractiveDesktopFactAttribute()
    {
        var s = InteractiveDesktop.Probe();
        if (!s.Interactive) Skip = $"Needs an interactive desktop to read the real screen: {s.Reason}. The synthetic capture tests (ScreenCaptureHeadlessTests) cover the pipeline.";
    }
}

/// <summary>Runs only where there is NO interactive desktop (e.g. inside run-headless-observation.ps1's window station).</summary>
public sealed class NonInteractiveDesktopFactAttribute : FactAttribute
{
    public NonInteractiveDesktopFactAttribute()
    {
        if (InteractiveDesktop.Probe().Interactive) Skip = "Checks the refusal on a session WITHOUT an interactive desktop; this session has one (run the script run-headless-observation.ps1 in this test folder).";
    }
}
