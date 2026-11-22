[CmdletBinding()]
param([string]$OutputDirectory = (Join-Path $PSScriptRoot 'dist'))

$ErrorActionPreference = 'Stop'
$compiler = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) {
    throw 'The Windows .NET Framework 4.x x64 compiler is required.'
}
New-Item -Path $OutputDirectory -ItemType Directory -Force | Out-Null
$destination = (Resolve-Path -LiteralPath $OutputDirectory).Path
$exe = Join-Path $destination 'Pixiu-ARB-SSH.exe'
$compile = @('/nologo', '/codepage:65001', '/target:winexe', '/platform:anycpu', '/optimize+',
    '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll',
    '/reference:System.Xml.Linq.dll', '/reference:System.Xml.dll', "/out:$exe",
    (Join-Path $PSScriptRoot 'ConnectionProfile.cs'), (Join-Path $PSScriptRoot 'PixiuSshClient.cs'))
& $compiler @compile
if ($LASTEXITCODE -ne 0) { throw 'Compilation failed.' }
$test = Start-Process -FilePath $exe -ArgumentList '--self-test' -PassThru -Wait -WindowStyle Hidden
if ($test.ExitCode -ne 0) { throw "Connector self-test failed ($($test.ExitCode))." }

$digest = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant()
Set-Content -LiteralPath (Join-Path $destination 'SHA256SUMS') -Value "$digest  Pixiu-ARB-SSH.exe" -Encoding ASCII
Get-Item -LiteralPath $exe
