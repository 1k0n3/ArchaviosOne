<#
.SYNOPSIS
  Ein-Klick-Installation von MTGA Stats: prüft Node.js (installiert es bei Bedarf über winget),
  legt Startmenü-Verknüpfungen an, richtet optional den Autostart ein und startet das Dashboard.

.PARAMETER NoAutostart   Autostart nicht anbieten
.PARAMETER Quiet         Keine Rückfragen (Autostart wird eingerichtet)
.PARAMETER NoStart       Tray und Dashboard am Ende nicht starten
#>
param([switch]$NoAutostart, [switch]$Quiet, [switch]$NoStart)
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Host.UI.RawUI.WindowTitle = "MTGA Stats – Installation"

function Write-Step($t) { Write-Host ""; Write-Host ("  " + $t) -ForegroundColor Cyan }
function Write-Ok($t) { Write-Host ("    [OK] " + $t) -ForegroundColor Green }
function Write-Warn2($t) { Write-Host ("    [!] " + $t) -ForegroundColor Yellow }
function Refresh-Path { $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User") }
function Get-NodeVersion {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $cmd) { return $null }
  try { return [version]((& $cmd.Source --version).TrimStart("v")) } catch { return $null }
}

Write-Host ""
Write-Host "  ╔══════════════════════════════════════════════╗" -ForegroundColor DarkYellow
Write-Host "  ║   MTGA Stats – lokales Dashboard für Arena   ║" -ForegroundColor DarkYellow
Write-Host "  ╚══════════════════════════════════════════════╝" -ForegroundColor DarkYellow
Write-Host "  Ordner: $root"

# ---- 1. Node.js ----------------------------------------------------------------------------------
Write-Step "1/4  Node.js prüfen"
$need = [version]"22.13"
$v = Get-NodeVersion
if ($v -and $v -ge $need) {
  Write-Ok "Node.js $v gefunden"
} else {
  if ($v) { Write-Warn2 "Node.js $v ist zu alt (mindestens $need nötig)." } else { Write-Warn2 "Node.js ist nicht installiert." }
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if ($winget) {
    Write-Host "    Installiere Node.js LTS über winget (Windows-Paketmanager) ..."
    & winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements --silent | Out-Host
    Refresh-Path
    $v = Get-NodeVersion
  }
  if (-not ($v -and $v -ge $need)) {
    Write-Warn2 "Node.js konnte nicht automatisch installiert werden."
    Write-Host "    Bitte Node.js LTS von https://nodejs.org installieren und Install.cmd danach erneut starten."
    Start-Process "https://nodejs.org/"
    exit 1
  }
  Write-Ok "Node.js $v installiert"
}

# ---- 2. MTG Arena --------------------------------------------------------------------------------
Write-Step "2/4  MTG Arena prüfen"
$logDir = Join-Path $env:USERPROFILE "AppData\LocalLow\Wizards Of The Coast\MTGA"
if (Test-Path (Join-Path $logDir "Player.log")) { Write-Ok "Arena-Logdatei gefunden" }
else { Write-Warn2 "Noch keine Arena-Logdatei gefunden. Arena einmal starten, dann findet der Watcher alles automatisch." }
Write-Host "    Hinweis: In Arena unter Einstellungen > Konto die Option 'Detaillierte Protokolle (Plugin-Unterstützung)' einschalten."

# ---- 3. Verknüpfungen + Autostart -----------------------------------------------------------------
Write-Step "3/4  Verknüpfungen anlegen"
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root "scripts\create-shortcut.ps1") | ForEach-Object { Write-Host ("    " + $_) }
Write-Ok "Startmenü: 'MTGA Stats' (Tray) und 'MTGA Stats Dashboard' (App-Fenster)"

if (-not $NoAutostart) {
  $doAuto = $Quiet
  if (-not $Quiet) {
    $answer = Read-Host "    Beim Windows-Start automatisch im Hintergrund mitlaufen? [J/n]"
    $doAuto = ($answer -eq "" -or $answer -match "^[jJyY]")
  }
  if ($doAuto) {
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root "scripts\install-autostart.ps1") | ForEach-Object { Write-Host ("    " + $_) }
    Write-Ok "Autostart eingerichtet"
  } else { Write-Host "    Autostart übersprungen (später: npm run autostart)" }
}

# ---- 4. Starten ----------------------------------------------------------------------------------
Write-Step "4/4  Starten"
if ($NoStart) { Write-Host "    übersprungen (-NoStart)" } else {
Start-Process wscript.exe -ArgumentList "`"$(Join-Path $root 'scripts\hidden.vbs')`" `"$(Join-Path $root 'scripts\tray.ps1')`""
Write-Ok "Tray-Icon und Watcher gestartet (Symbol unten rechts im Infobereich)"
Start-Process wscript.exe -ArgumentList "`"$(Join-Path $root 'scripts\hidden.vbs')`" `"$(Join-Path $root 'scripts\open-app.ps1')`""
Write-Ok "Dashboard-Fenster wird geöffnet"
}
Write-Host ""
Write-Host "  Fertig. Alle Daten bleiben auf diesem PC (Ordner 'out')." -ForegroundColor Green
Write-Host "  Deinstallation: Uninstall.cmd im selben Ordner."
Write-Host ""
