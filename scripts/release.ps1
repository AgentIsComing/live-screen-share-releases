param(
  [ValidateSet('patch', 'minor', 'major', 'none')]
  [string]$Bump = 'patch',
  [string]$Owner = 'AgentIsComing',
  [string]$Repo = 'live-screen-share-releases',
  [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

if (-not (Test-Path "./package.json")) {
  throw "package.json not found in $projectRoot"
}

if (-not $env:GH_TOKEN) {
  throw 'GH_TOKEN is not set. Set it first: $env:GH_TOKEN="your_token"'
}

$env:RELEASE_OWNER = $Owner
$env:RELEASE_REPO = $Repo
$env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
$env:ELECTRON_RUN_AS_NODE = ''

if (-not $SkipInstall) {
  Write-Host "Installing dependencies..." -ForegroundColor Cyan
  npm install
  if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE" }
}

if ($Bump -ne 'none') {
  Write-Host "Bumping version ($Bump)..." -ForegroundColor Cyan
  npm version $Bump --no-git-tag-version
  if ($LASTEXITCODE -ne 0) { throw "npm version failed with exit code $LASTEXITCODE" }
}

Write-Host "Publishing update to $Owner/$Repo..." -ForegroundColor Cyan
npm run release:public
if ($LASTEXITCODE -ne 0) { throw "Release publish failed with exit code $LASTEXITCODE" }

$pkg = Get-Content "./package.json" -Raw | ConvertFrom-Json
Write-Host "Published version $($pkg.version) to $Owner/$Repo" -ForegroundColor Green
Write-Host "Release URL: https://github.com/$Owner/$Repo/releases/tag/v$($pkg.version)" -ForegroundColor Yellow