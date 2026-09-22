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
  Start-Process wscript.exe -ArgumentList "`"$(Join-Path $root 'scripts\hidden.vbs')`" `"$tray`""
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

# Läuft das App-Fenster schon (Browserprozess mit unserem Profil), nur nach vorn holen statt ein zweites zu öffnen
Add-Type -Namespace Win -Name Native -MemberDefinition @"
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
"@
$running = Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe' OR Name = 'msedge.exe'" |
  Where-Object { $_.CommandLine -and $_.CommandLine -like "*$profile*" -and $_.CommandLine -notlike "*--type=*" }
foreach ($p in $running) {
  $proc = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
  if ($proc -and $proc.MainWindowHandle -ne 0) {
    $h = $proc.MainWindowHandle
    if ([Win.Native]::IsIconic($h)) { [Win.Native]::ShowWindow($h, 9) | Out-Null }   # 9 = SW_RESTORE
    [Win.Native]::SetForegroundWindow($h) | Out-Null
    exit
  }
}
Start-Process $exe -ArgumentList @("--app=$url", "--user-data-dir=`"$profile`"", "--window-size=1500,960", "--no-first-run", "--no-default-browser-check", "--disable-features=TranslateUI")
