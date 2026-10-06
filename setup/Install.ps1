[CmdletBinding()]
param([switch]$VerifyOnly, [switch]$NoOpenGuide)
$ErrorActionPreference = 'Stop'
$bundle = [IO.Path]::GetFullPath($PSScriptRoot)
if ([Environment]::OSVersion.Version.Major -lt 10 -or -not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { throw 'This bundle needs x64 Windows 10 or newer. ARM Windows is not supported yet.' }
$inventory = Get-Content -LiteralPath (Join-Path $bundle 'SHA256SUMS.json') -Raw | ConvertFrom-Json
if ($inventory.version -ne '0.3.3' -or $inventory.files.Count -lt 10) { throw 'Invalid bundle manifest. Extract the complete ZIP again.' }
Write-Host 'Checking bundled files...'
foreach ($entry in $inventory.files) {
    $candidate = [IO.Path]::GetFullPath((Join-Path $bundle $entry.path))
    if (-not $candidate.StartsWith($bundle + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Manifest path escapes the bundle.' }
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { throw "Missing file: $($entry.path)" }
    if ((Get-FileHash -LiteralPath $candidate -Algorithm SHA256).Hash -ne $entry.sha256) { throw "Checksum mismatch: $($entry.path). Do not run a damaged or altered bundle." }
}
if ($VerifyOnly) { Write-Host 'Bundle verification passed.'; return }
$appRoot = [IO.Path]::GetFullPath((Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'senzdev\visave'))
$installRoot = Join-Path $appRoot ($inventory.version + '-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $installRoot -Force | Out-Null
foreach ($entry in $inventory.files) {
    if (-not $entry.path.StartsWith('app/', [StringComparison]::Ordinal)) { continue }
    $target = [IO.Path]::GetFullPath((Join-Path $installRoot $entry.path))
    if (-not $target.StartsWith($installRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Installation path escapes the application folder.' }
    New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $bundle $entry.path) -Destination $target
    if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ne $entry.sha256) { throw "Copied file failed verification: $($entry.path)" }
}
$nativeRoot = Join-Path $installRoot 'app'
. (Join-Path $bundle 'MediaTools.ps1')
Install-VisaveMediaTools -MetadataPath (Join-Path $nativeRoot 'FFMPEG-DOWNLOAD.json') -BinRoot (Join-Path $nativeRoot 'bin') -CacheRoot (Join-Path $appRoot 'cache')
$python = Join-Path $nativeRoot 'runtime\python.exe'
Write-Host 'Testing the private runtime, download components, MP4 and MP3...'
& $python (Join-Path $nativeRoot 'selfcheck.py')
if ($LASTEXITCODE -ne 0) { throw "Component checks failed. Registration unchanged. Test files are in $installRoot" }
$launcher = Join-Path $nativeRoot 'visave-host.cmd'
[IO.File]::WriteAllText($launcher, "@echo off`r`n`"%~dp0runtime\python.exe`" `"%~dp0host.py`"`r`n", [Text.Encoding]::ASCII)
$manifestPath = Join-Path $nativeRoot 'com.videolens.downloader.json'
$manifest = @{ name='com.videolens.downloader'; description='senzdev | visave download companion'; path=$launcher; type='stdio'; allowed_extensions=@('video-lens@local') } | ConvertTo-Json
[IO.File]::WriteAllText($manifestPath, $manifest, [Text.UTF8Encoding]::new($false))
# Retain the connection identity so existing Firefox settings and upgrades remain compatible.
$registryPath = 'HKCU:\Software\Mozilla\NativeMessagingHosts\com.videolens.downloader'
New-Item -Path $registryPath -Force | Out-Null
Set-Item -Path $registryPath -Value $manifestPath
Write-Host "Installation complete. Location: $nativeRoot"
Write-Host 'Open START-HERE.html for Firefox installation. Reload visave, then Settings > Installation > Check installation.'
Write-Host 'No background service or startup task was installed. Your existing downloads were preserved.'
if (-not $NoOpenGuide) {
    try { Start-Process -FilePath (Join-Path $bundle 'START-HERE.html') | Out-Null }
    catch { Write-Warning ('Open START-HERE.html in the setup folder to continue. ' + $_.Exception.Message) }
}
