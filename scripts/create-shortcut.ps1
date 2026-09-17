<#
.SYNOPSIS
  Legt die Verknüpfung "MTGA Stats" an, die alles startet (Tray-Icon, Watcher, Dashboard-Server).

.DESCRIPTION
  Standard: Startmenü des Benutzers (Programme). Mit -Desktop zusätzlich auf dem Desktop.
  Das Icon wird bei Bedarf über make-icon.ps1 erzeugt.

.PARAMETER Desktop   Verknüpfung auch auf dem Desktop anlegen
.PARAMETER Remove    Verknüpfungen entfernen
#>
param(
  [switch]$Desktop,
  [switch]$Remove
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$name = "MTGA Stats"
$startMenu = Join-Path ([Environment]::GetFolderPath("Programs")) "$name.lnk"
$desktopLnk = Join-Path ([Environment]::GetFolderPath("Desktop")) "$name.lnk"

if ($Remove) {
  foreach ($p in @($startMenu, $desktopLnk)) { if (Test-Path $p) { Remove-Item $p -Force; Write-Host "entfernt: $p" } }
  exit 0
}

$icon = Join-Path $root "assets\mtga-stats.ico"
if (-not (Test-Path $icon)) { & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root "scripts\make-icon.ps1") -Out $icon | Out-Null }

$ps = (Get-Command powershell.exe).Source
$tray = Join-Path $root "scripts\tray.ps1"
$targets = @($startMenu)
if ($Desktop) { $targets += $desktopLnk }
$shell = New-Object -ComObject WScript.Shell
foreach ($p in $targets) {
  $lnk = $shell.CreateShortcut($p)
  $lnk.TargetPath = $ps
  $lnk.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$tray`""
  $lnk.WorkingDirectory = $root
  $lnk.IconLocation = "$icon,0"
  $lnk.WindowStyle = 7
  $lnk.Description = "MTGA Stats: Tray-Icon, Watcher und Dashboard starten"
  $lnk.Save()
  Write-Host "Verknüpfung: $p"
}
