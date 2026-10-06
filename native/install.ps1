[CmdletBinding()]
param(
    [Parameter()]
    [string]$PythonPath
)

$ErrorActionPreference = 'Stop'
$hostName = 'com.videolens.downloader'
$extensionId = 'video-lens@local'
$nativeRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$requirementsPath = Join-Path $nativeRoot 'requirements.txt'
$venvRoot = Join-Path $nativeRoot '.venv'
$venvPython = Join-Path $venvRoot 'Scripts\python.exe'
$launcherPath = Join-Path $nativeRoot 'video-lens-host.cmd'
$manifestPath = Join-Path $nativeRoot "$hostName.json"
$registryPath = "HKCU:\Software\Mozilla\NativeMessagingHosts\$hostName"

function Resolve-RealPython {
    param([string]$RequestedPath)

    $candidates = [System.Collections.Generic.List[string]]::new()
    if ($RequestedPath) {
        $candidates.Add($RequestedPath)
    } else {
        $pyLauncher = Get-Command 'py.exe' -ErrorAction SilentlyContinue
        if ($pyLauncher) {
            try {
                $resolved = & $pyLauncher.Source -3 -c 'import sys; print(sys.executable)' 2>$null
                if ($LASTEXITCODE -eq 0 -and $resolved) {
                    $candidates.Add(($resolved | Select-Object -Last 1).Trim())
                }
            } catch {
            }
        }
        foreach ($name in @('python.exe', 'python3.exe')) {
            $command = Get-Command $name -ErrorAction SilentlyContinue
            if ($command) {
                $candidates.Add($command.Source)
            }
        }
    }

    foreach ($candidate in $candidates) {
        try {
            $fullPath = [System.IO.Path]::GetFullPath($candidate)
            if ($fullPath -match '(?i)\\WindowsApps\\' -or -not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
                continue
            }
            $reported = & $fullPath -c 'import os, sys; assert sys.version_info >= (3, 10); print(os.path.realpath(sys.executable))' 2>$null
            if ($LASTEXITCODE -ne 0 -or -not $reported) {
                continue
            }
            $realPath = [System.IO.Path]::GetFullPath(($reported | Select-Object -Last 1).Trim())
            if ($realPath -match '(?i)\\WindowsApps\\' -or -not (Test-Path -LiteralPath $realPath -PathType Leaf)) {
                continue
            }
            return $realPath
        } catch {
        }
    }
    throw 'A real Python 3.10 or newer installation was not found. Install Python from python.org, then rerun with -PythonPath C:\Path\To\python.exe. Windows Store command aliases are not supported.'
}

$python = Resolve-RealPython -RequestedPath $PythonPath
Write-Host "Creating the Video Lens environment with $python"
& $python -m venv $venvRoot
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $venvPython -PathType Leaf)) {
    throw 'Python could not create the helper environment.'
}

& $venvPython -m pip install --disable-pip-version-check --require-virtualenv --upgrade --upgrade-strategy eager -r $requirementsPath
if ($LASTEXITCODE -ne 0) {
    throw 'Installing yt-dlp failed. Check the network connection and rerun this installer.'
}

$launcher = @'
@echo off
"%~dp0.venv\Scripts\python.exe" "%~dp0host.py"
'@
Set-Content -LiteralPath $launcherPath -Value $launcher -Encoding ASCII

$manifest = [ordered]@{
    name = $hostName
    description = 'Video Lens download companion'
    path = $launcherPath
    type = 'stdio'
    allowed_extensions = @($extensionId)
}
$manifestJson = $manifest | ConvertTo-Json -Depth 4
[System.IO.File]::WriteAllText($manifestPath, $manifestJson, [System.Text.UTF8Encoding]::new($false))

New-Item -Path $registryPath -Force | Out-Null
Set-Item -Path $registryPath -Value $manifestPath

Write-Host 'Video Lens native messaging is installed for the current Windows user.'
Write-Host 'Install FFmpeg (including FFprobe) and Node.js on PATH if the extension probe reports them missing, then restart Firefox.'

