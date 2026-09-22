#!/usr/bin/env node
/**
 * Lokaler Dashboard-Server: liefert out/web und die Kartenbilder direkt aus den
 * MTGA-Spieldaten (komprimierte DXT/BC7-Textur ohne Umwandlung, Dekodierung im Browser per WebGL).
 *
 *   node serve.js [--out DIR] [--port 8765]
 *   GET /art/<ArtId>?w=256   -> rohe Texturdaten (Header: X-Tex-Format, X-Tex-Width, X-Tex-Height)
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");
const unity = require("./unity");

// ---- Auslieferung: Gzip für Text, ETag + 304, kleiner Cache komprimierter Dateien ----------------
const gzCache = new Map(); // key -> { etag, gz }
function gzCached(key, buf) {
  const hit = gzCache.get(key);
  if (hit) { gzCache.delete(key); gzCache.set(key, hit); return hit; }
  const v = { etag: '"' + crypto.createHash("sha1").update(buf).digest("base64").slice(0, 20) + '"', gz: zlib.gzipSync(buf, { level: 6 }) };
  gzCache.set(key, v);
  if (gzCache.size > 60) gzCache.delete(gzCache.keys().next().value);
  return v;
}
/** Text-Antwort senden: komprimiert, wenn der Browser es kann; 304 bei unverändertem ETag */
function sendText(req, res, buf, type, cacheControl, key) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  const v = gzCached(key || crypto.createHash("sha1").update(buf).digest("hex"), buf);
  const headers = { "Content-Type": type, "Cache-Control": cacheControl || "no-cache", ETag: v.etag, Vary: "Accept-Encoding" };
  if (req.headers["if-none-match"] === v.etag) { res.writeHead(304, headers); res.end(); return; }
  const gz = /\bgzip\b/.test(req.headers["accept-encoding"] || "") && buf.length > 1024;
  if (gz) { headers["Content-Encoding"] = "gzip"; headers["Content-Length"] = v.gz.length; }
  else headers["Content-Length"] = buf.length;
  res.writeHead(200, headers);
  res.end(gz ? v.gz : buf);
}
const TEXT_EXT = new Set([".html", ".js", ".css", ".json", ".svg"]);

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".jpg": "image/jpeg", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json" };
const BLOCK_BYTES = { 10: 8, 12: 16, 25: 16 };

let bundleIndex = null;
function findInstallDir() { return require("./paths").findInstallDir(); }
function indexBundles() {
  if (bundleIndex) return bundleIndex;
  bundleIndex = new Map();
  const dir = require("./paths").findDataDir();
  if (!dir) return bundleIndex;
  const ab = path.join(dir, "Downloads", "AssetBundle");
  if (!fs.existsSync(ab)) return bundleIndex;
  for (const f of fs.readdirSync(ab)) {
    const m = f.match(/^(\d+)_CardArt_/);
    if (m) bundleIndex.set(parseInt(m[1], 10), path.join(ab, f));
  }
  return bundleIndex;
}

// kleiner Cache der zuletzt gelieferten Texturen (max. ~600, je ≤ 64 KB)
const cache = new Map();
function cacheGet(k) { const v = cache.get(k); if (v) { cache.delete(k); cache.set(k, v); } return v; }
function cachePut(k, v) { cache.set(k, v); if (cache.size > 600) cache.delete(cache.keys().next().value); }

/** Textur eines ArtId: größte Mipmap mit Breite <= maxW */
function texture(artId, maxW) {
  const key = artId + ":" + maxW;
  const hit = cacheGet(key);
  if (hit) return hit;
  const file = indexBundles().get(artId);
  if (!file) return null;
  const texs = unity.extractTextures(file).filter((t) => !t.error && !/_util$/.test(t.name) && BLOCK_BYTES[t.format]);
  if (!texs.length) return null;
  const t = texs.sort((a, b) => b.width * b.height - a.width * a.height)[0];
  const bb = BLOCK_BYTES[t.format];
  let w = t.width, h = t.height, off = 0, mip = 0;
  const size = (mw, mh) => Math.ceil(Math.max(1, mw) / 4) * Math.ceil(Math.max(1, mh) / 4) * bb;
  while (w > maxW && mip + 1 < (t.mipCount || 1) && w > 4) { off += size(w, h); w >>= 1; h >>= 1; mip++; }
  const data = t.data.subarray(off, off + size(w, h));
  const res = { format: t.format, width: w, height: h, data: Buffer.from(data) };
  cachePut(key, res);
  return res;
}

