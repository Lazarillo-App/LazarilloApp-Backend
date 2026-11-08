@echo off
rem Lazarillo - instalar en esta PC (sin Drive). Arranca en la consola clasica (conhost), que
rem respeta -WindowStyle Hidden (Windows Terminal no: quedaba una pantalla negra). Lo que se ve
rem es la ventanita de progreso del instalador. Sin bloques ( ): la carpeta puede llamarse "(1)".
set "LZC=%SystemRoot%\System32\conhost.exe"
if not exist "%LZC%" set "LZC="
start "" %LZC% powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0_motor\lz_instalar.ps1"
