#!/usr/bin/env node
/**
 * Cloud-Sync des Companions (offline-first).
 *   - Ereignisse (Matches, Decks, Sammlungsstände) landen in out/sync/queue/<id>.json
 *   - flush() schickt sie gebündelt an die Website (POST /api/v1/sync) und löscht Bestätigtes; ohne Netz bleibt alles liegen
 *   - Gerätetoken liegt in out/sync/device.json (nur lokal, nicht im Repository)
 *
 *   node src/sync.js connect <CODE> [--url https://…]   Gerät mit dem Website-Konto verbinden
 *   node src/sync.js status | flush | disconnect
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
function cfg() {
  try { const raw = JSON.parse(fs.readFileSync(path.join(ROOT, "watch-config.json"), "utf8").replace(/^﻿/, "")); const o = {}; for (const k of Object.keys(raw)) if (!k.startsWith("_")) o[k] = raw[k]; return o; } catch (e) { return {}; }
}
const outDir = () => { const c = cfg(); const o = c.outDir || "out"; return path.isAbsolute(o) ? o : path.join(ROOT, o); };
const syncDir = () => { const d = path.join(outDir(), "sync"); fs.mkdirSync(path.join(d, "queue"), { recursive: true }); return d; };
const deviceFile = () => path.join(syncDir(), "device.json");
const stateFile = () => path.join(syncDir(), "state.json");
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return d; } };
const device = () => readJson(deviceFile(), null);
const state = () => readJson(stateFile(), { deckHashes: {}, lastFlushAt: null, lastError: null, sent: 0 });
const saveState = (s) => fs.writeFileSync(stateFile(), JSON.stringify(s, null, 2));
const baseUrl = () => String(cfg().syncUrl || (device() || {}).url || "").replace(/\/$/, "");
const hash = (o) => crypto.createHash("sha1").update(JSON.stringify(o)).digest("hex");
const eventId = (kind, key) => kind + "_" + hash(key).slice(0, 24);

function enqueue(kind, key, payload, at) {
  if (!device()) return false;   // nicht verbunden: nichts sammeln
  const id = eventId(kind, key);
  fs.writeFileSync(path.join(syncDir(), "queue", id + ".json"), JSON.stringify({ id, kind, at: at || new Date().toISOString(), payload }));
  return true;
}
/** Match inklusive Replay (Rahmen); die Karten-Wörterbücher rechnet der Server selbst */
function enqueueMatch(m, summary, tokens, cardInfo) {
  enqueue("match", summary.matchId + ":" + hash([summary.myDeckId, summary.myDeck, summary.result, summary.turns, tokens ? Object.keys(tokens).length : 0, cardInfo ? 1 : 0]), { summary, replay: { match: Object.assign({}, m, { frames: undefined }), frames: m.frames, tokens: tokens || undefined, cardInfo: cardInfo || undefined } }, new Date(m.start).toISOString());
}
/** Kompakte Karteninfos (Name, Set, Nr, Typ, Farben …) für eine ID-Liste; Fallback der Website, wenn Scryfall die Arena-ID nicht kennt */
function cardInfoOf(ids, cards) {
  const out = {};
  for (const g of new Set(ids)) {
    const c = cards.get(g); if (!c) continue;
    out[g] = { name: c.Name, set: String(c.ExpansionCode || ""), nr: String(c.CollectorNumber || ""), types: String(c.Types || ""), colors: String(c.Colors || ""), power: c.Power || "", toughness: c.Toughness || "", text: c.Text || "", typeLine: c.TypeLine || "", cost: c.ManaCost || "", rarity: c.Rarity || 0, token: c.IsToken ? 1 : 0, rebalanced: c.IsRebalanced ? 1 : 0 };
  }
  return Object.keys(out).length ? out : null;
}
/** Alle Karten-IDs eines Matches (Spielfeld, Ereignisse, Decklisten, Gegnerkarten) */
function matchCardIds(m) {
  const ids = new Set();
  for (const f of m.frames || []) { for (const o of [...(f.bf || []), ...(f.st || []), ...(f.cmd || [])]) ids.add(o[1]); for (const side of [...(f.h || []), ...(f.gy || []), ...(f.ex || [])]) for (const g of side) ids.add(g); for (const e of f.ev || []) { if (e.g) ids.add(e.g); if (typeof e.t === "number") ids.add(e.t); } }
  for (const c of [...((m.myDeck && m.myDeck.cards) || []), ...((m.myDeck && m.myDeck.commander) || []), ...(m.opponentCards || [])]) ids.add(c.grpId);
  ids.delete(0); ids.delete(undefined); ids.delete(null);
  return [...ids];
}
/** Token-Karten eines Matches (GrpId -> Name, Set, Nummer), damit die Website sie über das Scryfall-Token-Set auflösen kann */
function tokensOf(m, cards) {
  const ids = new Set();
  for (const f of m.frames || []) { for (const o of [...(f.bf || []), ...(f.st || []), ...(f.cmd || [])]) ids.add(o[1]); for (const e of f.ev || []) if (e.g) ids.add(e.g); }
  const out = {};
  for (const g of ids) { const c = cards.get(g); if (c && c.IsToken) out[g] = { name: c.Name, set: String(c.ExpansionCode || ""), nr: String(c.CollectorNumber || ""), types: String(c.Types || ""), colors: String(c.Colors || ""), power: c.Power || "", toughness: c.Toughness || "", text: c.Text || "", typeLine: c.TypeLine || "" }; }
  return Object.keys(out).length ? out : null;
}
/** Decks nur, wenn sich ihr Inhalt seit dem letzten Senden geändert hat */
function enqueueDecks(decks, cards) {
  if (!device()) return 0;
  const st = state(); let n = 0;
  for (const d of decks) {
    const h = hash([d.name, d.format, d.tile, d.zones, cards ? 1 : 0, d.archived ? 1 : 0]);
    if (st.deckHashes[d.id] === h) continue;
    const ids = [d.tile, ...Object.values(d.zones || {}).flatMap((z) => z.map(([g]) => g))].filter(Boolean);
    enqueue("deck", d.id + ":" + h, { id: d.id, name: d.name, format: d.format || null, tile: d.tile || null, lastUpdated: d.lastUpdated || null, zones: d.zones, archived: !!d.archived, archivedAt: d.archivedAt || null, cardInfo: cards ? cardInfoOf(ids, cards) || undefined : undefined }, d.lastUpdated || undefined);
    st.deckHashes[d.id] = h; n++;
  }
  saveState(st);
  return n;
}
/** Kontodaten (Gold, Edelsteine, Rang …): nur bei Änderung, ID aus dem Inhalt */
function enqueueAccount(a) {
  const body = Object.assign({}, a); delete body.takenAt;
  // nur der letzte Stand zählt: ältere, noch nicht gesendete Kontostände aus der Warteschlange nehmen
  const q = path.join(syncDir(), "queue");
  if (fs.existsSync(q)) for (const f of fs.readdirSync(q)) if (f.startsWith("account_")) { try { fs.unlinkSync(path.join(q, f)); } catch (e) { /* ignorieren */ } }
  enqueue("account", "acct:" + hash(body), a, a.takenAt || new Date().toISOString());
}
function enqueueCollection(snapshotMap, takenAt) {
  const at = takenAt || new Date().toISOString();
  enqueue("collection", "col:" + at, { takenAt: at, snapshot: [...snapshotMap] }, at);
}

