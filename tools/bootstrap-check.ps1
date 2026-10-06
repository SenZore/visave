$ErrorActionPreference = 'Stop'
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'install.ps1')
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ('visave-bootstrap-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixtureRoot | Out-Null
$script:fixtureZip = Join-Path $fixtureRoot 'fixture.zip'
$script:fixtureChecksum = Join-Path $fixtureRoot 'fixture.sha256'

function New-Fixture {
    param([string[]]$Names = @('Install.ps1', 'MediaTools.ps1', 'SHA256SUMS.json', 'START-HERE.html', 'app/runtime/python.exe', 'app/FFMPEG-DOWNLOAD.json'))
    $zip = [IO.Compression.ZipFile]::Open($script:fixtureZip, [IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($name in $Names) {
            $entry = $zip.CreateEntry($name)
            $writer = [IO.StreamWriter]::new($entry.Open())
            try { $writer.Write('fixture, never executed') } finally { $writer.Dispose() }
        }
    } finally { $zip.Dispose() }
    $digest = (Get-FileHash -LiteralPath $script:fixtureZip -Algorithm SHA256).Hash
    [IO.File]::WriteAllText($script:fixtureChecksum, $digest + '  visave-windows-0.3.3.zip')
}

function Invoke-WebRequest {
    param($Uri, $OutFile, [switch]$UseBasicParsing, $ErrorAction, $TimeoutSec)
    if ($Uri -notlike 'https://github.com/senzore/visave/releases/download/v0.3.3/*') { throw 'Unexpected download origin' }
    $source = if ($Uri.EndsWith('.sha256')) { $script:fixtureChecksum } else { $script:fixtureZip }
    Copy-Item -LiteralPath $source -Destination $OutFile
}

function Assert-Rejected {
    param([scriptblock]$Action, [string]$Expected)
    try { & $Action | Out-Null } catch {
        if ($_.Exception.Message.Contains($Expected)) { return }
        throw
    }
    throw ('Expected rejection: ' + $Expected)
}

New-Fixture
$bundle = Get-VisaveBundle -ReleaseVersion '0.3.3' -WorkRoot (Join-Path $fixtureRoot 'valid')
if (-not (Test-Path (Join-Path $bundle 'Install.ps1'))) { throw 'Verified bundle was not extracted' }
[IO.File]::WriteAllText($script:fixtureChecksum, ('0' * 64) + '  visave-windows-0.3.3.zip')
Assert-Rejected { Get-VisaveBundle -ReleaseVersion '0.3.3' -WorkRoot (Join-Path $fixtureRoot 'changed') } 'does not match'
[IO.File]::WriteAllText($script:fixtureChecksum, ('0' * 64) + '  unrelated.zip')
Assert-Rejected { Get-VisaveBundle -ReleaseVersion '0.3.3' -WorkRoot (Join-Path $fixtureRoot 'wrong-asset') } 'does not identify'
Assert-Rejected { Get-VisaveBundle -ReleaseVersion '../outside' -WorkRoot (Join-Path $fixtureRoot 'bad-version') } 'does not match'
$script:fixtureZip = Join-Path $fixtureRoot 'traversal.zip'
New-Fixture -Names @('../outside.txt')
Assert-Rejected { Get-VisaveBundle -ReleaseVersion '0.3.3' -WorkRoot (Join-Path $fixtureRoot 'traversal') } 'outside its folder'
if (Test-Path (Join-Path $fixtureRoot 'traversal/outside.txt')) { throw 'Unsafe archive wrote outside its folder' }
$script:fixtureZip = Join-Path $fixtureRoot 'incomplete.zip'
New-Fixture -Names @('START-HERE.html')
Assert-Rejected { Get-VisaveBundle -ReleaseVersion '0.3.3' -WorkRoot (Join-Path $fixtureRoot 'incomplete') } 'incomplete'
Write-Host 'PASS bootstrap: verified release extraction, bad checksum, wrong asset, invalid version, unsafe ZIP paths, incomplete bundle. No network calls or setup processes ran.'
Write-Host ('Test fixtures: ' + $fixtureRoot)
