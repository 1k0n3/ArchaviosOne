// Embleme und UI-Symbole aus den Spieldaten: Sprites der Atlas-Bundles (Ränge, Münzen, Edelsteine, Wildcards,
// Tresor, Quest-Symbole, MTGA-Logo). Nichts wird auf der Platte abgelegt – die PNGs entstehen beim Aufruf aus dem
// AssetBundle und bleiben nur im Speicher. Die Website hat keine Spieldaten und bekommt die Bilder als Data-URLs.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const lib = require("./lib");
const unity = require("./unity");

const TIERS = ["bronze", "silver", "gold", "platinum", "diamond", "mythic", "unranked"];
const ATLASES = ["Ranked", "NavBar", "Objectives", "Home", "Profile", "Rewards", "DeckBuilding"];   // erlaubte Atlanten (Atlas_<Name>_…)
/** UI-Symbole: Schlüssel -> [Atlas, Sprite] */
const UI_ICONS = {
  logo: ["NavBar", "Nav_Logo"], coins: ["NavBar", "Nav_Coins"], gems: ["NavBar", "Nav_Gems"], vault: ["NavBar", "Nav_Vault"],
  wc_c: ["NavBar", "Nav_WildCard_Common"], wc_u: ["NavBar", "Nav_WildCard_Uncommon"], wc_r: ["NavBar", "Nav_WildCard_Rare"], wc_m: ["NavBar", "Nav_WildCard_MythicRare"],
  xp: ["Objectives", "ObjectiveIcon_CoinAndMasteryXP"], check: ["Objectives", "ObjectiveCheckMark"], hourglass: ["Objectives", "Objective_Hourglass"],
  q_w: ["Objectives", "ObjectiveType_White"], q_u: ["Objectives", "ObjectiveType_Blue"], q_b: ["Objectives", "ObjectiveType_Black"], q_r: ["Objectives", "ObjectiveType_Red"], q_g: ["Objectives", "ObjectiveType_Green"], q_m: ["Objectives", "ObjectiveType_Multicolor"], q_x: ["Objectives", "ObjectiveType_Generic"],
  pip: ["Ranked", "RankPip"], pipSlot: ["Ranked", "RankPipSlot"], wcGlow: ["NavBar", "Nav_WildCard_Glow"],
  // Filtersymbole des Deckbaus (Farben, mehrfarbig, farblos, Land; leuchtende Variante für "aktiv") und Lupen
  f_w: ["DeckBuilding", "filter_white"], f_u: ["DeckBuilding", "filter_blue"], f_b: ["DeckBuilding", "filter_black"], f_r: ["DeckBuilding", "filter_red"], f_g: ["DeckBuilding", "filter_green"], f_m: ["DeckBuilding", "filter_multiColor"], f_c: ["DeckBuilding", "filter_colorless"], f_l: ["DeckBuilding", "filter_land"],
  f_w_on: ["DeckBuilding", "filter_white_Glow"], f_u_on: ["DeckBuilding", "filter_blue_Glow"], f_b_on: ["DeckBuilding", "filter_black_Glow"], f_r_on: ["DeckBuilding", "filter_red_Glow"], f_g_on: ["DeckBuilding", "filter_green_Glow"], f_m_on: ["DeckBuilding", "filter_multiColor_Glow"], f_c_on: ["DeckBuilding", "filter_colorless_Glow"], f_l_on: ["DeckBuilding", "filter_land_Glow"],
  zoomIn: ["DeckBuilding", "filter_MagnifyPlus"], zoomOut: ["DeckBuilding", "filter_MagnifyMinus"], search: ["DeckBuilding", "filter_Magnify"],
  qPlus: ["DeckBuilding", "cardTileAddPlus"], qBacker: ["DeckBuilding", "blurredCardQuantityBacker"]   // Zähler im Deckbau: Plus-Glyphe und Mengen-Hintergrund der Kartenkachel
};
/** Schriften des Spiels (OpenType) aus dem Fonts-Bundle – nur für das lokale Dashboard */
const FONTS = ["BELEREN2016-BOLD", "GOTHAMNARROW-MEDIUM", "ROBOTO-REGULAR", "ROBOTO-BOLD"];
const fontCache = new Map();
function fontData(name) {
  if (!FONTS.includes(name)) return null;
  if (fontCache.has(name)) return fontCache.get(name);
  let out = null;
  try {
    const dir = bundleDir();
    const f = dir && fs.readdirSync(dir).find((x) => /^Fonts_/.test(x));
    if (f) {
      const b = unity.readBundle(path.join(dir, f));
      for (const fl of b.files) {
        if (!fl.buf.length || /\.(resS|resource)$/.test(fl.path)) continue;
        let sf; try { sf = unity.readSerialized(fl.buf); } catch (e) { continue; }
        for (const o of sf.objects) {
          if (o.classId !== 128) continue;
          let x; try { x = unity.readObject(sf, o); } catch (e) { continue; }
          if (x.m_Name !== name) continue;
          const d = x.m_FontData;
          out = Buffer.isBuffer(d) ? d : Buffer.from(Array.isArray(d) ? d.map((v) => (typeof v === "object" ? v.data : v)) : []);
          break;
        }
        if (out) break;
      }
    }
  } catch (e) { out = null; }
  fontCache.set(name, out && out.length ? out : null);
  return fontCache.get(name);
}
const cache = new Map();          // Atlas:Sprite:Höhe -> { png, width, height } | null
const atlasFiles = new Map();     // Atlas-Name -> Pfad | null