let flushing = false;
/** Warteschlange senden; gibt { sent, left, error } zurück */
async function flush(log = () => {}) {
  const dev = device();
  const url = baseUrl();
  if (!dev || !url || flushing) return { sent: 0, left: 0, error: dev ? null : "nicht verbunden" };
  flushing = true;
  const st = state();
  try {
    const q = path.join(syncDir(), "queue");
    const files = fs.readdirSync(q).filter((f) => f.endsWith(".json")).sort();
    let sent = 0;
    // Paketgröße: Standard 40 Ereignisse; bei "413 Payload Too Large" (kleine Upload-Grenze bei Shared Hosting) halbieren und merken
    let size = Math.max(1, Math.min(40, st.batchSize || 40));
    for (let i = 0; i < files.length;) {
      const batch = files.slice(i, i + size);
      const events = batch.map((f) => readJson(path.join(q, f), null)).filter(Boolean);
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 60000);
      let r;
      try { r = await fetch(url + "/api/v1/sync", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + dev.token }, body: JSON.stringify({ device: { name: dev.name }, events }), signal: ctl.signal }); }
      finally { clearTimeout(t); }
      if (r.status === 401) { st.lastError = "Gerätetoken abgelehnt (auf der Website getrennt?)"; saveState(st); return { sent, left: files.length - sent, error: st.lastError }; }
      if (r.status === 413 && size > 1) { size = Math.ceil(size / 2); st.batchSize = size; saveState(st); log("Sync: Paket zu groß, sende jetzt " + size + " Ereignisse pro Paket"); continue; }
      if (!r.ok) throw new Error("HTTP " + r.status);
      i += batch.length;
      const j = await r.json();
      const done = new Set([...(j.accepted || []), ...(j.skipped || [])]);
      for (const f of batch) { const id = f.slice(0, -5); if (done.has(id)) { fs.unlinkSync(path.join(q, f)); sent++; } }
      for (const fl of j.failed || []) log(`Sync: Ereignis ${fl.id} abgelehnt: ${fl.error}`);
      if ((j.failed || []).length && !done.size) break;
    }
    st.lastFlushAt = new Date().toISOString(); st.lastError = null; st.sent = (st.sent || 0) + sent; saveState(st);
    if (sent) log(`Sync: ${sent} Ereignisse an ${url} gesendet`);
    return { sent, left: fs.readdirSync(q).length, error: null };
  } catch (e) {
    st.lastError = e.name === "AbortError" ? "Zeitüberschreitung" : e.message; saveState(st);
    return { sent: 0, left: fs.readdirSync(path.join(syncDir(), "queue")).length, error: st.lastError };
  } finally { flushing = false; }
}

