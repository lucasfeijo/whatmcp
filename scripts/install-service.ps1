$ErrorActionPreference = 'Stop'
$project = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$result = Join-Path $project 'data\logs\service-setup.log'
try {
    $wrapper = Join-Path $project 'whatmcp\deploy\windows\whatmcp-service.exe'
    $serviceConfig = Join-Path $project 'whatmcp\deploy\windows\whatmcp-service.xml'
    if (-not (Test-Path -LiteralPath $serviceConfig)) {
        $template = Get-Content -Raw (Join-Path $project 'whatmcp\deploy\windows\whatmcp-service.example.xml')
        $template.Replace('@PROJECT@', [Security.SecurityElement]::Escape($project)) | Set-Content $serviceConfig -Encoding UTF8
    }
    $service = Get-Service -Name WhatMCP -ErrorAction SilentlyContinue
    if (-not $service) {
        & $wrapper install *>> $result
        if ($LASTEXITCODE -ne 0) { throw 'WinSW installation failed' }
    } else {
        Stop-Service WhatMCP
    }
    & sc.exe config WhatMCP obj= 'NT AUTHORITY\LocalService' *>> $result
    if ($LASTEXITCODE -ne 0) { throw 'Could not set LocalService account' }
    $task = Get-ScheduledTask -TaskName 'WhatMCP HTTPS Server' -ErrorAction SilentlyContinue
    if ($task) {
        Stop-ScheduledTask -TaskName 'WhatMCP HTTPS Server'
        Unregister-ScheduledTask -TaskName 'WhatMCP HTTPS Server' -Confirm:$false
    }
    Start-Service WhatMCP
    Get-CimInstance Win32_Service -Filter "Name='WhatMCP'" | Select-Object Name,State,StartMode,StartName | ConvertTo-Json | Add-Content $result
} catch { $_.Exception.Message | Add-Content $result; exit 1 }
