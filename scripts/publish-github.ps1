param([string]$Owner='anish0083',[string]$Repository='FaucetBeacon')
$ErrorActionPreference='Stop'
if ($Owner -notmatch '^[-\w.]+$' -or $Repository -notmatch '^[-\w.]+$') { throw 'Invalid GitHub owner or repository name.' }
Set-Location (Split-Path -Parent $PSScriptRoot)
if (-not (Test-Path -LiteralPath '.git')) {
  git init -b main
  if ($LASTEXITCODE -ne 0) { throw 'Git initialization failed.' }
}
$branch = git symbolic-ref --short HEAD
if ($branch -ne 'main') { throw 'Expected main branch. No branch was renamed.' }
git check-ignore -q .env
if ($LASTEXITCODE -ne 0) { throw '.env is not ignored; publishing stopped.' }
git add .
if ($LASTEXITCODE -ne 0) { throw 'Git staging failed.' }
node scripts/check-repository-secrets.mjs
if ($LASTEXITCODE -ne 0) { throw 'Secret scan failed; publishing stopped.' }
git diff --cached --check
if ($LASTEXITCODE -ne 0) { throw 'Staged file check failed.' }
git diff --cached --quiet
if ($LASTEXITCODE -eq 1) {
  git commit -m 'Prepare FaucetBeacon for two-server Render deployment'
  if ($LASTEXITCODE -ne 0) { throw 'Git commit failed. Check git user.name and user.email.' }
}
Write-Output 'Sign in to GitHub using the device link/code if prompted. The repository will be PRIVATE.'
git credential-manager github login --username $Owner --device
if ($LASTEXITCODE -ne 0) { throw 'GitHub login failed.' }
$credentialRequest = "protocol=https`nhost=github.com`nusername=$Owner`n`n"
$credentials = $credentialRequest | git credential fill
if ($LASTEXITCODE -ne 0) { throw 'Could not use the GitHub credential.' }
try { $repoUrl = $credentials | node scripts/github-repository.mjs $Owner $Repository }
finally { $credentials = $null }
if ($LASTEXITCODE -ne 0 -or -not $repoUrl) { throw 'GitHub repository setup failed.' }
$repoUrl = $repoUrl.Trim()
$remotes = @(git remote)
if ($remotes -contains 'origin') {
  $existingRemote = git remote get-url origin
  if ($existingRemote -ne $repoUrl) { throw 'Origin points elsewhere; it was not changed.' }
} else {
  git remote add origin $repoUrl
  if ($LASTEXITCODE -ne 0) { throw 'Could not configure origin.' }
}
git push -u origin main
if ($LASTEXITCODE -ne 0) { throw 'Push failed. No force push was attempted.' }
Write-Output "Published private repository: https://github.com/$Owner/$Repository"
