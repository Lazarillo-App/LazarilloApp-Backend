@echo off
cd /d "%~dp0"
start "" powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0_motor\lz_instalar.ps1"
exit /b
