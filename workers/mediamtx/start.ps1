# Starts MediaMTX with the HLS secret Core uses (MIYORIA_HLS_SECRET in the repo's .env).
# Run from anywhere: & workers\mediamtx\start.ps1
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$envFile = Join-Path $here '..\..\.env'
$line = Select-String -Path $envFile -Pattern '^MIYORIA_HLS_SECRET=(.+)$' | Select-Object -First 1
if (-not $line) { throw "MIYORIA_HLS_SECRET is not in .env; Core and MediaMTX need the same value" }
$env:MTX_HLSCDNSECRET = $line.Matches[0].Groups[1].Value.Trim()
$exe = Join-Path $here 'mediamtx.exe'
if (-not (Test-Path $exe)) { throw "mediamtx.exe is missing; see workers\mediamtx\README.md" }
Set-Location $here
& $exe (Join-Path $here 'mediamtx.yml')
