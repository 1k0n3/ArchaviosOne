// Der KI-Assistent ist Standard: das Skript steht in jeder Seite. Eine Fassung ohne ihn bleibt möglich,
// muss aber ausdrücklich abgewählt werden ("assistant": false in der Einstellungsdatei oder MTGA_ASSISTANT=0).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const paths = require("../src/paths");

const WEB = path.join(__dirname, "..", "web");
const TAG = '<script src="assistant.js" data-asst="1"></script>';

test("jede Seite bindet den Assistenten ein", () => {
  const seiten = fs.readdirSync(WEB).filter((f) => f.endsWith(".html"));
  assert.ok(seiten.length >= 5, "es sollte mehrere Seiten geben");
  for (const f of seiten) {
    const html = fs.readFileSync(path.join(WEB, f), "utf8");
    assert.ok(html.includes(TAG), f + " bindet assistant.js nicht ein");
    assert.ok(html.indexOf(TAG) > html.indexOf('<script src="app.js">'), f + ": assistant.js muss nach app.js kommen");
  }
  assert.ok(fs.existsSync(path.join(WEB, "assistant.js")), "web/assistant.js fehlt");
});

test("assistantEnabled: Standard an, Abwahl über Einstellung oder Umgebung", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mtga-asst-"));
  const cfg = path.join(dir, "watch-config.json");
  const mit = (inhalt, env) => { fs.writeFileSync(cfg, JSON.stringify(inhalt)); return paths.assistantEnabled(Object.assign({ MTGA_STATS_CONFIG: cfg }, env)); };
  const alt = process.env.MTGA_STATS_CONFIG;
  process.env.MTGA_STATS_CONFIG = cfg;
  try {
    assert.equal(mit({}), true, "ohne Angabe ist der Assistent dabei");
    assert.equal(mit({ assistant: true }), true);
    assert.equal(mit({ assistant: false }), false, '"assistant": false liefert eine Fassung ohne Assistent');
    // Die Umgebung schlägt die Datei, in beide Richtungen
    assert.equal(mit({ assistant: false }, { MTGA_ASSISTANT: "1" }), true);
    assert.equal(mit({}, { MTGA_ASSISTANT: "0" }), false);
    assert.equal(mit({}, { MTGA_ASSISTANT: "false" }), false);
    assert.equal(mit({}, { MTGA_ASSISTANT: "nein" }), false);
  } finally {
    if (alt === undefined) delete process.env.MTGA_STATS_CONFIG; else process.env.MTGA_STATS_CONFIG = alt;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
