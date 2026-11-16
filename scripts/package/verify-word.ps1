# Real-HUD acceptance of "Open Microsoft Word and type hello" on a PACKAGED D-ASK (2026-11-16 remediation).
# The real launcher starts the stack; the request is typed into the real HUD; both approval cards (open Word ready for typing, type the text)
# are clicked in the real HUD by this harness (harness-approved, NOT a person); the result is read from the HUD; and, independently of the
# HUD and the daemon, Word's document is read through UI Automation (TextPattern). Word is then closed through its own automation interface
# WITHOUT saving (nothing is written to disk). Refuses to run if Word is already open (it never touches the user's documents).
#   powershell -ExecutionPolicy Bypass -File scripts\package\verify-word.ps1 -PackageRoot <package> -OutDir results\remediation\word-<stamp>
param([Parameter(Mandatory = $true)][string]$PackageRoot, [Parameter(Mandatory = $true)][string]$OutDir,
      [string]$Request = 'Open Microsoft Word and type hello', [string]$Expected = 'hello', [switch]$Decline)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\..\hud\hud-driver.ps1"
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Drawing, System.Windows.Forms
if ((Test-Path $OutDir) -and @(Get-ChildItem $OutDir -Force).Count -gt 0) { throw "OutDir must be new or empty: $OutDir" }
New-Item -ItemType Directory -Force $OutDir | Out-Null
$OutDir = (Resolve-Path $OutDir).Path
$PackageRoot = (Resolve-Path $PackageRoot).Path
$results = New-Object System.Collections.ArrayList
$env:DASK_AgentHost__ExtraEnvironment__DASK_MEMORY_DB = (Join-Path $OutDir 'memory.db')   # never the user's memory database
function Record([string]$Name, [bool]$Pass, $Detail) {
    [void]$results.Add([pscustomobject]@{ name = $Name; pass = $Pass; detail = $Detail })
    "{0}  {1}  {2}" -f $(if ($Pass) { ' ok ' } else { 'FAIL' }), $Name, ($Detail | ConvertTo-Json -Compress -Depth 4)
}
function Find-Proc([string]$ExeTail) { Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.EndsWith($ExeTail, [StringComparison]::OrdinalIgnoreCase) -and $_.ExecutablePath.StartsWith($PackageRoot, [StringComparison]::OrdinalIgnoreCase) } | Select-Object -First 1 }
function Stop-All { foreach ($n in 'hud-native.exe', 'DAsk.Daemon.exe') { $x = Find-Proc $n; if ($x) { taskkill /PID $x.ProcessId /T /F 2>$null | Out-Null } } }
function Desktop-Shot([string]$Path) {
    $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size); $g.Dispose()
    $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
}
function Get-WordWindows { @(Get-Process WINWORD -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }) }
# Word's document text through UI Automation (independent of D-ASK): the Document control's TextPattern.
function Read-WordText {
    $w = Get-WordWindows | Select-Object -First 1
    if (-not $w) { return $null }
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($w.MainWindowHandle)
    $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Document)
    $doc = $root.FindFirst('Descendants', $cond)
    if (-not $doc) { return $null }
    $tp = $null
    if ($doc.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$tp)) { return $tp.DocumentRange.GetText(-1) }
    return $null
}
function Restore-HudFront {
    if ([HudInput]::GetForegroundWindow() -eq $script:hwnd) { return }
    if ((Get-HudMode $script:hwnd) -eq 'interactive') { Send-HudToggleHotkey; try { [void](Wait-HudMode $script:hwnd 'ambient' 3000) } catch { } }
    Enter-HudInteractive $script:hwnd
    Start-Sleep -Milliseconds 800
}
function Wait-Card([string]$Pattern, [int]$TimeoutMs = 90000) {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    do { $t = Get-HudText $script:hwnd; if ($t -cmatch 'APPROVAL REQUIRED' -and $t -match $Pattern) { return $t }; if (Get-HudOutcome $script:hwnd) { return $null }; Start-Sleep -Milliseconds 200 } while ($sw.ElapsedMilliseconds -lt $TimeoutMs)
    return $null
}
function Decide([string]$Label, [string]$Button) {
    Restore-HudFront
    $btn = Find-HudButton $script:hwnd $Button
    $sw = [Diagnostics.Stopwatch]::StartNew(); while (-not $btn.Current.IsEnabled -and $sw.ElapsedMilliseconds -lt 8000) { Start-Sleep -Milliseconds 50 }
    Confirm-HudForeground $script:hwnd | Out-Null
    Click-HudElement $script:hwnd $btn
    Record "$Label clicked in the real HUD (harness, not a person)" $true @{ button = $Button; enabledAfterMs = $sw.ElapsedMilliseconds }
}
# Close Word through its own automation interface, discarding the demonstration text (wdDoNotSaveChanges = 0). Only the Word this run opened.
function Close-WordWithoutSaving {
    try {
        $app = [Runtime.InteropServices.Marshal]::GetActiveObject('Word.Application')
        foreach ($d in @($app.Documents)) { $d.Close(0) }
        $app.Quit(0)
        [void][Runtime.InteropServices.Marshal]::ReleaseComObject($app)
        return 'closed through Word automation without saving'
    } catch {
        foreach ($p in Get-WordWindows) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
        return "Word automation unavailable ($($_.Exception.Message)); the process this run opened was ended"
    }
}

