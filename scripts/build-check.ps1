param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('check', 'stamp')]
  [string]$Mode
)

$root = Split-Path -Parent $PSScriptRoot
$marker = Join-Path $root '.next\build-stamp.txt'
$watch = @('app', 'components', 'lib', 'public', 'next.config.ts', 'package.json', 'tsconfig.json', 'postcss.config.mjs', 'eslint.config.mjs', 'components.json')

function Get-SourceFingerprint {
  $tracked = @(& git diff --name-only HEAD -- $watch)
  if ($LASTEXITCODE -ne 0) { throw 'Unable to inspect tracked source changes.' }
  $untracked = @(& git ls-files --others --exclude-standard -- $watch)
  if ($LASTEXITCODE -ne 0) { throw 'Unable to inspect untracked source files.' }

  $entries = foreach ($path in @($tracked + $untracked | Sort-Object -Unique)) {
    $fullPath = Join-Path $root $path
    if (Test-Path -LiteralPath $fullPath -PathType Leaf) {
      $hash = (Get-FileHash -LiteralPath $fullPath -Algorithm SHA256).Hash
    } else {
      $hash = 'DELETED'
    }
    "$path`0$hash"
  }

  $input = [System.Text.Encoding]::UTF8.GetBytes(($entries -join "`n"))
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($sha.ComputeHash($input)).Replace('-', '') }
  finally { $sha.Dispose() }
}

Push-Location $root
try {
  & git rev-parse --is-inside-work-tree *> $null
  $isGit = $LASTEXITCODE -eq 0

  if ($Mode -eq 'stamp') {
    New-Item -ItemType Directory -Force -Path (Split-Path $marker) | Out-Null
    if ($isGit) {
      Get-SourceFingerprint | Set-Content -LiteralPath $marker -Encoding ascii
    } else {
      (Get-Date).ToString('s') | Set-Content -LiteralPath $marker -Encoding ascii
    }
    exit 0
  }

  if (-not (Test-Path -LiteralPath $marker)) { exit 1 }

  if ($isGit) {
    $current = Get-SourceFingerprint
    $built = (Get-Content -LiteralPath $marker -Raw).Trim()
    if ($current -eq $built) { exit 0 }
    exit 1
  }

  $latest = $null
  foreach ($path in $watch) {
    $fullPath = Join-Path $root $path
    if (-not (Test-Path -LiteralPath $fullPath)) { continue }
    foreach ($item in Get-ChildItem -LiteralPath $fullPath -Recurse -File -Force -ErrorAction SilentlyContinue) {
      if ($item.FullName -match '\\node_modules\\|\.next\\|\.git\\|\\uploads\\|\\generated-clips\\|\\data\\') { continue }
      if ($null -eq $latest -or $item.LastWriteTimeUtc -gt $latest.LastWriteTimeUtc) { $latest = $item }
    }
  }

  if ($null -eq $latest -or $latest.LastWriteTimeUtc -le (Get-Item -LiteralPath $marker).LastWriteTimeUtc) { exit 0 }
  exit 1
} finally {
  Pop-Location
}
