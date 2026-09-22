// Erzeugt das Web-Dashboard: kopiert web/ nach <outDir>/web und schreibt data.js/data.json + matches/<id>.js
const fs = require("fs");
const path = require("path");
const paths = require("./paths");
const lib = require("./lib");
const matches = require("./matches");
const { readDecksFromLog } = require("./decks");

// [Name, Set, Nr, Seltenheit, Token, ArtId, Farben, Typen, Rahmen-Flags, Stärke, Widerstandskraft, Regeltext, Typzeile, Manakosten]
function cardEntry(c) {
  return [c.Name, c.ExpansionCode, c.CollectorNumber, lib.RARITY[c.Rarity] || "", c.IsToken ? 1 : 0, c.ArtId || 0, c.Colors || "", c.Types || "", lib.frameFlags(c), c.Power || "", c.Toughness || "", c.Text || "", c.TypeLine || "", c.ManaCost || ""];
}

/** Ausgabeordner aus watch-config.json (Standard: out/) – für das Deck-Archiv */
function readConfig() {
  return require("./paths").readConfig();
}
function defaultOutDir() {
  const root = path.join(__dirname, "..");
  const c = readConfig();
  if (c.outDir) return path.isAbsolute(c.outDir) ? c.outDir : path.join(root, c.outDir);
  return path.join(root, "out");
}
/**
 * Decks aus dem Arena-Log plus Archiv: Decks, die in Arena gelöscht wurden, bleiben mit archived/archivedAt erhalten
 * (Datei decks-archive.json im Ausgabeordner merkt sich jedes je gesehene Deck). Archiviert wird nur, wenn das Log
 * einen vollständigen Deckbestand (StartHook) enthält – sonst wäre ein frisches Log ein Löschen aller Decks.
 */
function readDecks(cards, outDir = defaultOutDir()) {
  let current = [], complete = false;
  try {
    const logDir = matches.defaultLogDir();
    let r = readDecksFromLog(path.join(logDir, "Player.log"));
    if (!r.foundStartHook) r = readDecksFromLog(path.join(logDir, "Player-prev.log"));
    complete = r.foundStartHook;
    current = [...r.decks.values()].map((d) => {
      const zones = {};
      for (const [z, entries] of Object.entries(d.zones)) zones[z] = entries.map((e) => [e.cardId, e.quantity]);
      const tile = d.tileId || ((zones.CommandZone || [])[0] || [0])[0];
      return { id: d.id, name: d.name, format: d.format, lastUpdated: d.lastUpdated, tile, zones };
    });
  } catch (e) { /* kein Log: nur Archiv */ }
  if (!outDir) return current;
  const file = path.join(outDir, "decks-archive.json");
  let seen = {};
  try { seen = JSON.parse(fs.readFileSync(file, "utf8")).seen || {}; } catch (e) { /* noch kein Archiv */ }
  const now = new Date().toISOString();
  const curIds = new Set(current.map((d) => d.id));
  if (current.length) {
    for (const d of current) seen[d.id] = Object.assign({}, d, { lastSeen: now, archivedAt: null });
    if (complete) for (const d of Object.values(seen)) if (!curIds.has(d.id) && !d.archivedAt) d.archivedAt = now;
    try { fs.mkdirSync(outDir, { recursive: true }); fs.writeFileSync(file, JSON.stringify({ seen })); } catch (e) { /* nicht schreibbar */ }
  }
  const archived = Object.values(seen).filter((d) => d.archivedAt && !curIds.has(d.id)).map((d) => ({ id: d.id, name: d.name, format: d.format, lastUpdated: d.lastUpdated, tile: d.tile, zones: d.zones, archived: true, archivedAt: d.archivedAt }));
  return current.concat(archived);
}

function collectFrameCards(m, set) {
  for (const f of m.frames) {
    for (const o of f.bf) set.add(o[1]);
    for (const o of f.st) set.add(o[1]);
    for (const o of f.cmd) set.add(o[1]);
    for (const side of f.h) for (const g of side) set.add(g);
    for (const side of f.gy) for (const g of side) set.add(g);
    for (const side of f.ex) for (const g of side) set.add(g);
    for (const e of f.ev) { if (e.g) set.add(e.g); if (typeof e.t === "number") set.add(e.t); }
  }
}

function localArtIds(webDir) {
  const d = path.join(webDir, "art");
  if (!fs.existsSync(d)) return [];
  return fs.readdirSync(d).filter((f) => f.endsWith(".jpg")).map((f) => +f.slice(0, -4));
}

const FORMAT = 4; // Format der matches/<id>.js; bei Änderung werden alle neu erzeugt

