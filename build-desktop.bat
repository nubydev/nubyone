@echo off
echo === Building Nubyone Desktop ===
cd /d "%~dp0Nubyone-Desktop"
call npm install
call npm run build:win
echo === Done ===
pause
