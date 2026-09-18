#!/usr/bin/env node
/**
 * MTGA Collection Watcher
 *
 * Läuft dauerhaft im Hintergrund:
 *   - prüft alle pollSec, ob MTGA läuft
 *   - sobald es läuft: Sammlung lesen -> out/mtga-collection_<Sitzung>_vorher.csv
 *   - danach alle checkSec auf Änderungen prüfen (nur der bekannte Speicherblock wird
 *     nachgelesen, alle fullScanSec ein kompletter Scan); Änderungen sofort in
 *     out/changes.csv protokollieren
 *   - beim Beenden von MTGA: out/mtga-collection_<Sitzung>_nachher.csv,
 *     out/mtga-collection_<Sitzung>_aenderungen.csv (nur bei Änderungen),
 *     Zeile in out/sessions.csv, Deck-Export nach out/decks/
 *   - Unterschiede zwischen zwei Sitzungen (Watcher lief nicht) landen ebenfalls in changes.csv
 *
 * Einstellungen: watch-config.json (siehe dort), überschreibbar per Kommandozeile:
 *   node watch.js [--config DATEI] [--poll S] [--check S] [--full-scan S] [--retry S]
 *                 [--start-delay S] [--min-cards N] [--out DIR] [--once]
 *   --once: eine Sitzung simulieren (Vorher, eine Prüfung, Nachher) und beenden – zum Testen
 */
const fs = require("fs");
const path = require("path");
const lib = require("./lib");
const { exportDecks } = require("./decks");
const matches = require("./matches");
const webgen = require("./webgen");
const serve = require("./serve");
const sync = require("./sync");

// ---- Konfiguration --------------------------------------------------------------------------

const DEFAULTS = {
  pollSec: 300, checkSec: 60, fullScanSec: 600, retrySec: 60, startDelaySec: 0,
  minCards: 200, maxQty: 400, writeEndCsvIfUnchanged: true, outDir: "out", anchors: [], db: "",
  matchCheckSec: 10, webDashboard: true, webServer: true, webPort: 8765, prefetchCardImages: false
};

function loadConfig() {
  const args = process.argv.slice(2);
  let cfgPath = path.join(__dirname, "..", "watch-config.json");
  const cli = {};
  let once = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = () => args[++i];
    if (a === "--config") cfgPath = next();
    else if (a === "--poll") cli.pollSec = +next();
    else if (a === "--check") cli.checkSec = +next();
    else if (a === "--full-scan") cli.fullScanSec = +next();
    else if (a === "--retry") cli.retrySec = +next();
    else if (a === "--start-delay") cli.startDelaySec = +next();
    else if (a === "--min-cards") cli.minCards = +next();
    else if (a === "--out") cli.outDir = next();
    else if (a === "--match-check") cli.matchCheckSec = +next();
    else if (a === "--once") once = true;
    else if (a === "-h" || a === "--help") { console.log(fs.readFileSync(__filename, "utf8").split("*/")[0]); process.exit(0); }
    else { console.error("Unbekannte Option: " + a); process.exit(1); }
  }
  let file = {};
  if (fs.existsSync(cfgPath)) {
    const raw = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    for (const k of Object.keys(raw)) if (!k.startsWith("_")) file[k] = raw[k];
  }
  const cfg = Object.assign({}, DEFAULTS, file, cli);
  cfg.once = once;
  cfg.outDir = path.isAbsolute(cfg.outDir) ? cfg.outDir : path.join(__dirname, "..", cfg.outDir);
  return cfg;
}

process.on("unhandledRejection", (e) => { try { log("Unerwarteter Fehler (Promise): " + (e && e.stack || e)); } catch (x) { /* ignorieren */ } });
process.on("uncaughtException", (e) => { try { log("Unerwarteter Fehler: " + (e && e.stack || e)); } catch (x) { /* ignorieren */ } });

const cfg = loadConfig();
fs.mkdirSync(cfg.outDir, { recursive: true });
const LOG_FILE = path.join(cfg.outDir, "watch.log");
const STATE_FILE = path.join(cfg.outDir, "state.json");
const CHANGES_FILE = path.join(cfg.outDir, "changes.csv");
const SESSIONS_FILE = path.join(cfg.outDir, "sessions.csv");
const CHANGES_HEAD = ["Zeit", "Sitzung", "Ereignis", "Name", "Set", "Nr", "Seltenheit", "GrpId", "Vorher", "Nachher", "Differenz"];
const SESSIONS_HEAD = ["Sitzung", "Start", "Ende", "Drucke vorher", "Karten vorher", "Drucke nachher", "Karten nachher", "Neue Drucke", "Geänderte Drucke", "Differenz Karten"];

