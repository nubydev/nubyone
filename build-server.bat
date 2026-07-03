@echo off
title Nubyone Server
color 0A

echo ========================================
echo   Nubyone Remote Support Server
echo ========================================
echo.

where bun >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [INFO] Bun is not installed. Attempting to install via PowerShell...
    echo.
    powershell -NoProfile -ExecutionPolicy Bypass -Command "irm bun.sh/install.ps1 | iex"
    if %ERRORLEVEL% neq 0 (
        echo [ERROR] Could not install Bun automatically.
        echo.
        echo Please install Bun manually:
        echo   https://bun.sh/docs/installation
        echo   or run: powershell -c "irm bun.sh/install.ps1 | iex"
        echo.
        pause
        exit /b 1
    )
    set "PATH=%USERPROFILE%\.bun\bin;%PATH%"
    where bun >nul 2>&1
    if %ERRORLEVEL% neq 0 (
        echo [ERROR] Bun installed but not found in PATH. Please restart this window.
        pause
        exit /b 1
    )
    echo [INFO] Bun installed successfully.
    echo.
)

where go >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [INFO] Go is not installed. Attempting to install via winget...
    echo.
    winget install --id GoLang.Go --silent --accept-package-agreements --accept-source-agreements >nul 2>&1
    if %ERRORLEVEL% neq 0 (
        echo [WARN] winget install failed. Trying to locate Go in common paths...
    )
    if exist "C:\Program Files\Go\bin\go.exe" (
        set "PATH=C:\Program Files\Go\bin;%PATH%"
    ) else if exist "C:\Go\bin\go.exe" (
        set "PATH=C:\Go\bin;%PATH%"
    )
    where go >nul 2>&1
    if %ERRORLEVEL% neq 0 (
        echo [ERROR] Go is not installed and could not be installed automatically.
        echo.
        echo Please install Go manually, then re-run this script:
        echo   https://go.dev/dl/
        echo.
        pause
        exit /b 1
    )
    echo [INFO] Go found and added to PATH.
    echo.
)

if not defined GOCACHE (
    if defined LOCALAPPDATA (
        set "GOCACHE=%LOCALAPPDATA%\go-build"
    ) else (
        set "GOCACHE=%USERPROFILE%\AppData\Local\go-build"
    )
)
if not defined GOPATH (
    set "GOPATH=%USERPROFILE%\go"
)

echo [INFO] Go: %GOPATH%
echo [INFO] Go cache: %GOCACHE%
echo.

cd /d "%~dp0Nubyone-Server"

if not exist "node_modules" (
    echo [INFO] Installing dependencies...
    bun install
    if %ERRORLEVEL% neq 0 (
        echo [ERROR] Dependency install failed.
        pause
        exit /b 1
    )
    echo.
)

echo [INFO] Building CSS...
call bun run build:css
echo.

echo [INFO] Starting server on http://localhost:5000
echo [INFO] Default login: admin / admin
echo [INFO] Press Ctrl+C to stop.
echo.

set PORT=5000
set HOST=0.0.0.0
bun run src/index.ts

pause
