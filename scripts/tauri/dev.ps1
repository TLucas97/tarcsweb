$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '../..')
& node scripts/tauri/dev.mjs @args
exit $LASTEXITCODE