// ---- Karten-API (Bibliothek, Kartendetails) --------------------------------------------------------
let db = null, cardsList = null, cardsListJson = null, enumCache = null;
function openDb() {
  if (db) return db;
  const lib = require("./lib");
  const { DatabaseSync } = require("node:sqlite");
  db = new DatabaseSync(lib.findCardDb(), { readOnly: true });
  return db;
}
function enums(type) {
  if (!enumCache) enumCache = {};
  if (!enumCache[type]) {
    enumCache[type] = new Map(openDb().prepare("select e.Value v, l.Loc n from Enums e join Localizations_enUS l on l.LocId=e.LocId and l.Formatted=1 where e.Type=?").all(type).map((r) => [r.v, r.n]));
  }
  return enumCache[type];
}
const clean = (s) => (s == null ? "" : String(s).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim());
/** "o2oGoW" -> { cost: "{2}{G}{W}", cmc: 4 } */
function mana(text) {
  if (!text) return { cost: "", cmc: 0 };
  const parts = text.split("o").filter(Boolean);
  let cmc = 0;
  const cost = parts.map((p) => { const n = parseInt(p, 10); if (!isNaN(n)) cmc += n; else if (p !== "X") cmc += p.replace(/[^WUBRGC]/g, "").length || 0; return "{" + p + "}"; }).join("");
  return { cost, cmc };
}
function ownedCounts(webDir) {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(webDir, "..", "state.json"), "utf8"));
    return new Map(s.snapshot);
  } catch (e) { return new Map(); }
}
/** Kompakte Liste aller Karten: [grpId, name, set, nr, rarity, colors, types, artId, cmc, owned, cost, isToken, isRebalanced, isPrimary, frameFlags, power, toughness, text, typeLine] */
function allCards(webDir) {
  if (cardsListJson) return cardsListJson;
  const d = openDb();
  const rows = d.prepare(`select c.GrpId, c.ExpansionCode, c.CollectorNumber, c.Rarity, c.IsToken, c.IsRebalanced, c.ArtId, c.Colors, c.Types, c.Supertypes, c.OldSchoolManaText, c.IsPrimaryCard, c.DigitalReleaseSet, c.RawFrameDetail, c.AdditionalFrameDetails, c.ArtSize, c.Power, c.Toughness, c.AbilityIds, c.TypeTextId, c.SubtypeTextId,
      (select Loc from Localizations_enUS l where l.LocId = c.TitleId and l.Formatted = 1 limit 1) as Name from Cards c`).all();
  const owned = ownedCounts(webDir);
  const loc = new Map(d.prepare("select LocId, Loc from Localizations_enUS where Formatted = 1").all().map((r) => [r.LocId, r.Loc]));
  const textOf = (r) => String(r.AbilityIds || "").split(",").filter(Boolean).map((p) => clean(loc.get(+p.split(":")[1]) || "")).filter(Boolean).join("\n");
  const typeOf = (r) => { const tt = clean(loc.get(r.TypeTextId) || ""), st = clean(loc.get(r.SubtypeTextId) || ""); return tt + (st ? " — " + st : ""); };
  const legendId = require("./lib").legendaryTypeId(d);
  cardsList = rows.map((r) => { const m = mana(r.OldSchoolManaText); r.Legendary = require("./lib").isLegendary(r, legendId); return [r.GrpId, clean(r.Name), r.ExpansionCode, r.CollectorNumber, r.Rarity, r.Colors || "", r.Types || "", r.ArtId || 0, m.cmc, owned.get(r.GrpId) || 0, m.cost, r.IsToken ? 1 : 0, r.IsRebalanced ? 1 : 0, r.IsPrimaryCard ? 1 : 0, require("./lib").frameFlags(r), r.Power || "", r.Toughness || "", textOf(r), typeOf(r)]; });
  cardsListJson = JSON.stringify({ generatedAt: new Date().toISOString(), cards: cardsList });
  return cardsListJson;
}
/** Kartenliste als Array (gleiche Daten wie /api/cards) – Grundlage der Kartensuche des Assistenten */
/**
 * Lädt ein Modul neu, sobald sich seine Datei geändert hat. So greifen Verbesserungen am
 * Assistenten und an den Einstellungen sofort, ohne den Watcher neu zu starten. Nur für Module,
 * die bei jeder Anfrage frisch geholt werden und keinen wichtigen Zustand halten.
 */
