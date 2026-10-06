function Install-VisaveMediaTools {
    [CmdletBinding()]
    param([string]$MetadataPath, [string]$BinRoot, [string]$CacheRoot, [string]$ArchivePath)
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    $media = Get-Content -LiteralPath $MetadataPath -Raw | ConvertFrom-Json
    if ($media.archiveName -notmatch '^ffmpeg-[0-9.]+-essentials_build\.zip$' -or $media.sha256 -notmatch '^[a-fA-F0-9]{64}$' -or $media.url -notmatch '^https://github\.com/GyanD/codexffmpeg/releases/download/[0-9.]+/ffmpeg-[0-9.]+-essentials_build\.zip$') {
        throw 'Invalid FFmpeg download metadata. Download a fresh visave release.'
    }
    foreach ($name in @('ffmpeg.exe', 'ffprobe.exe')) {
        if ($media.binaries.$name -notmatch '^[a-fA-F0-9]{64}$') { throw ('Missing publisher-package hash for ' + $name) }
    }
    if (-not $ArchivePath) {
        New-Item -ItemType Directory -Path $CacheRoot -Force | Out-Null
        $ArchivePath = Join-Path $CacheRoot $media.archiveName
        $cached = (Test-Path -LiteralPath $ArchivePath -PathType Leaf) -and ((Get-FileHash -LiteralPath $ArchivePath -Algorithm SHA256).Hash -ieq $media.sha256)
        if (-not $cached) {
            Write-Host 'Downloading FFmpeg directly from the Gyan build publisher. This step needs internet access.'
            [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
            $temporary = Join-Path $CacheRoot ([guid]::NewGuid().ToString('N') + '.download')
            Invoke-WebRequest -Uri $media.url -OutFile $temporary -UseBasicParsing -ErrorAction Stop
            if ((Get-FileHash -LiteralPath $temporary -Algorithm SHA256).Hash -ine $media.sha256) {
                throw 'The FFmpeg download does not match the pinned publisher checksum. Nothing was registered.'
            }
            Move-Item -LiteralPath $temporary -Destination $ArchivePath -Force
        }
    }
    if ((Get-FileHash -LiteralPath $ArchivePath -Algorithm SHA256).Hash -ine $media.sha256) {
        throw 'FFmpeg archive checksum mismatch. Nothing was registered.'
    }
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    New-Item -ItemType Directory -Path $BinRoot -Force | Out-Null
    $zip = [IO.Compression.ZipFile]::OpenRead($ArchivePath)
    try {
        foreach ($name in @('ffmpeg.exe', 'ffprobe.exe')) {
            $entries = @($zip.Entries | Where-Object { $_.FullName.Replace('\', '/').EndsWith('/bin/' + $name, [StringComparison]::Ordinal) })
            if ($entries.Count -ne 1) { throw ('The publisher archive must contain exactly one ' + $name) }
            $target = Join-Path $BinRoot $name
            $inputStream = $entries[0].Open()
            $outputStream = [IO.File]::Create($target)
            try { $inputStream.CopyTo($outputStream) }
            finally { $outputStream.Dispose(); $inputStream.Dispose() }
            if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ine $media.binaries.$name) {
                throw ('Extracted FFmpeg file failed verification: ' + $name + '. Nothing was registered.')
            }
        }
    } finally { $zip.Dispose() }
    Write-Host 'FFmpeg and FFprobe match the pinned publisher package.'
}
