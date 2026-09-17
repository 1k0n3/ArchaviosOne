#!/usr/bin/env node
/**
 * MTGA Deck Export
 *
 * Liest alle Decks aus der Player.log (StartHook-Antwort mit DeckSummaries und
 * DecksInternal, danach angewendete DeckUpsertDeckV3-Änderungen) und schreibt
 *   out/decks/decks_YYYY-MM-DD.csv           alle Decks in einer Tabelle
 *   out/decks/txt/<Deckname>.txt             je Deck im Arena-Importformat
 *
 *   node decks.js [--out DIR] [--db PFAD] [--log PFAD] [--no-txt]
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const lib = require("./lib");

const ZONES = [
  ["CommandZone", "Commander"],
  ["Companions", "Companion"],
  ["MainDeck", "Deck"],
  ["Sideboard", "Sideboard"]
];

function defaultLogPath() {
  return path.join(os.homedir(), "AppData", "LocalLow", "Wizards Of The Coast", "MTGA", "Player.log");
}

/** Precon-Decks haben Lokalisierungsschlüssel statt Namen, z. B. "?=?Loc/Decks/Precon/FNM_Brawl_Kaza" */
function cleanDeckName(name) {
  const m = String(name || "").match(/^\?=\?Loc\/Decks\/(.+)$/);
  if (!m) return name || "";
  const parts = m[1].split("/");
  return parts[parts.length - 1].replace(/_/g, " ") + " (" + parts.slice(0, -1).join("/") + ")";
}

function attr(summary, name) {
  const a = (summary.Attributes || []).find((x) => x.name === name);
  if (!a) return "";
  return String(a.value).replace(/^"+|"+$/g, "");
}

/** Liest Decks aus einer Logdatei. Rückgabe: Map deckId -> { id, name, format, lastUpdated, zones: { MainDeck: [{cardId, quantity}], ... } } */
function readDecksFromLog(logPath) {
  const text = fs.readFileSync(logPath, "utf8");
  const lines = text.split(/\r?\n/);
  const decks = new Map();
  let foundStartHook = false;

  const upsertSummary = (s, deck) => {
    const id = s.DeckIdInternal || s.DeckId;
    if (!id) return;
    const d = decks.get(id) || { id, name: "", format: "", lastUpdated: "", tileId: 0, zones: {} };
    d.name = cleanDeckName(s.Name) || d.name;
    d.format = attr(s, "Format") || d.format;
    d.lastUpdated = attr(s, "LastUpdated") || d.lastUpdated;
    d.tileId = s.DeckTileId || parseInt(attr(s, "TileID"), 10) || d.tileId || 0;
    if (deck) {
      d.zones = {};
      for (const [zone] of ZONES) if (Array.isArray(deck[zone])) d.zones[zone] = deck[zone];
    }
    decks.set(id, d);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // StartHook-Antwort: kompletter Deckbestand (jeweils der letzte gewinnt)
    if (line.startsWith("<== StartHook(")) {
      const next = lines[i + 1] || "";
      if (!next.startsWith("{")) continue;
      let o;
      try { o = JSON.parse(next); } catch (e) { continue; }
      if (!o.DeckSummaries || !o.DecksInternal) continue;
      decks.clear();
      foundStartHook = true;
      for (const s of o.DeckSummaries) upsertSummary(s, o.DecksInternal[s.DeckIdInternal] || {});
      continue;
    }

    // Deck gespeichert / geändert: Request enthält Summary + Deck
    const m = line.match(/==> DeckUpsertDeckV\d+ (\{.*\})\s*$/);
    if (m) {
      try {
        const outer = JSON.parse(m[1]);
        const req = JSON.parse(outer.request);
        if (req.Summary) upsertSummary(req.Summary, req.Deck || null);
      } catch (e) { /* ignorieren */ }
    }
  }
  return { decks, foundStartHook };
}

function safeFilename(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/\s+/g, " ").trim().slice(0, 100) || "Deck";
}

