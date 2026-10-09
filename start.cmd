@echo off
cd /d "%~dp0"

rem Keep this file pure ASCII. cmd parses a batch file using the OEM code page,
rem and UTF-8 Chinese in here made it skip whole lines. Every Chinese message
rem lives in tools/launch.mjs, where UTF-8 is handled properly.
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js not found.
  echo   Install Node 20.11 or newer from https://nodejs.org/ then run this again.
  echo.
  pause
  exit /b 1
)

node "tools\launch.mjs"

echo.
pause
