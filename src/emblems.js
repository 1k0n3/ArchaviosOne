// Rang-Embleme aus den Spieldaten: Sprites des Atlas "Atlas_Ranked" (Bronze … Mythic, je Stufe 1–4, Constructed/Limited).
// Nichts wird auf der Platte abgelegt – die PNGs entstehen beim Aufruf aus dem AssetBundle und bleiben nur im Speicher.
const fs = require("fs");
const path = require("path");
const lib = require("./lib");
const unity = require("./unity");

const TIERS = ["bronze", "silver", "gold", "platinum", "diamond", "mythic", "unranked"];
const cache = new Map();          // Sprite-Name + Höhe -> { png, width, height } | null
let atlasFile;                    // Pfad des Atlas-Bundles (einmal gesucht)

function bundleDir() {
  try {
    const dir = lib.findInstallDir ? lib.findInstallDir() : null;
    if (dir) { const ab = path.join(dir, "MTGA_Data", "Downloads", "AssetBundle"); if (fs.existsSync(ab)) return ab; }
    const db = lib.findCardDb();                                   // …/MTGA_Data/Downloads/Raw/<db>.mtga
    const ab = path.join(path.dirname(path.dirname(db)), "AssetBundle");
    return fs.existsSync(ab) ? ab : null;
  } catch (e) { return null; }
}
function atlas() {
  if (atlasFile !== undefined) return atlasFile;
  atlasFile = null;
  const dir = bundleDir();
  if (dir) { const f = fs.readdirSync(dir).find((x) => /^Atlas_Ranked_/.test(x)); if (f) atlasFile = path.join(dir, f); }
  return atlasFile;
}

/** Sprite-Name für Format (constructed|limited), Stufe (bronze … mythic|unranked) und Level 1–4 */
function spriteName(format, tier, level) {
  const f = format === "limited" ? "limited" : "constructed";
  const t = TIERS.includes(String(tier).toLowerCase()) ? String(tier).toLowerCase() : "unranked";
  const l = Math.min(4, Math.max(1, parseInt(level, 10) || 1));
  return `rank_${f}_${t}` + (t === "mythic" || t === "unranked" ? "" : `_t${l}`);
}
/** PNG des Emblems (Höhe begrenzt), aus dem Speicher-Cache; null ohne Spieldaten */
function rankPng(format, tier, level, maxHeight = 0) {
  const name = spriteName(format, tier, level), key = name + ":" + maxHeight;
  if (cache.has(key)) return cache.get(key);
  let r = null;
  const file = atlas();
  if (file) { try { r = unity.spritePng(file, name, { maxHeight }); } catch (e) { r = null; } }
  cache.set(key, r);
  return r;
}
/** Für die Website: aktuelle Embleme als kleine Data-URLs (werden mit dem Kontostand gesendet) */
function rankIconsDataUrls(account, maxHeight = 96) {
  const out = {};
  for (const f of ["constructed", "limited"]) {
    const r = account && account.rank && account.rank[f];
    if (!r || !r.key) continue;
    const p = rankPng(f, r.key, r.level, maxHeight);
    if (p) out[f] = "data:image/png;base64," + p.png.toString("base64");
  }
  return Object.keys(out).length ? out : null;
}
module.exports = { spriteName, rankPng, rankIconsDataUrls, TIERS, available: () => !!atlas() };
