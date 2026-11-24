@echo off
node "%~dp0scripts\open-wallet.mjs"
if errorlevel 1 (
  pause
  exit /b 1
)
