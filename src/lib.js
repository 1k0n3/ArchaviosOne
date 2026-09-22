// Gemeinsame Funktionen für export.js und watch.js
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync, execFileSync } = require("child_process");
const { DatabaseSync } = require("node:sqlite");
const paths = require("./paths");


/**
 * Id des Supertyps "Legendary" in der Kartendatenbank. Die Enum-Namen liegen immer auf Englisch vor,
 * die Suche über den Namen ist also unabhängig von der Spielsprache.
 */
function legendaryTypeId(db) {
  try {
    const r = db.prepare("select e.Value v from Enums e join Localizations_enUS l on l.LocId = e.LocId and l.Formatted = 1 where e.Type = 'SuperType' and l.Loc = 'Legendary'").get();
    return r ? String(r.v) : "";
  } catch (e) { return ""; }
}
/** Legendär laut Supertyp der Karte (nicht nach dem Rahmen des Drucks) */
const isLegendary = (c, id) => !!id && String(c.Supertypes || "").split(",").includes(String(id));

/** Kompakte Rahmen-Flags eines Drucks aus den Frame-Spalten der Datenbank */
function frameFlags(c) {
  const raw = String(c.RawFrameDetail || "").toLowerCase(), add = String(c.AdditionalFrameDetails || "").toLowerCase();
  let f = "";
  if (c.IsToken) f += "T";
  if (c.Legendary || raw.includes("legendary")) f += "L";   // Supertyp (verlässlich), sonst der Rahmen
  if (raw.includes("pre-8ed") || add.includes("pre 8e")) f += "R";
  if (c.ArtSize > 0 || raw.includes("basic")) f += "F";
  if (add.includes("nyx")) f += "N";
  if (add.includes("mysticalarchive")) f += "M";
  if (add.includes("adventure") || raw.includes("adventure")) f += "V";
  if (add.includes("beyond")) f += "Y";
  if (add.includes("hybrid")) f += "H";
  if (add.includes("gold")) f += "G";
  return f;
}

/** "o2oGoW" -> "{2}{G}{W}" */
function manaCost(text) {
  if (!text) return "";
  return text.split("o").filter(Boolean).map((p) => "{" + p + "}").join("");
}

const RARITY = { 0: "Token", 1: "Standardland", 2: "Common", 3: "Uncommon", 4: "Rare", 5: "Mythic" };

// ---- MTGA-Prozess ------------------------------------------------------------------

/** Prozess-ID des laufenden Arena-Clients (Windows: MTGA.exe, macOS: MTGA, Linux: Proton/Wine-Prozess) oder null */
function mtgaPid() { return paths.mtgaPid(); }

// ---- Kartendatenbank ----------------------------------------------------------------

/** Installationsordner von Arena (enthält MTGA_Data bzw. auf dem Mac Data) oder null */
function findInstallDir() { return paths.findInstallDir(); }

function findCardDb(explicit) {
  if (explicit) return explicit;
  const dataDir = paths.findDataDir();
  if (!dataDir) throw new Error("MTGA-Installationsordner nicht gefunden. Bitte --db <Pfad zu Raw_CardDatabase_*.mtga> angeben oder MTGA_DIR setzen.");
  const raw = path.join(dataDir, "Downloads", "Raw");
  const files = fs.readdirSync(raw).filter((f) => /^Raw_CardDatabase_.*\.mtga$/.test(f));
  if (!files.length) throw new Error("Keine Raw_CardDatabase_*.mtga in " + raw);
  files.sort((a, b) => fs.statSync(path.join(raw, b)).mtimeMs - fs.statSync(path.join(raw, a)).mtimeMs);
  return path.join(raw, files[0]);
}

