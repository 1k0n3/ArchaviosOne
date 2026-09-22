"use strict";
process.env.MTGA_NO_MIRROR = "1";   // nie zur echten Website spiegeln
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Der Zugang liegt in out/assistant.json. Für den Test zeigt outDir() auf einen eigenen Ordner,
// damit die echte Datei des Benutzers unberührt bleibt.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mtga-asst-"));
const paths = require("../src/paths");
paths.outDir = () => tmp;

const asst = require("../src/assistant");
const cfgPath = path.join(tmp, "assistant.json");
const lies = () => JSON.parse(fs.readFileSync(cfgPath, "utf8"));

test.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* egal */ } });

test("Schlüssel und Modell gehören zum jeweiligen Anbieter", () => {
  asst._test.writeCfg({ provider: "openrouter", apiKey: "sk-or-test", model: "a/b:free" });
  let c = asst._test.readCfg();
  assert.equal(c.provider, "openrouter");
  assert.equal(c.apiKey, "sk-or-test");
  assert.equal(c.model, "a/b:free");

  // Anbieterwechsel: der fremde Schlüssel darf nicht mitwandern
  asst._test.writeCfg({ provider: "google", model: "" });
  c = asst._test.readCfg();
  assert.equal(c.provider, "google");
  assert.equal(c.apiKey, "", "Google darf den Schlüssel von OpenRouter nicht bekommen");
  assert.equal(c.model, "");

  // Eigener Schlüssel für Google
  asst._test.writeCfg({ apiKey: "goog-test", model: "gemini-2.5-flash" });
  c = asst._test.readCfg();
  assert.equal(c.apiKey, "goog-test");

  // Zurück zu OpenRouter: der alte Zugang ist noch da
  asst._test.writeCfg({ provider: "openrouter" });
  c = asst._test.readCfg();
  assert.equal(c.apiKey, "sk-or-test");
  assert.equal(c.model, "a/b:free");
});

test("Vergessen löscht nur den Zugang des gewählten Anbieters", () => {
  asst._test.writeCfg({ provider: "openrouter", apiKey: "sk-or-test", model: "a/b:free" });
  asst._test.writeCfg({ provider: "google", apiKey: "goog-test", model: "gemini-2.5-flash" });

  asst._test.writeCfg({ apiKey: null, model: null });
  let c = asst._test.readCfg();
  assert.equal(c.provider, "google");
  assert.equal(c.apiKey, "");

  asst._test.writeCfg({ provider: "openrouter" });
  c = asst._test.readCfg();
  assert.equal(c.apiKey, "sk-or-test", "der andere Anbieter bleibt verbunden");
  assert.deepEqual(asst._test.connectedProviders(), ["openrouter"]);
});

test("Ältere Datei mit flachen Feldern wird übernommen", () => {
  fs.writeFileSync(cfgPath, JSON.stringify({ provider: "groq", apiKey: "gsk-alt", model: "llama" }));
  const c = asst._test.readCfg();
  assert.equal(c.provider, "groq");
  assert.equal(c.apiKey, "gsk-alt");
  assert.equal(c.model, "llama");
  assert.deepEqual(asst._test.connectedProviders(), ["groq"]);
});

test("Die Datei bleibt für ältere Fassungen lesbar", () => {
  asst._test.writeCfg({ provider: "openrouter", apiKey: "sk-or-test", model: "a/b:free" });
  const roh = lies();
  assert.equal(roh.apiKey, "sk-or-test", "flaches Feld als Rückfallebene");
  assert.equal(roh.model, "a/b:free");
  assert.equal(roh.keys.openrouter, "sk-or-test");
});

test("Ein flaches Feld aus der Rückfallebene wandert nicht zu einem anderen Anbieter", () => {
  // So sieht die Datei aus, wenn eine ältere Fassung den Anbieter umgestellt hat: der flache
  // Schlüssel gehört noch zu OpenRouter, eingetragen ist aber Google.
  fs.writeFileSync(cfgPath, JSON.stringify({
    provider: "google",
    keys: { openrouter: "sk-or-test" },
    models: { openrouter: "a/b:free" },
    apiKey: "sk-or-test"
  }));
  const c = asst._test.readCfg();
  assert.equal(c.provider, "google");
  assert.equal(c.apiKey, "", "der Schlüssel von OpenRouter darf nicht als Google-Zugang gelten");
  assert.deepEqual(asst._test.connectedProviders(), ["openrouter"]);
});
