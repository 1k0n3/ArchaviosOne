@echo off
rem MTGA Stats: Website per FTP auf den lokalen Stand bringen und das lokale Dashboard neu bauen.
rem Zugangsdaten stehen in deploy-config.json (siehe hosting\DEPLOY.md).
chcp 65001 >nul
title MTGA Stats - Website hochladen
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js nicht gefunden - bitte installieren. & pause & exit /b 1)
echo.
echo  Lokales Dashboard neu bauen ...
node src\webgen.js
echo.
echo  Website abgleichen ...
node scripts\deploy.js
if errorlevel 1 (
  echo.
  echo  Es gab einen Fehler - Meldung oben pruefen.
) else (
  echo.
  echo  Fertig.
)
echo.
pause
