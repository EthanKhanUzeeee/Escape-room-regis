@echo off
cd /d "%~dp0"
title Escape Room Registration
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install it from https://nodejs.org and run this file again.
  pause
  exit /b 1
)
if "%PORT%"=="" set PORT=3000
start "" cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:%PORT%/admin"
node server.js
pause
