"use strict";
process.env.MTGA_NO_MIRROR = "1";   // nie zur echten Website
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

// Eigener Datenordner und ein leerer Log-Ordner: so tun, als wäre es ein neues Gerät
// Eigene Einstellungsdatei: auch das Sync-Modul liest seinen Datenordner daraus, nicht aus paths.outDir
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mtga-restore-"));
const leer = fs.mkdtempSync(path.join(os.tmpdir(), "mtga-log-"));
fs.writeFileSync(path.join(tmp, "test-config.json"), JSON.stringify({ outDir: tmp }));
process.env.MTGA_STATS_CONFIG = path.join(tmp, "test-config.json");
const paths = require("../src/paths");
assert.equal(paths.outDir(), tmp);
paths.findLogDir = () => leer;
const sync = require("../src/sync");
let geraet = null, url = "";
sync.device = () => geraet;
sync.baseUrl = () => url;
const restore = require("../src/restore");
const webgen = require("../src/webgen");

const replay = (id, start) => ({ match: { matchId: id, start, mySeat: 1, players: [{ seat: 1, name: "Ich" }, { seat: 2, name: "Gegner" }], myDeck: { deckId: "d1", cards: [{ grpId: 101, qty: 4 }], commander: [] }, opponentCards: [], result: "win", eventId: "Ladder" },
  frames: [{ bf: [], st: [], cmd: [], h: [[], []], gy: [[], []], ex: [[], []], ev: [] }], tokens: null, cardInfo: null });
const KONTO = {
  matches: { "m-0001": replay("m-0001", 1700000000000), "m-0002": replay("m-0002", 1700000600000), "m-0003": replay("m-0003", 1700001200000) },
  decks: [{ id: "d1", name: "Mono Rot", format: "Standard", tile: 101, zones: { MainDeck: [[101, 4]] }, lastUpdated: "2026-10-01T10:00:00.000Z", archived: false, archivedAt: null },
    { id: "d2", name: "Alt", format: "Historic", tile: 102, zones: { MainDeck: [[102, 2]] }, lastUpdated: "2026-09-01T10:00:00.000Z", archived: true, archivedAt: "2026-09-05T10:00:00.000Z" }],
  collection: { takenAt: "2026-10-08T12:00:00.000Z", snapshot: [[101, 4], [102, 2]] },
  account: { takenAt: "2026-10-08T12:00:00.000Z", data: { gold: 1234, gems: 560 } }
};
let anfragen = [];
const site = http.createServer((req, res) => {
  anfragen.push(req.url);
  const send = (o) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
  if (req.headers.authorization !== "Bearer tok-1") { res.writeHead(401); return res.end("{}"); }
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/api/v1/restore") return send({ matches: Object.keys(KONTO.matches).map((id) => [id, "2026-10-01"]).concat([["../böse", "x"]]), decks: KONTO.decks, collection: KONTO.collection.takenAt, account: KONTO.account.takenAt });
  if (u.pathname === "/api/v1/restore/matches") return send({ matches: u.searchParams.get("ids").split(",").filter((id) => KONTO.matches[id]).map((id) => ({ id, replay: KONTO.matches[id] })) });
  if (u.pathname === "/api/v1/restore/collection") return send(KONTO.collection);
  if (u.pathname === "/api/v1/restore/account") return send(KONTO.account);
  res.writeHead(404); res.end();
});
test.before(() => new Promise((ok) => site.listen(0, "127.0.0.1", () => { url = "http://127.0.0.1:" + site.address().port; ok(); })));
test.after(() => { site.close(); for (const d of [tmp, leer]) try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* egal */ } });

test("Ohne Verbindung wird nichts geholt", async () => {
  geraet = null;
  const r = await restore.run({});
  assert.equal(r.error, "nicht verbunden");
  assert.equal(anfragen.length, 0);
});

