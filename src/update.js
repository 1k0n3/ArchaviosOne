/**
 * Automatische Updates des Companions: neuesten Stand von GitHub (Zweig main) holen, sobald Arena
 * nicht läuft. Einstellungen (watch-config.json) und Daten (out/) bleiben unberührt.
 *
 *   Linux/macOS: über "mtga-stats update" (lädt install.sh von der Website, die das Archiv von GitHub
 *                holt und neu installiert; der Hintergrunddienst startet danach mit dem neuen Stand)
 *   Windows:     Archiv laden, mit tar.exe entpacken, Dateien ersetzen; der vom Tray gestartete
 *                Watcher startet mit dem neuen Stand neu, sobald Arena nicht läuft
 *
 * Nie in einem Git-Arbeitsordner (Entwicklung) und nie, wenn der Programmordner nicht beschreibbar ist
 * (Flatpak, Homebrew – die haben ihre eigenen Updates). Abschaltbar: "autoUpdate": false.
 *
 *   node src/update.js            Stand prüfen
 *   node src/update.js --apply    jetzt aktualisieren
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const INFO = path.join(ROOT, ".install.json");
const appDir = () => process.env.MTGA_STATS_HOME || path.join(os.homedir(), ".mtga-stats");
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return d; } };
const statusFile = () => path.join(require("./paths").outDir(), "update.json");
const SHA = /^[0-9a-f]{40}$/;
// Nur für Tests umlenkbar
const GH_API = () => process.env.MTGA_STATS_GITHUB_API || "https://api.github.com";
const CODELOAD = () => process.env.MTGA_STATS_CODELOAD || "https://codeload.github.com";

/** Darf dieser Ordner sich selbst ersetzen? Grund, wenn nicht. */
function blocker(root = ROOT) { return require("./program").updateBlocker(root); }
const enabled = () => require("./paths").readConfig().autoUpdate !== false;

/** Netzaussetzer (langsamer Verbindungsaufbau zu GitHub, WLAN) zweimal mit kurzer Pause wiederholen */
async function nochmal(fn, mal = 3) {
  for (let i = 1; ; i++) {
    try { return await fn(); }
    catch (e) { if (!e.netz || i >= mal) throw e; await new Promise((ok) => setTimeout(ok, 2000 * i)); }
  }
}
function fetchText(url, headers = {}, timeoutMs = 30000) {
  return nochmal(async () => {
    const ac = new AbortController(), to = setTimeout(() => ac.abort(), timeoutMs);
    const netz = (m) => { const x = new Error(m); x.netz = true; return x; };
    try {
      const r = await fetch(url, { headers: Object.assign({ "User-Agent": "MTGA-Stats-Companion" }, headers), signal: ac.signal });
      if (!r.ok) throw new Error("HTTP " + r.status + " von " + new URL(url).host);
      return await r.text();
    } catch (e) {
      if (e.name === "AbortError") throw netz("Zeitüberschreitung bei " + new URL(url).host);
      if (e.cause) throw netz("Keine Verbindung zu " + new URL(url).host + " (" + (e.cause.code || e.cause.message || "") + ")");
      throw e;
    } finally { clearTimeout(to); }
  });
}
/** GitHub-Projekt: aus der Installation, sonst von der Website (dieselbe Quelle wie der Download) */
async function repoOf() {
  const i = readJson(INFO, null);
  if (i && /^[\w.-]+\/[\w.-]+$/.test(i.repo || "")) return i.repo;
  const site = String(require("./paths").readConfig().syncUrl || "").replace(/\/$/, "");
  if (!site) return null;
  const j = JSON.parse(await fetchText(site + "/api/v1/companion"));
  return j && /^[\w.-]+\/[\w.-]+$/.test(j.repo || "") ? j.repo : null;
}

let letzte = readJson(statusFile(), null);
function save(s) { letzte = s; try { fs.writeFileSync(statusFile(), JSON.stringify(s)); } catch (e) { /* egal */ } return s; }

/** Gibt es einen neueren Stand? { current, latest, available, repo, blocked, enabled, checkedAt, error } */
async function check() {
  const cur = (readJson(INFO, {}) || {}).sha || null;
  const s = { current: cur, latest: null, available: false, repo: null, blocked: blocker(), enabled: enabled(), checkedAt: new Date().toISOString(), error: null,
    appliedAt: (letzte && letzte.appliedAt) || null, appliedSha: (letzte && letzte.appliedSha) || null };
  try {
    s.repo = await repoOf();
    if (!s.repo) throw new Error("Keine Download-Quelle bekannt (syncUrl in watch-config.json).");
    const sha = (await fetchText(GH_API() + "/repos/" + s.repo + "/commits/main", { Accept: "application/vnd.github.sha" })).trim();
    if (!SHA.test(sha)) throw new Error("GitHub lieferte keinen gültigen Stand.");
    s.latest = sha;
    s.available = sha !== cur;
  } catch (e) { s.error = String(e.message || e); }
  return save(s);
}

/** Linux/macOS: Installer außerhalb des eigenen Dienstes starten, damit dessen Neustart ihn nicht beendet */
function applyUnix(sha, log) {
  const ctl = path.join(ROOT, "scripts", "unix", "mtga-stats");
  const logFile = path.join(appDir(), "update.log");
  const how = require("./program").runOutside("bash", [ctl, "update", "--auto"], { env: { MTGA_STATS_SHA: sha }, logFile, name: "mtga-stats-update" });
  log("Update gestartet (" + how + "), Protokoll: " + logFile);
}