const frischStand = new Map();
function frisch(mod) {
  const file = require.resolve(mod);
  let m = 0;
  try { m = fs.statSync(file).mtimeMs; } catch (e) { /* Datei weg: altes Modul behalten */ }
  if (frischStand.has(file) && frischStand.get(file) !== m) delete require.cache[file];
  frischStand.set(file, m);
  return require(file);
}

function cardRows(webDir) { allCards(webDir); return cardsList || []; }
function cardDetail(grpId, webDir) {
  const d = openDb();
  const c = d.prepare("select * from Cards where GrpId=?").get(grpId);
  if (!c) return null;
  const loc = (id) => { if (!id) return ""; const r = d.prepare("select Loc from Localizations_enUS where LocId=? and Formatted=1").get(id); return r ? r.Loc : ""; };
  const list = (s, type) => String(s || "").split(",").filter(Boolean).map((v) => enums(type).get(+v) || v);
  const abilities = String(c.AbilityIds || "").split(",").filter(Boolean).map((p) => { const [, textId] = p.split(":"); return clean(loc(+textId)); }).filter(Boolean);
  const m = mana(c.OldSchoolManaText);
  const typeLine = [list(c.Supertypes, "SuperType").join(" "), list(c.Types, "CardType").join(" ")].filter(Boolean).join(" ") + (c.Subtypes ? " — " + list(c.Subtypes, "SubType").join(" ") : "");
  const owned = ownedCounts(webDir);
  const printings = d.prepare("select GrpId, ExpansionCode, CollectorNumber, ArtId from Cards where TitleId=? and IsToken=0 order by GrpId").all(c.TitleId).map((r) => [r.GrpId, r.ExpansionCode, r.CollectorNumber, r.ArtId, owned.get(r.GrpId) || 0]);
  return {
    grpId: c.GrpId, name: clean(loc(c.TitleId)), set: c.ExpansionCode, nr: c.CollectorNumber, rarity: c.Rarity, artId: c.ArtId, artist: c.ArtistCredit || "",
    cost: m.cost, cmc: m.cmc, colors: String(c.Colors || "").split(",").filter(Boolean).map(Number), typeLine, text: abilities, flavor: clean(loc(c.FlavorTextId)),
    power: c.Power || "", toughness: c.Toughness || "", isToken: !!c.IsToken, isRebalanced: !!c.IsRebalanced, digitalSet: c.DigitalReleaseSet || "",
    flags: require("./lib").frameFlags(Object.assign({}, c, { Legendary: require("./lib").isLegendary(c, require("./lib").legendaryTypeId(d)) })), owned: owned.get(c.GrpId) || 0, printings, linked: String(c.LinkedFaceGrpIds || "").split(",").filter(Boolean).map(Number)
  };
}