function build(outDir, cards) {
  const webDir = path.join(outDir, "web");
  const srcDir = path.join(__dirname, "..", "web");
  fs.mkdirSync(path.join(webDir, "matches"), { recursive: true });
  const fmtFile = path.join(webDir, "matches", ".format");
  let oldFmt = 0;
  try { oldFmt = +fs.readFileSync(fmtFile, "utf8"); } catch (e) { /* neu */ }
  if (oldFmt !== FORMAT) {
    for (const f of fs.readdirSync(path.join(webDir, "matches"))) if (f.endsWith(".js")) fs.unlinkSync(path.join(webDir, "matches", f));
    fs.writeFileSync(fmtFile, String(FORMAT));
  }
  // Der Assistent ist Standard und steht in den Seiten. Nur wenn er abgewählt ist ("assistant": false
  // in watch-config.json oder MTGA_ASSISTANT=0) oder die Datei fehlt, bleiben Skript und Verweis weg.
  const mitAssistent = require("./paths").assistantEnabled() && fs.existsSync(path.join(srcDir, "assistant.js"));
  const ASST_TAG = '<script src="assistant.js" data-asst="1"></script>';
  for (const f of fs.readdirSync(srcDir)) {
    const p = path.join(srcDir, f);
    // Unterordner (web/assets: Bilder der Oberfläche) mitnehmen
    if (!fs.statSync(p).isFile()) { fs.cpSync(p, path.join(webDir, f), { recursive: true }); continue; }
    if (!mitAssistent && f === "assistant.js") continue;
    if (!mitAssistent && f.endsWith(".html")) {
      fs.writeFileSync(path.join(webDir, f), fs.readFileSync(p, "utf8").split(ASST_TAG + "\n").join("").split(ASST_TAG).join(""));
      continue;
    }
    fs.copyFileSync(p, path.join(webDir, f));
  }
  if (!mitAssistent) { try { fs.unlinkSync(path.join(webDir, "assistant.js")); } catch (e) { /* war nie da */ } }
  // Icons für Manifest, App-Fenster und Tab
  const assets = path.join(__dirname, "..", "assets");
  for (const [src, dst] of [["icon-192.png", "icon-192.png"], ["icon-512.png", "icon-512.png"], ["mtga-stats.ico", "favicon.ico"]]) {
    const p = path.join(assets, src);
    if (fs.existsSync(p)) fs.copyFileSync(p, path.join(webDir, dst));
  }

  const decks = readDecks(cards);
  const deckById = new Map(decks.map((d) => [d.id, d]));
  const list = matches.loadMatches(outDir);
  const usedCards = new Set();
  const summaries = [];
  let myName = "";
  for (const m of list) {
    const s = matches.matchSummary(m, cards);
    if (s.myName) myName = s.myName;
    const d = deckById.get(s.myDeckId);
    s.tile = (d && d.tile) || ((m.myDeck.commander || [])[0] || {}).grpId || ((m.myDeck.cards || [])[0] || {}).grpId || 0;
    summaries.push(s);
    for (const c of m.myDeck.cards || []) usedCards.add(c.grpId);
    for (const c of m.myDeck.commander || []) usedCards.add(c.grpId);
    for (const c of m.opponentCards || []) usedCards.add(c.grpId);
    for (const [g] of s.played) usedCards.add(g);
    usedCards.add(s.tile);
    const mf = path.join(webDir, "matches", m.matchId + ".js");
    if (!fs.existsSync(mf)) {
      const frameCards = new Set();
      collectFrameCards(m, frameCards);
      for (const c of m.myDeck.cards || []) frameCards.add(c.grpId);
      for (const c of m.myDeck.commander || []) frameCards.add(c.grpId);
      for (const c of m.opponentCards || []) frameCards.add(c.grpId);
      const cardsForMatch = {};
      for (const g of frameCards) { const c = cards.get(g); if (c) cardsForMatch[g] = cardEntry(c); }
      fs.writeFileSync(mf, "window.MTGA_MATCH=" + JSON.stringify({ match: Object.assign({}, m, { frames: undefined }), frames: m.frames, cards: cardsForMatch }) + ";");
    }
  }
  // Die Deckliste aus dem Player.log stammt vom Spielstart; wurde ein Deck danach geändert und gespielt, ist die
  // Liste aus dem jüngsten Match aktueller. Dann wird sie übernommen (Commander, Hauptdeck, Sideboard).
  for (const m of list) {
    const d = deckById.get(m.myDeck.deckId);
    if (!d || !(m.myDeck.cards || []).length) continue;
    // Sicherheitsnetz: nur wenn der gespielte Commander zum Deck gehört (sonst falsche Zuordnung)
    const dc = new Set((d.zones.CommandZone || []).map(([g]) => g)), mc = (m.myDeck.commander || []).map((c) => c.grpId);
    if (mc.length !== dc.size || !mc.every((g) => dc.has(g))) continue;
    const at = new Date(m.start);
    if (d.lastUpdated && new Date(d.lastUpdated) >= at) continue;
    const toZone = (arr) => (arr || []).map((c) => [c.grpId, c.qty || 1]);
    const zones = { MainDeck: toZone(m.myDeck.cards) };
    if ((m.myDeck.commander || []).length) zones.CommandZone = toZone(m.myDeck.commander);
    if ((m.myDeck.sideboard || []).length) zones.Sideboard = toZone(m.myDeck.sideboard);
    if ((d.zones.Companions || []).length) zones.Companions = d.zones.Companions;
    d.zones = zones; d.lastUpdated = at.toISOString(); d.fromMatch = true;
    d.tile = d.tileId || ((zones.CommandZone || [])[0] || [d.tile])[0];
  }
  for (const d of decks) { usedCards.add(d.tile); for (const z of Object.values(d.zones)) for (const [g] of z) usedCards.add(g); }

  // Fehlenden Commander über die Deck-ID nachtragen
  const cmdByDeck = new Map();
  for (const d of decks) {
    const c = (d.zones.CommandZone || []).map(([g]) => (cards.get(g) || {}).Name || "?").join(", ");
    if (c) cmdByDeck.set(d.id, c);
  }
  for (const s of summaries) if (s.commander && s.myDeckId && !cmdByDeck.has(s.myDeckId)) cmdByDeck.set(s.myDeckId, s.commander);
  for (const s of summaries) if (!s.commander && s.myDeckId && cmdByDeck.has(s.myDeckId)) s.commander = cmdByDeck.get(s.myDeckId);

  const cardDict = {};
  for (const g of usedCards) { const c = cards.get(g); if (c) cardDict[g] = cardEntry(c); }

  let account = null; try { account = JSON.parse(fs.readFileSync(path.join(outDir, "account.json"), "utf8")); } catch (e) { /* noch keine Kontodaten */ }
  // Rang-Embleme: lokal liefert sie der Dashboard-Server aus den Spieldaten (ui/rank/…), die Website bekommt sie als Data-URL
  if (account) {
    if (account.rank) {
      const u = (f, r) => r && r.key ? `ui/rank/${f}/${r.key}/${Math.min(4, Math.max(1, r.level || 1))}?h=128` : null;
      const icons = { constructed: u("constructed", account.rank.constructed), limited: u("limited", account.rank.limited) };
      if (icons.constructed || icons.limited) account.rankIcons = icons;
    }
    try { account.uiIcons = require("./emblems").uiIconUrls(); } catch (e) { /* ohne Symbole */ }
  }
  const data = { generatedAt: new Date().toISOString(), format: FORMAT, player: myName, matches: summaries, decks, cards: cardDict, account, syncUrl: String(readConfig().syncUrl || "").replace(/\/$/, "") || null };
  fs.writeFileSync(path.join(webDir, "data.js"), "window.MTGA_DATA=" + JSON.stringify(data) + ";");
  fs.writeFileSync(path.join(webDir, "data.json"), JSON.stringify(data));
  return { index: path.join(webDir, "index.html"), matches: summaries.length, decks: decks.length };
}

/** GrpIds, für die Bilder gebraucht werden: zuerst Matches (Replays), dann Decks. */
function neededImages(outDir, cards) {
  const list = matches.loadMatches(outDir);
  const decks = readDecks(cards);
  const ids = new Set();
  for (const m of list) {
    for (const c of m.myDeck.commander || []) ids.add(c.grpId);
    for (const c of m.opponentCards || []) ids.add(c.grpId);
    collectFrameCards(m, ids);
    for (const c of m.myDeck.cards || []) ids.add(c.grpId);
  }
  for (const d of decks) ids.add(d.tile);
  for (const d of decks) for (const z of Object.values(d.zones)) for (const [g] of z) ids.add(g);
  return { cards: [...ids].filter((g) => g && cards.has(g)) };
}

module.exports = { build, neededImages, readDecks };

if (require.main === module) {
  const out = process.argv[2] || path.join(__dirname, "..", "out");
  const { cards } = lib.loadCards(lib.findCardDb());
  const r = build(out, cards);
  console.log(`Dashboard: ${r.index} (${r.matches} Matches, ${r.decks} Decks)`);
}