/** Windows: Archiv laden, entpacken, Programmdateien ersetzen (Einstellungen und Daten bleiben) */
async function applyWindows(s, log, root = ROOT) {
  const { spawnSync } = require("child_process");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mtga-update-"));
  try {
    const buf = await nochmal(async () => {
      const ac = new AbortController(), to = setTimeout(() => ac.abort(), 300000);
      try {
        const r = await fetch(CODELOAD() + "/" + s.repo + "/tar.gz/" + s.latest, { headers: { "User-Agent": "MTGA-Stats-Companion" }, signal: ac.signal });
        if (!r.ok) throw new Error("Download: HTTP " + r.status);
        return Buffer.from(await r.arrayBuffer());
      } catch (e) {
        if (e.cause) { const x = new Error("Keine Verbindung zu codeload.github.com (" + (e.cause.code || e.cause.message || "") + ")"); x.netz = true; throw x; }
        throw e;
      } finally { clearTimeout(to); }
    });
    const tgz = path.join(tmp, "neu.tar.gz"), dir = path.join(tmp, "neu");
    fs.writeFileSync(tgz, buf); fs.mkdirSync(dir);
    const sysTar = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
    const t = spawnSync(fs.existsSync(sysTar) ? sysTar : "tar", ["-xzf", tgz, "-C", dir], { stdio: "pipe" });
    if (t.status !== 0) throw new Error("Entpacken fehlgeschlagen: " + String(t.stderr || "").trim().slice(0, 200));
    const top = fs.readdirSync(dir).map((d) => path.join(dir, d)).find((d) => fs.statSync(d).isDirectory());
    if (!top || !fs.existsSync(path.join(top, "src", "watch.js"))) throw new Error("Archiv unvollständig");
    const n = copyOver(top, root, log);
    fs.writeFileSync(path.join(root, ".install.json"), JSON.stringify({ repo: s.repo, sha: s.latest, at: new Date().toISOString() }));
    log("Update: " + n + " Dateien ersetzt. Der Watcher startet mit dem neuen Stand neu, sobald Arena nicht läuft.");
  } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* egal */ } }
}
/** Neue Programmdateien über den Ordner legen; eigene Einstellungen und Daten nie anfassen */
function copyOver(src, dst, log = () => {}) {
  const KEEP = new Set(["out", ".git", ".install.json", "deploy-config.json", "node_modules"]);
  let n = 0;
  const walk = (a, b, top) => {
    for (const name of fs.readdirSync(a)) {
      if (top && KEEP.has(name)) continue;
      if (top && name === "watch-config.json" && fs.existsSync(path.join(b, name))) continue;
      const s = path.join(a, name), d = path.join(b, name);
      if (fs.statSync(s).isDirectory()) { fs.mkdirSync(d, { recursive: true }); walk(s, d, false); continue; }
      try {
        if (fs.existsSync(d) && fs.readFileSync(d).equals(fs.readFileSync(s))) continue;
        fs.copyFileSync(s, d); n++;
      } catch (e) { log("Update: " + path.relative(dst, d) + " nicht ersetzt (" + e.code + ")"); }
    }
  };
  walk(src, dst, true);
  return n;
}

let laeuft = false;
/** Prüfen und bei Bedarf aktualisieren. opt.force: auch ohne autoUpdate (Knopf „Jetzt aktualisieren“) */
async function run({ log = () => {}, force = false } = {}) {
  if (laeuft) return letzte;
  // Gesperrter Ordner (Entwicklung, Flatpak): automatisch gar nicht erst nachfragen
  if (!force && blocker()) return status();
  laeuft = true;
  try {
    const s = await check();
    if (s.error || !s.available) return s;
    if (s.blocked) return s;
    if (!force && !s.enabled) return s;
    if (require("./lib").mtgaPid()) return save(Object.assign(s, { waiting: "Arena läuft – Update danach." }));
    // Derselbe Stand wurde vor kurzem schon eingespielt, ist aber nicht angekommen: nicht im Kreis laufen
    if (!force && letzte && letzte.appliedSha === s.latest && Date.now() - Date.parse(letzte.appliedAt || 0) < 12 * 3600 * 1000) return save(Object.assign(s, { appliedAt: letzte.appliedAt, appliedSha: letzte.appliedSha, waiting: "Update auf diesen Stand lief schon, ohne anzukommen – Protokoll: ~/.mtga-stats/update.log" }));
    log("Update verfügbar: " + (s.current ? s.current.slice(0, 7) : "unbekannter Stand") + " → " + s.latest.slice(0, 7));
    s.appliedAt = new Date().toISOString(); s.appliedSha = s.latest;
    save(s);
    if (process.platform === "win32") await applyWindows(s, log);
    else applyUnix(s.latest, log);
    return s;
  } catch (e) {
    log("Update: " + (e.message || e));
    return save(Object.assign({}, letzte || {}, { error: String(e.message || e) }));
  } finally { laeuft = false; }
}
// Der installierte Stand kommt immer aus .install.json; eine gespeicherte Prüfung (auch eine mitkopierte) überdeckt ihn nicht
const status = () => {
  const cur = (readJson(INFO, {}) || {}).sha || null;
  const s = Object.assign({}, letzte || {});
  if (s.latest) s.available = s.latest !== cur;
  return Object.assign(s, { current: cur, blocked: blocker(), enabled: enabled(), kind: require("./program").kindOf(), platform: process.platform, version: (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version; } catch (e) { return ""; } })() });
};

module.exports = { check, run, status, blocker, copyOver, applyWindows };

if (require.main === module) {
  (process.argv.includes("--apply") ? run({ log: console.log, force: true }) : check()).then((s) => console.log(JSON.stringify(s, null, 2)));
}
