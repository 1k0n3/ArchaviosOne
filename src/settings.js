/**
 * Einstellungen des Begleitprogramms für das Dashboard lesen und schreiben.
 *
 * Geschrieben wird dieselbe watch-config.json, die auch das Tray-Menü pflegt: UTF-8 ohne BOM, die
 * Kommentarschlüssel (_name) bleiben erhalten. Es werden ausschließlich Schlüssel aus FIELDS
 * angenommen, jeder mit Typ und Grenzen – so kann die Oberfläche die Datei nicht beschädigen.
 *
 *   GET  /api/settings   -> { config, fields, file, outDir, version, platform, memoryScan, syncUrl }
 *   POST /api/settings   -> { ok, config }  (nur bekannte Schlüssel, Werte werden geprüft)
 */
const fs = require("fs");
const path = require("path");
const paths = require("./paths");

/** Was die Oberfläche anbieten darf. num: [min, max]; alles andere bleibt dem Tray-Menü überlassen. */
const FIELDS = [
  { key: "webDashboard", type: "bool", group: "dashboard", label: "Web-Dashboard aktualisieren", hint: "Nach jedem Match und zum Sitzungsende neu erzeugen." },
  { key: "webServer", type: "bool", group: "dashboard", label: "Lokalen Server starten", hint: "Liefert Dashboard, Kartenbilder und den Assistenten." },
  { key: "webPort", type: "num", min: 1024, max: 65535, group: "dashboard", label: "Port", hint: "Adresse des Dashboards: http://localhost:<Port>/" },
  { key: "prefetchCardImages", type: "bool", group: "dashboard", label: "Kartenbilder vorab auflösen", hint: "Beim Start alle Bildadressen holen. Aus, weil Scryfall sonst drosselt." },
  { key: "checkSec", type: "num", min: 5, max: 3600, group: "scan", label: "Prüfung während des Spiels (Sekunden)", hint: "Schneller Blick auf den bekannten Speicherblock." },
  { key: "fullScanSec", type: "num", min: 0, max: 86400, group: "scan", label: "Vollständiger Scan (Sekunden)", hint: "Findet verschobene Daten. 0 schaltet ihn ab." },
  { key: "pollSec", type: "num", min: 10, max: 3600, group: "scan", label: "Prüfung, ob Arena läuft (Sekunden)", hint: "Gilt nur, solange das Spiel nicht läuft." },
  { key: "matchCheckSec", type: "num", min: 2, max: 600, group: "scan", label: "Protokoll auf neue Matches prüfen (Sekunden)", hint: "Sehr günstig, darf klein bleiben." },
  { key: "startDelaySec", type: "num", min: 0, max: 600, group: "scan", label: "Wartezeit nach Spielstart (Sekunden)" },
  { key: "retrySec", type: "num", min: 10, max: 3600, group: "scan", label: "Wiederholung ohne Sammlung (Sekunden)", hint: "Wenn nach dem Start noch keine Sammlung im Speicher liegt." },
  { key: "minCards", type: "num", min: 1, max: 100000, group: "scan", label: "Mindestzahl Karten", hint: "Darunter gilt die Sammlung als noch nicht geladen." },
  { key: "maxQty", type: "num", min: 1, max: 10000, group: "scan", label: "Höchstzahl je Karte", hint: "Plausibilitätsgrenze für den Speicher-Scan." },
  { key: "writeEndCsvIfUnchanged", type: "bool", group: "export", label: "Nachher-CSV immer schreiben", hint: "Auch wenn sich in der Sitzung nichts geändert hat." },
  { key: "syncAccount", type: "bool", group: "sync", label: "Kontodaten mit synchronisieren", hint: "Gold, Edelsteine, Wildcards, Rang, Mastery und Quests zur Website senden." }
];
const BY_KEY = new Map(FIELDS.map((f) => [f.key, f]));

