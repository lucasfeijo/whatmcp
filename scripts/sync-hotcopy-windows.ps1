[CmdletBinding()]
param(
    [string]$DataDirectory,
    [string]$Waren6Directory,
    [string]$NodePath = 'C:\Program Files\nodejs\node.exe',
    [string]$PythonPath,
    [string]$StorePath,
    [string]$CasesDirectory,
    [string]$SourceDirectory,
    [switch]$Full,
    [switch]$NightlyRecovery = ($env:WHATMCP_NIGHTLY_RECOVERY -eq '1'),
    [switch]$ResultJson
)

$ErrorActionPreference = 'Stop'
$project = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$data = if ($DataDirectory) { $DataDirectory } else { Join-Path $project 'data' }
$runs = Join-Path $data 'hot-copy-runs'
$logs = Join-Path $data 'logs'
$waren6 = if ($Waren6Directory) { Join-Path $Waren6Directory 'waren6.ps1' } else { Join-Path $project 'WAren6\waren6.ps1' }
$repository = Split-Path $PSScriptRoot -Parent
$cli = Join-Path $repository 'src\cli.ts'
$node = $NodePath
$source = if ($SourceDirectory) { $SourceDirectory } else { Join-Path $env:LOCALAPPDATA 'Packages\5319275A.WhatsAppDesktop_cv1g1gvanyjgm' }
$runId = (Get-Date -Format 'yyyyMMdd-HHmmss') + "-$PID"
$run = Join-Path $runs $runId
$log = Join-Path $logs "hot-copy-$runId.log"
$summaryPath = Join-Path $logs 'hot-copy-summary.jsonl'
$lastSuccessPath = Join-Path $logs 'hot-copy-last-success.json'
$status = 'failed'
$reason = $null
$metrics = $null
$copyStats = @()
$started = Get-Date
$mutex = [Threading.Mutex]::new($false, 'Local\WhatMCP-HotCopy-Sync')
$hasMutex = $false
$restoreWhatsApp = $false
$runtimeJsonl = $null
$runtimeCaptureStatus = 'not_requested'

function Stop-WhatsAppForSnapshot {
    $processes = @(Get-Process -Name WhatsApp.Root -ErrorAction SilentlyContinue)
    foreach ($process in $processes) { [void]$process.CloseMainWindow() }
    $watch = [Diagnostics.Stopwatch]::StartNew()
    while ((Get-Process -Name WhatsApp.Root -ErrorAction SilentlyContinue) -and $watch.ElapsedMilliseconds -lt 5000) {
        Start-Sleep -Milliseconds 250
    }
    Get-Process -Name WhatsApp.Root -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction Stop
    $watch.Restart()
    while ((Get-Process -Name WhatsApp.Root -ErrorAction SilentlyContinue) -and $watch.ElapsedMilliseconds -lt 5000) {
        Start-Sleep -Milliseconds 250
    }
    if (Get-Process -Name WhatsApp.Root -ErrorAction SilentlyContinue) { throw 'WhatsApp did not close; closed snapshot cancelled' }
    Write-RunLog 'WhatsApp closed for consistent evidence copy'
}

function Restore-WhatsAppAfterSnapshot {
    if (-not $script:restoreWhatsApp) { return }
    Start-Process -FilePath 'explorer.exe' -ArgumentList 'shell:AppsFolder\5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App' -WindowStyle Hidden | Out-Null
    $watch = [Diagnostics.Stopwatch]::StartNew()
    while (-not (Get-Process -Name WhatsApp.Root -ErrorAction SilentlyContinue) -and $watch.ElapsedMilliseconds -lt 15000) {
        Start-Sleep -Milliseconds 250
    }
    if (-not (Get-Process -Name WhatsApp.Root -ErrorAction SilentlyContinue)) { throw 'WhatsApp could not be reopened after snapshot' }
    $script:restoreWhatsApp = $false
    Write-RunLog 'WhatsApp reopened after evidence copy'
}

