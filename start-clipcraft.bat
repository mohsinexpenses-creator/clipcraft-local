@echo off
cd /d "%~dp0"
start "Docker Desktop" "C:\Program Files\Docker\Docker\Docker Desktop.exe"
timeout /t 20 /nobreak >nul
call npm run db:up
start "ClipCraft Worker" cmd /k "npm run worker"
timeout /t 5 /nobreak >nul
start "ClipCraft Web" cmd /k "npm run dev"
timeout /t 10 /nobreak >nul
start http://localhost:3000