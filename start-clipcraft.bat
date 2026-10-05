@echo off
cd /d "%~dp0"
start "ClipCraft Worker" cmd /k "npm run worker"
timeout /t 3 /nobreak >nul
start "ClipCraft Web" cmd /k "npm run dev"
timeout /t 10 /nobreak >nul
start http://localhost:3000
