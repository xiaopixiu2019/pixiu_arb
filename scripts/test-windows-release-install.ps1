param([Parameter(Mandatory = $true)][string]$ArchivePath)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$RepositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$Node = (Get-Command node -ErrorAction Stop).Source
& $Node (Join-Path $RepositoryRoot 'scripts\test-desktop-release.mjs') ([IO.Path]::GetFullPath($ArchivePath))
if ($LASTEXITCODE -ne 0) { throw 'Native desktop installation acceptance failed.' }
