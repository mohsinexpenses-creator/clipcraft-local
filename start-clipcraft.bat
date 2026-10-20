@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

rem Only build when app source files changed since the last successful build.
git rev-parse --is-inside-work-tree >nul 2>&1
if not errorlevel 1 (
  git diff --quiet -- app components lib public next.config.ts package.json tsconfig.json postcss.config.mjs eslint.config.mjs components.json
  if not errorlevel 1 if exist ".next\build-stamp.txt" (
    echo No source changes detected. Skipping build.
    goto start_app
  )
)

rem Fallback: if the repo is not a git checkout, only build when the source tree is newer than the saved stamp.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$root=(Get-Location).Path; $marker=Join-Path $root '.next\build-stamp.txt'; $watch=@('app','components','lib','public','next.config.ts','package.json','tsconfig.json','postcss.config.mjs','eslint.config.mjs','components.json'); $latest=$null; foreach ($p in $watch) { $full=Join-Path $root $p; if (-not (Test-Path $full)) { continue }; foreach ($item in Get-ChildItem -Path $full -Recurse -File -Force -ErrorAction SilentlyContinue) { $path=$item.FullName; if ($path -match '\\node_modules\\|\\.next\\|\\.git\\|\\uploads\\|\\generated-clips\\|\\data\\') { continue }; if ($null -eq $latest -or $item.LastWriteTimeUtc -gt $latest.LastWriteTimeUtc) { $latest=$item } } }; if (-not (Test-Path $marker)) { exit 1 }; if ($null -eq $latest) { exit 0 }; if ($latest.LastWriteTimeUtc -gt (Get-Item $marker).LastWriteTimeUtc) { exit 1 } else { exit 0 }"
if errorlevel 1 (
  echo Building ClipCraft production app...
  call npm run build
  if errorlevel 1 (
    echo Build failed. Exiting.
    exit /b 1
  )

  if not exist ".next" mkdir ".next"
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$root=(Get-Location).Path; $marker=Join-Path $root '.next\build-stamp.txt'; New-Item -ItemType Directory -Force -Path (Split-Path $marker) | Out-Null; (Get-Date).ToString('s') | Out-File -FilePath $marker -Encoding ascii"
) else (
  echo No source changes detected. Skipping build.
)

:start_app
start "ClipCraft Worker" cmd /k "npm run worker"
timeout /t 3 /nobreak >nul
start "ClipCraft Web" cmd /k "npm run start"
timeout /t 10 /nobreak >nul
start http://localhost:3000
