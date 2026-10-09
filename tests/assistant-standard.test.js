"use strict";
process.env.MTGA_NO_MIRROR = "1";   // nie zur echten Website spiegeln
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { EventEmitter } = require("node:events");

// Eigener Ordner für out/assistant.json, damit die echte Datei unberührt bleibt
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mtga-std-"));
const paths = require("../src/paths");
paths.outDir = () => tmp;
// Der Abgleich mit der Website liest sonst das echte verbundene Gerät aus out/sync und fragt die
// echte Website: im Test gibt es kein verbundenes Gerät
const sync = require("../src/sync");
sync.device = () => null;
const asst = require("../src/assistant");
const { chat, readCfg, writeCfg, stdCheck, keyInfo, verifyKey, setSite } = asst._test;
const cfgPath = path.join(tmp, "assistant.json");

/** Nachgebaute Website: Auskunft zum Standard und Chat, wie hosting/app/routes.php sie anbietet */
let gesehen = [], verfuegbar = true, chatStatus = 200;
const site = http.createServer((req, res) => {
  let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => {
    gesehen.push({ url: req.url, auth: req.headers.authorization, body: b ? JSON.parse(b) : null });
    if (req.headers.authorization !== "Bearer geraet-123") { res.writeHead(401, { "Content-Type": "application/json" }); return res.end('{"error":"Gerätetoken ungültig"}'); }
    if (req.url === "/api/v1/assistant/standard") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify(verfuegbar ? { available: true, perUser: 30, used: 2, left: 28 } : { available: false })); }
    if (req.url === "/api/v1/assistant/chat") {
      if (chatStatus !== 200) { res.writeHead(chatStatus, { "Content-Type": "application/json" }); return res.end('{"error":"kaputt"}'); }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      return res.end('data: {"t":"model","model":"openai/gpt-oss-120b","std":true}\n\ndata: {"t":"text","d":"Hallo"}\n\ndata: {"t":"tool","id":"c1","name":"search_cards","args":{"q":"bolt"}}\n\ndata: {"t":"done","stop":"tool"}\n\n');
    }
    res.writeHead(404); res.end();
  });
});
let url = "";
test.before(() => new Promise((ok) => site.listen(0, "127.0.0.1", () => { url = "http://127.0.0.1:" + site.address().port; ok(); })));
test.after(() => { site.close(); setSite(null); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* egal */ } });

function antwort() {
  const r = new EventEmitter(); r.text = "";
  r.write = (s) => { r.text += s; return true; };
  r.events = () => r.text.split("\n\n").filter(Boolean).map((b) => JSON.parse(b.replace(/^data: /, "")));
  return r;
}

test("Ohne verbundene Website gibt es keinen Standard", async () => {
  setSite(() => null);
  await stdCheck(true);
  assert.equal(readCfg().provider, "openrouter");
  const v = await verifyKey({ provider: "standard" });
  assert.equal(v.ok, false);
  assert.match(v.error, /mit der Website verbinden/);
  const res = antwort();
  await chat({ provider: "standard" }, { messages: [{ role: "user", text: "x" }] }, res);
  assert.match(res.events()[0].m, /verbundenes Konto/);
});

test("Verbundenes Gerät ohne eigene Einstellung: der Standard gilt", async () => {
  setSite(() => ({ url, token: "geraet-123" }));
  await stdCheck(true);
  const c = readCfg();
  assert.equal(c.provider, "standard");
  assert.equal(asst.PROVIDERS.standard.noKey, true);
  assert.deepEqual(await verifyKey(c), { ok: true });
  const q = await keyInfo(c);
  assert.equal(q.standard, true);
  assert.equal(q.tagGrenze, 30);
  assert.equal(q.tagBenutzt, 2);
  assert.equal(q.tagRest, 28);
  const l = await asst.listModels(c);
  assert.equal(l.length, 1);
  assert.equal(l[0].id, "auto");
});

test("Fragen gehen mit dem Gerätetoken an die Website, Ereignisse unverändert zurück", async () => {
  setSite(() => ({ url, token: "geraet-123" }));
  gesehen = [];
  const res = antwort();
  await chat({ provider: "standard" }, { system: "Sys", messages: [{ role: "user", text: "Hallo?" }], tools: [{ name: "search_cards" }] }, res);
  const req = gesehen.find((g) => g.url === "/api/v1/assistant/chat");
  assert.ok(req);
  assert.equal(req.auth, "Bearer geraet-123");
  assert.equal(req.body.system, "Sys");
  assert.equal(req.body.messages[0].text, "Hallo?");
  assert.equal(req.body.tools[0].name, "search_cards");
  const ev = res.events();
  assert.deepEqual(ev.map((e) => e.t), ["model", "text", "tool", "done"]);
  assert.equal(ev[2].args.q, "bolt");
});

test("Abgelaufene Verbindung und Fehler der Website werden verständlich gemeldet", async () => {
  setSite(() => ({ url, token: "falsch" }));
  let res = antwort();
  await chat({ provider: "standard" }, { messages: [{ role: "user", text: "x" }] }, res);
  assert.match(res.events()[0].m, /neu verbinden/);
  setSite(() => ({ url, token: "geraet-123" }));
  chatStatus = 500;
  res = antwort();
  await chat({ provider: "standard" }, { messages: [{ role: "user", text: "x" }] }, res);
  assert.match(res.events()[0].m, /HTTP 500 – kaputt/);
  chatStatus = 200;
});

test("Ein eigener Zugang hat Vorrang; der Standard wird nicht gespiegelt", async () => {
  setSite(() => ({ url, token: "geraet-123" }));
  await stdCheck(true);
  writeCfg({ provider: "groq", apiKey: "gsk-eigen" });
  assert.equal(readCfg().provider, "groq");
  const n = writeCfg({ provider: "standard" });
  assert.equal(n.provider, "standard");
  assert.equal(n.apiKey, "");
  // Der eigene Groq-Schlüssel bleibt für später erhalten
  const roh = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  assert.equal(roh.keys.groq, "gsk-eigen");
  fs.rmSync(cfgPath, { force: true });
});

test("Bietet die Website keinen Standard an, verschwindet er aus der Liste", async () => {
  setSite(() => ({ url, token: "geraet-123" }));
  const state = () => new Promise((ok) => {
    const res = { writeHead() {}, end(b) { ok(JSON.parse(String(b))); } };
    asst.handle({ method: "GET" }, res, new URL("http://127.0.0.1/api/assistant/state"), () => [], 0);
  });
  verfuegbar = true; await stdCheck(true);
  let s = await state();
  assert.ok(s.providers.some((p) => p.id === "standard"));
  assert.equal(s.provider, "standard");
  assert.equal(s.hasKey, true);
  verfuegbar = false; await stdCheck(true);
  s = await state();
  assert.ok(!s.providers.some((p) => p.id === "standard"));
  assert.equal(s.provider, "openrouter");
  verfuegbar = true;
});
