@echo off
setlocal
set "ROOT=%~dp0"

if exist "%ROOT%runtime\node-v22.23.2-win-x64\node.exe" (
  set "PATH=%ROOT%runtime\node-v22.23.2-win-x64;%PATH%"
)

where node >nul 2>nul || (
  echo [ERROR] Node.js not found.
  exit /b 1
)

cd /d "%ROOT%"
node scripts\verify-fast-tools.mjs
if errorlevel 1 (
  echo.
  echo Fast Tools verification failed.
  echo Run install.bat or: node scripts\apply-fast-tools.mjs
  pause
  exit /b 1
)

cd /d "%ROOT%app"
call node_modules\.bin\devspace.cmd serve
endlocal