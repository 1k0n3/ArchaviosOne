<#
.SYNOPSIS
  Entfernt Autostart, Verknüpfungen und das App-Profil und beendet Tray/Watcher.
  Die eigenen Daten (Ordner out) bleiben erhalten, außer mit -Data.
.PARAMETER Data   Auch den Ordner out (Sammlung, Matches, Dashboard) löschen
#>
param([switch]$Data)
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$ErrorActionPreference = "Continue"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Write-Host ""
Write-Host "  MTGA Stats – Deinstallation" -ForegroundColor DarkYellow
Write-Host "  Beende Tray und Watcher ..."
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and ($_.CommandLine -like "*$root*tray.ps1*" -or $_.CommandLine -like "*$root*watch.js*") } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Write-Host "  Entferne Autostart ..."
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root "scripts\install-autostart.ps1") -Uninstall | Out-Null
Write-Host "  Entferne Verknüpfungen ..."
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root "scripts\create-shortcut.ps1") -Remove | Out-Null
$profile = Join-Path $env:LOCALAPPDATA "MTGA Stats"
if (Test-Path $profile) { Remove-Item $profile -Recurse -Force -ErrorAction SilentlyContinue; Write-Host "  App-Profil entfernt" }
if ($Data) { $out = Join-Path $root "out"; if (Test-Path $out) { Remove-Item $out -Recurse -Force; Write-Host "  Datenordner out gelöscht" } }
else { Write-Host "  Deine Daten im Ordner 'out' bleiben erhalten (Uninstall.cmd -Data löscht sie)." }
Write-Host "  Fertig. Den Projektordner kannst du jetzt löschen." -ForegroundColor Green
Write-Host ""
