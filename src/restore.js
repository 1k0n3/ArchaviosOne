/**
 * Daten des Website-Kontos auf dieses Gerät holen – für ein weiteres Gerät wie das Steam Deck oder
 * einen zweiten PC. Sonst beginnt das lokale Dashboard dort leer, und unter Linux/macOS kann der
 * Companion die Sammlung nicht selbst aus dem Speicher lesen.
 *
 * Es wird nur ergänzt, nie gelöscht:
 *   - Matches: fehlende Replays landen in out/matches/, genau wie selbst aufgezeichnete
 *   - Decks, Sammlung, Kontostand: in eigenen Dateien (site-decks.json, site-collection.json,
 *     site-account.json). Sie gelten nur, solange hier nichts Eigenes vorliegt, und gehen nie zurück
 *     zur Website – sonst überschriebe ein alter Stand dieses Geräts den neueren eines anderen.
 *
 *   node src/restore.js    einmal abholen und das Dashboard neu bauen
 */
const fs = require("fs");
const path = require("path");

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return d; } };
const outDir = () => require("./paths").outDir();
const file = (name) => path.join(outDir(), name);
const statusFile = () => path.join(outDir(), "sync", "restore.json");
/** Höchstens so viele Replays pro Lauf; der Rest kommt beim nächsten Mal */
const MAX_MATCHES = 300, BATCH = 8;

/** Wie getJsonOnce, aber ein Netzaussetzer (WLAN, Aufwachen aus dem Ruhezustand) wird einmal wiederholt */
async function getJson(url, token, timeoutMs) {
  try { return await getJsonOnce(url, token, timeoutMs); }
  catch (e) {
    if (!/^Keine Verbindung|^Zeitüberschreitung/.test(e.message)) throw e;
    await new Promise((ok) => setTimeout(ok, 3000));
    return getJsonOnce(url, token, timeoutMs);
  }
}
async function getJsonOnce(url, token, timeoutMs = 60000) {
  const ac = new AbortController(), to = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: { Authorization: "Bearer " + token }, signal: ac.signal });
    if (r.status === 401) throw new Error("Gerätetoken abgelehnt (auf der Website getrennt?)");
    // Ältere Website ohne Abholstelle: nichts zu holen, kein Fehler
    if (r.status === 404) return undefined;
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  } catch (e) {
    if (e.name === "AbortError") throw new Error("Zeitüberschreitung");
    // "fetch failed" sagt nichts; der Grund steckt in e.cause (offline, Name nicht auflösbar …)
    if (e.cause) { let host = ""; try { host = new URL(url).host; } catch (x) { /* egal */ } throw new Error("Keine Verbindung zu " + host + " (" + (e.cause.code || e.cause.message || "") + ")"); }
    throw e;
  } finally { clearTimeout(to); }
}
/** Schreibt nur, wenn sich der Inhalt geändert hat; true = geändert */
function writeIfChanged(f, obj) {
  const s = JSON.stringify(obj);
  try { if (fs.readFileSync(f, "utf8") === s) return false; } catch (e) { /* neu */ }
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f + ".tmp", s);
  fs.renameSync(f + ".tmp", f);
  return true;
}

let laeuft = null;
/**
 * Holt, was dem Gerät fehlt. Rückgabe: { matches, decks, collection, account, changed, left, error }.
 * opt.rebuild() baut danach das Dashboard neu (nur wenn sich etwas geändert hat).
 */
