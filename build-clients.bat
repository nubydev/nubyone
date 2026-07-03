@echo off
setlocal
set ROOT=%~dp0
set CLIENT_DIR=%ROOT%Nubyone-Client
set OUT_DIR=%ROOT%dist-clients

REM ── Reputation-stable build ─────────────────────────────────────────────
REM
REM We deliberately do NOT bake the server URL into the binary. Embedding a
REM per-customer URL produces a unique SHA-256 per build, which permanently
REM prevents Chrome Safe Browsing and SmartScreen from accumulating download
REM reputation. The agent reads its server URL at runtime from
REM   - the NUBYONE_SERVER environment variable, or
REM   - a "server" field in config\settings.json next to the executable.
REM
REM This batch script therefore produces ONE identical binary per (os, arch)
REM that can be redistributed unchanged to every customer.

set "BASE_LDFLAGS=-s -w"
set "WIN_LDFLAGS=-s -w -H windowsgui"

REM Build tags to drop dead stdlib code from the binary:
REM   nethttpomithttp2 — drops the HTTP/2 implementation (the agent only
REM                      uses HTTP/1.1 over WebSocket).
REM   osusergo         — pure-Go user/group lookup (drops cgo nss code).
REM   netgo            — pure-Go DNS resolver (drops cgo netdb code).
REM Combined savings: ~300-400KB per binary.
set "BUILD_TAGS=nethttpomithttp2 osusergo netgo"

if not exist "%OUT_DIR%" mkdir "%OUT_DIR%"

pushd "%CLIENT_DIR%"
echo == Building agent for windows amd64 ==
set GOOS=windows
set GOARCH=amd64
set CGO_ENABLED=0
go build -buildvcs=false -trimpath -tags="%BUILD_TAGS%" -ldflags="%WIN_LDFLAGS%" -o "%OUT_DIR%\agent-windows-amd64.exe" ./cmd/agent
if errorlevel 1 goto :err

echo == Building agent for windows x86 ==
set GOOS=windows
set GOARCH=386
set CGO_ENABLED=0
go build -buildvcs=false -trimpath -tags="%BUILD_TAGS%" -ldflags="%WIN_LDFLAGS%" -o "%OUT_DIR%\agent-windows-386.exe" ./cmd/agent
if errorlevel 1 goto :err

echo == Building agent for windows arm64 ==
set GOOS=windows
set GOARCH=arm64
set CGO_ENABLED=0
go build -buildvcs=false -trimpath -tags="%BUILD_TAGS%" -ldflags="%WIN_LDFLAGS%" -o "%OUT_DIR%\agent-windows-arm64.exe" ./cmd/agent
if errorlevel 1 goto :err

echo == Building agent for linux amd64 ==
set GOOS=linux
set GOARCH=amd64
set CGO_ENABLED=0
go build -buildvcs=false -trimpath -tags="%BUILD_TAGS%" -ldflags="%BASE_LDFLAGS%" -o "%OUT_DIR%\agent-linux-amd64" ./cmd/agent
if errorlevel 1 goto :err

echo == Building agent for linux arm64 ==
set GOOS=linux
set GOARCH=arm64
set CGO_ENABLED=0
go build -buildvcs=false -trimpath -tags="%BUILD_TAGS%" -ldflags="%BASE_LDFLAGS%" -o "%OUT_DIR%\agent-linux-arm64" ./cmd/agent
if errorlevel 1 goto :err

echo == Building agent for linux arm (armv7) ==
set GOOS=linux
set GOARCH=arm
set GOARM=7
set CGO_ENABLED=0
go build -buildvcs=false -trimpath -tags="%BUILD_TAGS%" -ldflags="%BASE_LDFLAGS%" -o "%OUT_DIR%\agent-linux-armv7" ./cmd/agent
if errorlevel 1 goto :err

echo == Building agent for darwin arm64 ==
set GOOS=darwin
set GOARCH=arm64
set CGO_ENABLED=0
go build -buildvcs=false -trimpath -tags="%BUILD_TAGS%" -ldflags="%BASE_LDFLAGS%" -o "%OUT_DIR%\agent-darwin-arm64" ./cmd/agent
if errorlevel 1 goto :err

echo == Building agent for darwin amd64 ==
set GOOS=darwin
set GOARCH=amd64
set CGO_ENABLED=0
go build -buildvcs=false -trimpath -tags="%BUILD_TAGS%" -ldflags="%BASE_LDFLAGS%" -o "%OUT_DIR%\agent-darwin-amd64" ./cmd/agent
if errorlevel 1 goto :err

echo == Building agent for freebsd amd64 ==
set GOOS=freebsd
set GOARCH=amd64
set CGO_ENABLED=0
go build -buildvcs=false -trimpath -tags="%BUILD_TAGS%" -ldflags="%BASE_LDFLAGS%" -o "%OUT_DIR%\agent-freebsd-amd64" ./cmd/agent
if errorlevel 1 goto :err

echo == Building agent for freebsd arm64 ==
set GOOS=freebsd
set GOARCH=arm64
set CGO_ENABLED=0
go build -buildvcs=false -trimpath -tags="%BUILD_TAGS%" -ldflags="%BASE_LDFLAGS%" -o "%OUT_DIR%\agent-freebsd-arm64" ./cmd/agent
if errorlevel 1 goto :err

echo == Building agent for openbsd amd64 ==
set GOOS=openbsd
set GOARCH=amd64
set CGO_ENABLED=0
go build -buildvcs=false -trimpath -tags="%BUILD_TAGS%" -ldflags="%BASE_LDFLAGS%" -o "%OUT_DIR%\agent-openbsd-amd64" ./cmd/agent
if errorlevel 1 goto :err

echo == Building agent for openbsd arm64 ==
set GOOS=openbsd
set GOARCH=arm64
set CGO_ENABLED=0
go build -buildvcs=false -trimpath -tags="%BUILD_TAGS%" -ldflags="%BASE_LDFLAGS%" -o "%OUT_DIR%\agent-openbsd-arm64" ./cmd/agent
if errorlevel 1 goto :err

echo Builds complete. Outputs in %OUT_DIR%
goto :eof

:err
echo Build failed. See errors above.
exit /b 1

:eof
popd
endlocal
