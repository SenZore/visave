$ErrorActionPreference = 'Stop'
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'setup/MediaTools.ps1')
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('visave-media-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testRoot | Out-Null
$script:archive = Join-Path $testRoot 'publisher.zip'
$metadataPath = Join-Path $testRoot 'media.json'
$cacheRoot = Join-Path $testRoot 'cache'
$binRoot = Join-Path $testRoot 'bin'
$script:downloadCount = 0

function New-MediaFixture {
    param([switch]$Duplicate)
    if (Test-Path -LiteralPath $script:archive) { Remove-Item -LiteralPath $script:archive }
    $zip = [IO.Compression.ZipFile]::Open($script:archive, [IO.Compression.ZipArchiveMode]::Create)
    try {
        $names = @('publisher/bin/ffmpeg.exe', 'publisher/bin/ffprobe.exe', '../../outside.txt')
        if ($Duplicate) { $names += 'other/bin/ffmpeg.exe' }
        foreach ($name in $names) {
            $writer = [IO.StreamWriter]::new($zip.CreateEntry($name).Open())
            try { $writer.Write('test fixture, never executed') } finally { $writer.Dispose() }
        }
    } finally { $zip.Dispose() }
    $fixtureFile = Join-Path $testRoot 'fixture.txt'
    [IO.File]::WriteAllText($fixtureFile, 'test fixture, never executed')
    $binaryHash = (Get-FileHash -LiteralPath $fixtureFile -Algorithm SHA256).Hash
    $script:metadata = @{
        archiveName = 'ffmpeg-9.0.2-essentials_build.zip'
        url = 'https://github.com/GyanD/codexffmpeg/releases/download/9.0.2/ffmpeg-9.0.2-essentials_build.zip'
        sha256 = (Get-FileHash -LiteralPath $script:archive -Algorithm SHA256).Hash
        binaries = @{ 'ffmpeg.exe' = $binaryHash; 'ffprobe.exe' = $binaryHash }
    }
    Save-Metadata
}

function Save-Metadata {
    $script:metadata | ConvertTo-Json | Set-Content -LiteralPath $metadataPath -Encoding UTF8
}

function Invoke-WebRequest {
    param($Uri, $OutFile, [switch]$UseBasicParsing, $ErrorAction)
    if ($Uri -ne $script:metadata.url) { throw 'Unexpected publisher origin' }
    $script:downloadCount++
    Copy-Item -LiteralPath $script:archive -Destination $OutFile
}

function Assert-Rejected {
    param([scriptblock]$Action, [string]$Expected)
    try { & $Action | Out-Null } catch {
        if ($_.Exception.Message.Contains($Expected)) { return }
        throw
    }
    throw ('Expected rejection: ' + $Expected)
}

function Install-Fixture {
    Install-VisaveMediaTools -MetadataPath $metadataPath -BinRoot $binRoot -CacheRoot $cacheRoot
}

New-MediaFixture
Install-Fixture
Install-Fixture
if ($script:downloadCount -ne 1) { throw 'Verified cache was not reused' }
if (@(Get-ChildItem -LiteralPath $binRoot -File).Count -ne 2) { throw 'Unexpected extracted file' }
if (Test-Path -LiteralPath (Join-Path $testRoot 'outside.txt')) { throw 'Unrequested archive entry was extracted' }
[IO.File]::WriteAllText((Join-Path $cacheRoot $script:metadata.archiveName), 'broken cache')
Install-Fixture
if ($script:downloadCount -ne 2) { throw 'Broken cache was not replaced' }
$script:metadata.sha256 = '0' * 64
Save-Metadata
Assert-Rejected { Install-Fixture } 'does not match the pinned publisher checksum'
New-MediaFixture
$script:metadata.binaries.'ffmpeg.exe' = '0' * 64
Save-Metadata
Assert-Rejected { Install-Fixture } 'Extracted FFmpeg file failed verification'
New-MediaFixture -Duplicate
Assert-Rejected { Install-Fixture } 'exactly one ffmpeg.exe'
$script:metadata.url = 'https://example.com/ffmpeg.zip'
Save-Metadata
Assert-Rejected { Install-Fixture } 'Invalid FFmpeg download metadata'
Write-Host 'Media tools checks passed: publisher origin, cache, archive and binary hashes, exact extraction, duplicates.'
