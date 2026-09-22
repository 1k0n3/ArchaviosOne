"use strict";
process.env.MTGA_NO_MIRROR = "1";   // nie zur echten Website spiegeln
const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const { EventEmitter } = require("node:events");
const { chat } = require("../src/assistant")._test;

/** Nachgebauter Anbieter: schickt die Antwort in beliebig zerteilten Bytes */
function anbieter(stuecke) {
  return new Promise((ok) => {
    const srv = http.createServer((req, res) => {
      req.resume();
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      let i = 0;
      const weiter = () => { if (i >= stuecke.length) return res.end(); res.write(stuecke[i++]); setTimeout(weiter, 5); };
      weiter();
    });
    srv.listen(0, "127.0.0.1", () => ok({ srv, url: "http://127.0.0.1:" + srv.address().port }));
  });
}
/** Fängt die Ereignisse ab, die sonst an den Browser gingen */
function antwort() {
  const r = new EventEmitter(); r.text = "";
  r.write = (s) => { r.text += s; return true; };
  r.events = () => r.text.split("\n\n").filter(Boolean).map((b) => JSON.parse(b.replace(/^data: /, "")));
  return r;
}
const sse = (o) => "data: " + JSON.stringify(o) + "\n\n";

test("Ein Umlaut über zwei Netzpakete bleibt ganz", async () => {
  const roh = Buffer.from(sse({ choices: [{ delta: { content: "Schön grün" } }] }) + sse({ choices: [{ delta: {}, finish_reason: "stop" }] }), "utf8");
  const mitte = roh.indexOf(Buffer.from("ö")) + 1;          // mitten im ö trennen
  const a = await anbieter([roh.subarray(0, mitte), roh.subarray(mitte)]);
  try {
    const res = antwort();
    await chat({ provider: "custom", baseUrl: a.url, apiKey: "x", model: "m" }, { messages: [{ role: "user", text: "hi" }] }, res);
    const text = res.events().filter((e) => e.t === "text").map((e) => e.d).join("");
    assert.equal(text, "Schön grün");
  } finally { a.srv.close(); }
});

test("Ein abgeschnittener Werkzeugaufruf wird nicht ausgeführt", async () => {
  const a = await anbieter([
    sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "search_cards", arguments: "{\"q\":\"Lightn" } }] } }] }),
    sse({ choices: [{ delta: {}, finish_reason: "length" }] })
  ]);
  try {
    const res = antwort();
    await chat({ provider: "custom", baseUrl: a.url, apiKey: "x", model: "m" }, { messages: [{ role: "user", text: "hi" }] }, res);
    const ev = res.events();
    assert.equal(ev.filter((e) => e.t === "tool").length, 0, "kein halber Werkzeugaufruf");
    assert.ok(ev.some((e) => e.t === "err" && /abgeschnitten/.test(e.m)));
  } finally { a.srv.close(); }
});

test("Ein vollständiger Werkzeugaufruf kommt mit seinen Angaben an", async () => {
  const a = await anbieter([
    sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "search_cards", arguments: "{\"q\":" } }] } }] }),
    sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "\"Blitz\"}" } }] } }] }),
    sse({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })
  ]);
  try {
    const res = antwort();
    await chat({ provider: "custom", baseUrl: a.url, apiKey: "x", model: "m" }, { messages: [{ role: "user", text: "hi" }] }, res);
    const t = res.events().find((e) => e.t === "tool");
    assert.ok(t);
    assert.deepEqual(t.args, { q: "Blitz" });
  } finally { a.srv.close(); }
});

test("Ein Netzaussetzer wird einmal wiederholt und sonst verständlich gemeldet", async () => {
  // Erster Versuch: Verbindung wird sofort geschlossen. Zweiter Versuch: echte Antwort.
  let n = 0;
  const srv = http.createServer((req, res) => {
    n++;
    if (n === 1) { req.socket.destroy(); return; }
    req.resume();
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(sse({ choices: [{ delta: { content: "Hallo" } }] }) + sse({ choices: [{ delta: {}, finish_reason: "stop" }] }));
  });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  try {
    const res = antwort();
    await chat({ provider: "custom", baseUrl: "http://127.0.0.1:" + srv.address().port, apiKey: "x", model: "m" }, { messages: [{ role: "user", text: "hi" }] }, res);
    assert.equal(n, 2, "einmal wiederholt");
    assert.equal(res.events().filter((e) => e.t === "text").map((e) => e.d).join(""), "Hallo");
  } finally { srv.close(); }
});

test("Ist der Anbieter gar nicht erreichbar, nennt die Meldung Adresse und Grund", async () => {
  // Ein freier Port, auf dem niemand lauscht
  const srv = http.createServer(); await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  const port = srv.address().port; await new Promise((ok) => srv.close(ok));
  const res = antwort();
  await chat({ provider: "custom", baseUrl: "http://127.0.0.1:" + port, apiKey: "x", model: "m" }, { messages: [{ role: "user", text: "hi" }] }, res);
  const err = res.events().find((e) => e.t === "err");
  assert.ok(err, "Fehler gemeldet");
  assert.match(err.m, /Keine Verbindung zu 127\.0\.0\.1:\d+ \(ECONNREFUSED\)/);
});