/**
 * Exportiert alle Decks. Rückgabe: { count, csvFile, txtDir }
 */
function exportDecks(cards, outDir, opts = {}) {
  const logPath = opts.log || defaultLogPath();
  const { decks, foundStartHook } = readDecksFromLog(logPath);
  if (!foundStartHook) {
    const prev = logPath.replace(/Player\.log$/, "Player-prev.log");
    if (fs.existsSync(prev)) {
      const r = readDecksFromLog(prev);
      if (r.foundStartHook) { for (const [k, v] of r.decks) if (!decks.has(k)) decks.set(k, v); }
    }
  }
  if (!decks.size) throw new Error("Keine Decks im Log gefunden (" + logPath + "). MTGA muss seit dem letzten Start eingeloggt gewesen sein.");

  const stamp = opts.stamp || lib.stampDate();
  const deckDir = path.join(outDir, "decks");
  const txtDir = path.join(deckDir, "txt");
  fs.mkdirSync(txtDir, { recursive: true });

  const list = [...decks.values()].sort((a, b) => a.name.localeCompare(b.name, "en"));
  const csvLines = [lib.csvLine(["Deck", "Format", "Zone", "Name", "Set", "Nr", "Anzahl", "GrpId", "Zuletzt geändert", "DeckId"])];
  const usedNames = new Set();

  for (const d of list) {
    const txt = [];
    for (const [zone, label] of ZONES) {
      const entries = d.zones[zone];
      if (!entries || !entries.length) continue;
      const rows = entries.map((e) => {
        const c = cards.get(e.cardId) || { Name: "? (" + e.cardId + ")", ExpansionCode: "", CollectorNumber: "" };
        return { name: c.Name, set: c.ExpansionCode, nr: c.CollectorNumber, qty: e.quantity, grpId: e.cardId };
      });
      rows.sort((a, b) => a.name.localeCompare(b.name, "en"));
      txt.push(label);
      for (const r of rows) {
        txt.push(`${r.qty} ${r.name} (${r.set}) ${r.nr}`);
        csvLines.push(lib.csvLine([d.name, d.format, label, r.name, r.set, r.nr, r.qty, r.grpId, d.lastUpdated, d.id]));
      }
      txt.push("");
    }
    if (opts.txt !== false) {
      let base = safeFilename(d.name);
      let file = base;
      let n = 2;
      while (usedNames.has(file.toLowerCase())) file = base + "_" + n++;
      usedNames.add(file.toLowerCase());
      fs.writeFileSync(path.join(txtDir, file + ".txt"), txt.join("\r\n"));
    }
  }

  const csvFile = path.join(deckDir, "decks_" + stamp + ".csv");
  fs.writeFileSync(csvFile, "﻿" + csvLines.join("\r\n") + "\r\n");
  return { count: list.length, csvFile, txtDir };
}

module.exports = { exportDecks, readDecksFromLog };

if (require.main === module) {
  const args = process.argv.slice(2);
  const opt = { out: path.join(__dirname, "..", "out"), db: "", log: "", txt: true };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = () => args[++i];
    if (a === "--out") opt.out = next();
    else if (a === "--db") opt.db = next();
    else if (a === "--log") opt.log = next();
    else if (a === "--no-txt") opt.txt = false;
    else if (a === "-h" || a === "--help") { console.log(fs.readFileSync(__filename, "utf8").split("*/")[0]); process.exit(0); }
    else { console.error("Unbekannte Option: " + a); process.exit(1); }
  }
  try {
    const { cards } = lib.loadCards(lib.findCardDb(opt.db));
    const r = exportDecks(cards, opt.out, { log: opt.log || undefined, txt: opt.txt });
    console.log(`${r.count} Decks exportiert`);
    console.log("  " + r.csvFile);
    if (opt.txt) console.log("  " + r.txtDir + path.sep + "*.txt");
  } catch (e) {
    console.error("Fehler: " + e.message);
    process.exit(1);
  }
}
