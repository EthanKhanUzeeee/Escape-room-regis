@echo off
cd /d "%~dp0"
title Escape Room Booking (online)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-online.ps1"
pause
