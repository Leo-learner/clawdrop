param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$FilePath
)

$ErrorActionPreference = "Stop"

$server = $env:CLAWDROP_SERVER
$token = $env:CLAWDROP_UPLOAD_TOKEN

if ([string]::IsNullOrWhiteSpace($server)) {
    Write-Error "CLAWDROP_SERVER is not set. Example: `$env:CLAWDROP_SERVER = 'http://127.0.0.1:3010'"
    exit 1
}

if ([string]::IsNullOrWhiteSpace($token)) {
    Write-Error "CLAWDROP_UPLOAD_TOKEN is not set. Configure it with the server's UPLOAD_TOKEN value."
    exit 1
}

if (-not (Test-Path -LiteralPath $FilePath -PathType Leaf)) {
    Write-Error "File not found: $FilePath"
    exit 1
}

$curl = Get-Command curl.exe -ErrorAction SilentlyContinue
if (-not $curl) {
    Write-Error "curl.exe was not found. Install a current Windows curl build and try again."
    exit 1
}

$fullPath = (Resolve-Path -LiteralPath $FilePath).Path
$uploadUrl = $server.TrimEnd('/') + "/api/upload"
$responseFile = [System.IO.Path]::GetTempFileName()

try {
    $statusCode = & curl.exe `
        --silent `
        --show-error `
        --output $responseFile `
        --write-out "%{http_code}" `
        --request POST `
        --header "Authorization: Bearer $token" `
        --form "file=@$fullPath" `
        $uploadUrl

    $curlExitCode = $LASTEXITCODE
    $responseText = Get-Content -LiteralPath $responseFile -Raw

    if ($curlExitCode -ne 0) {
        Write-Error "Upload failed because curl.exe exited with code $curlExitCode. Server response: $responseText"
        exit $curlExitCode
    }

    if ([int]$statusCode -lt 200 -or [int]$statusCode -ge 300) {
        Write-Error "Server returned HTTP $statusCode. Response: $responseText"
        exit 1
    }

    try {
        $result = $responseText | ConvertFrom-Json
    }
    catch {
        Write-Error "Server returned invalid JSON: $responseText"
        exit 1
    }

    $baseUrl = $server.TrimEnd('/')
    Write-Host "Uploaded: $($result.file.originalName)"
    Write-Host "File ID: $($result.file.id)"
    Write-Host "Size: $($result.file.size) bytes"
    Write-Host "Download: $baseUrl$($result.file.downloadUrl)"
    Write-Host "Preview: $baseUrl$($result.file.previewUrl)"
}
finally {
    Remove-Item -LiteralPath $responseFile -Force -ErrorAction SilentlyContinue
}
