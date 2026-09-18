<#
.SYNOPSIS
  Richtet das Tray-Icon (tray.ps1, startet den Watcher) als Aufgabe ein, die bei der Windows-Anmeldung startet.

.DESCRIPTION
  Legt in der Aufgabenplanung die Aufgabe "MTGA Collection Export" an (für den
  aktuellen Benutzer, keine Adminrechte nötig) und startet sie sofort.
  Mit -Uninstall wird die Aufgabe wieder entfernt und ein laufender Watcher beendet.
  Einstellungen des Watchers: watch-config.json

.PARAMETER Uninstall  Aufgabe entfernen
.PARAMETER Elevated   Aufgabe mit höchsten Rechten einrichten (nötig, wenn MTGA mit Administratorrechten läuft).
                      Dieses Skript dann aus einer Administrator-PowerShell aufrufen.
#>
param(
  [switch]$Uninstall,
  [switch]$Elevated
)

$ErrorActionPreference = "Stop"
$taskName = "MTGA Collection Export"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$dir = $root

if ($Uninstall) {
  $t = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($t) {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "Aufgabe '$taskName' entfernt."
  } else {
    Write-Host "Aufgabe '$taskName' war nicht eingerichtet."
  }
  exit 0
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Write-Error "node.exe nicht im PATH gefunden. Bitte Node.js installieren." }
$isAdmin = (New-Object System.Security.Principal.WindowsPrincipal([System.Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
if ($Elevated -and -not $isAdmin) {
  # Selbst mit Administratorrechten neu starten (UAC-Abfrage), Ausgabe im neuen Fenster
  Write-Host "Starte mit Administratorrechten neu (UAC-Abfrage bestätigen) ..."
  $args = "-NoProfile -ExecutionPolicy Bypass -NoExit -File `"$PSCommandPath`" -Elevated"
  Start-Process -FilePath (Get-Command powershell.exe).Source -ArgumentList $args -Verb RunAs
  exit 0
}

# Start über wscript + hidden.vbs: kein sichtbares Konsolenfenster beim Anmelden
$psExe = (Get-Command wscript.exe).Source
$tray = Join-Path $root "scripts\tray.ps1"
$arguments = "`"$(Join-Path $root 'scripts\hidden.vbs')`" `"$tray`""

$action = New-ScheduledTaskAction -Execute $psExe -Argument $arguments -WorkingDirectory $dir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew

$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}

$runLevel = if ($Elevated) { "Highest" } else { "Limited" }
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel $runLevel
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
  -Description "Wartet auf MTGA und exportiert Sammlung, Änderungen und Decks nach $dir\out" | Out-Null
if ($Elevated) { Write-Host "Aufgabe läuft mit höchsten Rechten (für MTGA mit Administratorrechten)." }
Start-ScheduledTask -TaskName $taskName

Write-Host "Aufgabe '$taskName' eingerichtet und gestartet (Symbol im Infobereich)."
Write-Host "  Tray:          $tray (startet src\watch.js)"
Write-Host "  Einstellungen: $dir\watch-config.json (nach Änderung: dieses Skript erneut ausführen)"
Write-Host "  Exporte:       $dir\out"
Write-Host "  Protokoll:     $dir\out\watch.log"
Write-Host "Entfernen:  powershell -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Uninstall"
