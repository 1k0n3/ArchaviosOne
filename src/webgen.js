// Erzeugt das Web-Dashboard: kopiert web/ nach <outDir>/web und schreibt data.js/data.json + matches/<id>.js
const fs = require("fs");
const path = require("path");
const lib = require("./lib");
const matches = require("./matches");
const { readDecksFromLog } = require("./decks");

// [Name, Set, Nr, Seltenheit, Token, ArtId, Farben, Typen, Rahmen-Flags, Stärke, Widerstandskraft, Regeltext, Typzeile, Manakosten]
function cardEntry(c) {
  return [c.Name, c.ExpansionCode, c.CollectorNumber, lib.RARITY[c.Rarity] || "", c.IsToken ? 1 : 0, c.ArtId || 0, c.Colors || "", c.Types || "", lib.frameFlags(c), c.Power || "", c.Toughness || "", c.Text || "", c.TypeLine || "", c.ManaCost || ""];
}

function readDecks(cards) {
  try {
    const logDir = matches.defaultLogDir();
    let r = readDecksFromLog(path.join(logDir, "Player.log"));
    if (!r.foundStartHook) r = readDecksFromLog(path.join(logDir, "Player-prev.log"));
    return [...r.decks.values()].map((d) => {
      const zones = {};
      for (const [z, entries] of Object.entries(d.zones)) zones[z] = entries.map((e) => [e.cardId, e.quantity]);
      const tile = d.tileId || ((zones.CommandZone || [])[0] || [0])[0];
      return { id: d.id, name: d.name, format: d.format, lastUpdated: d.lastUpdated, tile, zones };
    });
  } catch (e) { return []; }
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
  for (const f of fs.readdirSync(srcDir)) {
    const p = path.join(srcDir, f);
    if (fs.statSync(p).isFile()) fs.copyFileSync(p, path.join(webDir, f));
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

  const data = { generatedAt: new Date().toISOString(), format: FORMAT, player: myName, matches: summaries, decks, cards: cardDict };
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
