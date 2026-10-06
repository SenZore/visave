[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$hostName = 'com.videolens.downloader'
$nativeRoot = [System.IO.Path]::GetFullPath((Split-Path -Parent $MyInvocation.MyCommand.Path))
$registryPath = "HKCU:\Software\Mozilla\NativeMessagingHosts\$hostName"

if (Test-Path -LiteralPath $registryPath) {
    Remove-Item -LiteralPath $registryPath -Force
}

foreach ($relativePath in @('.venv', 'video-lens-host.cmd', "$hostName.json")) {
    $target = [System.IO.Path]::GetFullPath((Join-Path $nativeRoot $relativePath))
    $parent = [System.IO.Path]::GetFullPath((Split-Path -Parent $target))
    if ($parent -ne $nativeRoot) {
        throw "Refusing to remove a path outside $nativeRoot"
    }
    if (Test-Path -LiteralPath $target) {
        Remove-Item -LiteralPath $target -Recurse -Force
    }
}

Write-Host 'Video Lens native messaging has been removed for the current Windows user.'

