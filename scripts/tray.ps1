<#
.SYNOPSIS
  Tray-Icon (Infobereich) zur Steuerung des MTGA Stats Watchers.

.DESCRIPTION
  Startet watch.js im Hintergrund (Watcher + lokaler Dashboard-Server) und zeigt ein Symbol
  im Infobereich. Linksklick oder Doppelklick öffnet das Dashboard im Browser.
  Statuspunkt: grün = Watcher läuft, MTGA offen · gold = wartet auf MTGA · grau = gestoppt.
  Rechtsklick: Dashboard, Status, Watcher starten/stoppen, Sammlung exportieren, Intervalle,
  Speicherort, Ordner/Protokoll, Einstellungen, Beenden.

.PARAMETER NoAutoStart   Watcher beim Start des Trays nicht automatisch starten
.PARAMETER TestSeconds   Nur zum Testen: Tray nach N Sekunden automatisch beenden
#>
param(
  [switch]$NoAutoStart,
  [int]$TestSeconds = 0
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$script:dir = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$script:configPath = Join-Path $script:dir "watch-config.json"
$script:node = $null
$script:exportProc = $null
$script:logPos = 0
$script:logPath = ""

# ---- Nur eine Instanz -------------------------------------------------------------------------
$created = $false
$script:mutex = New-Object System.Threading.Mutex($true, "Local\MTGACollectionTray", [ref]$created)
if (-not $created) {
  [System.Windows.Forms.MessageBox]::Show("MTGA Stats läuft bereits (Symbol im Infobereich).", "MTGA Stats") | Out-Null
  exit 0
}

# ---- Konfiguration ---------------------------------------------------------------------------------
function Get-Config {
  if (-not (Test-Path $script:configPath)) { return [pscustomobject]@{} }
  Get-Content -LiteralPath $script:configPath -Raw -Encoding UTF8 | ConvertFrom-Json
}
function Set-ConfigValue([string]$name, $value) {
  $c = Get-Config
  if ($c.PSObject.Properties[$name]) { $c.$name = $value } else { $c | Add-Member -NotePropertyName $name -NotePropertyValue $value }
  # UTF-8 ohne BOM schreiben (Set-Content -Encoding UTF8 setzt in PowerShell 5 ein BOM, das JSON.parse in Node ablehnt)
  [System.IO.File]::WriteAllText($script:configPath, ($c | ConvertTo-Json -Depth 5), (New-Object System.Text.UTF8Encoding $false))
}
function Get-ConfigValue([string]$name, $default) {
  $c = Get-Config
  if ($c.PSObject.Properties[$name] -and $null -ne $c.$name) { return $c.$name }
  return $default
}
function Get-OutDir {
  $o = Get-ConfigValue "outDir" "out"
  if ([System.IO.Path]::IsPathRooted($o)) { return $o }
  return Join-Path $script:dir $o
}
function Get-DashboardUrl { return ("http://localhost:{0}/" -f (Get-ConfigValue "webPort" 8765)) }

# ---- Watcher-Prozess -------------------------------------------------------------------------------
function Get-NodePath { $c = Get-Command node -ErrorAction SilentlyContinue; if ($c) { $c.Source } else { $null } }
function Test-WatcherRunning { return ($null -ne $script:node -and -not $script:node.HasExited) }
function Test-MtgaRunning { return [bool](Get-Process -Name MTGA -ErrorAction SilentlyContinue) }

function Start-Watcher {
  if (Test-WatcherRunning) { return }
  $nodeExe = Get-NodePath
  if (-not $nodeExe) {
    [System.Windows.Forms.MessageBox]::Show("node.exe nicht gefunden. Bitte Node.js installieren.", "MTGA Stats") | Out-Null
    return
  }
  $script:node = Start-Process -FilePath $nodeExe -ArgumentList "src\watch.js" -WorkingDirectory $script:dir -WindowStyle Hidden -PassThru
  Update-Status
}
function Stop-Watcher {
  if (Test-WatcherRunning) { & taskkill /PID $script:node.Id /T /F 2>&1 | Out-Null }
  $script:node = $null
  Update-Status
}
function Restart-Watcher([string]$reason) {
  $was = Test-WatcherRunning
  Stop-Watcher
  if ($was) {
    Start-Sleep -Milliseconds 400
    Start-Watcher
    Show-Balloon ("Watcher neu gestartet: " + $reason)
  }
}
function Open-Dashboard {
  if (-not (Test-WatcherRunning)) { Start-Watcher; Start-Sleep -Milliseconds 1500 }
  # Als eigenständiges App-Fenster (Chrome/Edge im App-Modus), sonst im Standardbrowser
  $app = Join-Path $script:dir "scripts\open-app.ps1"
  if (Test-Path $app) { Start-Process wscript.exe -ArgumentList "`"$(Join-Path $script:dir 'scripts\hidden.vbs')`" `"$app`" -Port $(Get-ConfigValue "webPort" 8765)" }
  else { Start-Process (Get-DashboardUrl) }
}

# ---- Icon: Schild mit goldenem Funken und fünf Mana-Steinen, Statuspunkt unten rechts --------------
function New-TrayIcon([System.Drawing.Color]$dot) {
  # Logo: fünf Mana-Balken auf Plakette, Oberkanten bilden ein M; Statuspunkt unten rechts
  $bmp = New-Object System.Drawing.Bitmap 32, 32
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)
  $s = 1.0

  # Plakette (abgerundetes Quadrat) mit Goldrand, fünf Mana-Balken, deren Oberkanten ein M bilden
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $r = 7.5 * $s; $x0 = 1 * $s; $y0 = 1 * $s; $w = 30 * $s
  $path.AddArc($x0, $y0, 2 * $r, 2 * $r, 180, 90); $path.AddArc($x0 + $w - 2 * $r, $y0, 2 * $r, 2 * $r, 270, 90)
  $path.AddArc($x0 + $w - 2 * $r, $y0 + $w - 2 * $r, 2 * $r, 2 * $r, 0, 90); $path.AddArc($x0, $y0 + $w - 2 * $r, 2 * $r, 2 * $r, 90, 90); $path.CloseFigure()
  $bgBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush (New-Object System.Drawing.PointF 0, 0), (New-Object System.Drawing.PointF 0, (32 * $s)), ([System.Drawing.Color]::FromArgb(44, 32, 24)), ([System.Drawing.Color]::FromArgb(16, 13, 11))
  $g.FillPath($bgBrush, $path)
  $g.DrawPath((New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(140, 242, 177, 52)), ([Math]::Max(0.8, 0.8 * $s))), $path)
  $cols = @(@(243, 233, 200), @(61, 127, 214), @(154, 143, 179), @(216, 72, 47), @(63, 154, 79))
  $hs = @(17, 12.5, 8.5, 12.5, 17)
  for ($i = 0; $i -lt 5; $i++) {
    $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb($cols[$i][0], $cols[$i][1], $cols[$i][2])), ([Math]::Max(1.5, 3.5 * $s))
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round; $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $x = (6 + $i * 5) * $s
    $g.DrawLine($pen, [single]$x, [single](25 * $s - 1.5 * $s), [single]$x, [single]((25 - $hs[$i]) * $s + 1.5 * $s))
  }
  $g.FillEllipse((New-Object System.Drawing.SolidBrush $dot), 21, 21, 10, 10)
  $g.DrawEllipse((New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(16, 13, 11)), 1.5), 21, 21, 10, 10)
  $g.Dispose()
  return [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
}
$script:iconGreen = New-TrayIcon ([System.Drawing.Color]::FromArgb(34, 197, 94))
$script:iconBlue = New-TrayIcon ([System.Drawing.Color]::FromArgb(242, 177, 52))
$script:iconGray = New-TrayIcon ([System.Drawing.Color]::FromArgb(120, 128, 150))

