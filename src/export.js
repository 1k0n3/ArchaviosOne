#!/usr/bin/env node
/**
 * MTGA Collection Export (einmalig)
 *
 * Liest die Kartensammlung aus dem laufenden MTGA-Client (Speicher-Scan über
 * scan-memory.ps1), löst GrpIds über die lokale MTGA-Kartendatenbank auf und
 * schreibt eine CSV.
 *
 *   node export.js [--out DIR] [--db PFAD] [--max-qty N] [--min-cards N]
 *                  [--anchor "Kartenname=Anzahl"]... [--include-mapped]
 *
 * Ausgabe: out/mtga-collection_YYYY-MM-DD.csv
 *   Spalten: Name;Set;Anzahl;Nr;Seltenheit;GrpId;Rebalanced (englische Kartennamen)
 *
 * Exit-Codes: 0 ok, 1 Fehler, 2 MTGA läuft nicht, 3 kein Block gefunden, 4 Block zu klein (< --min-cards)
 */
const fs = require("fs");
const path = require("path");
const lib = require("./lib");

const args = process.argv.slice(2);
const opt = { out: path.join(__dirname, "..", "out"), db: "", maxQty: 400, minCards: 200, anchors: [], includeMapped: false };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  const next = () => args[++i];
  if (a === "--out") opt.out = next();
  else if (a === "--db") opt.db = next();
  else if (a === "--max-qty") opt.maxQty = parseInt(next(), 10);
  else if (a === "--min-cards") opt.minCards = parseInt(next(), 10);
  else if (a === "--anchor") opt.anchors.push(next());
  else if (a === "--include-mapped") opt.includeMapped = true;
  else if (a === "-h" || a === "--help") { console.log(fs.readFileSync(__filename, "utf8").split("*/")[0]); process.exit(0); }
  else { console.error("Unbekannte Option: " + a); process.exit(1); }
}

(function main() {
  const pid = lib.mtgaPid();
  if (!pid) {
    console.error("MTGA.exe läuft nicht. Bitte MTGA starten und einloggen.");
    process.exit(2);
  }
  const dbPath = lib.findCardDb(opt.db);
  console.log("Kartendatenbank: " + dbPath);
  const { cards, version } = lib.loadCards(dbPath);
  console.log("Karten in DB: " + cards.size + " (Datenversion " + version + ")");
  const anchors = lib.resolveAnchors(cards, opt.anchors);

  const scan = lib.runScan(cards, { maxQty: opt.maxQty, includeMapped: opt.includeMapped, pid });
  console.log(scan.output);
  if (scan.status === 2) process.exit(2);
  if (scan.status !== 0) { console.error("Speicher-Scan fehlgeschlagen (Exit " + scan.status + ")."); process.exit(1); }

  const best = lib.chooseBlock(scan.json, cards, anchors, (s) => console.log(s));
  if (!best) {
    console.error("Kein Block gefunden. Ist MTGA eingeloggt? Im Client einmal Decks / Sammlung öffnen und erneut versuchen.");
    process.exit(3);
  }
  console.log(`Gewählt: ${best.unique} Karten (Stride ${best.stride}, Dups ${best.dups}, Adresse ${best.address})`);
  if (best.unique < opt.minCards) {
    console.error(`Block zu klein (${best.unique} < ${opt.minCards}). Sammlung vermutlich noch nicht geladen.`);
    process.exit(4);
  }

  const snapshot = lib.snapshotFromBlock(best);
  const rows = lib.toRows(snapshot, cards);
  const file = path.join(opt.out, "mtga-collection_" + lib.stampDate() + ".csv");
  lib.writeCollectionCsv(file, rows);
  console.log(`\nExportiert: ${rows.length} Drucke, ${lib.totalCards(snapshot)} Karten gesamt`);
  console.log("  " + file);
})();
