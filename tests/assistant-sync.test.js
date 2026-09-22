"use strict";
process.env.MTGA_NO_MIRROR = "1";   // nie zur echten Website spiegeln
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

// Eigener Ausgabeordner, damit die echte Einstellung des Benutzers unberührt bleibt
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mtga-asst-sync-"));
const paths = require("../src/paths");
paths.outDir = () => tmp;
const sync = require("../src/sync");
const asst = require("../src/assistant");
const T = asst._test;
const cfgPath = path.join(tmp, "assistant.json");

test.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* egal */ } });

test("Nur Sprachmodelle bleiben in der Liste", () => {
  const l = ["gemini-3.6-flash", "gemini-embedding-001", "gemini-2.5-flash-preview-tts", "imagen-4", "aqa", "gemma-4-31b-it", "veo-3", "antigravity-preview-09-2026", "gemini-3.1-flash-image"].map((id) => ({ id }));
  assert.deepEqual(T.nurChatModelle("google", l).map((m) => m.id), ["gemini-3.6-flash", "gemma-4-31b-it"]);
  const o = ["gpt-5-mini", "whisper-1", "text-embedding-3-large", "dall-e-3", "gpt-4o-realtime-preview", "omni-moderation-latest", "gpt-4.1-mini"].map((id) => ({ id }));
  assert.deepEqual(T.nurChatModelle("openai", o).map((m) => m.id), ["gpt-5-mini", "gpt-4.1-mini"]);
});

test("Ein abgeschaltetes Modell wird durch den genannten Nachfolger ersetzt", () => {
  const google = { provider: "google" };
  const text = "This model models/gemini-2.5-flash is no longer available to new users. Please update your code to use models/gemini-3.6-flash for the latest features.";
  assert.equal(T.ersatzModell(google, 404, text, "gemini-2.5-flash"), "gemini-3.6-flash");
  // Ohne Hinweis im Text: das Standardmodell des Anbieters
  assert.equal(T.ersatzModell(google, 404, "model not found", "gemini-1.0-pro"), asst.PROVIDERS.google.model);
  // Andere Fehler lösen keinen Wechsel aus
  assert.equal(T.ersatzModell(google, 429, text, "gemini-2.5-flash"), "");
  assert.equal(T.ersatzModell(google, 400, "Please pass a valid API key", "gemini-2.5-flash"), "");
});

test("Das Standardmodell von Gemini ist nicht das abgeschaltete", () => {
  assert.notEqual(asst.PROVIDERS.google.model, "gemini-2.5-flash");
});

test("Lange Fehlertexte werden an einer Grenze gekürzt", () => {
  const lang = "Erster Satz ist hier. " + "wort ".repeat(200);
  const k = T.kurz(lang, 120);
  assert.ok(k.length <= 122);
  assert.ok(!/wor$/.test(k), "nicht mitten im Wort");
});

function fakeSite(antwort) {
  return new Promise((ok) => {
    const seen = [];
    const srv = http.createServer((req, res) => {
      seen.push({ url: req.url, auth: req.headers.authorization });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(antwort()));
    });
    srv.listen(0, "127.0.0.1", () => ok({ srv, seen, url: "http://127.0.0.1:" + srv.address().port }));
  });
}

test("Auf der Website verbunden heißt auch hier verbunden", async () => {
  fs.writeFileSync(cfgPath, JSON.stringify({ provider: "openrouter", keys: { openrouter: "sk-or" }, models: {}, updatedAt: "2026-01-01T00:00:00Z" }));
  const stand = new Date().toISOString();
  const site = await fakeSite(() => ({ provider: "google", key: "g-schluessel", model: "gemini-3.6-flash", updatedAt: stand }));
  const altD = sync.device, altB = sync.baseUrl;
  sync.device = () => ({ token: "geraet-123" });
  sync.baseUrl = () => site.url;
  try {
    const v = await asst.pullFromSite(true, { ungeprueft: true });
    assert.equal(v.neu, true);
    const c = T.readCfg();
    assert.equal(c.provider, "google");
    assert.equal(c.apiKey, "g-schluessel");
    assert.equal(c.model, "gemini-3.6-flash");
    assert.equal(site.seen[0].url, "/api/v1/assistant");
    assert.equal(site.seen[0].auth, "Bearer geraet-123");
    // Der alte Zugang bleibt erhalten
    assert.deepEqual(T.connectedProviders().sort(), ["google", "openrouter"]);
    // Zweiter Abgleich: nichts Neues
    const v2 = await asst.pullFromSite(true, { ungeprueft: true });
    assert.equal(v2.neu, false);
  } finally { sync.device = altD; sync.baseUrl = altB; site.srv.close(); }
});

test("Ein älterer Stand der Website überschreibt eine neuere Einstellung nicht", async () => {
  fs.writeFileSync(cfgPath, JSON.stringify({ provider: "openrouter", keys: { openrouter: "sk-or" }, models: {}, updatedAt: new Date().toISOString() }));
  const site = await fakeSite(() => ({ provider: "groq", key: "gsk-alt", model: "", updatedAt: "2025-01-01T00:00:00Z" }));
  const altD = sync.device, altB = sync.baseUrl;
  sync.device = () => ({ token: "t" });
  sync.baseUrl = () => site.url;
  try {
    const v = await asst.pullFromSite(true, { ungeprueft: true });
    assert.equal(v.neu, false);
    assert.equal(T.readCfg().provider, "openrouter");
  } finally { sync.device = altD; sync.baseUrl = altB; site.srv.close(); }
});

test("Ohne Schlüssel wird nichts zur Website gespiegelt", () => {
  // Nur hier wird das Spiegeln eingeschaltet, und zwar gegen eine Attrappe: nichts verlässt den Rechner
  const altE = sync.enqueueAssistant, altD = sync.device, gesendet = [];
  const altEnv = { a: process.env.MTGA_NO_MIRROR, b: process.env.NODE_TEST_CONTEXT };
  sync.device = () => ({ token: "t" });
  sync.enqueueAssistant = (c) => { gesendet.push(c); return false; };
  delete process.env.MTGA_NO_MIRROR; delete process.env.NODE_TEST_CONTEXT;
  try {
    fs.writeFileSync(cfgPath, JSON.stringify({ provider: "openrouter", keys: { openrouter: "sk-or" }, models: {} }));
    T.writeCfg({ provider: "google", model: "" });          // Wechsel ohne Schlüssel
    assert.equal(gesendet.length, 0);
    T.writeCfg({ apiKey: "g-neu" });                        // jetzt vollständig
    assert.equal(gesendet.length, 1);
    assert.equal(gesendet[0].provider, "google");
    assert.equal(gesendet[0].apiKey, "g-neu");
  } finally {
    sync.enqueueAssistant = altE; sync.device = altD;
    if (altEnv.a !== undefined) process.env.MTGA_NO_MIRROR = altEnv.a;
    if (altEnv.b !== undefined) process.env.NODE_TEST_CONTEXT = altEnv.b;
  }
});