// ---- Echte Kartenbilder (gedruckte Karte) von Scryfall, nur als Link (nichts wird lokal abgelegt) ----
// Reihenfolge: Set + Sammlernummer -> digitales Set -> Name (beliebiger Druck). Gedrosselt (max. ~5/s).
const UA = "MTGAStats/1.0 (lokales Dashboard; +https://mtga.a16.be)";
let lastFetchAt = 0;
const missing = new Map(); // grpId -> Zeitpunkt des Fehlschlags
let cardBackUrl = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Scryfall-Sperre: nach einem 429 pausieren alle Anfragen bis Retry-After abgelaufen ist
let blockedUntil = 0;
function noteRateLimit(r) {
  const secs = Math.min(300, Math.max(5, parseInt(r.headers.get("retry-after") || "60", 10) || 60));
  blockedUntil = Math.max(blockedUntil, Date.now() + secs * 1000);
  return blockedUntil - Date.now();
}

// Starts werden auf ~5 pro Sekunde begrenzt, höchstens 2 Anfragen laufen gleichzeitig
let inFlight = 0;
const waiters = [];
async function throttledFetch(url) {
  await new Promise((resolve) => { waiters.push(resolve); pumpFetch(); });
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 20000);
    try { return await fetch(url, { headers: { "User-Agent": UA, Accept: "*/*" }, signal: ctl.signal }); }
    finally { clearTimeout(t); }
  } finally {
    inFlight--;
    pumpFetch();
  }
}
// Deutlich unter Scryfalls Limit bleiben: höchstens 2 Anfragen gleichzeitig, mindestens 250 ms Abstand
let pumpTimer = null;
function pumpFetch() {
  if (!waiters.length || inFlight >= 2) return;
  const wait = Math.max(200 - (Date.now() - lastFetchAt), blockedUntil - Date.now());
  if (wait > 0) { if (!pumpTimer) pumpTimer = setTimeout(() => { pumpTimer = null; pumpFetch(); }, wait); return; }
  lastFetchAt = Date.now();
  inFlight++;
  waiters.shift()();
  if (waiters.length) pumpFetch();
}
// Nichts wird lokal abgelegt: der Server löst nur die Bild-URL auf (im Speicher gemerkt) und leitet
// den Browser per 302 auf das Bild im Scryfall-CDN weiter. Bilder liegen nur im Browser-Cache.
const urlCache = new Map(); // grpId -> CDN-URL
const pending = new Map();  // grpId -> Promise
async function fetchJson(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await throttledFetch(url);
    if (r.status === 429) { await sleep(noteRateLimit(r)); continue; }
    if (r.status === 404) return null;
    if (!r.ok) { await sleep(800); continue; }
    return await r.json();
  }
  return null;
}
const imageUris = (j) => j && (j.image_uris || (j.card_faces && j.card_faces[0].image_uris)) || null;
function cardInfo(grpId) {
  const d = openDb();
  const c = d.prepare("select ExpansionCode, CollectorNumber, DigitalReleaseSet, TitleId, IsToken from Cards where GrpId=?").get(grpId);
  if (!c) return null;
  const name = clean((d.prepare("select Loc from Localizations_enUS where LocId=? and Formatted=1").get(c.TitleId) || {}).Loc);
  // Token liegen bei Scryfall im Token-Set des jeweiligen Sets (z. B. tsnc), mit denselben Sammlernummern
  const set = String(c.ExpansionCode || "").toLowerCase();
  return { set: c.IsToken ? "t" + set : set, digitalSet: c.IsToken ? "" : String(c.DigitalReleaseSet || "").toLowerCase(), nr: String(c.CollectorNumber || "").trim(), name, token: !!c.IsToken };
}
/** Antwort von /cards/collection oder null bei Netz-/Sperrfehler (dann nichts als fehlend merken) */
async function postCollection(identifiers) {
  for (let attempt = 0; attempt < 4; attempt++) {
    let r;
    try { r = await throttledFetchPost("https://api.scryfall.com/cards/collection", { identifiers }); }
    catch (e) { await sleep(1500); continue; }
    if (r.status === 429) { await sleep(noteRateLimit(r) + 500); continue; }
    if (!r.ok) { await sleep(800); continue; }
    return await r.json();
  }
  return null;
}
async function throttledFetchPost(url, body) {
  await new Promise((resolve) => { waiters.push(resolve); pumpFetch(); });
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 25000);
    try { return await fetch(url, { method: "POST", headers: { "User-Agent": UA, Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify(body), signal: ctl.signal }); }
    finally { clearTimeout(t); }
  } finally { inFlight--; pumpFetch(); }
}
// Sammelauflösung: Anfragen werden 120 ms gesammelt und in Paketen zu 75 Karten bei Scryfall nachgeschlagen
const batchWaiting = new Map(); // grpId -> [resolve...]
let batchTimer = null;
function resolveBatch() {
  batchTimer = null;
  const ids = [...batchWaiting.keys()].slice(0, 75);
  const entries = ids.map((g) => [g, batchWaiting.get(g)]);
  for (const g of ids) batchWaiting.delete(g);
  if (batchWaiting.size) batchTimer = setTimeout(resolveBatch, 130);
  (async () => {
    const infos = new Map(ids.map((g) => [g, cardInfo(g)]));
    const results = new Map();
    let netFail = false; // Scryfall nicht erreichbar / gesperrt: Karten nicht als fehlend merken
    const tryIds = async (makeId, pool) => {
      const list = pool.filter((g) => infos.get(g) && makeId(g, infos.get(g)));
      if (!list.length) return;
      const j = await postCollection(list.map((g) => makeId(g, infos.get(g))));
      if (!j || !j.data) { netFail = true; return; }
      // Zuordnung über Set + Nummer bzw. Name
      for (const card of j.data) {
        const uris = imageUris(card);
        if (!uris) continue;
        for (const g of list) {
          if (results.has(g)) continue;
          const inf = infos.get(g);
          const sameSet = card.set === inf.set || card.set === inf.digitalSet;
          const sameNr = String(card.collector_number).toLowerCase() === inf.nr.toLowerCase();
          const sameName = card.name === inf.name || (card.name || "").split(" // ")[0] === inf.name;
          if ((sameSet && sameNr) || (!sameSet && sameName && makeId === byName)) { results.set(g, uris); break; }
        }
      }
    };
    const bySetNr = (g, inf) => inf.set && inf.nr ? { set: inf.set, collector_number: inf.nr } : null;
    const byDigital = (g, inf) => inf.digitalSet && inf.nr && inf.digitalSet !== inf.set ? { set: inf.digitalSet, collector_number: inf.nr } : null;
    const byName = (g, inf) => inf.name ? (inf.token ? { name: inf.name, set: inf.set } : { name: inf.name }) : null;
    try {
      await tryIds(bySetNr, ids);
      await tryIds(byDigital, ids.filter((g) => !results.has(g)));
      await tryIds(byName, ids.filter((g) => !results.has(g)));
      // Token, die noch fehlen: Scryfall-Suche nach Token mit exaktem Namen (andere Nummerierung als in Arena)
      for (const g of ids.filter((x) => !results.has(x) && infos.get(x) && infos.get(x).token)) {
        const inf = infos.get(g);
        const j = await fetchJson(`https://api.scryfall.com/cards/search?q=${encodeURIComponent(`!"${inf.name}" t:token`)}&unique=prints&order=released`);
        const hit = j && j.data && (j.data.find((x) => x.set === inf.set) || j.data[0]);
        const uris = imageUris(hit);
        if (uris) results.set(g, uris);
      }
    } catch (e) { netFail = true; }
    for (const [g, resolvers] of entries) {
      const uris = results.get(g) || null;
      if (uris) { for (const v of ["small", "normal", "large"]) if (uris[v]) urlCache.set(g + ":" + v, uris[v]); }
      else if (!netFail) missing.set(g + ":normal", Date.now());
      for (const r of resolvers) r(uris);
    }
  })();
}
/** CDN-URL des gedruckten Kartenbilds, oder null (Sammelauflösung über Scryfall /cards/collection) */
/** Scryfall-Bildlink in der gewünschten Größe; "art" = Artwork-Ausschnitt (gleicher Pfad wie das normale Bild, Ordner art_crop) */
const pickUri = (uris, version) => version === "art" ? (uris.normal ? uris.normal.replace("/normal/", "/art_crop/") : null) : (uris[version] || uris.normal || null);
async function cardImageUrl(grpId, version = "normal") {
  const key = grpId + ":" + version;
  if (urlCache.has(key)) return urlCache.get(key);
  if (urlCache.has(grpId + ":normal")) return pickUri({ normal: urlCache.get(grpId + ":normal") }, version);
  const failedAt = missing.get(grpId + ":normal");
  if (failedAt && Date.now() - failedAt < 6 * 3600 * 1000) return null;
  // Während einer Scryfall-Sperre nicht warten: sofort "nicht verfügbar" (503 + Retry-After), der Browser zeigt
  // solange das Artwork und fragt das gedruckte Bild später erneut an
  if (blockedUntil > Date.now()) return null;
  const uris = await new Promise((resolve) => {
    if (!batchWaiting.has(grpId)) batchWaiting.set(grpId, []);
    batchWaiting.get(grpId).push(resolve);
    if (!batchTimer) batchTimer = setTimeout(resolveBatch, 120);
  });
  return uris ? pickUri(uris, version) : null;
}
/** Set-Namen von Scryfall (Code -> Name), einmalig im Speicher; bei Sperre oder Netzfehler leer */
let setsJson = null, setsAt = 0;
async function setNames() {
  if (setsJson && Date.now() - setsAt < 24 * 3600 * 1000) return setsJson;
  if (blockedUntil > Date.now()) return setsJson || "{}";
  try {
    const j = await fetchJson("https://api.scryfall.com/sets");
    if (j && j.data) {
      const map = {};
      for (const s of j.data) map[String(s.code).toLowerCase()] = s.name;
      setsJson = JSON.stringify(map); setsAt = Date.now();
    }
  } catch (e) { /* bleibt leer */ }
  return setsJson || "{}";
}
/** URL des Standard-Kartenrückens (Scryfall); feste Kennung, keine Abfrage nötig */
const CARD_BACK_ID = "0aeebaf5-8c7d-4636-9e82-8c27447861f7";
async function cardBackUrlGet() {
  if (!cardBackUrl) cardBackUrl = `https://backs.scryfall.io/normal/${CARD_BACK_ID[0]}/${CARD_BACK_ID[1]}/${CARD_BACK_ID}.jpg`;
  return cardBackUrl;
}
/** Bild-URLs für eine Liste von GrpIds im Hintergrund auflösen (nur im Speicher) */
async function prefetch(grpIds, webDir, log) {
  let done = 0, failed = 0;
  for (const g of grpIds) {
    if (urlCache.has(g + ":normal")) continue;
    const u = await cardImageUrl(g);
    if (u) done++; else failed++;
    if (done && done % 200 === 0 && log) log(`Kartenbild-Links aufgelöst: ${done} ...`);
  }
  return { done, failed };
}

