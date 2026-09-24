<#
.SYNOPSIS
  Windows-only convenience wrapper: downloads a whisper.cpp CLI build + ggml model
  and writes WHISPER_CLI_PATH / WHISPER_MODEL_PATH into .env.local.

.DESCRIPTION
  Prefer `npm run setup:whisper` (scripts/setup-whisper.mjs) - it is cross-platform and
  shows download progress. This .ps1 exists for people who cannot/don't want to run the
  Node script, or who want to review exactly what happens in PowerShell.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\setup-whisper.ps1
  powershell -ExecutionPolicy Bypass -File scripts\setup-whisper.ps1 -Model base.en
  powershell -ExecutionPolicy Bypass -File scripts\setup-whisper.ps1 -Model large-v3-turbo -UseHfMirror
#>
[CmdletBinding()]
param(
  [string]$Model = 'small',
  [switch]$UseHfMirror,
  [switch]$SkipBinary,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
# GitHub release assets + huggingface.co both require TLS 1.2 on older PowerShell/.NET.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Root       = Split-Path -Parent $PSScriptRoot
$WhisperDir = Join-Path $Root '.whisper'
$ModelsDir  = Join-Path $Root 'models'
$EnvFile    = Join-Path $Root '.env.local'

New-Item -ItemType Directory -Force -Path $WhisperDir | Out-Null
New-Item -ItemType Directory -Force -Path $ModelsDir  | Out-Null

function Write-Step($msg) { Write-Host "[setup-whisper] $msg" -ForegroundColor Cyan }

function Set-EnvVar([string]$Key, [string]$Value) {
  $line = "$Key=$Value"
  if (Test-Path $EnvFile) {
    $lines = Get-Content -LiteralPath $EnvFile
    $found = $false
    for ($i = 0; $i -lt $lines.Count; $i++) {
      if ($lines[$i] -match "^\s*$Key\s*=") { $lines[$i] = $line; $found = $true }
    }
    if (-not $found) { $lines += $line }
    Set-Content -LiteralPath $EnvFile -Value $lines -Encoding UTF8
  } else {
    Set-Content -LiteralPath $EnvFile -Value $line -Encoding UTF8
  }
  Write-Step ".env.local -> $line"
}

# ---------------------------------------------------------------- binary
$BinaryPath = $null
if (-not $SkipBinary) {
  Write-Step 'Querying latest whisper.cpp release from GitHub...'
  $release = Invoke-RestMethod -Uri 'https://api.github.com/repos/ggml-org/whisper.cpp/releases/latest' `
             -Headers @{ 'User-Agent' = 'clipcraft-setup'; 'Accept' = 'application/vnd.github+json' }

  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
  $asset = $release.assets | Where-Object {
    $_.name -match 'windows' -and $_.name -match $arch -and $_.name -match '\.zip$'
  } | Select-Object -First 1

  if (-not $asset) {
    throw "No windows-$arch zip asset in release $($release.tag_name). See https://github.com/ggml-org/whisper.cpp/releases"
  }

  $zip = Join-Path $WhisperDir "whisper-$($release.tag_name)-windows-$arch.zip"
  $out = Join-Path $WhisperDir "whisper-$($release.tag_name)-windows-$arch"

  Write-Step "Downloading $($asset.name) (~$([math]::Round($asset.size / 1MB, 1)) MB)"
  Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $zip -UseBasicParsing

  Write-Step "Extracting to $out"
  if (Test-Path $out) { Remove-Item -Recurse -Force $out }
  Expand-Archive -LiteralPath $zip -DestinationPath $out -Force
  Remove-Item -Force $zip

  $BinaryPath = (Get-ChildItem -Path $out -Recurse -Filter 'whisper-cli.exe' | Select-Object -First 1).FullName
  if (-not $BinaryPath) { throw "whisper-cli.exe not found under $out" }
  Write-Step "Binary: $BinaryPath"
}

# ---------------------------------------------------------------- model
$Model = $Model -replace '^ggml-', '' -replace '\.bin$', ''
$ModelName = "ggml-$Model.bin"
$ModelPath = Join-Path $ModelsDir $ModelName

if ((Test-Path $ModelPath) -and -not $Force) {
  Write-Step "Model already present: $ModelPath (use -Force to re-download)"
} else {
  $base = if ($UseHfMirror) { 'https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main' }
          else { 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main' }
  Write-Step "Downloading $ModelName from huggingface (this can be several hundred MB)..."
  try {
    Invoke-WebRequest -Uri "$base/$ModelName" -OutFile $ModelPath -UseBasicParsing
  } catch {
    if (-not $UseHfMirror) {
      Write-Step 'huggingface.co failed, retrying via hf-mirror.com...'
      Invoke-WebRequest -Uri "https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/$ModelName" `
                        -OutFile $ModelPath -UseBasicParsing
    } else { throw }
  }
}

# ---------------------------------------------------------------- env
if ($BinaryPath) { Set-EnvVar 'WHISPER_CLI_PATH' $BinaryPath }
Set-EnvVar 'WHISPER_MODEL_PATH' $ModelPath

Write-Host ''
Write-Step 'Done. Now check http://localhost:3000/startup-validation'
Write-Host '  If Windows SmartScreen/antivirus blocks whisper-cli.exe, allow it once -' -ForegroundColor Yellow
Write-Host '  it also needs the VC++ 2015-2022 x64 redistributable (msvcp140.dll).' -ForegroundColor Yellow
