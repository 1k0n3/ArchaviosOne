process.env.MTGA_NO_MIRROR = "1";   // nie zur echten Website spiegeln
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Die Einstellungen arbeiten auf der Datei aus paths.configFile(); für den Test auf eine Kopie zeigen
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mtga-set-"));
const file = path.join(tmp, "watch-config.json");
process.env.MTGA_STATS_CONFIG = file;
const st = require("../src/settings");

const ORIGINAL = `{
    "_hinweis":  "Alle Zeiten in Sekunden.",
    "pollSec":  300,
    "_pollSec":  "Wie oft geprüft wird, ob MTGA läuft.",
    "checkSec":  60,
    "webPort":  8765,
    "syncUrl":  "https://mtga.a16.be",
    "anchors":  []
}`;
const write = () => fs.writeFileSync(file, ORIGINAL, "utf8");
const read = () => JSON.parse(fs.readFileSync(file, "utf8"));

test("coerce prüft Typ und Grenzen", () => {
  const port = st.FIELDS.find((f) => f.key === "webPort");
  const flag = st.FIELDS.find((f) => f.key === "webServer");
  assert.equal(st.coerce(port, "8080"), 8080, "Zahlen dürfen als Text kommen");
  assert.throws(() => st.coerce(port, 80), /1024 bis 65535/);
  assert.throws(() => st.coerce(port, "abc"), /Zahl erwartet/);
  assert.equal(st.coerce(flag, "false"), false);
  assert.equal(st.coerce(flag, true), true);
  assert.throws(() => st.coerce(flag, "vielleicht"), /true oder false/);
});

test("apply schreibt nur bekannte Schlüssel und lässt den Rest in Ruhe", () => {
  write();
  const r = st.apply({ checkSec: 45, syncUrl: "http://boese.example", outDir: "C:/woanders", unbekannt: 1 });
  assert.deepEqual(Object.keys(r.changed), ["checkSec"]);
  const now = read();
  assert.equal(now.checkSec, 45);
  assert.equal(now.syncUrl, "https://mtga.a16.be", "gesperrte Schlüssel bleiben unberührt");
  assert.equal(now.outDir, undefined);
  assert.equal(now.unbekannt, undefined);
});

test("apply erhält Kommentarschlüssel und Reihenfolge", () => {
  write();
  const before = Object.keys(read());
  st.apply({ pollSec: 120 });
  const after = read();
  assert.deepEqual(Object.keys(after), before, "keine Schlüssel verloren oder verschoben");
  assert.equal(after._pollSec, "Wie oft geprüft wird, ob MTGA läuft.");
  assert.equal(after.pollSec, 120);
});

test("apply schreibt ohne BOM und lässt die Datei lesbar", () => {
  write();
  st.apply({ webPort: 9000 });
  const raw = fs.readFileSync(file);
  assert.notEqual(raw[0], 0xEF, "kein UTF-8-BOM, sonst scheitert JSON.parse in Node");
  assert.equal(JSON.parse(raw.toString("utf8")).webPort, 9000);
});

test("apply ohne Änderung fasst die Datei nicht an", () => {
  write();
  const before = fs.readFileSync(file, "utf8");
  const r = st.apply({ checkSec: 60 });
  assert.deepEqual(r.changed, {});
  assert.equal(fs.readFileSync(file, "utf8"), before, "gleicher Wert: keine Neuformatierung");
});

test("ungültiger Wert bricht ab, bevor geschrieben wird", () => {
  write();
  const before = fs.readFileSync(file, "utf8");
  assert.throws(() => st.apply({ checkSec: 30, webPort: 12 }), /webPort/);
  assert.equal(fs.readFileSync(file, "utf8"), before, "auch der gültige Teil landet nicht in der Datei");
});

test("current füllt fehlende Schlüssel mit den Standardwerten des Watchers", () => {
  write();
  const c = st.current();
  assert.equal(c.checkSec, 60);
  assert.equal(c.minCards, 200, "steht nicht in der Datei, kommt aus dem Standard");
  assert.equal(c.webDashboard, true);
  assert.equal(Object.keys(c).length, st.FIELDS.length);
});

test("jedes Feld ist vollständig beschrieben", () => {
  for (const f of st.FIELDS) {
    assert.ok(f.key && f.label && f.group, "Feld braucht Schlüssel, Beschriftung und Gruppe: " + f.key);
    assert.ok(["bool", "num"].includes(f.type), "unbekannter Typ bei " + f.key);
    if (f.type === "num") assert.ok(f.min < f.max, "Grenzen bei " + f.key);
  }
});

test.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* egal */ } });
