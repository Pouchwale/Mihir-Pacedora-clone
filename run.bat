@echo off
setlocal
cd /d "%~dp0"

rem Usage:
rem   run.bat        fast production mode (builds only when the code changed)
rem   run.bat build  force a fresh production build
rem   run.bat dev    development mode with hot reload (slower page loads)

echo === Pacdora Clone: starting ===

rem Stop an old server on port 3000 (it also locks Prisma's engine DLL)
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:":3000 .*LISTENING"') do (
  echo Stopping old server on port 3000 [PID %%p]
  taskkill /PID %%p /F >nul 2>&1
)
ping -n 3 127.0.0.1 >nul

rem Install dependencies if missing or installed on another OS (no Windows shim)
if not exist "node_modules\.bin\next.cmd" (
  echo [1/4] Installing dependencies...
  call npm install || goto :fail
) else (
  echo [1/4] Dependencies OK
)

rem Database: frontend\.env DATABASE_URL decides.
rem  - postgresql://... (e.g. the Render database EXTERNAL URL): use PostgreSQL, apply migrations and seed
rem  - file:../dev.db: local SQLite copy for offline development
pushd frontend
findstr /r /c:"^DATABASE_URL=.*postgres" .env >nul 2>&1
if not errorlevel 1 (
  echo [2/4] Using PostgreSQL database from frontend\.env - applying migrations...
  call npx prisma generate >nul || (popd & goto :fail)
  call npx prisma migrate deploy || (popd & goto :fail)
  call node scripts\seed.js || (popd & goto :fail)
) else (
  echo [2/4] Preparing local SQLite database and Prisma client...
  call node scripts\make-sqlite-schema.js >nul || (popd & goto :fail)
  call npx prisma db push --schema prisma\schema.sqlite.prisma --skip-generate >nul || (popd & goto :fail)
  call npx prisma generate --schema prisma\schema.sqlite.prisma >nul || (popd & goto :fail)
)
popd

if /i "%~1"=="dev" goto :dev

rem Rebuild when forced, when there is no build yet, or when any source file is newer than it
set NEED_BUILD=0
if /i "%~1"=="build" set NEED_BUILD=1
if not exist "frontend\.next\BUILD_ID" set NEED_BUILD=1
if "%NEED_BUILD%"=="0" (
  powershell -NoProfile -Command "$b=(Get-Item 'frontend/.next/BUILD_ID').LastWriteTime; $dirs='app','components','lib','store','prisma' | ForEach-Object { 'frontend/' + $_ }; $newer=Get-ChildItem $dirs -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -gt $b } | Select-Object -First 1; $cfg=Get-ChildItem 'frontend/middleware.ts','frontend/next.config.mjs','frontend/tailwind.config.js','package.json' -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -gt $b } | Select-Object -First 1; if ($newer -or $cfg) { exit 1 } else { exit 0 }"
  if errorlevel 1 set NEED_BUILD=1
)

if "%NEED_BUILD%"=="1" (
  echo [3/4] Building optimized production version - takes 1-2 minutes...
  call npx next build frontend
  if errorlevel 1 goto :fail
) else (
  echo [3/4] Build is up to date
)

echo [4/4] Starting server at http://localhost:3000
if not defined NO_BROWSER start "" http://localhost:3000
call npx next start frontend -p 3000
goto :eof

:dev
echo [3/3] Starting DEV server at http://localhost:3000 (pages compile on first visit)
if not defined NO_BROWSER start "" http://localhost:3000
call npm run dev
goto :eof

:fail
echo.
echo Startup failed. See the errors above.
pause
exit /b 1
