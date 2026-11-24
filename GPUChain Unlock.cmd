@echo off
setlocal
cd /d "%~dp0"
node scripts\participant.mjs unlock
echo.
pause
