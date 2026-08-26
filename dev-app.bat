@echo off
REM ---------------------------------------------------------------------------
REM Creatio Case Lookup - DEVELOPER launcher (auto-reload).
REM
REM Same app as start-app.bat, but it watches the source: save a file in src\
REM and the server rebuilds and restarts itself in a second or two. Files in
REM public\ (app.js, styles.css, index.html) need no restart at all - just
REM refresh the browser.
REM
REM Two windows open: "tsc watch" (the compiler - watch it for type errors)
REM and this one (the server log). Close this window to stop the app.
REM
REM NOTE: a restart kills any AI run in progress and clears staged work
REM tickets, so don't save a src\ file while a triage or work run is going.
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

REM The server auto-restarts on every rebuild - without this it would pop open
REM a new browser tab each time.
set CREATIO_APP_NO_OPEN=1

echo Building once before starting...
call npx tsc
if errorlevel 1 (
  echo.
  echo Build failed - fix the errors above and run this again.
  pause
  exit /b 1
)

REM Compiler in its own window. Deliberately NOT minimized: if a compile fails,
REM dist\ keeps the last good build and the server silently runs old code, so
REM those errors need to stay visible.
start "tsc watch" cmd /c npm run watch

REM Open the app once, after the server has had a moment to bind the port.
start "" /min cmd /c "timeout /t 4 >nul && start "" http://127.0.0.1:3000"

echo.
echo Watching src\ - save a file and the server restarts itself.
echo Close this window to stop the app (then close the "tsc watch" window).
echo.
call npm run app:watch

pause