function Write-RunLog([string]$message) {
    $line = "$(Get-Date -Format o) $message"
    # A reader or antivirus can briefly lock the log. Diagnostic logging must
    # not turn a completed, validated import into a failed synchronization.
    for ($attempt = 0; $attempt -lt 10; $attempt++) {
        try {
            $sharing = [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete
            $stream = [IO.FileStream]::new($log, [IO.FileMode]::Append, [IO.FileAccess]::Write, $sharing)
            try {
                $writer = [IO.StreamWriter]::new($stream, [Text.UTF8Encoding]::new($false))
                try { $writer.WriteLine($line); $writer.Flush() } finally { $writer.Dispose() }
            } finally { $stream.Dispose() }
            break
        } catch [IO.IOException] {
            if ($attempt -eq 9) { Write-Warning 'Run log is locked; continuing with synchronization output' }
            else { Start-Sleep -Milliseconds 100 }
        }
    }
    Write-Output $line
}

function Copy-LiveDirectory([string]$relative, [string]$destination, [bool]$excludeTransfers = $false) {
    $from = Join-Path $source $relative
    if (-not (Test-Path -LiteralPath $from -PathType Container)) {
        throw "WhatsApp source directory missing: $relative"
    }
    $to = Join-Path $run $destination
    New-Item -ItemType Directory -Path $to -Force | Out-Null
    $copyLog = Join-Path $logs ("robocopy-$runId-" + ($destination -replace '[\\/ ]', '-') + '.log')
    $arguments = @($from, $to, '/E', '/R:1', '/W:1', '/MT:8', '/NP', '/NFL', '/NDL', '/NJH', '/NJS')
    if ($excludeTransfers) { $arguments += @('/XD', 'transfers') }
    & robocopy.exe @arguments *> $copyLog
    $code = $LASTEXITCODE
    if ($code -ge 8) { throw "Robocopy failed for $relative with exit code $code; see $copyLog" }

    # These counts are diagnostics. Live LevelDB files may change after this check.
    $sourceFiles = @(Get-ChildItem -LiteralPath $from -Recurse -File | Where-Object {
        -not $excludeTransfers -or $_.FullName -notmatch '[\\/]transfers[\\/]'
    })
    $missing = 0
    $sizeChanged = 0
    foreach ($file in $sourceFiles) {
        $relativeFile = $file.FullName.Substring($from.Length).TrimStart('\')
        $copied = Join-Path $to $relativeFile
        if (-not (Test-Path -LiteralPath $copied -PathType Leaf)) { $missing++; continue }
        if ((Get-Item -LiteralPath $copied).Length -ne $file.Length) { $sizeChanged++ }
    }
    $copiedFiles = @(Get-ChildItem -LiteralPath $to -Recurse -File)
    $stat = [ordered]@{
        source = $relative; robocopy_exit = $code; source_files = $sourceFiles.Count
        copied_files = $copiedFiles.Count; missing_at_check = $missing
        size_changed_at_check = $sizeChanged
    }
    $script:copyStats += $stat
    Write-RunLog "Copy $relative exit=$code files=$($copiedFiles.Count) missing_now=$missing size_changed_now=$sizeChanged"
}

function Write-OwnedMarker([string]$directory, [string]$state) {
    [ordered]@{ schema = 'whatmcp.hotcopy.v1'; run_id = $runId; status = $state } |
        ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $directory '.whatmcp-hotcopy.json') -Encoding UTF8
}

function Remove-OldRuns {
    $cleanup = Join-Path $PSScriptRoot 'prune-windows-cases.ts'
    $roots = @($runs)
    if ($CasesDirectory) { $roots += $CasesDirectory }
    foreach ($root in $roots) {
        & $node --experimental-strip-types --no-warnings $cleanup $root $runId
        if ($LASTEXITCODE -ne 0) { throw "Cleanup failed for $root" }
    }
}

function Copy-AudioTransfers {
    # Database and WebView evidence are copied separately. Preserve only known
    # audio formats from transfer folders; images/documents are not imported.
    $local = Join-Path $source 'LocalState'
    foreach ($folder in @(Get-ChildItem -LiteralPath $local -Recurse -Directory -Filter 'transfers')) {
        $relative = $folder.FullName.Substring($local.Length).TrimStart('\')
        $destination = Join-Path (Join-Path $run 'LocalState') $relative
        $copyLog = Join-Path $logs ("audio-copy-$runId-" + ($relative -replace '[\\/ ]','-') + '.log')
        & robocopy.exe $folder.FullName $destination '*.ogg' '*.opus' '*.mp3' '*.wav' '*.m4a' '*.aac' '*.amr' '*.flac' '*.webm' /E /XJ /R:1 /W:1 /NP /NFL /NDL *> $copyLog
        if ($LASTEXITCODE -ge 8) { throw "Audio transfer copy failed; see $copyLog" }
    }
}

try {
    New-Item -ItemType Directory -Path $logs, $runs -Force | Out-Null
    try { $hasMutex = $mutex.WaitOne(0) }
    catch [Threading.AbandonedMutexException] { $hasMutex = $true }
    if (-not $hasMutex) { throw 'Another hot-copy sync is already running' }
    $runtimePath = Join-Path $data 'runtime-windows.json'
    if (-not $PythonPath -and (Test-Path -LiteralPath $runtimePath)) {
        $runtime = Get-Content -Raw -LiteralPath $runtimePath | ConvertFrom-Json
        $PythonPath = $runtime.python_path
    }
    if ($PythonPath) {
        if (-not (Test-Path -LiteralPath $PythonPath -PathType Leaf)) { throw "Python missing: $PythonPath" }
        $env:PATH = (Split-Path $PythonPath -Parent) + ';' + $env:PATH
    }
    if (-not (Test-Path -LiteralPath $waren6 -PathType Leaf)) { throw "WAren6 missing: $waren6" }
    if (-not (Test-Path -LiteralPath $node -PathType Leaf)) { throw "Node.js missing: $node" }
    New-Item -ItemType Directory -Path $run -Force | Out-Null
    Write-OwnedMarker $run 'created'
    Write-RunLog "START run=$runId whatsapp_running=$([bool](Get-Process -Name WhatsApp.Root -ErrorAction SilentlyContinue))"

    if ($NightlyRecovery) {
        $restoreWhatsApp = [bool](Get-Process -Name WhatsApp.Root -ErrorAction SilentlyContinue)
        $runtimeRoot = Join-Path $run 'nightly-runtime'
        $runtimeLog = Join-Path $logs "runtime-$runId.log"
        Write-RunLog 'Nightly recovery: restarting WhatsApp to capture runtime Store 8 text'
        & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $waren6 `
            -r -c $runtimeRoot -s *> $runtimeLog
        $runtimeExit = $LASTEXITCODE
        $candidate = Join-Path $runtimeRoot 'runtime\runtime_store8_messages.jsonl'
        if ($runtimeExit -eq 0 -and (Test-Path -LiteralPath $candidate) -and (Get-Item -LiteralPath $candidate).Length -gt 0) {
            $runtimeJsonl = $candidate
            $runtimeCaptureStatus = 'captured'
        } else {
            $runtimeCaptureStatus = 'failed'
            Write-RunLog "Runtime recovery unavailable exit=$runtimeExit; continuing with closed snapshot; see $runtimeLog"
        }
        Stop-WhatsAppForSnapshot
    }

    Copy-LiveDirectory 'LocalState' 'LocalState' $true
    Copy-AudioTransfers
    Copy-LiveDirectory 'LocalCache\EBWebView\Default\IndexedDB' 'LocalCache\EBWebView\Default\IndexedDB'
    Copy-LiveDirectory 'LocalCache\EBWebView\Default\Local Storage' 'LocalCache\EBWebView\Default\Local Storage'
    if ($NightlyRecovery) { Restore-WhatsAppAfterSnapshot }

    $caseOutput = if ($CasesDirectory) { Join-Path $CasesDirectory $runId } else { Join-Path $run 'cases' }
    New-Item -ItemType Directory -Path $caseOutput -Force | Out-Null
    Write-OwnedMarker $caseOutput 'created'
    $extractorLog = Join-Path $logs "waren6-$runId.log"
    $env:WHATMCP_HOME = $data
    $env:WAREN6_INDEXEDDB_CACHE = Join-Path $data 'indexeddb-cache\cache.sqlite'
    $env:WHATMCP_AUDIO_ACQUISITION_ENABLED = '0'
    $audioConfigPath = Join-Path $data 'config.json'
    if (Test-Path -LiteralPath $audioConfigPath) {
        $audioConfig = Get-Content -Raw -LiteralPath $audioConfigPath | ConvertFrom-Json
        if ($audioConfig.transcription_auto_after_import -and $audioConfig.transcription_model) {
            $env:WHATMCP_AUDIO_ACQUISITION_ENABLED = '1'
        }
    }
    $env:WHATMCP_AUDIO_CACHE_PATH = Join-Path $source 'LocalCache\EBWebView\Default\Cache\Cache_Data'
    $env:WHATMCP_AUDIO_CACHE_PYTHON = if ($PythonPath) { $PythonPath } else { 'python.exe' }
    $env:WHATMCP_AUDIO_CACHE_VENDOR = Join-Path (Split-Path $waren6 -Parent) 'vendor'
    Write-RunLog "Starting WAren6 on copied evidence; acquisition_mode=$(if ($NightlyRecovery) { 'closed_snapshot' } else { 'hot_copy' })"
    $supplementArguments = if ($runtimeJsonl) { @('-j', $runtimeJsonl) } else { @() }
    & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $waren6 `
        -f -n -m -NoArchive -KeepCaseDirectoryAfterArchive -PreservedCopy `
        -w (Join-Path $run 'LocalState') -d $caseOutput -s @supplementArguments *> $extractorLog
    $extractorExit = $LASTEXITCODE
    if ($extractorExit -ne 0) { throw "WAren6 exit=$extractorExit; see $extractorLog" }
    $case = Get-ChildItem -LiteralPath $caseOutput -Directory -Filter 'WAren6_*' |
        Sort-Object Name -Descending | Select-Object -First 1
    if (-not $case) { throw "WAren6 produced no case; see $extractorLog" }
    $reportPath = Join-Path $case.FullName 'validation_report.json'
    $dbPath = Join-Path $case.FullName 'unified_whatsapp.db'
    if (-not (Test-Path -LiteralPath $reportPath) -or -not (Test-Path -LiteralPath $dbPath)) {
        throw "WAren6 did not produce a database and validation report; see $extractorLog"
    }
    $report = Get-Content -Raw -LiteralPath $reportPath | ConvertFrom-Json
    $metrics = $report.metrics
    Write-RunLog "Validation status=$($report.status) errors=$(@($report.errors).Count) warnings=$(@($report.warnings) -join ',') messages=$($metrics.messages) text=$($metrics.non_empty_text)"
    if ($report.status -ne 'ok' -or @($report.errors).Count -gt 0) {
        throw "WAren6 validation failed; archive unchanged; see $reportPath"
    }

    if (Test-Path -LiteralPath $lastSuccessPath) {
        $previous = Get-Content -Raw -LiteralPath $lastSuccessPath | ConvertFrom-Json
        $delta = [long]$metrics.messages - [long]$previous.messages
        Write-RunLog "Message count delta versus last successful run: $delta"
    }

    $env:WHATMCP_HOME = $data
    $importLog = Join-Path $logs "import-$runId.log"
    if ($StorePath) { $env:WHATMCP_STORE = $StorePath }
    $importArguments = @('--experimental-sqlite', '--experimental-strip-types', '--no-warnings', $cli, 'import-windows', $dbPath, '--json')
    # The outer sync/index worker owns the lock and processes audio/embeddings.
    if ($ResultJson) { $importArguments += '--import-only' }
    if ($Full) { $importArguments += '--full' }
    & $node @importArguments *> $importLog
    $importExit = $LASTEXITCODE
    if ($importExit -ne 0) { throw "WhatMCP import exit=$importExit; see $importLog" }
    $importResult = Get-Content -LiteralPath $importLog -Tail 1 | ConvertFrom-Json
    Write-RunLog "Import complete: $((Get-Content -LiteralPath $importLog -Tail 1) -join ' ')"
    [ordered]@{ run_id = $runId; messages = $metrics.messages; non_empty_text = $metrics.non_empty_text } |
        ConvertTo-Json -Compress | Set-Content -LiteralPath $lastSuccessPath -Encoding UTF8
    $status = 'ok'
    if ($ResultJson) { Write-Output ('WHATMCP_HOTCOPY_RESULT=' + ($importResult | ConvertTo-Json -Compress)) }
    Write-RunLog "SUCCESS run=$runId whatsapp_running=$([bool](Get-Process -Name WhatsApp.Root -ErrorAction SilentlyContinue))"
} catch {
    $reason = $_.Exception.Message
    Write-RunLog "FAILED $reason"
} finally {
    if ($NightlyRecovery -and $restoreWhatsApp) {
        try { Restore-WhatsAppAfterSnapshot } catch { Write-Warning $_.Exception.Message; $status = 'failed'; $reason = $_.Exception.Message }
    }
    $summary = [ordered]@{
        run_id = $runId; started = $started.ToString('o'); ended = (Get-Date).ToString('o')
        acquisition_mode = if ($NightlyRecovery) { 'closed_snapshot' } else { 'hot_copy' }
        runtime_capture_status = $runtimeCaptureStatus
        opaque_unresolved = if ($metrics) { $metrics.store8_opaque_unresolved_messages } else { $null }
        runtime_decoded = if ($metrics) { $metrics.store8_runtime_decoded_messages } else { $null }
        recovered = if ($importResult) { $importResult.recovered } else { $null }
        status = $status; reason = $reason; whatsapp_running_after = [bool](Get-Process -Name WhatsApp.Root -ErrorAction SilentlyContinue)
        copy = $copyStats; messages = if ($metrics) { $metrics.messages } else { $null }
        non_empty_text = if ($metrics) { $metrics.non_empty_text } else { $null }
        run_log = $log
    }
    Add-Content -LiteralPath $summaryPath -Value ($summary | ConvertTo-Json -Compress -Depth 5) -Encoding UTF8
    if ($hasMutex) {
        if (Test-Path -LiteralPath (Join-Path $run '.whatmcp-hotcopy.json')) { Write-OwnedMarker $run $status }
        if ($caseOutput -and (Test-Path -LiteralPath (Join-Path $caseOutput '.whatmcp-hotcopy.json'))) { Write-OwnedMarker $caseOutput $status }
        try { Remove-OldRuns } catch { Write-RunLog "Cleanup warning: $($_.Exception.Message)" }
        $mutex.ReleaseMutex() | Out-Null
    }
    $mutex.Dispose()
}
if ($status -ne 'ok') { exit 1 }
exit 0