function loadCards(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const rows = db.prepare(`
    select c.GrpId, c.ExpansionCode, c.CollectorNumber, c.Rarity, c.IsToken, c.IsRebalanced, c.ArtId, c.Colors, c.Types, c.Supertypes, c.Power, c.Toughness, c.RawFrameDetail, c.AdditionalFrameDetails, c.ArtSize, c.AbilityIds, c.TypeTextId, c.SubtypeTextId, c.OldSchoolManaText,
           (select Loc from Localizations_enUS l where l.LocId = c.TitleId and l.Formatted = 1 limit 1) as Name
    from Cards c
  `).all();
  const clean = (s) => (s == null ? "?" : String(s).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim());
  // Lokalisierungen einmal komplett laden (Regeltexte, Typzeilen)
  const loc = new Map(db.prepare("select LocId, Loc from Localizations_enUS where Formatted = 1").all().map((r) => [r.LocId, r.Loc]));
  const cards = new Map();
  const legendId = legendaryTypeId(db);
  for (const r of rows) {
    r.Legendary = isLegendary(r, legendId);
    r.Name = clean(r.Name);
    r.Text = String(r.AbilityIds || "").split(",").filter(Boolean).map((p) => clean(loc.get(+p.split(":")[1]) || "")).filter(Boolean).join("\n");
    const tt = clean(loc.get(r.TypeTextId) || ""), st = clean(loc.get(r.SubtypeTextId) || "");
    r.TypeLine = tt + (st ? " — " + st : "");
    r.ManaCost = manaCost(r.OldSchoolManaText);
    cards.set(r.GrpId, r);
  }
  const version = db.prepare("select Version from Versions where Type='Data'").get();
  db.close();
  return { cards, version: version ? version.Version : "?" };
}

// ---- Speicher-Scan -----------------------------------------------------------------------

/**
 * Führt scan-memory.ps1 aus.
 * opts: { maxQty, includeMapped, pid, region: { address, length } | null }
 * Rückgabe: { status, json|null, output }
 */
function runScan(cards, opts) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mtga-scan-"));
  const idFile = path.join(tmp, "ids.txt");
  const outFile = path.join(tmp, "scan.json");
  fs.writeFileSync(idFile, [...cards.keys()].join("\n"));

  const ps = [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(__dirname, "..", "scripts", "scan-memory.ps1"),
    "-IdFile", idFile, "-OutFile", outFile, "-MaxQty", String(opts.maxQty || 400)
  ];
  if (opts.includeMapped) ps.push("-IncludeMapped");
  if (opts.pid) ps.push("-ProcessId", String(opts.pid));
  if (opts.region) ps.push("-Address", String(opts.region.address), "-Length", String(opts.region.length));

  const r = spawnSync("powershell.exe", ps, { encoding: "utf8" });
  const output = ((r.stdout || "") + (r.stderr || "")).trim();
  let json = null;
  if (r.status === 0 && fs.existsSync(outFile)) {
    json = JSON.parse(fs.readFileSync(outFile, "utf8"));
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  return { status: r.status, json, output };
}

// ---- Blockauswahl ---------------------------------------------------------------------------

function resolveAnchors(cards, anchorArgs) {
  const out = [];
  for (const a of anchorArgs || []) {
    const m = a.match(/^(.+?)=(\d+)$/);
    if (!m) throw new Error("Anker-Format: \"Kartenname=Anzahl\" (bekommen: " + a + ")");
    const name = m[1].trim().toLowerCase();
    const ids = [...cards.values()].filter((c) => c.Name.toLowerCase() === name).map((c) => c.GrpId);
    if (!ids.length) throw new Error("Anker-Karte nicht gefunden: " + m[1]);
    out.push({ name: m[1], qty: parseInt(m[2], 10), ids: new Set(ids) });
  }
  return out;
}

function scoreBlock(b, cards, anchors) {
  let real = 0, tokens = 0;
  for (const [id] of b.entries) {
    const c = cards.get(id);
    if (!c) continue;
    if (c.IsToken) tokens++; else real++;
  }
  const dupRatio = b.count ? b.dups / b.count : 1;
  let anchorHits = 0;
  for (const a of anchors) {
    if (b.entries.find(([id, qty]) => a.ids.has(id) && qty === a.qty)) anchorHits++;
  }
  const anchorScore = anchors.length ? anchorHits / anchors.length : 0;
  const score = (1 - dupRatio) * 0.3 + (real / Math.max(1, b.entries.length)) * 0.2 + Math.min(1, b.unique / 3000) * 0.2 + anchorScore * 0.3;
  return { score, real, tokens, dupRatio, anchorHits };
}

