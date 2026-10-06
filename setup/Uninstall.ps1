[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$appRoot = [IO.Path]::GetFullPath((Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'senzdev\visave'))
$registryPath = 'HKCU:\Software\Mozilla\NativeMessagingHosts\com.videolens.downloader'
if (Test-Path -LiteralPath $registryPath) {
    $registered = [IO.Path]::GetFullPath((Get-Item -LiteralPath $registryPath).GetValue(''))
    if (-not $registered.StartsWith($appRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'The current connection belongs to another installation. It has been preserved.' }
    Remove-Item -LiteralPath $registryPath
}
if (Test-Path -LiteralPath $appRoot) {
    $expected = [IO.Path]::GetFullPath((Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'senzdev\visave'))
    if ($appRoot -ne $expected -or (Get-Item -LiteralPath $appRoot).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Unexpected install path. Removal refused.' }
    # Reject junctions anywhere in the application tree before recursive deletion.
    foreach ($item in Get-ChildItem -LiteralPath $appRoot -Recurse -Force) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Application folder contains a link. Automatic removal refused.' }
        if (-not $item.FullName.StartsWith($appRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected application path.' }
    }
    Remove-Item -LiteralPath $appRoot -Recurse -Force
}
Write-Host 'visave companion removed. Saved videos and audio were preserved. Remove the Firefox extension separately.'
