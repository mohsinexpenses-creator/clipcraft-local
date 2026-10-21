@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

rem Compare source changes with the last successful build.
powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\build-check.ps1" -Mode check
if errorlevel 1 goto build_app
echo No source changes detected. Skipping build.
goto start_app

:build_app
echo Building ClipCraft production app...
call npm run build
if errorlevel 1 (
  echo Build failed. Exiting.
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\build-check.ps1" -Mode stamp
if errorlevel 1 (
  echo Failed to save build stamp. Exiting.
  exit /b 1
)

:start_app
start "ClipCraft Worker" cmd /k "npm run worker"
start "ClipCraft Web" cmd /k "npm run start"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ready=$false; for ($i=0; $i -lt 120; $i++) { $client=[System.Net.Sockets.TcpClient]::new(); try { $client.Connect('localhost',3000); $ready=$client.Connected; if ($ready) { break } } catch {} finally { $client.Dispose() }; Start-Sleep -Milliseconds 250 }; if ($ready) { Start-Process 'http://localhost:3000'; exit 0 } else { Write-Host 'ClipCraft Web did not become ready on port 3000 within 30 seconds.'; exit 1 }"
if errorlevel 1 exit /b 1
