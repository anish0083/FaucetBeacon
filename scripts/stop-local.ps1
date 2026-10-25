# Stop only the locally recorded FaucetBeacon process; preserve database settings.
$ErrorActionPreference = 'Stop'
$projectDirectory = Split-Path -Parent $PSScriptRoot
$statePath = Join-Path $projectDirectory '.data\faucet-process.json'
if (-not (Test-Path -LiteralPath $statePath)) {
  Write-Output 'No recorded bot process. Close any npm start/dev terminal before Render deployment.'
  exit 0
}
$state = Get-Content -LiteralPath $statePath | ConvertFrom-Json
$botProcess = Get-Process -Id $state.pid -ErrorAction SilentlyContinue
if (-not $botProcess) { Write-Output 'Recorded local bot is already stopped.'; exit 0 }
if ($botProcess.StartTime.ToUniversalTime().Ticks -ne ([datetime]$state.startedAt).ToUniversalTime().Ticks) {
  throw 'The recorded PID now belongs to another process; nothing was stopped.'
}
if ($botProcess.ProcessName -ne 'node') { throw 'The recorded process is not Node.js; nothing was stopped.' }
Stop-Process -Id $botProcess.Id
Write-Output 'Local FaucetBeacon stopped. Render may wait up to 3 minutes for the old worker lease to expire.'