# ---- Tray + Menü ------------------------------------------------------------------------------------
$script:tray = New-Object System.Windows.Forms.NotifyIcon
$script:tray.Icon = $script:iconGray
$script:tray.Text = "MTGA Stats"
$script:tray.Visible = $true

function Show-Balloon([string]$text, [string]$title = "MTGA Stats") {
  try { $script:tray.ShowBalloonTip(5000, $title, $text, [System.Windows.Forms.ToolTipIcon]::Info) } catch {}
}

# ---- Menü im App-Design: warmes Dunkel, Gold als Akzent (wie app.css) ------------------------------
Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @"
using System.Drawing;
using System.Windows.Forms;
public class MtgaColorTable : ProfessionalColorTable {
  static readonly Color Bg = Color.FromArgb(26, 21, 18), Hi = Color.FromArgb(44, 36, 28), Line = Color.FromArgb(74, 60, 47), Gold = Color.FromArgb(242, 177, 52);
  public override Color ToolStripDropDownBackground { get { return Bg; } }
  public override Color MenuBorder { get { return Line; } }
  public override Color MenuItemBorder { get { return Color.FromArgb(120, 242, 177, 52); } }
  public override Color MenuItemSelected { get { return Hi; } }
  public override Color MenuItemSelectedGradientBegin { get { return Hi; } }
  public override Color MenuItemSelectedGradientEnd { get { return Hi; } }
  public override Color MenuItemPressedGradientBegin { get { return Hi; } }
  public override Color MenuItemPressedGradientMiddle { get { return Hi; } }
  public override Color MenuItemPressedGradientEnd { get { return Hi; } }
  public override Color ImageMarginGradientBegin { get { return Bg; } }
  public override Color ImageMarginGradientMiddle { get { return Bg; } }
  public override Color ImageMarginGradientEnd { get { return Bg; } }
  public override Color SeparatorDark { get { return Line; } }
  public override Color SeparatorLight { get { return Bg; } }
  public override Color CheckBackground { get { return Hi; } }
  public override Color CheckSelectedBackground { get { return Hi; } }
  public override Color CheckPressedBackground { get { return Hi; } }
  public override Color ButtonSelectedBorder { get { return Gold; } }
}
public class MtgaRenderer : ToolStripProfessionalRenderer {
  static readonly Color Ink = Color.FromArgb(245, 238, 226), Muted = Color.FromArgb(148, 133, 114), Gold = Color.FromArgb(242, 177, 52);
  public MtgaRenderer() : base(new MtgaColorTable()) { RoundedEdges = false; }
  protected override void OnRenderItemText(ToolStripItemTextRenderEventArgs e) {
    if (!e.Item.Enabled) e.TextColor = e.Item.ForeColor == SystemColors.ControlText ? Muted : e.Item.ForeColor;
    else if (e.Item.Selected) e.TextColor = Color.FromArgb(255, 211, 107);
    else e.TextColor = Ink;
    base.OnRenderItemText(e);
  }
  protected override void OnRenderArrow(ToolStripArrowRenderEventArgs e) { e.ArrowColor = e.Item.Selected ? Gold : Muted; base.OnRenderArrow(e); }
  protected override void OnRenderItemCheck(ToolStripItemImageRenderEventArgs e) {
    // goldener Haken statt Systembild
    Rectangle r = e.ImageRectangle;
    using (Pen p = new Pen(Gold, 2f)) {
      e.Graphics.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
      int cx = r.Left + r.Width / 2, cy = r.Top + r.Height / 2;
      e.Graphics.DrawLines(p, new Point[] { new Point(cx - 5, cy), new Point(cx - 1, cy + 4), new Point(cx + 6, cy - 4) });
    }
  }
}
"@
$script:renderer = New-Object MtgaRenderer
[System.Windows.Forms.ToolStripManager]::Renderer = $script:renderer

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$menu.Renderer = $script:renderer
$menu.BackColor = [System.Drawing.Color]::FromArgb(26, 21, 18)
$menu.ForeColor = [System.Drawing.Color]::FromArgb(245, 238, 226)
$menu.Font = New-Object System.Drawing.Font("Segoe UI", 9.5)
$menu.ShowImageMargin = $false
$menu.Padding = New-Object System.Windows.Forms.Padding(2, 6, 2, 6)