function start(webDir, port, log) {
  const server = http.createServer((req, res) => {
    try { handle(req, res); } catch (e) { try { res.writeHead(500); res.end(e.message); } catch (x) { /* Antwort schon unterwegs */ } }
  });
  function handle(req, res) {
    const url = new URL(req.url, "http://localhost");
    const p = decodeURIComponent(url.pathname);
    // Schutz der Endpunkte mit Schlüsseln und Einstellungen. Ohne ihn könnte jede Webseite, die der
    // Spieler gerade offen hat, per Formular an localhost schreiben – etwa eine fremde Adresse für
    // den Anbieter setzen und damit den Schlüssel abgreifen. Deshalb:
    //  - Host muss localhost sein (schützt gegen DNS-Rebinding),
    //  - eine mitgeschickte Herkunft (Origin) muss diese Oberfläche sein,
    //  - schreibende Anfragen müssen JSON sein; das erzwingt beim Browser eine Vorabfrage, die wir
    //    nicht beantworten, womit fremde Seiten gar nicht erst senden dürfen.
    if (p === "/api/settings" || p.startsWith("/api/sync/") || p.startsWith("/api/assistant/") || p === "/api/cards/search") {
      const host = String(req.headers.host || "").toLowerCase();
      const hostOk = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
      const origin = req.headers.origin;
      const originOk = !origin || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(String(origin));
      const schreibt = req.method !== "GET" && req.method !== "HEAD";
      const jsonOk = !schreibt || /application\/json/i.test(String(req.headers["content-type"] || ""));
      if (!hostOk || !originOk || !jsonOk) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Anfrage nicht von dieser Oberfläche" }));
        return;
      }
    }
    if (p === "/api/settings" || p.startsWith("/api/sync/")) {
      try { if (frisch("./settings").handle(req, res, url, port)) return; }
      catch (e) { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: e.message })); return; }
    }
    // Optionaler Zusatz: die Endpunkte gibt es nur, wenn src/assistant.js mitgeliefert ist
    if (p.startsWith("/api/assistant/") || p === "/api/cards/search") {
      let asst = null;
      try { asst = frisch("./assistant"); } catch (e) { asst = null; }
      if (!asst) { res.writeHead(404, { "Content-Type": "application/json" }); res.end('{"error":"nicht verfügbar"}'); return; }
      try { if (asst.handle(req, res, url, () => cardRows(webDir), port)) return; }
      catch (e) { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: e.message })); return; }
    }
    const im = p.match(/^\/card-img\/(\d+)$/);
    if (im || p === "/card-back") {
      const version = ["large", "small", "art"].includes(url.searchParams.get("v")) ? url.searchParams.get("v") : "normal";
      (im ? cardImageUrl(+im[1], version) : cardBackUrlGet()).then((target) => {
        if (!target) {
          const wait = Math.ceil(Math.max(0, blockedUntil - Date.now()) / 1000);
          res.writeHead(wait > 0 ? 503 : 404, { "Cache-Control": "no-cache", "Retry-After": String(wait || 60) }); res.end(); return;
        }
        res.writeHead(302, { Location: target, "Cache-Control": "public, max-age=86400" });
        res.end();
      }).catch((e) => { res.writeHead(500); res.end(e.message); });
      return;
    }
    // Embleme und UI-Symbole aus den Spieldaten:
    //   /ui/rank/<constructed|limited>/<bronze…mythic|unranked>/<1-4>[?h=128]   /ui/sprite/<Atlas>/<Sprite>[?h=64]
    const rk = p.match(/^\/ui\/rank\/(constructed|limited)\/([a-z]+)\/(\d)$/), sp = p.match(/^\/ui\/sprite\/([A-Za-z]+)\/([A-Za-z0-9_.-]+)$/);
    // Schriften des Spiels (OpenType) für das lokale Dashboard: /ui/font/<NAME>
    const ft = p.match(/^\/ui\/font\/([A-Z0-9-]+)$/);
    if (ft) {
      let buf = null; try { buf = require("./emblems").fontData(ft[1]); } catch (e) { buf = null; }
      if (!buf) { res.writeHead(404, { "Cache-Control": "no-cache" }); res.end(); return; }
      res.writeHead(200, { "Content-Type": "font/otf", "Cache-Control": "public, max-age=604800", "Content-Length": buf.length });
      res.end(buf);
      return;
    }
    if (rk || sp) {
      const maxH = Math.min(512, Math.max(0, parseInt(url.searchParams.get("h") || "0", 10) || 0));
      let r = null; try { const em = require("./emblems"); r = rk ? em.rankPng(rk[1], rk[2], rk[3], maxH) : em.spritePng(sp[1], sp[2], maxH); } catch (e) { r = null; }
      if (!r) { res.writeHead(404, { "Cache-Control": "no-cache" }); res.end(); return; }
      res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "public, max-age=604800", "Content-Length": r.png.length });
      res.end(r.png);
      return;
    }
    if (p === "/api/card-url") {
      const g = +url.searchParams.get("g");
      cardImageUrl(g, url.searchParams.get("v") || "normal").then((u) => { res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache" }); res.end(JSON.stringify({ url: u })); });
      return;
    }
    if (p === "/api/sets") {
      setNames().then((j) => sendText(req, res, j, "application/json", "public, max-age=3600", "api/sets:" + j.length)).catch((e) => { res.writeHead(500); res.end(e.message); });
      return;
    }
    if (p === "/api/cards") {
      try { const j = allCards(webDir); sendText(req, res, j, "application/json", "no-cache", "api/cards:" + j.length); }
      catch (e) { res.writeHead(500); res.end(e.message); }
      return;
    }
    const cm = p.match(/^\/api\/card\/(\d+)$/);
    if (cm) {
      try { const c = cardDetail(+cm[1], webDir); if (!c) { res.writeHead(404); res.end(); return; } sendText(req, res, JSON.stringify(c), "application/json", "no-cache"); }
      catch (e) { res.writeHead(500); res.end(e.message); }
      return;
    }
    if (p === "/api/refresh") { cardsListJson = null; res.writeHead(200); res.end("ok"); return; }
    const m = p.match(/^\/art\/(\d+)$/);
    if (m) {
      try {
        const maxW = Math.min(1024, Math.max(32, parseInt(url.searchParams.get("w") || "256", 10)));
        const t = texture(parseInt(m[1], 10), maxW);
        if (!t) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, {
          "Content-Type": "application/octet-stream", "Content-Length": t.data.length,
          "X-Tex-Format": String(t.format), "X-Tex-Width": String(t.width), "X-Tex-Height": String(t.height),
          "Cache-Control": "public, max-age=31536000, immutable", "Access-Control-Expose-Headers": "X-Tex-Format, X-Tex-Width, X-Tex-Height"
        });
        res.end(t.data);
      } catch (e) {
        res.writeHead(500); res.end(e.message);
      }
      return;
    }
    let file = path.join(webDir, p === "/" ? "index.html" : p);
    let st;
    try { st = fs.statSync(file); } catch (e) { st = null; }
    if (!file.startsWith(webDir) || !st || st.isDirectory()) { res.writeHead(404); res.end("nicht gefunden"); return; }
    const ext = path.extname(file).toLowerCase();
    const cc = ext === ".js" && p.startsWith("/matches/") ? "public, max-age=86400" : "no-cache";
    if (TEXT_EXT.has(ext) && st.size < 32 * 1024 * 1024) {
      try { sendText(req, res, fs.readFileSync(file), MIME[ext], cc, file + ":" + st.mtimeMs + ":" + st.size); } catch (e) { res.writeHead(500); res.end(e.message); }
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": cc, "Content-Length": st.size });
    fs.createReadStream(file).pipe(res);
  }
  server.on("error", (e) => log && log("Server-Fehler: " + e.message));
  server.on("clientError", (e, socket) => {
    if (e.code !== "ECONNRESET" && e.code !== "ERR_HTTP_REQUEST_TIMEOUT" && log) log("Ungültige Anfrage (" + e.code + "): " + String(e.rawPacket || "").slice(0, 200).replace(/\r?\n/g, " | "));
    // Abgebrochene oder ausgelaufene Verbindungen nur schließen: der Browser wiederholt die Anfrage dann auf einer neuen Verbindung
    if (e.code === "ECONNRESET" || e.code === "ERR_HTTP_REQUEST_TIMEOUT" || !socket.writable) { socket.destroy(); return; }
    try { socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"); } catch (x) { /* ignorieren */ }
  });
  server.listen(port, "127.0.0.1", () => log && log(`Dashboard-Server: http://localhost:${port}/`));
  return server;
}

module.exports = { start, texture, cardImageUrl, prefetch, cardRows, openDb, ownedCounts };

if (require.main === module) {
  const args = process.argv.slice(2);
  let out = path.join(__dirname, "..", "out"), port = 8765;
  for (let i = 0; i < args.length; i++) { if (args[i] === "--out") out = args[++i]; else if (args[i] === "--port") port = +args[++i]; }
  start(path.join(out, "web"), port, console.log);
}
