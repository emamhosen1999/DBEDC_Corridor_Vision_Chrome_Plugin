@echo off
REM Run Corridor Vision in the foreground. Useful for a first run and for
REM troubleshooting; use install-task.ps1 for unattended 24/7 operation.
setlocal
cd /d "%~dp0.."
if "%CORRIDOR_HOME%"=="" set CORRIDOR_HOME=%CD%
echo Corridor Vision  -  data in %CORRIDOR_HOME%
node src\cli.mjs run
if errorlevel 1 (
  echo.
  echo Corridor Vision exited with an error. Run "node src\cli.mjs doctor" to diagnose.
  pause
)