$avail = [int]((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory / 1024)
if (Get-Process WINWORD -ErrorAction SilentlyContinue) { throw 'Microsoft Word is already running; close it first. This script never touches existing documents.' }
if (Get-Process DAsk.Daemon, hud-native -ErrorAction SilentlyContinue) { throw 'A D-ASK daemon or HUD is already running; stop it first (one instance only).' }
$opened = $false
try {
    Start-Process -FilePath "$PackageRoot\Start-D-ASK.cmd" -WindowStyle Hidden | Out-Null
    for ($i = 0; $i -lt 90; $i++) { Start-Sleep -Milliseconds 500; $h = Find-Proc 'hud-native.exe'; if ($h) { $p = Get-Process -Id $h.ProcessId -EA SilentlyContinue; if ($p -and $p.MainWindowHandle -ne 0) { break } } }
    $script:hwnd = Get-HudHwnd (Find-Proc 'hud-native.exe').ProcessId
    Enter-HudInteractive $script:hwnd; Start-Sleep -Seconds 2
    Record 'the packaged app started from its own launcher' ([bool](Find-Proc 'DAsk.Daemon.exe')) @{ availableMBBeforeStart = $avail; package = $PackageRoot }
    Restore-HudFront
    $sw = [Diagnostics.Stopwatch]::StartNew()
    Submit-HudRequest $script:hwnd $Request
    $card1 = Wait-Card 'Word'
    if ($card1) { Set-Content -Encoding utf8 "$OutDir\card1-open.txt" $card1; Save-HudShot $script:hwnd "$OutDir\card1-open.png" }
    Record 'card 1 offered: open Word ready for typing (program and /w switch shown)' ($card1 -and $card1 -match 'WINWORD' -and $card1 -match '/w') @{ shown = [bool]$card1; msToCard = $sw.ElapsedMilliseconds }
    if (-not $card1) { throw 'no approval card appeared for opening Word' }
    Decide 'card 1 (open Word) APPROVE' '^APPROVE$'
    $opened = $true

    $card2 = Wait-Card 'Type (this text|exactly)' 120000
    if ($card2) { Set-Content -Encoding utf8 "$OutDir\card2-type.txt" $card2; Save-HudShot $script:hwnd "$OutDir\card2-type.png" }
    Record 'card 2 offered: type the exact text into the Word window D-ASK opened' ($card2 -and $card2 -cmatch [regex]::Escape($Expected) -and $card2 -match 'WINWORD') @{ shown = [bool]$card2 }
    if (-not $card2) { throw 'no approval card appeared for typing' }
    $before = Read-WordText
    Record 'Word is open on a blank document after card 1 (UI Automation, independent of D-ASK)' (@(Get-WordWindows).Count -eq 1 -and ($before -replace "[\r\n]", '') -eq '') @{ windows = @(Get-WordWindows).Count; title = (Get-WordWindows | Select-Object -First 1).MainWindowTitle }
    if ($Decline) { Decide 'card 2 (type) DECLINE' '^(DECLINE|DENY|REJECT)$' } else { Decide 'card 2 (type) APPROVE' '^APPROVE$' }

    $o = Wait-HudOutcome $script:hwnd 120000
    $hudText = Get-HudText $script:hwnd
    Set-Content -Encoding utf8 "$OutDir\hud-result.txt" $hudText
    Save-HudShot $script:hwnd "$OutDir\hud-result.png"
    Start-Sleep -Milliseconds 500
    $text = Read-WordText
    Desktop-Shot "$OutDir\desktop-final.png"
    if ($Decline) {
        Record 'the HUD does not report success after the decline' ($o.Outcome -ne 'COMPLETED') @{ outcome = $o.Outcome }
        Record "Word's document is still empty (nothing typed after the decline; read by UI Automation)" (($text -replace "[\r\n]", '') -eq '') @{ text = $text }
    } else {
        Record 'the HUD reports COMPLETED and INDEPENDENTLY VERIFIED' (($o.Outcome -eq 'COMPLETED') -and ($hudText -match '(?m)^INDEPENDENTLY VERIFIED$')) @{ outcome = $o.Outcome; ms = $o.Ms; totalMs = $sw.ElapsedMilliseconds }
        Record "Word's document holds exactly '$Expected' (read by UI Automation, not by D-ASK)" (($text -replace "[\r\n]+$", '') -ceq $Expected) @{ text = $text }
    }
} catch {
    Record 'unexpected error' $false @{ error = "$($_.Exception.Message)" }
    try { Desktop-Shot "$OutDir\desktop-error.png"; Save-HudShot $script:hwnd "$OutDir\hud-error.png"; Set-Content -Encoding utf8 "$OutDir\hud-error.txt" (Get-HudText $script:hwnd) } catch { }
} finally {
    if ($opened -or (Get-Process WINWORD -ErrorAction SilentlyContinue)) { $how = Close-WordWithoutSaving; Record 'Word closed without saving' $true @{ how = $how } }
    Stop-All
    ConvertTo-Json -InputObject @($results.ToArray()) -Depth 6 | Set-Content -Encoding utf8 "$OutDir\verify-word.json"
    $failed = @($results | Where-Object { -not $_.pass }).Count
    "`n$(@($results | Where-Object { $_.pass }).Count) of $($results.Count) passed"
    if ($failed) { exit 1 }
}