/** Rohe Datei samt Kommentarschlüsseln (readConfig() wirft die _-Schlüssel weg) */
function readRaw() {
  try { return JSON.parse(fs.readFileSync(paths.configFile(), "utf8").replace(/^﻿/, "")); } catch (e) { return {}; }
}
/** Einen Wert prüfen; gibt den bereinigten Wert zurück oder wirft mit einer Begründung */
function coerce(field, v) {
  if (field.type === "bool") {
    if (typeof v === "boolean") return v;
    if (v === "true" || v === "false") return v === "true";
    throw new Error(field.key + ": true oder false erwartet");
  }
  const n = typeof v === "number" ? v : parseInt(String(v), 10);
  if (!Number.isFinite(n)) throw new Error(field.key + ": Zahl erwartet");
  if (n < field.min || n > field.max) throw new Error(field.key + ": erlaubt sind " + field.min + " bis " + field.max);
  return n;
}
/**
 * Änderungen übernehmen. Unbekannte Schlüssel werden still übergangen, damit eine ältere Oberfläche
 * nichts erzwingen kann. Reihenfolge und Kommentare der Datei bleiben, weil in das gelesene Objekt
 * hineingeschrieben wird.
 */
function apply(patch) {
  const raw = readRaw(), changed = {};
  for (const [k, v] of Object.entries(patch || {})) {
    const f = BY_KEY.get(k);
    if (!f) continue;
    const val = coerce(f, v);
    if (raw[k] !== val) { raw[k] = val; changed[k] = val; }
  }
  if (Object.keys(changed).length) fs.writeFileSync(paths.configFile(), JSON.stringify(raw, null, 4), "utf8");
  return { raw, changed };
}
/** Aktueller Stand: nur die angebotenen Schlüssel, fehlende mit dem Standard des Watchers */
function current() {
  const raw = readRaw(), out = {};
  const DEF = { pollSec: 300, checkSec: 60, fullScanSec: 600, retrySec: 60, startDelaySec: 0, syncAccount: true, minCards: 200, maxQty: 400, writeEndCsvIfUnchanged: true, matchCheckSec: 10, webDashboard: true, webServer: true, webPort: 8765, prefetchCardImages: false };
  for (const f of FIELDS) out[f.key] = raw[f.key] !== undefined ? raw[f.key] : DEF[f.key];
  return out;
}

function info() {
  let version = "";
  try { version = require("../package.json").version; } catch (e) { /* ohne Version */ }
  return {
    config: current(), fields: FIELDS, file: paths.configFile(), outDir: paths.outDir(),
    version, platform: process.platform, node: process.version,
    memoryScan: paths.memoryScanSupported(), syncUrl: paths.readConfig().syncUrl || "",
    logDir: (() => { try { return paths.findLogDir(); } catch (e) { return ""; } })(),
    installDir: (() => { try { return paths.findInstallDir() || ""; } catch (e) { return ""; } })()
  };
}

