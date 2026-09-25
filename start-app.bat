@echo off
REM ---------------------------------------------------------------------------
REM Creatio Case Lookup - one-click launcher.
REM Sets up Python dependencies if needed, starts the local web app, and opens
REM it in your browser. Requires Python 3.12+ (https://www.python.org).
REM ---------------------------------------------------------------------------
setlocal
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
  echo Python is not installed or not on PATH.
  echo Install Python 3.12+ from https://www.python.org and run this again.
  pause
  exit /b 1
)

REM Create the virtual environment and install dependencies on first run.
if not exist ".venv\Scripts\python.exe" (
  echo Setting up Python environment, one moment...
  python -m venv .venv
  call .venv\Scripts\python -m pip install -e ".[login]"
)

echo Starting Creatio Case Lookup...
echo A browser window will open. Close this window to stop the app.
call .venv\Scripts\python -m creatio_case_lookup.server

pause
