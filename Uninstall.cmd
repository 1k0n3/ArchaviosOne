@echo off
rem MTGA Stats - Deinstallation (Autostart, Verknuepfungen, App-Profil). Daten bleiben erhalten.
setlocal
chcp 65001 >nul
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\uninstall.ps1" %*
echo.
pause
