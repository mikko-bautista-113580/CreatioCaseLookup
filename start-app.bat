@echo off
REM ---------------------------------------------------------------------------
REM Creatio Case Lookup - one-click launcher.
REM Finds Python 3.12+, sets up (or updates) the Python packages, creates .env
REM from .env.example if there isn't one, prints a setup check, then starts the
REM local web app and opens it in your browser.
REM ---------------------------------------------------------------------------
setlocal
cd /d "%~dp0"

REM Find Python 3.12+. "python" can be the Microsoft Store placeholder, so run
REM it rather than just finding it; fall back to the py launcher.
set "PY="
python -c "import sys; sys.exit(0 if sys.version_info >= (3, 12) else 1)" >nul 2>nul
if not errorlevel 1 set "PY=python"
if not defined PY (
  py -3 -c "import sys; sys.exit(0 if sys.version_info >= (3, 12) else 1)" >nul 2>nul
  if not errorlevel 1 set "PY=py -3"
)
if not defined PY (
  echo Python 3.12 or newer was not found.
  echo Install it from https://www.python.org ^(tick "Add python.exe to PATH"^) and run this again.
  pause
  exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
  echo Creating the Python environment, one moment...
  %PY% -m venv .venv
  if errorlevel 1 (
    echo Could not create the .venv folder.
    pause
    exit /b 1
  )
)

REM Install packages on first run, and again whenever pyproject.toml changes,
REM so updates that add a package reach everyone who already set up.
.venv\Scripts\python -m creatio_case_lookup.preflight --deps-stale
if errorlevel 1 (
  echo Installing Python packages...
  .venv\Scripts\python -m pip install --disable-pip-version-check -q -e ".[login]"
  if errorlevel 1 (
    echo Package install failed. Check your network connection and run this again.
    pause
    exit /b 1
  )
  .venv\Scripts\python -m creatio_case_lookup.preflight --deps-mark
)

if not exist ".env" (
  copy /y ".env.example" ".env" >nul
  echo Created .env from .env.example. Sign in from the Settings tab.
)

REM Setup check. Exit code 1 means something stops the app from starting.
.venv\Scripts\python -m creatio_case_lookup.preflight
if errorlevel 1 (
  pause
  exit /b 1
)

echo Starting Creatio Case Lookup...
echo A browser window will open. Close this window to stop the app.
.venv\Scripts\python -m creatio_case_lookup.server

pause
