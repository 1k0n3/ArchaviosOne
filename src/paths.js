// Plattform-Pfade: wo Arena sein Player.log und seine Spieldaten ablegt – Windows, macOS, Linux (Steam/Proton, Wine).
// Überschreibbar per Umgebungsvariablen MTGA_LOG_DIR (Ordner mit Player.log) und MTGA_DIR (Ordner mit MTGA_Data bzw. Data).
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

const STEAM_APP_ID = "2141910";   // Magic: The Gathering Arena bei Steam
const LOG_SUB = ["AppData", "LocalLow", "Wizards Of The Coast", "MTGA"];

/** Kandidaten für den Ordner mit Player.log, in Prüfreihenfolge (reine Funktion, testbar) */
function logDirCandidates(platform = process.platform, home = os.homedir(), env = process.env) {
  const out = [];
  if (env.MTGA_LOG_DIR) out.push(env.MTGA_LOG_DIR);
  if (platform === "win32") out.push(path.join(home, ...LOG_SUB));
  else if (platform === "darwin") out.push(path.join(home, "Library", "Logs", "Wizards Of The Coast", "MTGA"));
  else {
    // Steam (nativ, ~/.steam-Link, Flatpak) mit Proton-Präfix, danach Wine/Lutris/Bottles
    const steamRoots = [path.join(home, ".local", "share", "Steam"), path.join(home, ".steam", "steam"), path.join(home, ".steam", "root"),
      path.join(home, ".var", "app", "com.valvesoftware.Steam", ".local", "share", "Steam")];
    for (const r of steamRoots) out.push(path.join(r, "steamapps", "compatdata", STEAM_APP_ID, "pfx", "drive_c", "users", "steamuser", ...LOG_SUB));
    for (const prefix of winePrefixes(home)) for (const u of usersOf(prefix)) out.push(path.join(prefix, "drive_c", "users", u, ...LOG_SUB));
  }
  return [...new Set(out)];
}
/** Kandidaten für den Installationsordner (enthält MTGA_Data bzw. Data), in Prüfreihenfolge */
function installDirCandidates(platform = process.platform, home = os.homedir(), env = process.env) {
  const out = [];
  if (env.MTGA_DIR) out.push(env.MTGA_DIR);
  if (platform === "win32") out.push("C:\\Program Files\\Wizards of the Coast\\MTGA", "C:\\Program Files (x86)\\Wizards of the Coast\\MTGA",
    "C:\\Program Files\\Epic Games\\MagicTheGathering", "C:\\Program Files (x86)\\Steam\\steamapps\\common\\MTGA");
  else if (platform === "darwin") out.push("/Applications/MTGA.app/Contents/Resources", path.join(home, "Applications", "MTGA.app", "Contents", "Resources"),
    path.join(home, "Library", "Application Support", "Steam", "steamapps", "common", "MTGA", "MTGA.app", "Contents", "Resources"));
  else {
    const steamRoots = [path.join(home, ".local", "share", "Steam"), path.join(home, ".steam", "steam"), path.join(home, ".steam", "root"),
      path.join(home, ".var", "app", "com.valvesoftware.Steam", ".local", "share", "Steam")];
    for (const r of steamRoots) out.push(path.join(r, "steamapps", "common", "MTGA"));
    for (const prefix of winePrefixes(home)) out.push(path.join(prefix, "drive_c", "Program Files", "Wizards of the Coast", "MTGA"), path.join(prefix, "drive_c", "Program Files (x86)", "Wizards of the Coast", "MTGA"));
  }
  return [...new Set(out)];
}
function winePrefixes(home) {
  const out = [path.join(home, ".wine")];
  for (const base of [path.join(home, "Games"), path.join(home, ".local", "share", "lutris", "runners", "prefixes"), path.join(home, ".local", "share", "bottles", "bottles")]) {
    try { for (const d of fs.readdirSync(base)) if (/arena|mtga|magic/i.test(d)) out.push(path.join(base, d)); } catch (e) { /* gibt es nicht */ }
  }
  return out;
}
function usersOf(prefix) {
  try { return fs.readdirSync(path.join(prefix, "drive_c", "users")).filter((u) => u !== "Public"); } catch (e) { return []; }
}

/** Ersten Kandidaten wählen, in dem Player.log liegt (sonst den ersten vorhandenen Ordner, sonst den ersten) */
function pickLogDir(candidates) {
  return candidates.find((d) => fs.existsSync(path.join(d, "Player.log"))) || candidates.find((d) => fs.existsSync(d)) || candidates[0];
}
/** Ordner mit Player.log */
function findLogDir() { return pickLogDir(logDirCandidates()); }
function findLogFile() { return path.join(findLogDir(), "Player.log"); }