/** Gerät verbinden: Code von der Website gegen Token tauschen */
async function connect(code, url) {
  url = String(url || baseUrl() || "").replace(/\/$/, "");
  if (!url) throw new Error("Website-Adresse fehlt (syncUrl in watch-config.json oder --url)");
  const r = await fetch(url + "/api/v1/device/claim", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: String(code).trim(), name: require("os").hostname() }) });
  if (r.status === 404) throw new Error("Code ungültig oder abgelaufen");
  if (!r.ok) throw new Error("HTTP " + r.status);
  const j = await r.json();
  fs.writeFileSync(deviceFile(), JSON.stringify({ url, token: j.token, deviceId: j.deviceId, user: j.user, name: require("os").hostname(), connectedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  saveState({ deckHashes: {}, lastFlushAt: null, lastError: null, sent: 0 });
  return j.user;
}
function disconnect() { try { fs.unlinkSync(deviceFile()); } catch (e) { /* schon weg */ } }
function status() {
  const dev = device(), st = state();
  const left = fs.existsSync(path.join(syncDir(), "queue")) ? fs.readdirSync(path.join(syncDir(), "queue")).length : 0;
  return { connected: !!dev, url: dev ? dev.url : baseUrl(), user: dev ? dev.user : null, queued: left, lastFlushAt: st.lastFlushAt, lastError: st.lastError, sent: st.sent || 0 };
}

module.exports = { enqueueMatch, enqueueDecks, enqueueCollection, enqueueAccount, tokensOf, cardInfoOf, matchCardIds, resendAll, syncAll, flush, connect, disconnect, status, device };


/** Alles erneut einreihen (z. B. nach neuer Server-Datenbank): gespeicherte Matches, alle Decks, letzte Sammlung */
async function resendAll(log = () => {}) {
  const lib = require("./lib"), matches = require("./matches"), webgen = require("./webgen");
  const { cards } = lib.loadCards(lib.findCardDb());
  const mdir = path.join(outDir(), "matches"); let n = 0;
  for (const f of fs.existsSync(mdir) ? fs.readdirSync(mdir) : []) {
    if (!f.endsWith(".json")) continue;
    try { const m = readJson(path.join(mdir, f), null); if (!m) continue; enqueueMatch(m, matches.matchSummary(m, cards), tokensOf(m, cards), cardInfoOf(matchCardIds(m), cards)); n++; } catch (e) { log("Match " + f + ": " + e.message); }
  }
  const st = state(); st.deckHashes = {}; saveState(st);
  const nd = enqueueDecks(webgen.readDecks(cards), cards);
  const snap = readJson(path.join(outDir(), "state.json"), null);
  if (snap && snap.snapshot) enqueueCollection(new Map(snap.snapshot));
  const acct = readJson(path.join(outDir(), "account.json"), null);
  if (acct) enqueueAccount(acct);
  log(`Eingereiht: ${n} Matches, ${nd} Decks, Sammlung`);
  const r = await flush(log); log(JSON.stringify(r)); return r;
}
/** Zähler des Servers (Decks, Matches) für das verbundene Konto */
async function serverCounts() {
  const dev = device(); if (!dev) return null;
  const r = await fetch(baseUrl() + "/api/v1/me", { headers: { Authorization: "Bearer " + dev.token } });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}
/** "Jetzt synchronisieren": Warteschlange senden; hat der Server weniger Decks oder Matches als lokal vorhanden, alles nachschicken */
async function syncAll(log = () => {}) {
  let r = await flush(log);
  if (r.error) return r;
  const me = await serverCounts(); if (!me) return r;
  const mdir = path.join(outDir(), "matches");
  const localMatches = fs.existsSync(mdir) ? fs.readdirSync(mdir).filter((f) => f.endsWith(".json")).length : 0;
  const localDecks = (readJson(path.join(outDir(), "web", "data.json"), {}).decks || []).length;
  if ((me.matches || 0) < localMatches || (me.decks || 0) < localDecks) {
    log(`Server hat ${me.matches} Matches / ${me.decks} Decks, lokal ${localMatches} / ${localDecks}: schicke alles nach`);
    r = await resendAll(log);
  } else {
    // Sammlung und Konto: hat der Server einen älteren Stand (oder andere Zahlen), den aktuellen lokalen nachschicken
    const snap = readJson(path.join(outDir(), "state.json"), null);
    const localSnap = snap && snap.snapshot ? new Map(snap.snapshot) : null;
    const localCards = localSnap ? [...localSnap.values()].reduce((s, q) => s + q, 0) : 0;
    const sc = me.collection || null;
    let extra = 0;
    if (localSnap && (!sc || sc.prints !== localSnap.size || sc.cards !== localCards)) { log(`Sammlung: Server ${sc ? sc.prints + " Drucke / " + sc.cards + " Karten" : "keine"}, lokal ${localSnap.size} / ${localCards}: schicke nach`); enqueueCollection(localSnap); extra++; }
    const acct = readJson(path.join(outDir(), "account.json"), null);
    if (acct && acct.takenAt && (!me.account || me.account < acct.takenAt)) { log("Konto: Server älter, schicke nach"); enqueueAccount(acct); extra++; }
    if (extra) { const r2 = await flush(log); r.sent += r2.sent; r.left = r2.left; r.error = r2.error; }
  }
  return Object.assign(r, { server: { matches: me.matches, decks: me.decks, collection: me.collection || null }, local: { matches: localMatches, decks: localDecks, collection: (() => { const s = readJson(path.join(outDir(), "state.json"), null); return s && s.snapshot ? { prints: s.snapshot.length, cards: s.snapshot.reduce((a, p) => a + p[1], 0) } : null; })() } });
}

if (require.main === module) {
  const [cmd, ...rest] = process.argv.slice(2);
  const urlArg = rest.includes("--url") ? rest[rest.indexOf("--url") + 1] : null;
  (async () => {
    if (cmd === "connect") { const u = await connect(rest[0], urlArg); console.log(`Verbunden als ${u.displayName} (${u.handle})`); }
    else if (cmd === "flush") { const r = await flush(console.log); console.log(JSON.stringify(r)); }
    else if (cmd === "disconnect") { disconnect(); console.log("Getrennt."); }
    else if (cmd === "resend") { await resendAll(console.log); }
    else if (cmd === "sync") { const r = await syncAll(console.log); console.log(JSON.stringify(r)); }
    else console.log(JSON.stringify(status(), null, 2));
  })().catch((e) => { console.error("Fehler: " + e.message); process.exit(1); });
}