function run(opt = {}) {
  if (laeuft) return laeuft;
  laeuft = runOnce(opt).finally(() => { laeuft = null; });
  return laeuft;
}
async function runOnce({ log = () => {}, rebuild = module.exports.defaultRebuild || null } = {}) {
  const sync = require("./sync");
  const dev = sync.device(), url = sync.baseUrl();
  const res = { matches: 0, decks: 0, collection: false, account: false, changed: false, left: 0, error: null };
  if (!dev || !dev.token || !url) return Object.assign(res, { error: "nicht verbunden" });
  try {
    const idx = await getJson(url + "/api/v1/restore", dev.token);
    if (idx === undefined) return Object.assign(res, { error: "Die Website bietet das Abholen noch nicht an." });

    // Matches: was hier fehlt, stückweise holen
    const mdir = path.join(outDir(), "matches");
    fs.mkdirSync(mdir, { recursive: true });
    const lokal = new Set(fs.readdirSync(mdir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)));
    const fehlt = (idx.matches || []).map((m) => String(m[0])).filter((id) => /^[A-Za-z0-9_.:-]{4,80}$/.test(id) && !lokal.has(id));
    const jetzt = fehlt.slice(0, MAX_MATCHES);
    res.left = fehlt.length - jetzt.length;
    for (let i = 0; i < jetzt.length; i += BATCH) {
      const teil = jetzt.slice(i, i + BATCH);
      const j = await getJson(url + "/api/v1/restore/matches?ids=" + teil.map(encodeURIComponent).join(","), dev.token, 120000);
      for (const e of (j && j.matches) || []) {
        const rp = e && e.replay;
        if (!rp || !rp.match || !Array.isArray(rp.frames) || !teil.includes(e.id) || String(rp.match.matchId || e.id) !== e.id) continue;
        const m = Object.assign({}, rp.match, { matchId: e.id, frames: rp.frames });
        if (!m.myDeck || !Array.isArray(m.players)) continue;
        const f = path.join(mdir, e.id + ".json");
        if (fs.existsSync(f)) continue;   // inzwischen selbst aufgezeichnet
        fs.writeFileSync(f, JSON.stringify(m));
        res.matches++;
      }
    }

    // Decks des Kontos (gelten nur, wenn das Arena-Log hier noch keine liefert)
    const decks = (idx.decks || []).filter((d) => d && d.id && d.zones && typeof d.zones === "object")
      .map((d) => ({ id: String(d.id), name: String(d.name || ""), format: d.format || null, lastUpdated: d.lastUpdated || null, tile: +d.tile || 0, zones: d.zones, archived: !!d.archived, archivedAt: d.archivedAt || null }));
    if (writeIfChanged(file("site-decks.json"), { decks })) res.decks = decks.length;

    // Sammlung und Kontostand nur holen, wenn die Website einen anderen Stand hat als zuletzt geholt
    if (idx.collection && (readJson(file("site-collection.json"), {}) || {}).takenAt !== idx.collection) {
      const c = await getJson(url + "/api/v1/restore/collection", dev.token);
      if (c && Array.isArray(c.snapshot)) { writeIfChanged(file("site-collection.json"), { takenAt: c.takenAt, snapshot: c.snapshot }); res.collection = true; }
    }
    if (idx.account && (readJson(file("site-account.json"), {}) || {}).takenAt !== idx.account) {
      const a = await getJson(url + "/api/v1/restore/account", dev.token);
      if (a && a.data && typeof a.data === "object") { writeIfChanged(file("site-account.json"), Object.assign({}, a.data, { takenAt: a.takenAt })); res.account = true; }
    }
    res.changed = !!(res.matches || res.decks || res.collection || res.account);
  } catch (e) {
    res.error = String(e.message || e);
  }
  try { writeIfChanged(statusFile(), Object.assign({ at: new Date().toISOString() }, res)); } catch (e) { /* egal */ }
  if (res.matches) log(`Vom Konto geholt: ${res.matches} Matches${res.left ? ` (${res.left} folgen beim nächsten Abgleich)` : ""}`);
  if (res.collection) log("Vom Konto geholt: Sammlung");
  if (res.error && res.error !== "nicht verbunden") log("Abholen vom Konto: " + res.error);
  if (res.changed && rebuild) { try { await rebuild(); } catch (e) { log("Dashboard nach dem Abholen: " + e.message); } }
  return res;
}
/** Letzter Lauf, für die Einstellungen */
const status = () => readJson(statusFile(), null);

/** Dashboard ohne laufenden Watcher neu bauen (Einstellungen, Kommandozeile) */
function rebuildStandalone() {
  const lib = require("./lib"), webgen = require("./webgen");
  const { cards } = lib.loadCards(lib.findCardDb());
  webgen.build(outDir(), cards);
}

module.exports = { run, status, rebuildStandalone, MAX_MATCHES, defaultRebuild: null };

if (require.main === module) {
  run({ log: console.log, rebuild: rebuildStandalone }).then((r) => { console.log(JSON.stringify(r)); process.exit(r.error && r.error !== "nicht verbunden" ? 1 : 0); });
}