/** Installationsordner aus dem Kopf des Player.log ("Mono path[0] = '<dir>/MTGA_Data/Managed'", auf dem Mac "<dir>/Data/Managed").
 *  Wine/Proton schreiben Windows-Pfade (C:/…) ins Log, die auf Linux nicht existieren – dann null. */
function installFromLogHead(head, platform = process.platform) {
  const m = String(head).match(/Mono path\[0\] = '(.+?)[\\/](MTGA_Data|Data)[\\/]Managed'/);
  if (!m) return null;
  if (platform !== "win32" && /^[A-Za-z]:[\\/]/.test(m[1])) return null;
  return { dir: platform === "win32" ? m[1].replace(/\//g, "\\") : m[1], dataDir: m[2] };
}
/** Installationsordner samt Namen des Datenordners ("MTGA_Data", auf dem Mac "Data"): aus dem Log, sonst aus den Kandidaten */
function findInstall() {
  const logDir = findLogDir();
  for (const f of ["Player.log", "Player-prev.log"]) {
    const p = path.join(logDir, f);
    if (!fs.existsSync(p)) continue;
    let head = "";
    try { const fd = fs.openSync(p, "r"); const buf = Buffer.alloc(4000); const n = fs.readSync(fd, buf, 0, 4000, 0); fs.closeSync(fd); head = buf.toString("utf8", 0, n); } catch (e) { continue; }
    const r = installFromLogHead(head);
    if (r && fs.existsSync(r.dir)) return r;
  }
  for (const d of installDirCandidates()) {
    for (const dataDir of ["MTGA_Data", "Data"]) if (fs.existsSync(path.join(d, dataDir, "Downloads"))) return { dir: d, dataDir };
  }
  return null;
}
function findInstallDir() { const r = findInstall(); return r ? r.dir : null; }
/** Ordner mit Downloads/Raw (Kartendatenbank) und Downloads/AssetBundle */
function findDataDir() { const r = findInstall(); return r ? path.join(r.dir, r.dataDir) : null; }

/** Prozess-ID des laufenden Arena-Clients (unter Linux der Proton-/Wine-Prozess MTGA.exe), sonst null */
function mtgaPid() {
  try {
    if (process.platform === "win32") {
      const out = execFileSync("tasklist", ["/FI", "IMAGENAME eq MTGA.exe", "/NH", "/FO", "CSV"], { encoding: "utf8" });
      const m = out.match(/^"MTGA\.exe","(\d+)"/m);
      return m ? parseInt(m[1], 10) : null;
    }
    const args = process.platform === "darwin" ? ["-x", "MTGA"] : ["-f", "MTGA\\.exe"];
    const out = execFileSync("pgrep", args, { encoding: "utf8" });
    const pid = parseInt(out.trim().split("\n")[0], 10);
    return Number.isFinite(pid) ? pid : null;
  } catch (e) { return null; }
}

/** Einstellungsdatei: MTGA_STATS_CONFIG (Flatpak, Homebrew: Programmordner schreibgeschützt), sonst watch-config.json im Tool-Ordner */
function configFile() { return process.env.MTGA_STATS_CONFIG || path.join(__dirname, "..", "watch-config.json"); }
/** Einstellungen als Objekt (ohne die _-Kommentarschlüssel); leer, wenn die Datei fehlt */
function readConfig() {
  try { const raw = JSON.parse(fs.readFileSync(configFile(), "utf8").replace(/^\uFEFF/, "")); const o = {}; for (const k of Object.keys(raw)) if (!k.startsWith("_")) o[k] = raw[k]; return o; } catch (e) { return {}; }
}
/** Ausgabeordner: outDir aus den Einstellungen (relativ zum Tool-Ordner), sonst out/ im Tool-Ordner */
function outDir() { const o = readConfig().outDir || "out"; return path.isAbsolute(o) ? o : path.join(__dirname, "..", o); }

/** Speicher-Scan der Sammlung gibt es bisher nur unter Windows (PowerShell); Matches, Decks und Konto kommen überall aus dem Log */
function memoryScanSupported() { return process.platform === "win32"; }

module.exports = { configFile, readConfig, outDir, logDirCandidates, installDirCandidates, pickLogDir, installFromLogHead, findLogDir, findLogFile, findInstall, findInstallDir, findDataDir, mtgaPid, memoryScanSupported, STEAM_APP_ID };
