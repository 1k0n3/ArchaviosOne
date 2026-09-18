<#
.SYNOPSIS
  Öffnet das Dashboard als eigenständiges App-Fenster (Chrome oder Edge im App-Modus, ohne Adressleiste).
  Fällt auf den Standardbrowser zurück, wenn keiner der beiden installiert ist.
.PARAMETER Port
  Port des Dashboard-Servers (Standard: webPort aus watch-config.json, sonst 8765).
#>
param([int]$Port = 0)
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
if ($Port -le 0) {
  $Port = 8765
  $cfg = Join-Path $root "watch-config.json"
  if (Test-Path $cfg) { try { $j = Get-Content $cfg -Raw | ConvertFrom-Json; if ($j.webPort) { $Port = [int]$j.webPort } } catch { } }
}
$url = "http://localhost:$Port/"
# Läuft der Dashboard-Server noch nicht, Tray (mit Watcher) starten und kurz auf den Server warten
function Test-Server { try { $c = New-Object Net.Sockets.TcpClient; $c.Connect("127.0.0.1", $Port); $c.Close(); return $true } catch { return $false } }
if (-not (Test-Server)) {
  $tray = Join-Path $root "scripts\tray.ps1"
  Start-Process powershell -WindowStyle Hidden -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$tray`""
  $deadline = (Get-Date).AddSeconds(40)
  while (-not (Test-Server) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
}
$candidates = @(
  (Join-Path $env:ProgramFiles "Google\Chrome\Application\chrome.exe"),
  (Join-Path ${env:ProgramFiles(x86)} "Google\Chrome\Application\chrome.exe"),
  (Join-Path $env:LOCALAPPDATA "Google\Chrome\Application\chrome.exe"),
  (Join-Path $env:ProgramFiles "Microsoft\Edge\Application\msedge.exe"),
  (Join-Path ${env:ProgramFiles(x86)} "Microsoft\Edge\Application\msedge.exe")
)
$exe = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $exe) { Start-Process $url; exit }
# Eigenes Profil, damit das App-Fenster unabhängig vom normalen Browser läuft (Fenstergröße, Einstellungen)
$profile = Join-Path $env:LOCALAPPDATA "MTGA Stats\app-profile"
New-Item -ItemType Directory -Force -Path $profile | Out-Null
Start-Process $exe -ArgumentList @("--app=$url", "--user-data-dir=`"$profile`"", "--window-size=1500,960", "--no-first-run", "--no-default-browser-check", "--disable-features=TranslateUI")
