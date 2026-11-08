@echo off
title Lazarillo - generando, no cierres esta ventana
echo.
echo   Lazarillo - trabajando. Tarda unos 4 minutos.
echo   Cuando termine aparece el cartel y esta ventana se cierra sola.
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0_motor\lz_lazarillo.ps1"
