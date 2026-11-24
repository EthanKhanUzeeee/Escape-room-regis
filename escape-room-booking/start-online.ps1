# Starts the escape room app and puts it online with Tailscale Funnel (free, fixed https link).
# Run it through start-online.bat. Keep the window open while the event is running.
$ErrorActionPreference = 'Continue'
Set-Location $PSScriptRoot
$port = if ($env:PORT) { $env:PORT } else { '3000' }

function Stop-WithMessage($text) {
  Write-Host ""
  Write-Host $text -ForegroundColor Red
  exit 1
}

function Find-Tailscale {
  $cmd = Get-Command tailscale -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  foreach ($p in @("$env:ProgramFiles\Tailscale\tailscale.exe", "${env:ProgramFiles(x86)}\Tailscale\tailscale.exe")) {
    if (Test-Path $p) { return $p }
  }
  return $null
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Stop-WithMessage 'Node.js is not installed. Install it from https://nodejs.org and run this again.' }
if (-not (Test-Path node_modules)) {
  Write-Host "Installing the app's libraries (first time only)..."
  npm install --no-audit --no-fund
  if ($LASTEXITCODE) { Stop-WithMessage 'Installing the libraries failed. Check your internet connection and run this again.' }
}

$ts = Find-Tailscale
if (-not $ts) { Stop-WithMessage 'Tailscale is not installed. Install it from https://tailscale.com/download, sign in, then run this again.' }

$status = $null
try { $status = ((& $ts status --json) -join "`n") | ConvertFrom-Json } catch { $status = $null }
if (-not $status -or $status.BackendState -ne 'Running') {
  Stop-WithMessage 'Tailscale is not signed in. Open Tailscale from the taskbar (near the clock), sign in, then run this again.'
}
$dns = "$($status.Self.DNSName)".TrimEnd('.')
if (-not $dns) { Stop-WithMessage "Couldn't read this computer's Tailscale name. Open Tailscale, make sure it says Connected, and run this again." }
$public = "https://$dns"

Write-Host "Turning on Tailscale Funnel for port $port..."
Write-Host "(The first time, Tailscale may print a link to allow Funnel for your account. Open it, allow it, and this continues.)"
& $ts funnel --bg $port
if ($LASTEXITCODE) { Stop-WithMessage 'Funnel could not start. If Tailscale printed a link above, open it to allow Funnel, then run this again.' }

$env:PUBLIC_URL = $public
$env:PORT = $port
$env:HOST = '127.0.0.1'   # only Tailscale reaches the app; nothing else on the network can

Write-Host ""
Write-Host "  Public booking link: $public" -ForegroundColor Green
Write-Host "  Door scanner:        $public/staff/scan" -ForegroundColor Green
Write-Host ""
Write-Host "Keep this window open: closing it takes the site offline."
Write-Host "Also make sure this laptop doesn't sleep while plugged in (Settings > System > Power)."

while ($true) {
  node server.js
  Write-Host "The app stopped (exit code $LASTEXITCODE). Restarting in 5 seconds. Close this window to stop it." -ForegroundColor Yellow
  Start-Sleep -Seconds 5
}