function Add-Item([string]$text, [scriptblock]$onClick, [bool]$enabled = $true, [bool]$bold = $false) {
  $mi = New-Object System.Windows.Forms.ToolStripMenuItem $text
  $mi.Enabled = $enabled
  if ($bold) { $mi.Font = New-Object System.Drawing.Font("Segoe UI", 10, [System.Drawing.FontStyle]::Bold) }
  if ($onClick) { $mi.Add_Click($onClick) }
  [void]$menu.Items.Add($mi)
  return $mi
}
function Add-Separator { [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) }
function Add-Header([string]$text) {
  $mi = New-Object System.Windows.Forms.ToolStripMenuItem $text
  $mi.Enabled = $false
  $mi.Font = New-Object System.Drawing.Font("Segoe UI", 8, [System.Drawing.FontStyle]::Bold)
  $mi.ForeColor = [System.Drawing.Color]::FromArgb(242, 177, 52)
  [void]$menu.Items.Add($mi)
}

# Kopf: Dashboard ganz oben
$script:miDash = Add-Item "Dashboard öffnen" { Open-Dashboard } $true $true
$script:miSite = Add-Item "Website öffnen" { $u = Get-ConfigValue "syncUrl" ""; if ($u) { Start-Process $u } else { Show-Balloon "Noch keine Website verbunden (Cloud-Sync → Mit Website verbinden…)." } }
$script:miStatus = Add-Item "Status: ..." $null $false
$script:miMtga = Add-Item "MTGA: ..." $null $false
$script:miLast = Add-Item "" $null $false
Add-Separator