function bundleDir() {
  try {
    const dataDir = lib.findDataDir ? lib.findDataDir() : null;
    if (dataDir) { const ab = path.join(dataDir, "Downloads", "AssetBundle"); if (fs.existsSync(ab)) return ab; }
    const db = lib.findCardDb();                                   // …/MTGA_Data/Downloads/Raw/<db>.mtga
    const ab = path.join(path.dirname(path.dirname(db)), "AssetBundle");
    return fs.existsSync(ab) ? ab : null;
  } catch (e) { return null; }
}
function atlas(name) {
  if (atlasFiles.has(name)) return atlasFiles.get(name);
  let file = null;
  const dir = ATLASES.includes(name) ? bundleDir() : null;
  if (dir) { const f = fs.readdirSync(dir).find((x) => x.startsWith("Atlas_" + name + "_")); if (f) file = path.join(dir, f); }
  atlasFiles.set(name, file);
  return file;
}
/** PNG eines Sprites (Höhe begrenzt), aus dem Speicher-Cache; null ohne Spieldaten oder unbekannt */
function spritePng(atlasName, spriteName, maxHeight = 0) {
  const key = atlasName + ":" + spriteName + ":" + maxHeight;
  if (cache.has(key)) return cache.get(key);
  let r = null;
  const file = atlas(atlasName);
  if (file && /^[A-Za-z0-9_.-]+$/.test(spriteName)) { try { r = unity.spritePng(file, spriteName, { maxHeight }); } catch (e) { r = null; } }
  cache.set(key, r);
  return r;
}

/** Sprite-Name für Format (constructed|limited), Stufe (bronze … mythic|unranked) und Level 1–4 */
function spriteName(format, tier, level) {
  const f = format === "limited" ? "limited" : "constructed";
  const t = TIERS.includes(String(tier).toLowerCase()) ? String(tier).toLowerCase() : "unranked";
  const l = Math.min(4, Math.max(1, parseInt(level, 10) || 1));
  return `rank_${f}_${t}` + (t === "mythic" || t === "unranked" ? "" : `_t${l}`);
}
function rankPng(format, tier, level, maxHeight = 0) { return spritePng("Ranked", spriteName(format, tier, level), maxHeight); }

const dataUrl = (p) => p ? "data:image/png;base64," + p.png.toString("base64") : null;
/** Aktuelle Rang-Embleme als kleine Data-URLs */
function rankIconsDataUrls(account, maxHeight = 96) {
  const out = {};
  for (const f of ["constructed", "limited"]) {
    const r = account && account.rank && account.rank[f];
    if (!r || !r.key) continue;
    const u = dataUrl(rankPng(f, r.key, r.level, maxHeight));
    if (u) out[f] = u;
  }
  return Object.keys(out).length ? out : null;
}
/** Alle UI-Symbole als Data-URLs (einmal berechnet) */
let uiCache = null;
function uiIconsDataUrls(maxHeight = 64) {
  if (uiCache) return uiCache;
  const out = {};
  for (const [k, [a, s]] of Object.entries(UI_ICONS)) { const u = dataUrl(spritePng(a, s, maxHeight)); if (u) out[k] = u; }
  uiCache = Object.keys(out).length ? out : null;
  return uiCache;
}
/** Lokale Adressen der UI-Symbole (liefert der Dashboard-Server aus den Spieldaten) */
function uiIconUrls(maxHeight = 64) {
  const out = {};
  for (const [k, [a, s]] of Object.entries(UI_ICONS)) out[k] = `ui/sprite/${a}/${s}?h=${maxHeight}`;
  return out;
}
/**
 * Bilder für die Website-Synchronisierung: Rang-Embleme und UI-Symbole nur mitschicken, wenn sie sich seit dem
 * letzten Senden geändert haben (Merkdatei im Ausgabeordner); die Website behält den letzten Stand.
 */
function iconsForSync(account, outDir) {
  const file = outDir ? path.join(outDir, "sync", "icons-sent.json") : null;
  let sent = {}; try { sent = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { /* noch nichts gesendet */ }
  const out = {};
  const rank = rankIconsDataUrls(account);
  const h = (o) => crypto.createHash("sha1").update(JSON.stringify(o)).digest("hex");
  if (rank && sent.rank !== h(rank)) { out.rankIcons = rank; sent.rank = h(rank); }
  const ui = uiIconsDataUrls();
  if (ui && sent.ui !== h(ui)) { out.uiIcons = ui; sent.ui = h(ui); }
  if (file && Object.keys(out).length) { try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(sent)); } catch (e) { /* nicht schreibbar */ } }
  return Object.keys(out).length ? out : null;
}
module.exports = { spriteName, spritePng, rankPng, rankIconsDataUrls, uiIconsDataUrls, uiIconUrls, iconsForSync, fontData, FONTS, TIERS, ATLASES, UI_ICONS, available: () => !!atlas("Ranked") };
