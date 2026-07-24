@echo off
REM ---------------------------------------------------------------------------
REM Creatio Case Lookup - one-click launcher.
REM Builds if needed, starts the local web app, and opens it in your browser.
REM Requires Node.js installed (https://nodejs.org). No VS Code needed.
REM ---------------------------------------------------------------------------
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed or not on PATH.
  echo Install it from https://nodejs.org and run this again.
  pause
  exit /b 1
)

REM Install dependencies on first run.
if not exist "node_modules" (
  echo Installing dependencies, one moment...
  call npm install
)

echo Starting Creatio Case Lookup...
echo A browser window will open. Close this window to stop the app.
call npm run app

pause
