// Kartendaten. Quelle Scryfall: alle Arena-Karten (game:arena) täglich in die Tabelle cards, Set-Liste in card_sets.
// Bilder werden nicht gespeichert, sondern per Link aus der Tabelle an Scryfall weitergeleitet.
// Arena-IDs (arena_id) sind die GrpIds, die der Companion verwendet.
const fs = require("fs");
const path = require("path");
const db = require("./db");
const config = require("./config");

const UA = config.scryfall.userAgent;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastCall = 0;
/** Scryfall erlaubt ~10 Anfragen/s; wir bleiben deutlich darunter */
async function sfFetch(url, init) {
  const wait = 150 - (Date.now() - lastCall);
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
  for (let a = 0; a < 4; a++) {
    const r = await fetch(url, Object.assign({ headers: { "User-Agent": UA, Accept: "*/*" } }, init || {}));
    if (r.status === 429) { await sleep(1000 * (parseInt(r.headers.get("retry-after") || "5", 10) + 1)); continue; }
    return r;
  }
  throw new Error("Scryfall: dauerhaft gedrosselt");
}

const TYPE_IDS = { Artifact: 1, Creature: 2, Enchantment: 3, Instant: 4, Land: 5, Planeswalker: 8, Sorcery: 10, Tribal: 11, Kindred: 11, Battle: 14 };
const COLOR_IDS = { W: 1, U: 2, B: 3, R: 4, G: 5 };
const RARITY_IDS = { common: 2, uncommon: 3, rare: 4, mythic: 5, special: 4, bonus: 4 };

function rowFromScryfall(c) {
  const face = c.card_faces && c.card_faces[0] && !c.image_uris ? c.card_faces[0] : c;
  const uris = (c.image_uris || (c.card_faces && c.card_faces[0] && c.card_faces[0].image_uris)) || null;
  return {
    arena_id: c.arena_id, scryfall_id: c.id, name: c.name, set_code: c.set, collector: String(c.collector_number),
    rarity: c.rarity, colors: (c.colors || face.colors || []).join(","), type_line: c.type_line || face.type_line || "",
    mana_cost: c.mana_cost || face.mana_cost || "", oracle_text: c.card_faces ? c.card_faces.map((f) => f.oracle_text || "").filter(Boolean).join("\n//\n") : (c.oracle_text || ""),
    power: c.power || face.power || "", toughness: c.toughness || face.toughness || "",
    image_uris: uris ? JSON.stringify({ small: uris.small, normal: uris.normal, large: uris.large }) : null
  };
}

/** Alle Arena-Karten von Scryfall holen (paginiert) und in cards schreiben. Dauert einige Minuten. */
async function syncCards(log = console.log) {
  let url = "https://api.scryfall.com/cards/search?" + new URLSearchParams({ q: "game:arena", unique: "prints", order: "set", include_extras: "true" });
  let n = 0, page = 0;
  const upsert = "INSERT INTO cards (arena_id, scryfall_id, name, set_code, collector, rarity, colors, type_line, mana_cost, oracle_text, power, toughness, image_uris, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(arena_id) DO UPDATE SET scryfall_id = excluded.scryfall_id, name = excluded.name, set_code = excluded.set_code, collector = excluded.collector, rarity = excluded.rarity, colors = excluded.colors, type_line = excluded.type_line, mana_cost = excluded.mana_cost, oracle_text = excluded.oracle_text, power = excluded.power, toughness = excluded.toughness, image_uris = excluded.image_uris, updated_at = excluded.updated_at";
  while (url) {
    const r = await sfFetch(url);
    if (!r.ok) throw new Error(`Scryfall search ${r.status}`);
    const j = await r.json();
    db.tx(() => {
      for (const c of j.data) {
        if (!c.arena_id) continue;
        const row = rowFromScryfall(c);
        db.run(upsert, row.arena_id, row.scryfall_id, row.name, row.set_code, row.collector, row.rarity, row.colors, row.type_line, row.mana_cost, row.oracle_text, row.power, row.toughness, row.image_uris, db.now());
        n++;
      }
    });
    page++;
    if (page % 10 === 0) log(`Karten: ${n} (Seite ${page})`);
    url = j.has_more ? j.next_page : null;
  }
  const sr = await sfFetch("https://api.scryfall.com/sets");
  if (sr.ok) {
    const j = await sr.json();
    db.tx(() => { for (const s of j.data) db.run("INSERT INTO card_sets (code, name, icon_uri, released_at) VALUES (?, ?, ?, ?) ON CONFLICT(code) DO UPDATE SET name = excluded.name, icon_uri = excluded.icon_uri, released_at = excluded.released_at", s.code, s.name, s.icon_svg_uri, s.released_at); });
  }
  db.run("INSERT INTO meta (key, value) VALUES ('cards_synced_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", db.now());
  log(`Kartendaten aktualisiert: ${n} Arena-Karten`);
  return n;
}

