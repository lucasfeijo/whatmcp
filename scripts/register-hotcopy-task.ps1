[CmdletBinding()]
param(
    [ValidateRange(1, 24)][int]$IntervalHours = 2,
    [string]$StartBoundary
)

$ErrorActionPreference = 'Stop'
$project = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$data = Join-Path $project 'data'
$runner = Join-Path $PSScriptRoot 'sync-hotcopy-windows.ps1'
$hiddenLauncher = Join-Path $PSScriptRoot 'run-hotcopy-hidden.vbs'
$taskName = 'WhatMCP Hot Copy'
$taskXmlPath = Join-Path $data 'hot-copy-task.xml'
if (-not (Test-Path -LiteralPath $runner -PathType Leaf)) { throw "Runner missing: $runner" }
if (-not (Test-Path -LiteralPath $hiddenLauncher -PathType Leaf)) { throw "Hidden launcher missing: $hiddenLauncher" }
New-Item -ItemType Directory -Path $data -Force | Out-Null

$boundary = if ($StartBoundary) { $StartBoundary } else {
    (Get-Date).AddHours($IntervalHours).ToString('yyyy-MM-ddTHH:mm:ss')
}
$arguments = '//B //Nologo "' + $hiddenLauncher + '"'
$xmlArguments = [Security.SecurityElement]::Escape($arguments)
$xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>WhatMCP hot copy, validation, import, and retained logs without closing WhatsApp.</Description></RegistrationInfo>
  <Triggers><TimeTrigger><Repetition><Interval>PT$($IntervalHours * 60)M</Interval></Repetition><StartBoundary>$boundary</StartBoundary><Enabled>true</Enabled></TimeTrigger></Triggers>
  <Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable><Enabled>true</Enabled><ExecutionTimeLimit>PT90M</ExecutionTimeLimit></Settings>
  <Actions Context="Author"><Exec><Command>wscript.exe</Command><Arguments>$xmlArguments</Arguments></Exec></Actions>
</Task>
"@
[IO.File]::WriteAllText($taskXmlPath, $xml, [Text.Encoding]::Unicode)
& schtasks.exe /Create /TN $taskName /XML $taskXmlPath /F
if ($LASTEXITCODE -ne 0) { throw "Could not register scheduled task $taskName" }
Write-Output "Registered $taskName every $IntervalHours hours; schedule starts $boundary and uses an invisible launcher"
Write-Output "Task definition: $taskXmlPath"
