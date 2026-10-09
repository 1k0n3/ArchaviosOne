/**
 * Das Programm selbst: Installationsart erkennen, Abläufe außerhalb des Companions starten
 * (Update, Deinstallation) und deinstallieren – jeweils passend zur Plattform.
 *
 *   windows  ZIP/Installer: scripts/uninstall.ps1, danach Programmordner löschen
 *   linux    install.sh (auch Steam Deck): install.sh --uninstall, danach Ordner löschen
 *   mac      install.sh: dasselbe mit launchd
 *   flatpak / brew   verwalten sich selbst: nur den passenden Befehl nennen
 *   dev      Git-Arbeitsordner (Entwicklung): nie etwas löschen oder ersetzen
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const appDir = () => process.env.MTGA_STATS_HOME || path.join(os.homedir(), ".mtga-stats");

/** Wie ist dieser Programmordner installiert? */
function kindOf(root = ROOT) {
  if (fs.existsSync(path.join(root, ".git"))) return "dev";
  if (process.env.FLATPAK_ID || /^\/app\//.test(root)) return "flatpak";
  if (/[\\/](Cellar|homebrew|linuxbrew)[\\/]/i.test(root)) return "brew";
  try { fs.accessSync(root, fs.constants.W_OK); } catch (e) { return "readonly"; }
  if (process.platform === "win32") return fs.existsSync(path.join(root, "scripts", "uninstall.ps1")) ? "windows" : "readonly";
  if (!fs.existsSync(path.join(root, "install.sh")) || !fs.existsSync(path.join(root, "scripts", "unix", "mtga-stats"))) return "readonly";
  return process.platform === "darwin" ? "mac" : "linux";
}
const FLATPAK_ID = () => process.env.FLATPAK_ID || "be.a16.mtga.Stats";

/** Warum sich der Ordner nicht selbst aktualisieren kann (oder null) */
function updateBlocker(root = ROOT) {
  switch (kindOf(root)) {
    case "dev": return "Entwicklungsordner (Git) – hier wird nichts automatisch ersetzt.";
    case "flatpak": return "Flatpak: über Discover oder „flatpak update“ aktualisieren.";
    case "brew": return "Homebrew: mit „brew upgrade mtga-stats“ aktualisieren.";
    case "readonly": return "Programmordner ist schreibgeschützt (Flatpak/Homebrew aktualisieren sich selbst).";
    default: return null;
  }
}

/**
 * Startet einen Ablauf so, dass er den Companion überlebt: Update und Deinstallation beenden den
 * Watcher, der den Knopf ausgelöst hat. Unter systemd liefe ein Kindprozess in dessen Steuergruppe
 * und würde mit beendet – dort deshalb systemd-run.
 */
function runOutside(cmd, args, { env = {}, logFile = null, name = "mtga-stats-job" } = {}) {
  const { spawn, spawnSync } = require("child_process");
  const allEnv = Object.assign({}, process.env, env);
  let c = cmd, a = args, how = "eigener Prozess";
  if (process.platform === "linux" && spawnSync("systemd-run", ["--version"], { stdio: "ignore" }).status === 0
    && spawnSync("systemctl", ["--user", "show-environment"], { stdio: "ignore" }).status === 0) {
    // Die Ausgabe einer systemd-Einheit landet sonst im Journal: in die Protokolldatei umlenken
    const wrap = logFile ? ["bash", "-c", 'exec "$@" >> "$MTGA_LOG" 2>&1', "mtga-stats", cmd, ...args] : [cmd, ...args];
    c = "systemd-run";
    a = ["--user", "--collect", "--quiet", "--unit=" + name + "-" + Date.now(),
      ...Object.entries(Object.assign({}, env, logFile ? { MTGA_LOG: logFile } : {})).map(([k, v]) => "--setenv=" + k + "=" + v), "--", ...wrap];
    how = "systemd-run";
  }
  let out = "ignore";
  if (logFile) { try { fs.mkdirSync(path.dirname(logFile), { recursive: true }); out = fs.openSync(logFile, "a"); } catch (e) { out = "ignore"; } }
  const p = spawn(c, a, { detached: true, stdio: ["ignore", out, out], cwd: os.homedir(), env: allEnv, windowsHide: true });
  p.on("error", () => {});
  p.unref();
  if (typeof out === "number") { try { fs.closeSync(out); } catch (e) { /* egal */ } }
  return how;
}

// ---- Deinstallation ------------------------------------------------------------------------------

/** Datenordner, der gefahrlos gelöscht werden darf: im Programmordner oder eindeutig unserer */
function dataDirSafe(out, root = ROOT) {
  const o = path.resolve(out), r = path.resolve(root), home = path.resolve(os.homedir());
  if (o === r || o === home || o === path.parse(o).root) return false;
  return o.startsWith(r + path.sep) || /mtga-stats/i.test(path.basename(o)) || /mtga-stats/i.test(path.basename(path.dirname(o)));
}

/** Was der Knopf „Deinstallieren“ hier tun kann */
function uninstallInfo(root = ROOT) {
  const kind = kindOf(root);
  let out = ""; try { out = require("./paths").outDir(); } catch (e) { /* ohne Einstellungen */ }
  const base = { kind, platform: process.platform, programDir: root, dataDir: out, can: false, command: "", hint: "" };
  if (kind === "dev") return Object.assign(base, { hint: "Entwicklungsordner (Git) – hier nicht per Knopf deinstallierbar." });
  if (kind === "flatpak") return Object.assign(base, { hint: "Flatpak-Apps entfernst du über Discover oder mit diesem Befehl:", command: "flatpak uninstall " + FLATPAK_ID() });
  if (kind === "brew") return Object.assign(base, { hint: "Mit Homebrew installiert – entfernen mit:", command: "brew services stop mtga-stats && brew uninstall mtga-stats" });
  if (kind === "readonly") return Object.assign(base, { hint: "Der Programmordner ist schreibgeschützt und lässt sich hier nicht entfernen." });
  return Object.assign(base, { can: true, dataInside: path.resolve(out).startsWith(path.resolve(root) + path.sep) });
}

/** Ablauf für Linux/macOS: Dienst und Verknüpfungen weg, dann Dateien. Argumente: ROOT APPDIR OUT DATA */
const UNIX_SCRIPT = `#!/usr/bin/env bash
# MTGA Stats entfernen – aus dem Dashboard gestartet, läuft außerhalb des Companions
ROOT="$1"; APPDIR="$2"; OUT="$3"; DATA="$4"
[ -n "$ROOT" ] && [ -f "$ROOT/src/watch.js" ] || { echo "Programmordner unklar: $ROOT"; exit 1; }
sleep 2
bash "$ROOT/install.sh" --uninstall
[ -n "$APPDIR" ] && [ "$APPDIR" != "$HOME" ] && rm -rf "$APPDIR"
if [ "$DATA" = 1 ]; then
  [ -n "$OUT" ] && rm -rf "$OUT"
  rm -rf "\${XDG_CONFIG_HOME:-$HOME/.config}/mtga-stats" "\${XDG_DATA_HOME:-$HOME/.local/share}/mtga-stats"
  rm -rf "$ROOT"
else
  # Daten und Einstellungen bleiben im Ordner liegen
  find "$ROOT" -mindepth 1 -maxdepth 1 ! -name out ! -name watch-config.json -exec rm -rf {} +
fi
echo "MTGA Stats entfernt."
rm -f "$0"
`;
/** Ablauf für Windows: uninstall.ps1 (Tray, Watcher, Autostart, Verknüpfungen), dann Dateien */
const WIN_SCRIPT = `param([string]$Root, [string]$Out, [string]$Data)
# MTGA Stats entfernen – aus dem Dashboard gestartet, läuft außerhalb des Companions
$ErrorActionPreference = "Continue"
if (-not (Test-Path (Join-Path $Root "src\\watch.js"))) { Write-Output "Programmordner unklar: $Root"; exit 1 }
Start-Sleep -Seconds 2
$u = Join-Path $Root "scripts\\uninstall.ps1"
if ($Data -eq "1") { & powershell -NoProfile -ExecutionPolicy Bypass -File $u -Data } else { & powershell -NoProfile -ExecutionPolicy Bypass -File $u }
Start-Sleep -Seconds 2
if ($Data -eq "1") {
  if ($Out -and (Test-Path $Out)) { Remove-Item -LiteralPath $Out -Recurse -Force -ErrorAction SilentlyContinue }
  Set-Location $env:TEMP
  Remove-Item -LiteralPath $Root -Recurse -Force -ErrorAction SilentlyContinue
} else {
  Get-ChildItem -LiteralPath $Root -Force | Where-Object { $_.Name -ne "out" -and $_.Name -ne "watch-config.json" } | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Output "MTGA Stats entfernt."
Remove-Item -LiteralPath $MyInvocation.MyCommand.Path -Force -ErrorAction SilentlyContinue
`;

/**
 * Deinstalliert dieses Programm. data=true löscht auch die eigenen Daten (Matches, Replays,
 * Einstellungen) auf diesem Gerät; das Website-Konto bleibt immer unberührt.
 */
function uninstall({ data = false, root = ROOT, dryRun = false } = {}) {
  const info = uninstallInfo(root);
  if (!info.can) throw new Error(info.hint || "Hier nicht möglich.");
  const out = info.dataDir;
  const loeschDaten = data && dataDirSafe(out, root) ? "1" : "0";
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mtga-stats-uninstall-"));
  const logFile = path.join(os.tmpdir(), "mtga-stats-uninstall.log");
  if (process.platform === "win32") {
    const f = path.join(tmpDir, "uninstall.ps1");
    fs.writeFileSync(f, "﻿" + WIN_SCRIPT);
    const args = ["-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", f, "-Root", path.resolve(root), "-Out", path.resolve(out || path.join(root, "out")), "-Data", loeschDaten];
    if (!dryRun) runOutside("powershell", args, { logFile });
    return { ok: true, script: f, args, dataDeleted: loeschDaten === "1", logFile };
  }
  const f = path.join(tmpDir, "uninstall.sh");
  fs.writeFileSync(f, UNIX_SCRIPT, { mode: 0o700 });
  const args = [f, path.resolve(root), appDir(), path.resolve(out || path.join(root, "out")), loeschDaten];
  if (!dryRun) runOutside("bash", args, { logFile, name: "mtga-stats-uninstall" });
  return { ok: true, script: f, args, dataDeleted: loeschDaten === "1", logFile };
}

module.exports = { kindOf, updateBlocker, runOutside, uninstallInfo, uninstall, dataDirSafe, UNIX_SCRIPT, WIN_SCRIPT, ROOT };