// ---- HTTP -------------------------------------------------------------------------------------
function readBody(req, max = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let n = 0; const parts = [];
    req.on("data", (c) => { n += c.length; if (n > max) { reject(new Error("Anfrage zu groß")); req.destroy(); return; } parts.push(c); });
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(parts).toString("utf8") || "{}")); } catch (e) { reject(new Error("Ungültige Anfrage")); } });
    req.on("error", reject);
  });
}
const json = (res, o, code = 200) => { const b = Buffer.from(JSON.stringify(o)); res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-cache", "Content-Length": b.length }); res.end(b); };

/**
 * Verbindung zur Website: Stand abfragen, mit einem Code verbinden, trennen, jetzt abgleichen.
 * Das gehört in die Einstellungen, damit das Tray-Menü dafür nicht nötig ist.
 */
const loginStates = new Map();   // state -> Zeitpunkt; die Anmeldung läuft im Browser

function syncHandle(req, res, rest, port) {
  const sync = require("./sync");
  const st = () => { const s = sync.status(); return { connected: s.connected, url: s.url, user: s.user, queued: s.queued, lastFlushAt: s.lastFlushAt, lastError: s.lastError, sent: s.sent }; };
  if (rest === "state" && req.method === "GET") { json(res, st()); return true; }
  if (rest === "connect" && req.method === "POST") {
    readBody(req).then(async (b) => {
      const code = String(b.code || "").trim();
      if (code.length < 6 || code.length > 12) { json(res, { error: "Code fehlt oder ist zu kurz." }, 400); return; }
      try {
        const user = await sync.connect(code, b.url || undefined);
        // Zugang des Assistenten gleich mitgeben, damit man online ohne zweite Anmeldung verbunden ist
        try { const a = require("./assistant").readCfg(); if (a.apiKey) sync.enqueueAssistant(a); } catch (e) { /* ohne Assistent */ }
        sync.syncAll(() => {}).catch(() => {});
        json(res, { ok: true, user, state: st() });
      } catch (e) { json(res, { error: e.message }, 400); }
    }).catch((e) => json(res, { error: e.message }, 400));
    return true;
  }
  // Anmeldung im Browser: die Website kennt das Konto, der Companion bekommt nur einen Code zurück
  if (rest === "login" && req.method === "GET") {
    const url = String(paths.readConfig().syncUrl || "").replace(/\/$/, "");
    if (!url) { json(res, { error: "Keine Website-Adresse eingetragen (syncUrl)." }, 400); return true; }
    const state = require("crypto").randomBytes(12).toString("hex");
    loginStates.set(state, Date.now());
    for (const [k, t] of loginStates) if (Date.now() - t > 15 * 60 * 1000) loginStates.delete(k);
    const cb = "http://localhost:" + (port || 8765) + "/api/sync/callback";
    json(res, { url: url + "/connect/app?state=" + state + "&cb=" + encodeURIComponent(cb) + "&name=" + encodeURIComponent(require("os").hostname()) });
    return true;
  }
  if (rest === "callback" && req.method === "GET") {
    const q = new URL(req.url, "http://localhost").searchParams;
    const page = (title, text) => {
      const b = Buffer.from('<!doctype html><meta charset="utf-8"><title>' + title + '</title><body style="background:#100d0b;color:#f5eee2;font:16px/1.6 system-ui;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center;max-width:420px"><h1 style="font:700 22px Georgia,serif;color:#f2b134">' + title + '</h1><p>' + text + '</p><button onclick="window.close()" style="background:linear-gradient(180deg,#ffd36b,#f2b134);border:0;border-radius:10px;padding:10px 18px;font-weight:700;cursor:pointer">Fenster schließen</button></div><script>try{window.opener&&window.opener.postMessage("mtga-sync-connected","*")}catch(e){}<\/script>', "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": b.length });
      res.end(b);
    };
    const state = q.get("state") || "", code = q.get("code") || "";
    if (!loginStates.has(state)) { page("Abgelaufen", "Die Anmeldung ist abgelaufen. Bitte erneut starten."); return true; }
    loginStates.delete(state);
    if (!code) { page("Abgebrochen", "Es wurde kein Zugang erteilt."); return true; }
    sync.connect(code, paths.readConfig().syncUrl).then(() => {
      try { const a = require("./assistant").readCfg(); if (a.apiKey) sync.enqueueAssistant(a); } catch (e) { /* ohne Assistent */ }
      sync.syncAll(() => {}).catch(() => {});
      page("Verbunden", "Dieses Gerät ist jetzt mit deinem Konto verbunden.");
    }).catch((e) => page("Fehlgeschlagen", String(e.message || e)));
    return true;
  }
  if (rest === "disconnect" && req.method === "POST") { sync.disconnect(); json(res, { ok: true, state: st() }); return true; }
  if (rest === "now" && req.method === "POST") {
    sync.syncAll(() => {}).then((r) => json(res, { ok: !r.error, ergebnis: r, state: st() })).catch((e) => json(res, { error: e.message }, 502));
    return true;
  }
  json(res, { error: "unbekannt" }, 404);
  return true;
}

/** GET liefert Stand und Felder, POST übernimmt Änderungen. true = Anfrage erledigt. */
function handle(req, res, url, port) {
  const p = url ? url.pathname : "/api/settings";
  if (p.startsWith("/api/sync/")) return syncHandle(req, res, p.slice("/api/sync/".length), port);
  if (req.method === "GET") { json(res, info()); return true; }
  if (req.method === "POST") {
    readBody(req).then((b) => { const r = apply(b); json(res, { ok: true, config: current(), changed: Object.keys(r.changed) }); })
      .catch((e) => json(res, { error: e.message }, 400));
    return true;
  }
  json(res, { error: "unbekannt" }, 405);
  return true;
}

module.exports = { FIELDS, info, current, apply, coerce, readRaw, handle, syncHandle };
