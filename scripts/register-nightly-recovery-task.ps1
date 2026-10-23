[CmdletBinding()]
param(
    [string]$StartBoundary,
    [switch]$DefinitionOnly
)

$ErrorActionPreference = 'Stop'
$project = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$data = Join-Path $project 'data'
$runner = Join-Path $PSScriptRoot 'sync-hotcopy-windows.ps1'
$hiddenLauncher = Join-Path $PSScriptRoot 'run-nightly-recovery-hidden.vbs'
$taskName = 'WhatMCP Nightly Recovery'
$taskXmlPath = Join-Path $data 'nightly-recovery-task.xml'
if (-not (Test-Path -LiteralPath $runner -PathType Leaf)) { throw "Runner missing: $runner" }
if (-not (Test-Path -LiteralPath $hiddenLauncher -PathType Leaf)) { throw "Hidden launcher missing: $hiddenLauncher" }
New-Item -ItemType Directory -Path $data -Force | Out-Null

$boundary = if ($StartBoundary) {
    ([datetime]::ParseExact($StartBoundary, 'yyyy-MM-ddTHH:mm:ss', [Globalization.CultureInfo]::InvariantCulture)).ToString('yyyy-MM-ddTHH:mm:ss')
} else {
    $zone = [TimeZoneInfo]::FindSystemTimeZoneById('E. South America Standard Time')
    $now = [TimeZoneInfo]::ConvertTimeFromUtc([datetime]::UtcNow, $zone)
    $nextRun = $now.Date.AddHours(4)
    if ($nextRun -le $now) { $nextRun = $nextRun.AddDays(1) }
    $nextRun.ToString('yyyy-MM-ddTHH:mm:ss')
}
$arguments = '//B //Nologo "' + $hiddenLauncher + '"'
$xmlArguments = [Security.SecurityElement]::Escape($arguments)
$xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>WhatMCP daily recovery at 04:00 with live runtime capture, validation, import and retained logs.</Description></RegistrationInfo>
  <Triggers><CalendarTrigger><StartBoundary>$boundary</StartBoundary><Enabled>true</Enabled><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>carlos</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>false</StartWhenAvailable><WakeToRun>true</WakeToRun><Enabled>true</Enabled><ExecutionTimeLimit>PT90M</ExecutionTimeLimit></Settings>
  <Actions Context="Author"><Exec><Command>wscript.exe</Command><Arguments>$xmlArguments</Arguments></Exec></Actions>
</Task>
"@
[xml]$validatedXml = $xml
[IO.File]::WriteAllText($taskXmlPath, $validatedXml.OuterXml, [Text.Encoding]::Unicode)
if ($DefinitionOnly) {
    Write-Output "Task definition prepared: $taskXmlPath"
    return
}
& schtasks.exe /Create /TN $taskName /XML $taskXmlPath /F
if ($LASTEXITCODE -ne 0) { throw "Could not register scheduled task $taskName" }
Write-Output "Registered $taskName daily at 04:00; starts $boundary with an invisible launcher"
Write-Output "Task definition: $taskXmlPath"