Add-Header "WATCHER"
$script:miToggle = Add-Item "Watcher stoppen" {
  if (Test-WatcherRunning) { Stop-Watcher; Show-Balloon "Watcher gestoppt." } else { Start-Watcher; Show-Balloon "Watcher gestartet." }
}
$script:miExport = Add-Item "Sammlung jetzt exportieren" {
  if (-not (Test-MtgaRunning)) { Show-Balloon "MTGA läuft nicht, Export nicht möglich."; return }
  if ($script:exportProc -and -not $script:exportProc.HasExited) { Show-Balloon "Export läuft bereits."; return }
  $nodeExe = Get-NodePath
  if (-not $nodeExe) { return }
  $out = Get-OutDir
  $script:exportProc = Start-Process -FilePath $nodeExe -ArgumentList @("src\export.js", "--out", "`"$out`"") -WorkingDirectory $script:dir -WindowStyle Hidden -PassThru
  Show-Balloon "Export gestartet, dauert etwa 30 Sekunden ..."
}
Add-Separator

Add-Header "INTERVALLE"
function Add-IntervalMenu([string]$title, [string]$key, [int]$default, [hashtable[]]$choices) {
  $parent = New-Object System.Windows.Forms.ToolStripMenuItem $title
  $parent.Tag = $key
  $parent.DropDown.Renderer = $script:renderer
  $parent.DropDown.BackColor = $menu.BackColor
  $parent.DropDown.ForeColor = $menu.ForeColor
  foreach ($ch in $choices) {
    $mi = New-Object System.Windows.Forms.ToolStripMenuItem $ch.label
    $mi.Tag = [int]$ch.value
    $mi.Add_Click({
      param($sender, $e)
      $p = $sender.OwnerItem
      $k = $p.Tag
      $v = [int]$sender.Tag
      Set-ConfigValue $k $v
      foreach ($x in $p.DropDownItems) { $x.Checked = ($x.Tag -eq $v) }
      Restart-Watcher ("$($p.Text) = $($sender.Text)")
    }.GetNewClosure())
    [void]$parent.DropDownItems.Add($mi)
  }
  $parent.Add_DropDownOpening({
    param($sender, $e)
    $cur = [int](Get-ConfigValue $sender.Tag 0)
    foreach ($x in $sender.DropDownItems) { $x.Checked = ($x.Tag -eq $cur) }
  })
  [void]$menu.Items.Add($parent)
  return $parent
}
$minutes = @(
  @{ label = "1 Minute"; value = 60 }, @{ label = "2 Minuten"; value = 120 }, @{ label = "5 Minuten"; value = 300 },
  @{ label = "10 Minuten"; value = 600 }, @{ label = "15 Minuten"; value = 900 }, @{ label = "30 Minuten"; value = 1800 }
)
[void](Add-IntervalMenu "Prüfen, ob MTGA läuft" "pollSec" 300 $minutes)
[void](Add-IntervalMenu "Änderungsprüfung im Spiel" "checkSec" 60 @(
  @{ label = "30 Sekunden"; value = 30 }, @{ label = "1 Minute"; value = 60 }, @{ label = "2 Minuten"; value = 120 },
  @{ label = "5 Minuten"; value = 300 }, @{ label = "10 Minuten"; value = 600 }
))
[void](Add-IntervalMenu "Kompletter Scan im Spiel" "fullScanSec" 600 @(
  @{ label = "5 Minuten"; value = 300 }, @{ label = "10 Minuten"; value = 600 }, @{ label = "30 Minuten"; value = 1800 },
  @{ label = "60 Minuten"; value = 3600 }, @{ label = "nie"; value = 0 }
))
Add-Separator

Add-Header "DATEIEN"
$script:miOutDir = Add-Item "Speicherort ändern ..." {
  $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
  $dlg.Description = "Ordner für Exporte, Änderungslog, Matches und Dashboard"
  $dlg.SelectedPath = Get-OutDir
  $dlg.ShowNewFolderButton = $true
  if ($dlg.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
    Set-ConfigValue "outDir" $dlg.SelectedPath
    $script:logPos = 0
    Restart-Watcher ("Speicherort " + $dlg.SelectedPath)
    Update-Status
  }
}
$script:miOpenOut = Add-Item "Ausgabeordner öffnen" {
  $o = Get-OutDir
  if (-not (Test-Path $o)) { New-Item -ItemType Directory -Path $o | Out-Null }
  Start-Process explorer.exe $o
}
$script:miOpenLog = Add-Item "Protokoll öffnen" {
  $l = Join-Path (Get-OutDir) "watch.log"
  if (Test-Path $l) { Start-Process notepad.exe $l } else { Show-Balloon "Noch kein Protokoll vorhanden." }
}
$script:miOpenCfg = Add-Item "Alle Einstellungen bearbeiten (JSON)" { Start-Process notepad.exe $script:configPath }
Add-Separator

# ---- Autostart (Aufgabenplanung, siehe install-autostart.ps1) ----------------------------------------
Add-Header "AUTOSTART"
$script:taskName = "MTGA Collection Export"
function Get-AutostartTask { Get-ScheduledTask -TaskName $script:taskName -ErrorAction SilentlyContinue }
# PowerShell-Befehl unsichtbar ausführen, bei Bedarf mit Administratorrechten (UAC-Abfrage)
function Invoke-PsHidden([string]$command, [bool]$admin) {
  $a = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -Command `"$command`""
  try {
    if ($admin) { Start-Process powershell.exe -ArgumentList $a -Verb RunAs -WindowStyle Hidden -Wait }
    else { Start-Process powershell.exe -ArgumentList $a -WindowStyle Hidden -Wait }
    return $true
  } catch { Show-Balloon "Abgebrochen: $($_.Exception.Message)"; return $false }
}
function Register-Autostart {
  $elev = [bool](Get-ConfigValue "autostartElevated" $false)
  $inst = Join-Path $script:dir "scripts\install-autostart.ps1"
  $cmd = "& '$inst' -NoStart" + $(if ($elev) { " -Elevated" } else { "" })
  Invoke-PsHidden $cmd $elev
}
$script:miAutostart = Add-Item "Beim Anmelden automatisch starten" {
  $t = Get-AutostartTask
  if ($t) {
    $admin = ($t.Principal.RunLevel -eq "Highest")
    $cmd = $(if ($t.State -eq "Disabled") { "Enable-ScheduledTask" } else { "Disable-ScheduledTask" }) + " -TaskName '$($script:taskName)' | Out-Null"
    [void](Invoke-PsHidden $cmd $admin)
  } else { [void](Register-Autostart) }
  $t = Get-AutostartTask
  Show-Balloon $(if ($t -and $t.State -ne "Disabled") { "Autostart eingeschaltet." } else { "Autostart ausgeschaltet." })
}
$script:miAutostartAdmin = Add-Item "Mit Administratorrechten (wenn MTGA als Admin läuft)" {
  $new = -not [bool](Get-ConfigValue "autostartElevated" $false)
  Set-ConfigValue "autostartElevated" $new
  $t = Get-AutostartTask
  if ($t) {
    # bestehende Aufgabe mit der neuen Rechtestufe neu anlegen (Entfernen der alten braucht ggf. Adminrechte)
    $inst = Join-Path $script:dir "scripts\install-autostart.ps1"
    $cmd = "& '$inst' -NoStart" + $(if ($new) { " -Elevated" } else { "" })
    [void](Invoke-PsHidden $cmd ($new -or $t.Principal.RunLevel -eq "Highest"))
  }
  Show-Balloon $(if ($new) { "Autostart läuft künftig mit Administratorrechten." } else { "Autostart läuft künftig ohne Administratorrechte." })
}
$menu.Add_Opening({
  $script:miSite.Enabled = [bool](Get-ConfigValue "syncUrl" "")
  if ($script:miDeploy) { $script:miDeploy.Visible = Test-Path (Join-Path $script:dir "deploy-config.json") }
  if ($script:miSyncAccount) { $script:miSyncAccount.Checked = [bool](Get-ConfigValue "syncAccount" $true) }
  $t = Get-AutostartTask
  $script:miAutostart.Checked = [bool]($t -and $t.State -ne "Disabled")
  $script:miAutostartAdmin.Checked = $(if ($t) { $t.Principal.RunLevel -eq "Highest" } else { [bool](Get-ConfigValue "autostartElevated" $false) })
})
$menu.ShowCheckMargin = $true
# node ohne Konsolenfenster ausführen und die Ausgabe zurückgeben
function Invoke-NodeHidden([string[]]$nodeArgs) {
  $nodeExe = Get-NodePath
  if (-not $nodeExe) { return "node.exe nicht gefunden" }
  $tmp = [System.IO.Path]::GetTempFileName()
  try {
    $p = Start-Process -FilePath $nodeExe -ArgumentList $nodeArgs -WorkingDirectory $script:dir -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput $tmp -RedirectStandardError ($tmp + ".err")
    $out = (Get-Content $tmp -Raw -ErrorAction SilentlyContinue) + (Get-Content ($tmp + ".err") -Raw -ErrorAction SilentlyContinue)
    return [string]$out
  } finally { Remove-Item $tmp, ($tmp + ".err") -Force -ErrorAction SilentlyContinue }
}
Add-Separator
Add-Header "CLOUD-SYNC"
$script:miConnect = Add-Item "Mit Website verbinden…" {
  Add-Type -AssemblyName Microsoft.VisualBasic
  $url = Get-ConfigValue "syncUrl" ""
  if (-not $url) {
    $url = [Microsoft.VisualBasic.Interaction]::InputBox("Adresse der MTGA-Stats-Website (z. B. https://mtga.example.de)", "MTGA Stats – Website", "https://")
    if (-not $url -or $url -eq "https://") { return }
    Set-ConfigValue "syncUrl" $url.Trim()
  }
  $code = [Microsoft.VisualBasic.Interaction]::InputBox("Verbindungscode aus den Website-Einstellungen (Companion verbinden):", "MTGA Stats – Gerät verbinden", "")
  if (-not $code) { return }
  $out = Invoke-NodeHidden @("src\sync.js", "connect", $code.Trim(), "--url", (Get-ConfigValue "syncUrl" ""))
  Show-Balloon ($out.Trim())
}
$script:miSyncNow = Add-Item "Jetzt synchronisieren" {
  Invoke-NodeHidden @("src\sync.js", "sync") | Out-Null
  $st = (Invoke-NodeHidden @("src\sync.js", "status")) | ConvertFrom-Json
  if ($st.connected) { Show-Balloon ("Verbunden als " + $st.user.displayName + " · " + $st.queued + " wartend" + $(if ($st.lastError) { " · Fehler: " + $st.lastError } else { "" })) } else { Show-Balloon "Nicht mit einer Website verbunden." }
}
$script:miSyncAccount = Add-Item "Kontodaten mitsenden (Gold, Edelsteine, Rang …)" {
  $new = -not [bool](Get-ConfigValue "syncAccount" $true)
  Set-ConfigValue "syncAccount" $new
  $script:miSyncAccount.Checked = $new
  Restart-Watcher $(if ($new) { "Kontodaten werden mitgesendet" } else { "Kontodaten werden nicht mehr gesendet" })
}
$script:miAccountNow = Add-Item "Kontodaten jetzt einlesen" {
  Show-Balloon "Player.log wird gelesen …"
  $out = Invoke-NodeHidden @("src\account.js", "--save")
  $lines = @(($out -split "`r?`n") | Where-Object { $_.Trim() })
  Show-Balloon (($lines | Select-Object -First 3) -join "`n")
}
$script:miDisconnect = Add-Item "Verbindung trennen" {
  Invoke-NodeHidden @("src\sync.js", "disconnect") | Out-Null
  Show-Balloon "Cloud-Sync getrennt."
}
# Eigene Website per FTP auf den lokalen Stand bringen (nur mit deploy-config.json; siehe hosting/DEPLOY.md)
$script:miDeploy = Add-Item "Website hochladen (FTP)" {
  Show-Balloon "Website wird abgeglichen …"
  $out = Invoke-NodeHidden @("scripts\deploy.js")
  $lines = @(($out -split "`r?`n") | Where-Object { $_.Trim() -and $_ -notmatch "Dateien hochgeladen" })
  Show-Balloon (($lines | Select-Object -Last 2) -join "`n")
}
Add-Separator
$script:miExit = Add-Item "Beenden" { Exit-Tray }

$script:tray.ContextMenuStrip = $menu
# Linksklick öffnet das Dashboard (Rechtsklick zeigt das Menü)
$script:tray.Add_MouseClick({ param($sender, $e) if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Open-Dashboard } })

