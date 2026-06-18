param()

$ErrorActionPreference = "Stop"

function Stop-Deploy {
    param([string]$Message)
    Write-Error $Message
    exit 1
}

Write-Host "ClawDrop Windows deployment check"

$node = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $node) {
    Stop-Deploy "Node.js was not found. Install Node.js 20 or newer, then reopen PowerShell."
}

$versionText = (& node.exe --version).TrimStart('v')
$majorVersion = 0
if (-not [int]::TryParse(($versionText -split '\.')[0], [ref]$majorVersion) -or $majorVersion -lt 20) {
    Stop-Deploy "Node.js 20 or newer is required. Current version: $versionText"
}
Write-Host "Node.js: v$versionText"

if (-not (Test-Path -LiteralPath ".env" -PathType Leaf)) {
    Stop-Deploy ".env was not found. Copy .env.example to .env and replace both example tokens."
}

$settings = @{}
Get-Content -LiteralPath ".env" | ForEach-Object {
    $line = $_.Trim()
    if ($line -and -not $line.StartsWith('#') -and $line.Contains('=')) {
        $parts = $line.Split('=', 2)
        $settings[$parts[0].Trim()] = $parts[1].Trim().Trim('"').Trim("'")
    }
}

$uploadToken = $settings['UPLOAD_TOKEN']
$adminToken = $settings['ADMIN_TOKEN']
if ([string]::IsNullOrWhiteSpace($uploadToken) -or $uploadToken -eq 'change-me-upload-token') {
    Stop-Deploy "UPLOAD_TOKEN is missing or still uses the example value."
}
if ([string]::IsNullOrWhiteSpace($adminToken) -or $adminToken -eq 'change-me-admin-token') {
    Stop-Deploy "ADMIN_TOKEN is missing or still uses the example value."
}
if ($uploadToken.Length -lt 32 -or $adminToken.Length -lt 32) {
    Stop-Deploy "UPLOAD_TOKEN and ADMIN_TOKEN must each contain at least 32 characters."
}
if ($uploadToken -eq $adminToken) {
    Stop-Deploy "UPLOAD_TOKEN and ADMIN_TOKEN must be different."
}
Write-Host "Environment file: token configuration looks valid"

Write-Host "Installing dependencies..."
& npm.cmd install
if ($LASTEXITCODE -ne 0) { Stop-Deploy "npm install failed." }

Write-Host "Checking JavaScript syntax..."
& npm.cmd run check
if ($LASTEXITCODE -ne 0) { Stop-Deploy "npm run check failed." }

Write-Host "Running tests..."
& npm.cmd test
if ($LASTEXITCODE -ne 0) { Stop-Deploy "npm test failed." }

Write-Host ""
Write-Host "Checks passed. Start ClawDrop with:"
Write-Host "  npm start"

$pm2 = Get-Command pm2.cmd -ErrorAction SilentlyContinue
if (-not $pm2) {
    $pm2 = Get-Command pm2 -ErrorAction SilentlyContinue
}
if ($pm2) {
    Write-Host ""
    Write-Host "PM2 is available. Optional process-manager commands:"
    Write-Host "  pm2 start server.js --name clawdrop"
    Write-Host "  pm2 save"
}

Write-Host "This script does not change Windows Firewall or expose a public port."
