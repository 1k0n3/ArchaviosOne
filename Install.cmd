@echo off
rem MTGA Stats - Ein-Klick-Installation (Windows). Doppelklick genuegt.
setlocal
chcp 65001 >nul
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install.ps1" %*
if errorlevel 1 (
  echo.
  echo Die Installation wurde nicht abgeschlossen. Siehe Hinweise oben.
)
echo.
pause
