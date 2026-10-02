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
    [switch]$ResultJson
)

$ErrorActionPreference = 'Stop'
$project = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$data = if ($DataDirectory) { $DataDirectory } else { Join-Path $project 'data' }
$runs = Join-Path $data 'hot-copy-runs'
$logs = Join-Path $data 'logs'
$waren6 = if ($Waren6Directory) { Join-Path $Waren6Directory 'waren6.ps1' } else { Join-Path $project 'WAren6\waren6.ps1' }
$cli = Join-Path $project 'whatmcp\src\cli.ts'
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

function Write-RunLog([string]$message) {
    $line = "$(Get-Date -Format o) $message"
    Add-Content -LiteralPath $log -Value $line -Encoding UTF8
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
    if ($excludeTransfers) { $arguments += @('/XD', (Join-Path $from 'transfers')) }
    & robocopy.exe @arguments *> $copyLog
    $code = $LASTEXITCODE
    if ($code -ge 8) { throw "Robocopy failed for $relative with exit code $code; see $copyLog" }

    # These counts are diagnostics. Live LevelDB files may change after this check.
    $sourceFiles = @(Get-ChildItem -LiteralPath $from -Recurse -File | Where-Object {
        -not $excludeTransfers -or $_.FullName -notlike "$(Join-Path $from 'transfers')\*"
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

function Remove-OldRuns {
    $root = [IO.Path]::GetFullPath($runs).TrimEnd('\') + '\'
    $oldRuns = @(Get-ChildItem -LiteralPath $runs -Directory | Sort-Object Name -Descending | Select-Object -Skip 2)
    foreach ($old in $oldRuns) {
        $target = [IO.Path]::GetFullPath($old.FullName)
        if (-not $target.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing cleanup outside hot-copy-runs: $target"
        }
        Remove-Item -LiteralPath $target -Recurse -Force
        Write-RunLog "Pruned generated run $($old.Name); retained the two newest runs"
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
    Write-RunLog "START run=$runId whatsapp_running=$([bool](Get-Process -Name WhatsApp.Root -ErrorAction SilentlyContinue))"

    Copy-LiveDirectory 'LocalState' 'LocalState' $true
    Copy-LiveDirectory 'LocalCache\EBWebView\Default\IndexedDB' 'LocalCache\EBWebView\Default\IndexedDB'
    Copy-LiveDirectory 'LocalCache\EBWebView\Default\Local Storage' 'LocalCache\EBWebView\Default\Local Storage'

    $caseOutput = if ($CasesDirectory) { Join-Path $CasesDirectory $runId } else { Join-Path $run 'cases' }
    New-Item -ItemType Directory -Path $caseOutput -Force | Out-Null
    $extractorLog = Join-Path $logs "waren6-$runId.log"
    Write-RunLog 'Starting WAren6 on copied evidence; WhatsApp remains open'
    & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $waren6 `
        -f -n -NoArchive -KeepCaseDirectoryAfterArchive -PreservedCopy `
        -w (Join-Path $run 'LocalState') -d $caseOutput -s *> $extractorLog
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
    $summary = [ordered]@{
        run_id = $runId; started = $started.ToString('o'); ended = (Get-Date).ToString('o')
        status = $status; reason = $reason; whatsapp_running_after = [bool](Get-Process -Name WhatsApp.Root -ErrorAction SilentlyContinue)
        copy = $copyStats; messages = if ($metrics) { $metrics.messages } else { $null }
        non_empty_text = if ($metrics) { $metrics.non_empty_text } else { $null }
        run_log = $log
    }
    Add-Content -LiteralPath $summaryPath -Value ($summary | ConvertTo-Json -Compress -Depth 5) -Encoding UTF8
    if ($hasMutex) {
        try { Remove-OldRuns } catch { Write-RunLog "Cleanup warning: $($_.Exception.Message)" }
        $mutex.ReleaseMutex() | Out-Null
    }
    $mutex.Dispose()
}
if ($status -ne 'ok') { exit 1 }
exit 0