/** Täglich prüfen; beim ersten Start sofort */
function scheduleCardSync(log) {
  const last = db.get("SELECT value FROM meta WHERE key = 'cards_synced_at'");
  const due = !last || Date.now() - Date.parse(last.value) > 24 * 3600000;
  const run = () => syncCards(log).catch((e) => log("Kartensync fehlgeschlagen: " + e.message));
  if (due) setTimeout(run, 5000);
  setInterval(() => { const l = db.get("SELECT value FROM meta WHERE key = 'cards_synced_at'"); if (!l || Date.now() - Date.parse(l.value) > 24 * 3600000) run(); }, 3600000);
}

// ---- Kartenformat für das gemeinsame Frontend (wie im Companion) ----------------------------------
const typeIds = (typeLine) => Object.keys(TYPE_IDS).filter((t) => new RegExp("\\b" + t + "\\b").test(typeLine || "")).map((t) => TYPE_IDS[t]);
const colorIds = (colors) => String(colors || "").split(",").filter(Boolean).map((c) => COLOR_IDS[c]).filter(Boolean);
const rarityName = (r) => ({ common: "Common", uncommon: "Uncommon", rare: "Rare", mythic: "Mythic", special: "Rare", bonus: "Rare" }[r] || "");
const isBasic = (row) => /^Basic Land/.test(row.type_line || "");
const cmcOf = (cost) => { let n = 0; for (const m of String(cost || "").matchAll(/\{([^}]+)\}/g)) { const v = parseInt(m[1], 10); if (!isNaN(v)) n += v; else if (m[1] !== "X") n += 1; } return n; };
/** Eintrag im Format des Companion-Wörterbuchs: [Name, Set, Nr, Seltenheit, Token, ArtId, Farben, Typen, Flags, P, T, Text, Typzeile, Kosten] */
function dictEntry(row) {
  const token = /\bToken\b/.test(row.type_line || "") ? 1 : 0;
  return [row.name, row.set_code.toUpperCase(), row.collector, isBasic(row) ? "Standardland" : rarityName(row.rarity), token, 0, colorIds(row.colors).join(","), typeIds(row.type_line).join(","), /Legendary/.test(row.type_line || "") ? "L" : "", row.power || "", row.toughness || "", row.oracle_text || "", row.type_line || "", row.mana_cost || ""];
}
/** Liste für die Bibliothek: [grpId, name, set, nr, rarity, colors, types, artId, cmc, owned, cost, isToken, isRebalanced, isPrimary, flags, power, toughness, text, typeLine] */
function libraryRow(row, owned) {
  const token = /\bToken\b/.test(row.type_line || "") ? 1 : 0;
  return [row.arena_id, row.name, row.set_code.toUpperCase(), row.collector, isBasic(row) ? 1 : (RARITY_IDS[row.rarity] || 0), colorIds(row.colors).join(","), typeIds(row.type_line).join(","), 0, cmcOf(row.mana_cost), owned || 0, row.mana_cost || "", token, 0, 1, /Legendary/.test(row.type_line || "") ? "L" : "", row.power || "", row.toughness || "", row.oracle_text || "", row.type_line || ""];
}
const cardRow = (arenaId) => db.get("SELECT * FROM cards WHERE arena_id = ?", arenaId) || null;
const tokenRow = (arenaId) => db.get("SELECT * FROM tokens WHERE arena_id = ?", arenaId) || null;
/** Wörterbuch-Eintrag für einen Token (Farben/Typen kommen als Arena-Zahlen vom Companion) */
const tokenEntry = (t) => [t.name, t.set_code.toUpperCase(), t.collector, "Token", 1, 0, t.colors || "", t.type_line ? "" : "", /Legendary/.test(t.type_line || "") ? "L" : "", t.power || "", t.toughness || "", t.oracle_text || "", t.type_line || "", ""];
function cardsDict(ids) {
  const out = {};
  for (const g of new Set(ids)) { const r = cardRow(g); if (r) { out[g] = dictEntry(r); continue; } const t = tokenRow(g); if (t) out[g] = tokenEntry(t); }
  return out;
}
/** Token-Bild über das Scryfall-Token-Set auflösen (t<set>/<nr>, Name prüfen; sonst Name im Token-Set); Ergebnis wird gemerkt */
const tokenInflight = new Map();
async function resolveToken(t) {
  if (t.image_uris) return JSON.parse(t.image_uris);
  if (t.failed_at && Date.now() - Date.parse(t.failed_at) < 7 * 86400000) return null;
  if (tokenInflight.has(t.arena_id)) return tokenInflight.get(t.arena_id);
  const job = (async () => {
    const tset = "t" + t.set_code;
    let card = null;
    const q = encodeURIComponent(`!"${t.name}" t:token`);
    for (const url of [`https://api.scryfall.com/cards/${tset}/${encodeURIComponent(t.collector)}`, `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(t.name)}&set=${tset}`, `https://api.scryfall.com/cards/search?q=${q}+set%3A${tset}&unique=prints`, `https://api.scryfall.com/cards/search?q=${q}&unique=prints&order=released`]) {
      try {
        const r = await sfFetch(url);
        if (!r.ok) continue;
        let j = await r.json();
        if (j.object === "list") j = (j.data || [])[0];                      // Suchergebnis: bestes Ergebnis nehmen
        if (!j) continue;
        const sameName = (j.name || "").toLowerCase() === t.name.toLowerCase();
        if (!sameName) continue;                                            // andere Nummerierung oder andere Karte
        if (!/Token|Emblem|Card/.test(j.type_line || "")) continue;          // normale Karte gleichen Namens
        card = j; break;
      } catch (e) { /* nächster Versuch */ }
    }
    const uris = card && (card.image_uris || (card.card_faces && card.card_faces[0].image_uris)) || null;
    if (uris) db.run("UPDATE tokens SET scryfall_id = ?, image_uris = ?, resolved_at = ? WHERE arena_id = ?", card.id, JSON.stringify({ small: uris.small, normal: uris.normal, large: uris.large }), db.now(), t.arena_id);
    else db.run("UPDATE tokens SET failed_at = ? WHERE arena_id = ?", db.now(), t.arena_id);
    return uris ? { small: uris.small, normal: uris.normal, large: uris.large } : null;
  })().finally(() => tokenInflight.delete(t.arena_id));
  tokenInflight.set(t.arena_id, job);
  return job;
}
const setNames = () => Object.fromEntries(db.all("SELECT code, name FROM card_sets").map((r) => [r.code, r.name]));

// ---- Bilder: nichts wird gespeichert, nur der Scryfall-Link aus der Kartentabelle (302-Weiterleitung) -----
const CARD_BACK = "https://backs.scryfall.io/normal/0/a/0aeebaf5-8c7d-4636-9e82-8c27447861f7.jpg";
async function cardImageUrl(arenaId, version = "normal") {
  const row = cardRow(arenaId);
  let uris = row && row.image_uris ? JSON.parse(row.image_uris) : null;
  if (!uris) { const t = tokenRow(arenaId); if (t) uris = await resolveToken(t); }
  if (!uris) return null;
  return uris[version] || uris.normal || null;
}
const cardBackUrl = () => CARD_BACK;

module.exports = { syncCards, scheduleCardSync, cardRow, cardsDict, dictEntry, libraryRow, setNames, cardImageUrl, cardBackUrl, cmcOf };

if (require.main === module && process.argv[2] === "sync") {
  db.migrate();
  syncCards().then((n) => { console.log("fertig:", n); db.close(); }).catch((e) => { console.error(e.message); process.exit(1); });
}