# ---- Status / Protokoll -----------------------------------------------------------------------------
function Update-Status {
  $running = Test-WatcherRunning
  $mtga = Test-MtgaRunning
  $script:miStatus.Text = "Watcher: " + $(if ($running) { "läuft (Server " + (Get-DashboardUrl) + ")" } else { "gestoppt" })
  $script:miMtga.Text = "MTGA: " + $(if ($mtga) { "läuft" } else { "nicht gestartet" })
  $script:miToggle.Text = $(if ($running) { "Watcher stoppen" } else { "Watcher starten" })
  $script:tray.Icon = $(if (-not $running) { $script:iconGray } elseif ($mtga) { $script:iconGreen } else { $script:iconBlue })
  $tip = "MTGA Stats: " + $(if ($running) { "läuft" } else { "gestoppt" }) + " | MTGA " + $(if ($mtga) { "offen" } else { "zu" }) + " | Klick = Dashboard"
  if ($tip.Length -gt 63) { $tip = $tip.Substring(0, 63) }
  $script:tray.Text = $tip

  $log = Join-Path (Get-OutDir) "watch.log"
  if ($log -ne $script:logPath) { $script:logPath = $log; $script:logPos = 0 }
  if (Test-Path $log) {
    try {
      $fs = [System.IO.File]::Open($log, 'Open', 'Read', 'ReadWrite')
      try {
        if ($script:logPos -gt $fs.Length) { $script:logPos = 0 }
        $first = ($script:logPos -eq 0)
        $fs.Seek($script:logPos, 'Begin') | Out-Null
        $sr = New-Object System.IO.StreamReader($fs, [System.Text.Encoding]::UTF8)
        $text = $sr.ReadToEnd()
        $script:logPos = $fs.Length
      } finally { $fs.Close() }
      $lines = @($text -split "`n" | Where-Object { $_.Trim() })
      if ($lines.Count) {
        $last = $lines[-1].Trim() -replace '^\[[^\]]+\] ', ''
        if ($last.Length -gt 80) { $last = $last.Substring(0, 80) + "..." }
        $script:miLast.Text = $last
        if (-not $first) {
          foreach ($l in $lines) {
            if ($l -match '\] (Änderung:|Vorher:|Sitzung beendet|Seit letztem Stand|Fehler|Match:)') {
              Show-Balloon ($l -replace '^\[[^\]]+\] ', '')
            }
          }
        }
      }
    } catch {}
  }

  if ($script:exportProc -and $script:exportProc.HasExited) {
    $code = $script:exportProc.ExitCode
    $script:exportProc = $null
    if ($code -eq 0) { Show-Balloon "Export fertig: $(Get-OutDir)" } else { Show-Balloon "Export fehlgeschlagen (Code $code). Ist die Sammlung im Client geladen?" }
  }
}

function Exit-Tray {
  $script:timer.Stop()
  Stop-Watcher
  $script:tray.Visible = $false
  $script:tray.Dispose()
  [System.Windows.Forms.Application]::Exit()
}

$script:timer = New-Object System.Windows.Forms.Timer
$script:timer.Interval = 5000
$script:timer.Add_Tick({ Update-Status })
$script:timer.Start()

if ($TestSeconds -gt 0) {
  $script:testTimer = New-Object System.Windows.Forms.Timer
  $script:testTimer.Interval = $TestSeconds * 1000
  $script:testTimer.Add_Tick({ $script:testTimer.Stop(); Exit-Tray })
  $script:testTimer.Start()
}

if (-not $NoAutoStart) { Start-Watcher }
Update-Status
[System.Windows.Forms.Application]::Run()
