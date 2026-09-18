// Baut die Daten für das gemeinsame Frontend (web/) aus der Datenbank: dasselbe Format wie data.js des Companions,
// damit Übersicht, Matches, Decks, Bibliothek und Replays auf der Website unverändert funktionieren.
const db = require("./db");
const cards = require("./cards");

function decksOf(userId, onlyVisible) {
  const rows = db.all(`SELECT * FROM decks WHERE user_id = ? AND deleted_at IS NULL ${onlyVisible ? "AND visibility != 'private'" : ""} ORDER BY updated_at DESC`, userId);
  return rows.map(deckOut);
}
const deckOut = (r) => ({ id: r.id, name: r.name, format: r.format, lastUpdated: r.updated_at, tile: r.tile, zones: JSON.parse(r.zones), visibility: r.visibility, shareSlug: r.share_slug });
function matchesOf(userId) {
  const tiles = new Map(db.all("SELECT id, tile FROM decks WHERE user_id = ?", userId).map((d) => [d.id, d.tile]));
  return db.all("SELECT summary FROM matches WHERE user_id = ? ORDER BY start_at", userId).map((r) => { const m = JSON.parse(r.summary); if (!m.tile) m.tile = tiles.get(m.myDeckId) || ((m.played || [])[0] || [0])[0] || 0; return m; });
}
function latestCollection(userId) {
  const r = db.get("SELECT snapshot FROM collections WHERE user_id = ? ORDER BY taken_at DESC LIMIT 1", userId);
  return r ? new Map(JSON.parse(r.snapshot)) : new Map();
}

/** Datenpaket eines Nutzers; own = true liefert alles, sonst nur freigegebene Decks und keine Matches */
function buildData(user, { own = false, deckIds = null } = {}) {
  let decks = decksOf(user.id, !own);
  if (deckIds) decks = decks.filter((d) => deckIds.includes(d.id));
  const matches = own ? matchesOf(user.id) : [];
  const ids = new Set();
  for (const d of decks) { ids.add(d.tile); for (const z of Object.values(d.zones)) for (const [g] of z) ids.add(g); }
  for (const m of matches) { ids.add(m.tile); for (const [g] of m.played || []) ids.add(g); for (const c of m.opponentCards || []) ids.add(c.grpId); }
  ids.delete(0); ids.delete(undefined); ids.delete(null);
  return { generatedAt: db.now(), format: 4, player: user.arena_name || user.display_name, matches, decks, cards: cards.cardsDict([...ids]), site: { handle: user.handle, own } };
}

/** Kartenliste für die Bibliothek mit Besitzstand aus der letzten Sammlung */
function libraryJson(user) {
  const owned = user ? latestCollection(user.id) : new Map();
  const rows = db.all("SELECT * FROM cards ORDER BY name");
  return JSON.stringify({ generatedAt: db.now(), cards: rows.map((r) => cards.libraryRow(r, owned.get(r.arena_id) || 0)) });
}

/** Kartendetails wie /api/card/<grpId> des Companions */
function cardDetail(grpId, user) {
  const r = cards.cardRow(grpId);
  if (!r) return null;
  const owned = user ? latestCollection(user.id) : new Map();
  const printings = db.all("SELECT arena_id, set_code, collector FROM cards WHERE name = ? ORDER BY arena_id", r.name).map((p) => [p.arena_id, p.set_code.toUpperCase(), p.collector, 0, owned.get(p.arena_id) || 0]);
  const e = cards.dictEntry(r);
  return { grpId: r.arena_id, name: r.name, set: r.set_code.toUpperCase(), nr: r.collector, rarity: e[3], artId: 0, artist: "", cost: r.mana_cost || "", cmc: cards.cmcOf(r.mana_cost), colors: e[6].split(",").filter(Boolean).map(Number), typeLine: r.type_line || "", text: (r.oracle_text || "").split("\n").filter(Boolean), flavor: "", power: r.power || "", toughness: r.toughness || "", isToken: !!e[4], isRebalanced: false, digitalSet: "", flags: e[8], owned: owned.get(r.arena_id) || 0, printings, linked: [] };
}

/** Replay-Daten eines Matches (matches/<id>.js) */
function replayJs(userId, matchId) {
  const r = db.get("SELECT summary, replay FROM matches WHERE user_id = ? AND id = ?", userId, matchId);
  if (!r || !r.replay) return null;
  const rep = JSON.parse(r.replay);
  // Karten-Wörterbuch aus den Rahmen ableiten (der Companion schickt nur Match und Rahmen)
  const ids = new Set();
  for (const f of rep.frames || []) { for (const o of [...(f.bf || []), ...(f.st || []), ...(f.cmd || [])]) ids.add(o[1]); for (const side of [...(f.h || []), ...(f.gy || []), ...(f.ex || [])]) for (const g of side) ids.add(g); for (const e of f.ev || []) { if (e.g) ids.add(e.g); if (typeof e.t === "number") ids.add(e.t); } }
  for (const c of [...(rep.match.myDeck && rep.match.myDeck.cards || []), ...(rep.match.myDeck && rep.match.myDeck.commander || []), ...(rep.match.opponentCards || [])]) ids.add(c.grpId);
  return "window.MTGA_MATCH=" + JSON.stringify({ match: rep.match, frames: rep.frames, cards: rep.cards || cards.cardsDict([...ids].filter(Boolean)) }) + ";";
}

module.exports = { buildData, libraryJson, cardDetail, replayJs, decksOf, matchesOf, deckOut };
