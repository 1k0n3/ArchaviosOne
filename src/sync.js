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
  try { const raw = JSON.parse(fs.readFileSync(path.join(ROOT, "watch-config.json"), "utf8")); const o = {}; for (const k of Object.keys(raw)) if (!k.startsWith("_")) o[k] = raw[k]; return o; } catch (e) { return {}; }
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
function enqueueMatch(m, summary) {
  enqueue("match", summary.matchId, { summary, replay: { match: Object.assign({}, m, { frames: undefined }), frames: m.frames } }, new Date(m.start).toISOString());
}
/** Decks nur, wenn sich ihr Inhalt seit dem letzten Senden geändert hat */
function enqueueDecks(decks) {
  if (!device()) return 0;
  const st = state(); let n = 0;
  for (const d of decks) {
    const h = hash([d.name, d.format, d.tile, d.zones]);
    if (st.deckHashes[d.id] === h) continue;
    enqueue("deck", d.id + ":" + h, { id: d.id, name: d.name, format: d.format || null, tile: d.tile || null, lastUpdated: d.lastUpdated || null, zones: d.zones }, d.lastUpdated || undefined);
    st.deckHashes[d.id] = h; n++;
  }
  saveState(st);
  return n;
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
    for (let i = 0; i < files.length; i += 40) {
      const batch = files.slice(i, i + 40);
      const events = batch.map((f) => readJson(path.join(q, f), null)).filter(Boolean);
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 60000);
      let r;
      try { r = await fetch(url + "/api/v1/sync", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + dev.token }, body: JSON.stringify({ device: { name: dev.name }, events }), signal: ctl.signal }); }
      finally { clearTimeout(t); }
      if (r.status === 401) { st.lastError = "Gerätetoken abgelehnt (auf der Website getrennt?)"; saveState(st); return { sent, left: files.length - sent, error: st.lastError }; }
      if (!r.ok) throw new Error("HTTP " + r.status);
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

module.exports = { enqueueMatch, enqueueDecks, enqueueCollection, flush, connect, disconnect, status, device };

if (require.main === module) {
  const [cmd, ...rest] = process.argv.slice(2);
  const urlArg = rest.includes("--url") ? rest[rest.indexOf("--url") + 1] : null;
  (async () => {
    if (cmd === "connect") { const u = await connect(rest[0], urlArg); console.log(`Verbunden als ${u.displayName} (${u.handle})`); }
    else if (cmd === "flush") { const r = await flush(console.log); console.log(JSON.stringify(r)); }
    else if (cmd === "disconnect") { disconnect(); console.log("Getrennt."); }
    else console.log(JSON.stringify(status(), null, 2));
  })().catch((e) => { console.error("Fehler: " + e.message); process.exit(1); });
}
