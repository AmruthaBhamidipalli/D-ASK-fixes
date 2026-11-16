# Real-HUD acceptance of "Open Chrome and search for <words>" on a PACKAGED D-ASK (2026-11-16 remediation): no D-ASK extension involved.
# The real launcher starts the stack; the request is typed into the real HUD; the approval card is clicked by this harness (harness-approved,
# NOT a person); the HUD's result is read; and, independently of D-ASK, a Chrome window titled "<words> - Google Search" is looked for through
# UI Automation. With web search switched off (-ExpectDisabled) the run instead checks that D-ASK says so as a SETTING, never as "offline".
# Chrome may already be running (the user's browser): the search then opens as a new tab there; nothing else in Chrome is touched.
#   powershell -ExecutionPolicy Bypass -File scripts\package\verify-chrome-search.ps1 -PackageRoot <package> -OutDir results\remediation\chrome-<stamp>
param([Parameter(Mandatory = $true)][string]$PackageRoot, [Parameter(Mandatory = $true)][string]$OutDir,
      [string]$Words = 'news', [switch]$ExpectDisabled)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\..\hud\hud-driver.ps1"
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Drawing, System.Windows.Forms
if ((Test-Path $OutDir) -and @(Get-ChildItem $OutDir -Force).Count -gt 0) { throw "OutDir must be new or empty: $OutDir" }
New-Item -ItemType Directory -Force $OutDir | Out-Null
$OutDir = (Resolve-Path $OutDir).Path
$PackageRoot = (Resolve-Path $PackageRoot).Path
$results = New-Object System.Collections.ArrayList
$env:DASK_AgentHost__ExtraEnvironment__DASK_MEMORY_DB = (Join-Path $OutDir 'memory.db')
# -ExpectDisabled is for a package or %LOCALAPPDATA%\D-ASK\features.cmd WITHOUT the "set DASK_AgentHost__WebSearch=true" line (the launcher's
# profile would override any value set here).
function Record([string]$Name, [bool]$Pass, $Detail) {
    [void]$results.Add([pscustomobject]@{ name = $Name; pass = $Pass; detail = $Detail })
    "{0}  {1}  {2}" -f $(if ($Pass) { ' ok ' } else { 'FAIL' }), $Name, ($Detail | ConvertTo-Json -Compress -Depth 4)
}
function Find-Proc([string]$ExeTail) { Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.EndsWith($ExeTail, [StringComparison]::OrdinalIgnoreCase) -and $_.ExecutablePath.StartsWith($PackageRoot, [StringComparison]::OrdinalIgnoreCase) } | Select-Object -First 1 }
function Stop-All { foreach ($n in 'hud-native.exe', 'DAsk.Daemon.exe') { $x = Find-Proc $n; if ($x) { taskkill /PID $x.ProcessId /T /F 2>$null | Out-Null } } }
function Chrome-Titles {
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    @($root.FindAll('Children', [System.Windows.Automation.Condition]::TrueCondition) | Where-Object { $_.Current.ClassName -like 'Chrome_WidgetWin*' -and $_.Current.Name } | ForEach-Object { $_.Current.Name })
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

if (Get-Process DAsk.Daemon, hud-native -ErrorAction SilentlyContinue) { throw 'A D-ASK daemon or HUD is already running; stop it first (one instance only).' }
$online = [System.Net.NetworkInformation.NetworkInterface]::GetIsNetworkAvailable()
try {
    Start-Process -FilePath "$PackageRoot\Start-D-ASK.cmd" -WindowStyle Hidden | Out-Null
    for ($i = 0; $i -lt 90; $i++) { Start-Sleep -Milliseconds 500; $h = Find-Proc 'hud-native.exe'; if ($h) { $p = Get-Process -Id $h.ProcessId -EA SilentlyContinue; if ($p -and $p.MainWindowHandle -ne 0) { break } } }
    $script:hwnd = Get-HudHwnd (Find-Proc 'hud-native.exe').ProcessId
    Enter-HudInteractive $script:hwnd; Start-Sleep -Seconds 2
    Record 'the packaged app started from its own launcher' ([bool](Find-Proc 'DAsk.Daemon.exe')) @{ package = $PackageRoot; windowsReportsNetwork = $online; chromeAlreadyRunning = [bool](Get-Process chrome -EA SilentlyContinue) }
    Restore-HudFront
    $sw = [Diagnostics.Stopwatch]::StartNew()
    Submit-HudRequest $script:hwnd "Open Chrome and search for $Words"
    if ($ExpectDisabled) {
        $o = Wait-HudOutcome $script:hwnd 60000
        $t = Get-HudText $script:hwnd
        Set-Content -Encoding utf8 "$OutDir\hud-result.txt" $t; Save-HudShot $script:hwnd "$OutDir\hud-result.png"
        Record 'with web search switched off: no approval card, the HUD says it is a D-ASK setting (not "offline mode")' (($t -notmatch 'APPROVAL REQUIRED') -and ($t -match 'D-ASK setting') -and ($t -notmatch 'offline mode')) @{ outcome = $o.Outcome }
    } else {
        $card = Wait-Card 'Search the web'
        if ($card) { Set-Content -Encoding utf8 "$OutDir\card-search.txt" $card; Save-HudShot $script:hwnd "$OutDir\card-search.png" }
        Record 'approval card offered: search the web in Chrome (the exact results address shown)' ($card -and $card -match 'google\.com/search\?q=') @{ shown = [bool]$card; msToCard = $sw.ElapsedMilliseconds }
        if (-not $card) { throw 'no approval card appeared for the search' }
        Restore-HudFront
        $btn = Find-HudButton $script:hwnd '^APPROVE$'
        $w = [Diagnostics.Stopwatch]::StartNew(); while (-not $btn.Current.IsEnabled -and $w.ElapsedMilliseconds -lt 8000) { Start-Sleep -Milliseconds 50 }
        Confirm-HudForeground $script:hwnd | Out-Null
        Click-HudElement $script:hwnd $btn
        Record 'APPROVE clicked in the real HUD (harness, not a person)' $true @{}
        $o = Wait-HudOutcome $script:hwnd 90000
        $t = Get-HudText $script:hwnd
        Set-Content -Encoding utf8 "$OutDir\hud-result.txt" $t; Save-HudShot $script:hwnd "$OutDir\hud-result.png"
        $titles = Chrome-Titles
        $hit = @($titles | Where-Object { $_ -like "*$Words*Google Search*" })
        Record 'the HUD reports COMPLETED' ($o.Outcome -eq 'COMPLETED') @{ outcome = $o.Outcome; totalMs = $sw.ElapsedMilliseconds }
        Record "a Chrome window shows the results page '$Words - Google Search' (UI Automation, independent of D-ASK)" ($hit.Count -ge 1) @{ titles = $titles }
    }
} catch {
    Record 'unexpected error' $false @{ error = "$($_.Exception.Message)" }
    try { Save-HudShot $script:hwnd "$OutDir\hud-error.png"; Set-Content -Encoding utf8 "$OutDir\hud-error.txt" (Get-HudText $script:hwnd) } catch { }
} finally {
    Stop-All
    ConvertTo-Json -InputObject @($results.ToArray()) -Depth 6 | Set-Content -Encoding utf8 "$OutDir\verify-chrome-search.json"
    $failed = @($results | Where-Object { -not $_.pass }).Count
    "`n$(@($results | Where-Object { $_.pass }).Count) of $($results.Count) passed"
    if ($failed) { exit 1 }
}