test("Neues Gerät: Matches, Decks, Sammlung und Kontostand kommen vom Konto", async () => {
  geraet = { token: "tok-1" };
  fs.mkdirSync(path.join(tmp, "matches"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "matches", "m-0002.json"), JSON.stringify(Object.assign({}, replay("m-0002", 1700000600000).match, { frames: [], hier: true })));
  let neu = 0;
  const r = await restore.run({ rebuild: () => { neu++; } });
  assert.equal(r.error, null);
  assert.equal(r.matches, 2, "nur die fehlenden zwei");
  assert.ok(r.collection && r.account && r.decks === 2 && r.changed);
  assert.equal(neu, 1, "Dashboard einmal neu gebaut");
  const m1 = JSON.parse(fs.readFileSync(path.join(tmp, "matches", "m-0001.json"), "utf8"));
  assert.equal(m1.matchId, "m-0001");
  assert.equal(m1.frames.length, 1);
  assert.equal(m1.myDeck.deckId, "d1");
  assert.ok(JSON.parse(fs.readFileSync(path.join(tmp, "matches", "m-0002.json"), "utf8")).hier, "eigene Aufzeichnung bleibt unangetastet");
  assert.ok(!fs.readdirSync(path.join(tmp, "matches")).some((f) => f.includes("böse")), "unsichere ID wird nicht geholt");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(tmp, "site-collection.json"), "utf8")).snapshot, [[101, 4], [102, 2]]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, "site-account.json"), "utf8")).gold, 1234);
  assert.equal(restore.status().matches, 2);
});

test("Zweiter Lauf holt nur Neues", async () => {
  anfragen = [];
  const r = await restore.run({ rebuild: () => assert.fail("nichts geändert, kein Neubau") });
  assert.equal(r.matches, 0);
  assert.equal(r.changed, false);
  assert.deepEqual(anfragen, ["/api/v1/restore"], "nur die Übersicht, keine Replays, Sammlung oder Konto");
  KONTO.collection = { takenAt: "2026-10-09T08:00:00.000Z", snapshot: [[101, 4], [102, 3], [103, 1]] };
  const r2 = await restore.run({});
  assert.equal(r2.collection, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, "site-collection.json"), "utf8")).snapshot.length, 3);
});

test("Ohne Arena-Log zeigt das Dashboard die Decks vom Konto – und schickt sie nicht zurück", () => {
  const decks = webgen.readDecks(new Map(), tmp);
  assert.deepEqual(decks.map((d) => [d.id, !!d.archived, d.fromSite]), [["d1", false, true], ["d2", true, true]]);
  geraet = { token: "tok-1" };
  // Das Sync-Modul liest das verbundene Gerät intern aus seiner Datei (hier im Testordner)
  fs.mkdirSync(path.join(tmp, "sync", "queue"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "sync", "device.json"), JSON.stringify({ url: "http://127.0.0.1:1", token: "tok-1" }));
  assert.equal(sync.enqueueDecks(decks, null), 0);
  assert.equal(fs.readdirSync(path.join(tmp, "sync", "queue")).length, 0);
  // Gegenprobe: ein eigenes Deck aus dem Log würde eingereiht
  assert.equal(sync.enqueueDecks([{ id: "d9", name: "Eigen", zones: { MainDeck: [[1, 1]] } }], null), 1);
  assert.equal(fs.readdirSync(path.join(tmp, "sync", "queue")).length, 1);
});

test("Besitzstand: eigene Lesung vor dem vom Konto geholten", () => {
  const serve = require("../src/serve");
  const web = path.join(tmp, "web");
  assert.equal(serve.ownedCounts(web).get(103), 1, "vom Konto");
  fs.writeFileSync(path.join(tmp, "state.json"), JSON.stringify({ snapshot: [[103, 9]] }));
  assert.equal(serve.ownedCounts(web).get(103), 9, "eigene Lesung gewinnt");
  fs.rmSync(path.join(tmp, "state.json"));
});

test("Abgelaufene Verbindung wird gemeldet, nichts geändert", async () => {
  geraet = { token: "falsch" };
  const r = await restore.run({});
  assert.match(r.error, /Gerätetoken abgelehnt/);
  assert.equal(r.changed, false);
});
