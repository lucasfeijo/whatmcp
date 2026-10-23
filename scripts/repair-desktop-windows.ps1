param([string]$InstallDir=(Join-Path $env:LOCALAPPDATA 'WhatMCP'))
$ErrorActionPreference='Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'This repair applies only to Windows.' }
$taskInstall=[IO.Path]::GetFullPath($InstallDir)
$taskBin=Join-Path $taskInstall 'bin'
$taskNode=Join-Path $taskBin 'node.exe'
$taskOriginal=Join-Path $taskBin 'node.original.exe'
$taskApp=Join-Path $taskInstall 'whatmcp-desktop.exe'
$taskCompiler=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (!(Test-Path -LiteralPath $taskNode) -or !(Test-Path -LiteralPath $taskApp)) { throw 'Installed WhatMCP runtime not found.' }
if (!(Test-Path -LiteralPath $taskCompiler)) { throw '.NET Framework C# compiler not found.' }
if (Get-Process -Name whatmcp-desktop -ErrorAction SilentlyContinue) { throw 'Close the WhatMCP desktop app before applying this repair.' }
$taskRoot=Split-Path $PSScriptRoot -Parent
$taskSource=Join-Path $taskRoot 'deploy\windows\desktop-node-host.cs'
$taskOutput=Join-Path $taskBin 'desktop-node-host.new.exe'
& $taskCompiler /nologo /target:winexe "/out:$taskOutput" $taskSource
if ($LASTEXITCODE -ne 0) { throw 'Windows bootstrap compilation failed.' }
$taskTest=Start-Process -FilePath $taskOutput -ArgumentList '--self-test' -WindowStyle Hidden -Wait -PassThru
if ($taskTest.ExitCode -ne 0) { throw 'Windows bootstrap regression checks failed.' }
if ((Get-AuthenticodeSignature -LiteralPath $taskNode).Status -eq 'Valid') {
    Copy-Item -LiteralPath $taskNode -Destination $taskOriginal -Force
} elseif (!(Test-Path -LiteralPath $taskOriginal)) { throw 'The original signed Node executable is missing.' }
if ((Get-AuthenticodeSignature -LiteralPath $taskOriginal).Status -ne 'Valid') { throw 'Original Node signature verification failed.' }
Copy-Item -LiteralPath $taskOutput -Destination $taskNode -Force
Remove-Item -LiteralPath $taskOutput
[pscustomobject]@{Installed=$true;WindowsOnly=$true;OriginalNode=$taskOriginal;TestsPassed=$true}