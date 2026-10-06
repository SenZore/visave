[CmdletBinding()]
param(
    [ValidatePattern('^\d+\.\d+\.\d+$')][string]$Version = '0.3.3',
    [switch]$DownloadOnly,
    [switch]$NoOpenGuide
)

function Expand-VisaveArchive {
    param([string]$Archive, [string]$Destination)
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $root = [IO.Path]::GetFullPath($Destination) + [IO.Path]::DirectorySeparatorChar
    $zip = [IO.Compression.ZipFile]::OpenRead($Archive)
    try {
        foreach ($entry in $zip.Entries) {
            $path = [IO.Path]::GetFullPath((Join-Path $Destination $entry.FullName))
            if (-not $path.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
                throw 'The setup ZIP contains a path outside its folder. Extraction stopped.'
            }
            if ((($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) {
                throw 'The setup ZIP contains a symbolic link. Extraction stopped.'
            }
        }
    } finally { $zip.Dispose() }
    Expand-Archive -LiteralPath $Archive -DestinationPath $Destination
}

function Get-VisaveBundle {
    param(
        [ValidatePattern('^\d+\.\d+\.\d+$')][string]$ReleaseVersion,
        [string]$WorkRoot
    )
    $asset = 'visave-windows-' + $ReleaseVersion + '.zip'
    $release = 'https://github.com/senzore/visave/releases/download/v' + $ReleaseVersion
    New-Item -ItemType Directory -Path $WorkRoot -Force | Out-Null
    $archive = Join-Path $WorkRoot $asset
    $checksum = Join-Path $WorkRoot ('visave-windows-' + $ReleaseVersion + '.sha256')
    Write-Host ('Downloading visave ' + $ReleaseVersion + ' from GitHub. Setup also downloads FFmpeg from its publisher.')
    $ProgressPreference = 'SilentlyContinue'
    try {
        Invoke-WebRequest -Uri ($release + '/' + $asset) -OutFile $archive -UseBasicParsing -TimeoutSec 300 -ErrorAction Stop
        Invoke-WebRequest -Uri ($release + '/visave-windows-' + $ReleaseVersion + '.sha256') -OutFile $checksum -UseBasicParsing -TimeoutSec 300 -ErrorAction Stop
    } catch {
        throw ('Could not download release v' + $ReleaseVersion + '. Check your connection and https://github.com/senzore/visave/releases. Nothing was installed. ' + $_.Exception.Message)
    }
    $digest = (Get-Content -LiteralPath $checksum -Raw).Trim()
    $match = [regex]::Match($digest, '\A([a-fA-F0-9]{64})[ \t]+\*?([^\r\n]+)\z')
    if (-not $match.Success -or $match.Groups[2].Value -cne $asset) {
        throw 'The release checksum does not identify this setup ZIP. Nothing was installed.'
    }
    if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ine $match.Groups[1].Value) {
        throw 'The setup ZIP does not match the release checksum. Nothing was installed. Download it again from the project release page.'
    }
    $bundle = Join-Path $WorkRoot 'bundle'
    Expand-VisaveArchive -Archive $archive -Destination $bundle
    foreach ($name in @('Install.ps1', 'MediaTools.ps1', 'SHA256SUMS.json', 'START-HERE.html', 'app/runtime/python.exe', 'app/FFMPEG-DOWNLOAD.json')) {
        if (-not (Test-Path -LiteralPath (Join-Path $bundle $name) -PathType Leaf)) {
            throw ('The setup bundle is incomplete: ' + $name + '. Nothing was installed.')
        }
    }
    return $bundle
}

function Install-Visave {
    param([string]$ReleaseVersion, [switch]$OnlyDownload, [switch]$SkipGuide)
    $ErrorActionPreference = 'Stop'
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT -or [Environment]::OSVersion.Version.Major -lt 10 -or -not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') {
        throw 'This installer supports x64 Windows 10 and 11. ARM Windows, macOS and Linux packages are not available yet.'
    }
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $work = Join-Path ([IO.Path]::GetTempPath()) ('visave-setup-' + [guid]::NewGuid().ToString('N'))
    $bundle = Get-VisaveBundle -ReleaseVersion $ReleaseVersion -WorkRoot $work
    Write-Host ('Verified setup folder: ' + $bundle)
    if ($OnlyDownload) {
        Write-Host 'Download complete. Read Install.ps1 before running Setup.cmd in this folder.'
        return
    }
    # Use a separate process so execution policy changes stay in that process.
    $installer = Join-Path $bundle 'Install.ps1'
    $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $installer)
    if ($SkipGuide) { $arguments += '-NoOpenGuide' }
    & powershell.exe @arguments
    if ($LASTEXITCODE -ne 0) {
        throw ('Setup failed. Read the error above; files for inspection remain in ' + $bundle)
    }
    Write-Host 'The download companion is installed. Follow START-HERE.html to add the Firefox preview extension.'
    Write-Host 'This preview is unsigned. Firefox requires Mozilla signing for permanent installation.'
}

if ($MyInvocation.InvocationName -ne '.') {
    Install-Visave -ReleaseVersion $Version -OnlyDownload:$DownloadOnly -SkipGuide:$NoOpenGuide
}
