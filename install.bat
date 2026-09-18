@echo off
setlocal
set "ROOT=%~dp0"

where node >nul 2>nul || (
  echo [ERROR] Node.js not found. Install Node.js 22.19 - 26 first.
  exit /b 1
)
where npm >nul 2>nul || (
  echo [ERROR] npm not found.
  exit /b 1
)
where git >nul 2>nul || echo [WARN] Git not found. Git Fast Tools will not work.
where rg >nul 2>nul || echo [WARN] ripgrep not found. Search Fast Tools will not work.

cd /d "%ROOT%app"
call npm install
if errorlevel 1 exit /b 1

cd /d "%ROOT%"
node scripts\apply-fast-tools.mjs
if errorlevel 1 exit /b 1
node scripts\verify-fast-tools.mjs
if errorlevel 1 exit /b 1

echo.
echo Installation completed.
echo Configure DevSpace OAuth / allowedRoots, then run start-devspace.bat.
endlocal