function chooseBlock(scan, cards, anchors, print) {
  if (!scan || !scan.blocks.length) return null;
  const scored = scan.blocks.map((b) => Object.assign({ b }, scoreBlock(b, cards, anchors || [])));
  scored.sort((x, y) => y.score - x.score || y.b.unique - x.b.unique);
  if (print) {
    print("Kandidaten-Blöcke (Top 8):");
    print("  Score  Einträge  eindeutig  Dups  Token  Stride  Anker  Adresse");
    for (const s of scored.slice(0, 8)) {
      print("  " + s.score.toFixed(3).padStart(5) + String(s.b.count).padStart(10) + String(s.b.unique).padStart(11) +
        String(s.b.dups).padStart(6) + String(s.tokens).padStart(7) + String(s.b.stride).padStart(8) +
        String(s.anchorHits + "/" + (anchors || []).length).padStart(7) + "  " + s.b.address);
    }
  }
  return scored[0].b;
}

// ---- Snapshots, Zeilen, CSV -----------------------------------------------------------------

function snapshotFromBlock(block) {
  const m = new Map();
  for (const [id, qty] of block.entries) m.set(id, qty);
  return m;
}

function toRows(snapshot, cards) {
  const rows = [];
  for (const [id, qty] of snapshot) {
    const c = cards.get(id);
    if (!c) continue;
    rows.push({
      grpId: id, name: c.Name, set: c.ExpansionCode, collectorNumber: c.CollectorNumber,
      rarity: RARITY[c.Rarity] || String(c.Rarity), isRebalanced: !!c.IsRebalanced, quantity: qty
    });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name, "en") || a.set.localeCompare(b.set) ||
    String(a.collectorNumber).localeCompare(String(b.collectorNumber), undefined, { numeric: true }));
  return rows;
}

function csvCell(v) {
  return '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"';
}

function csvLine(values) {
  return values.map(csvCell).join(";");
}

const COLLECTION_HEAD = ["Name", "Set", "Anzahl", "Nr", "Seltenheit", "GrpId", "Rebalanced"];

function writeCollectionCsv(file, rows) {
  const lines = [csvLine(COLLECTION_HEAD)]
    .concat(rows.map((r) => csvLine([r.name, r.set, r.quantity, r.collectorNumber, r.rarity, r.grpId, r.isRebalanced ? "ja" : ""])));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "\uFEFF" + lines.join("\r\n") + "\r\n");
}

function appendCsv(file, head, lines) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, "\uFEFF" + csvLine(head) + "\r\n");
  if (lines.length) fs.appendFileSync(file, lines.map(csvLine).join("\r\n") + "\r\n");
}

// ---- Diff --------------------------------------------------------------------------------------

/** Vergleicht zwei Snapshots (Map grpId -> qty). Rückgabe: [{grpId, before, after, delta}] */
function diffSnapshots(before, after) {
  const out = [];
  const ids = new Set([...before.keys(), ...after.keys()]);
  for (const id of ids) {
    const b = before.get(id) || 0;
    const a = after.get(id) || 0;
    if (a !== b) out.push({ grpId: id, before: b, after: a, delta: a - b });
  }
  out.sort((x, y) => x.grpId - y.grpId);
  return out;
}

function totalCards(snapshot) {
  let t = 0;
  for (const q of snapshot.values()) t += q;
  return t;
}

// ---- Zeit -----------------------------------------------------------------------------------------

function pad(n) { return String(n).padStart(2, "0"); }
function stampDate(d = new Date()) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function stampTime(d = new Date()) { return `${pad(d.getHours())}${pad(d.getMinutes())}`; }
function stampFull(d = new Date()) { return `${stampDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; }

module.exports = {
  RARITY, COLLECTION_HEAD, frameFlags, legendaryTypeId, isLegendary, manaCost,
  mtgaPid, findInstallDir, findDataDir: paths.findDataDir, findLogDir: paths.findLogDir, memoryScanSupported: paths.memoryScanSupported, findCardDb, loadCards, runScan, resolveAnchors, chooseBlock,
  snapshotFromBlock, toRows, csvLine, writeCollectionCsv, appendCsv, diffSnapshots, totalCards,
  stampDate, stampTime, stampFull
};