function log(msg) {
  const line = `[${lib.stampFull()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + "\n"); } catch (e) { /* ignorieren */ }
}

const sleep = (s) => new Promise((r) => setTimeout(r, Math.max(0, s) * 1000));

// ---- Zustand (letzter bekannter Stand) ---------------------------------------------------------

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    return { snapshot: new Map(s.snapshot), updatedAt: s.updatedAt, session: s.session };
  } catch (e) {
    return null;
  }
}

function saveState(snapshot, session) {
  fs.writeFileSync(STATE_FILE, JSON.stringify({ updatedAt: new Date().toISOString(), session, snapshot: [...snapshot] }));
}

// ---- Scans -------------------------------------------------------------------------------------

let cards, anchors;

/** Kompletter Speicher-Scan. Rückgabe: { snapshot, block } oder null */
function fullScan(pid) {
  const r = lib.runScan(cards, { maxQty: cfg.maxQty, pid });
  if (r.status !== 0) {
    const m = r.output.match(/Zugriff auf MTGA verweigert[^\n"]*/);
    log("Scan fehlgeschlagen: " + (m ? m[0] : r.output.split("\n").filter(Boolean).slice(-3).join(" | ")));
    return null;
  }
  const best = lib.chooseBlock(r.json, cards, anchors);
  if (!best) { log("Kein Sammlungs-Block gefunden (noch nicht eingeloggt?)."); return null; }
  if (best.unique < cfg.minCards) { log(`Block zu klein (${best.unique} < ${cfg.minCards}), Sammlung noch nicht geladen.`); return null; }
  return { snapshot: lib.snapshotFromBlock(best), block: best };
}

/** Schnellprüfung des bekannten Blocks. Rückgabe wie fullScan oder null (dann kompletter Scan nötig). */
function quickScan(pid, prevBlock) {
  const address = parseInt(prevBlock.address, 16) - 64;
  const span = prevBlock.count * prevBlock.stride * 4;
  const length = span + Math.max(256 * 1024, span);
  const r = lib.runScan(cards, { maxQty: cfg.maxQty, pid, region: { address, length } });
  if (r.status !== 0 || !r.json) return null;
  const best = lib.chooseBlock(r.json, cards, anchors);
  if (!best) return null;
  if (best.unique < cfg.minCards || best.unique < prevBlock.unique * 0.9 || best.dups > best.count * 0.05) return null;
  return { snapshot: lib.snapshotFromBlock(best), block: best };
}

// ---- Protokollierung von Änderungen ----------------------------------------------------------------

function describe(id) {
  const c = cards.get(id);
  return c ? [c.Name, c.ExpansionCode, c.CollectorNumber, lib.RARITY[c.Rarity] || c.Rarity] : ["? (" + id + ")", "", "", ""];
}

function recordChanges(diffs, session, event) {
  const now = lib.stampFull();
  const lines = diffs.map((d) => [now, session, event, ...describe(d.grpId), d.grpId, d.before, d.after, (d.delta > 0 ? "+" : "") + d.delta]);
  lib.appendCsv(CHANGES_FILE, CHANGES_HEAD, lines);
}

function summarize(diffs) {
  const added = diffs.filter((d) => d.before === 0).length;
  const changed = diffs.length - added;
  const delta = diffs.reduce((s, d) => s + d.delta, 0);
  return { added, changed, delta };
}

function writeSessionDiffCsv(file, diffs) {
  const lines = [lib.csvLine(["Name", "Set", "Nr", "Seltenheit", "GrpId", "Vorher", "Nachher", "Differenz"])];
  const rows = diffs.map((d) => ({ d, desc: describe(d.grpId) })).sort((a, b) => a.desc[0].localeCompare(b.desc[0], "en"));
  for (const { d, desc } of rows) lines.push(lib.csvLine([...desc, d.grpId, d.before, d.after, (d.delta > 0 ? "+" : "") + d.delta]));
  fs.writeFileSync(file, "﻿" + lines.join("\r\n") + "\r\n");
}

function tryExportDecks() {
  refreshKnownDecks();
  try {
    const r = exportDecks(cards, cfg.outDir, { txt: true });
    log(`Decks exportiert: ${r.count} -> ${path.relative(cfg.outDir, r.csvFile)}`);
  } catch (e) {
    log("Deck-Export übersprungen: " + e.message);
  }
}

// ---- Matches (Player.log mitlesen) --------------------------------------------------------------------

let prefetchJob = null;
/** Echte Kartenbilder für Matches und Decks im Hintergrund vorladen (einmalig, danach offline) */
function prefetchCardImages() {
  if (!cfg.prefetchCardImages || prefetchJob) return;
  prefetchJob = (async () => {
    try {
      const ids = webgen.neededImages(cfg.outDir, cards).cards.filter((g) => !cards.get(g).IsToken);
      const r = await serve.prefetch(ids, path.join(cfg.outDir, "web"), log);
      if (r.done || r.failed) log(`Kartenbilder vorgeladen: ${r.done} neu, ${r.failed} nicht gefunden`);
    } catch (e) {
      log("Kartenbilder vorladen: " + e.message);
    } finally { prefetchJob = null; }
  })();
}

function buildWeb() {
  if (!cfg.webDashboard) return;
  try {
    const r = webgen.build(cfg.outDir, cards);
    log(`Dashboard aktualisiert: ${r.matches} Matches, ${r.decks} Decks -> ${path.relative(cfg.outDir, r.index)}`);
    prefetchCardImages();
    // Decks in die Cloud-Warteschlange (nur geänderte), danach senden
    try { const n = sync.enqueueDecks(webgen.readDecks(cards)); if (n) log(`Sync: ${n} Decks eingereiht`); } catch (e) { log("Sync: Decks nicht eingereiht: " + e.message); }
    syncFlush();
  } catch (e) {
    log("Dashboard nicht aktualisiert: " + e.message);
  }
}
/** Warteschlange an die Website senden (still, wenn nicht verbunden oder offline) */
function syncFlush() {
  sync.flush(log).then((r) => { if (r.error && r.error !== "nicht verbunden") log("Sync: " + r.error + (r.left ? ` (${r.left} wartend)` : "")); }).catch((e) => log("Sync: " + e.message));
}

function onMatch(m) {
  const r = matches.saveMatch(m, cfg.outDir, cards);
  if (!r.isNew) return;
  const s = matches.matchSummary(m, cards);
  matches.writeIndexCsv(cfg.outDir, cards);
  try { sync.enqueueMatch(m, s, sync.tokensOf(m, cards)); } catch (e) { log("Sync: Match nicht eingereiht: " + e.message); }
  log(`Match: ${s.result} gegen ${s.opponent} mit ${s.myDeck}${s.commander ? " (" + s.commander + ")" : ""}, ${s.turns} Züge, ${s.opponentCards.length} Gegnerkarten gesehen`);
  buildWeb();
}

let logTailer = null;

function refreshKnownDecks() {
  try { matches.setKnownDecks(webgen.readDecks(cards)); } catch (e) { /* kein Log */ }
}

function matchCatchUp() {
  refreshKnownDecks();
  const dir = matches.defaultLogDir();
  const prev = path.join(dir, "Player-prev.log");
  if (fs.existsSync(prev)) matches.parseLogFile(prev, onMatch);
  logTailer = new matches.LogTailer(path.join(dir, "Player.log"), new matches.MatchParser(onMatch));
  logTailer.poll();
}

async function matchLoop(pid) {
  while (lib.mtgaPid() === pid) {
    try { if (logTailer) logTailer.poll(); } catch (e) { log("Match-Log: " + e.message); }
    await sleep(cfg.matchCheckSec);
  }
  try { if (logTailer) logTailer.poll(); } catch (e) { /* ignorieren */ }
}

// ---- Sitzung -----------------------------------------------------------------------------------------

async function runSession(pid) {
  const startedAt = new Date();
  const session = lib.stampDate(startedAt) + "_" + lib.stampTime(startedAt);
  const base = path.join(cfg.outDir, "mtga-collection_" + session);
  log(`MTGA läuft (PID ${pid}), Sitzung ${session}`);
  const matchTask = matchLoop(pid);
  if (cfg.startDelaySec > 0) await sleep(cfg.startDelaySec);

  // Startzustand holen (mit Wiederholung, bis die Sammlung im Speicher liegt)
  let start = null;
  while (!start) {
    if (lib.mtgaPid() !== pid) { log("MTGA wurde beendet, bevor die Sammlung gelesen werden konnte."); return; }
    start = fullScan(pid);
    if (!start) await sleep(cfg.retrySec);
  }
  if (cfg.once) { await matchTask; }
  lib.writeCollectionCsv(base + "_vorher.csv", lib.toRows(start.snapshot, cards));
  log(`Vorher: ${start.snapshot.size} Drucke, ${lib.totalCards(start.snapshot)} Karten -> ${path.basename(base)}_vorher.csv`);

  // Unterschiede zum letzten bekannten Stand (z. B. Watcher lief nicht)
  const prev = loadState();
  if (prev) {
    const d = lib.diffSnapshots(prev.snapshot, start.snapshot);
    if (d.length) {
      recordChanges(d, session, "zwischen Sitzungen");
      const s = summarize(d);
      log(`Seit letztem Stand (${prev.updatedAt}): ${s.added} neue Drucke, ${s.changed} geändert, ${s.delta > 0 ? "+" : ""}${s.delta} Karten`);
    }
  }
  saveState(start.snapshot, session);
  try { sync.enqueueCollection(start.snapshot); } catch (e) { /* nicht verbunden */ }
  tryExportDecks();

  // Laufende Prüfung
  let current = start.snapshot;
  let block = start.block;
  let lastFull = Date.now();
  let forceFull = false;
  let checks = 0;
  while (true) {
    await sleep(cfg.checkSec);
    if (lib.mtgaPid() !== pid) break;
    const dueFull = forceFull || (cfg.fullScanSec > 0 && Date.now() - lastFull >= cfg.fullScanSec * 1000);
    let res = dueFull ? null : quickScan(pid, block);
    if (!res) {
      if (lib.mtgaPid() !== pid) break;
      res = fullScan(pid);
      lastFull = Date.now();
      forceFull = false;
      if (!res) { forceFull = true; continue; }
    }
    checks++;
    block = res.block;
    const d = lib.diffSnapshots(current, res.snapshot);
    if (d.length) {
      recordChanges(d, session, "während Sitzung");
      const s = summarize(d);
      log(`Änderung: ${s.added} neue Drucke, ${s.changed} geändert, ${s.delta > 0 ? "+" : ""}${s.delta} Karten (jetzt ${lib.totalCards(res.snapshot)})`);
      current = res.snapshot;
      saveState(current, session);
    }
    if (cfg.once) break;
  }

  // Sitzungsende
  const diffs = lib.diffSnapshots(start.snapshot, current);
  const s = summarize(diffs);
  if (diffs.length || cfg.writeEndCsvIfUnchanged) {
    lib.writeCollectionCsv(base + "_nachher.csv", lib.toRows(current, cards));
  }
  if (diffs.length) writeSessionDiffCsv(base + "_aenderungen.csv", diffs);
  lib.appendCsv(SESSIONS_FILE, SESSIONS_HEAD, [[
    session, lib.stampFull(startedAt), lib.stampFull(),
    start.snapshot.size, lib.totalCards(start.snapshot), current.size, lib.totalCards(current),
    s.added, s.changed, (s.delta > 0 ? "+" : "") + s.delta
  ]]);
  saveState(current, session);
  try { sync.enqueueCollection(current); } catch (e) { /* nicht verbunden */ }
  if (!cfg.once) await matchTask;
  tryExportDecks();
  buildWeb();
  log(`Sitzung beendet nach ${checks} Prüfungen: ${s.added} neue Drucke, ${s.changed} geändert, ${s.delta > 0 ? "+" : ""}${s.delta} Karten` +
    (diffs.length ? ` -> ${path.basename(base)}_aenderungen.csv` : " (keine Änderungen)"));
}

// ---- Hauptschleife ------------------------------------------------------------------------------------

setInterval(syncFlush, 5 * 60 * 1000);
(async function main() {
  const dbPath = lib.findCardDb(cfg.db);
  const loaded = lib.loadCards(dbPath);
  cards = loaded.cards;
  anchors = lib.resolveAnchors(cards, cfg.anchors);
  log(`Watcher gestartet: poll ${cfg.pollSec}s, check ${cfg.checkSec}s, fullScan ${cfg.fullScanSec}s, matchCheck ${cfg.matchCheckSec}s, out ${cfg.outDir}, DB ${loaded.version}` + (cfg.once ? " (once)" : ""));
  try { matchCatchUp(); buildWeb(); } catch (e) { log("Match-Import beim Start: " + e.message); }
  if (cfg.webServer && cfg.webDashboard) serve.start(path.join(cfg.outDir, "web"), cfg.webPort, log);

  while (true) {
    const pid = lib.mtgaPid();
    if (!pid) {
      if (cfg.once) { log("MTGA läuft nicht."); process.exit(2); }
      await sleep(cfg.pollSec);
      continue;
    }
    try {
      await runSession(pid);
    } catch (e) {
      log("Fehler in Sitzung: " + (e.stack || e.message));
    }
    if (cfg.once) break;
    // warten, bis MTGA wirklich weg ist (oder neu gestartet wurde)
    while (lib.mtgaPid() === pid) await sleep(cfg.pollSec);
    log("MTGA beendet, warte auf nächsten Start.");
  }
})().catch((e) => { log("Abbruch: " + (e.stack || e.message)); process.exit(1); });
