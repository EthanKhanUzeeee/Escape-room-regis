@echo off
cd /d "%~dp0"
title Escape Room Booking
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Install it from https://nodejs.org and run this file again.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Installing the app's libraries. This only happens once...
  call npm install --no-audit --no-fund
)
if "%PORT%"=="" set PORT=3000
start "" cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:%PORT%/staff"
node server.js
pause
