#!/usr/bin/env node
// Vorschau-Konto für Screenshots (Website, README): erfundener Spieler mit erfundenen Decks, Matches und Kontostand,
// damit keine echten Kontodaten in den Bildern landen. Kartendaten und Deckinhalte kommen aus dem echten Dashboard-
// Build (out/web/data.js); Namen, Gegner, Ergebnisse und Kontowerte werden erzeugt.
//   node scripts/preview-data.js            -> out-preview/web/ (dann: node src/serve.js --out out-preview --port 8767)
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const root = path.join(__dirname, "..");
const src = path.join(root, "out", "web");
const dst = path.join(root, "out-preview", "web");

const PLAYER = "Ashen Nova";
// Decknamen: Farbname aus den echten Karten des Decks (sonst stünde "Boros" über einem grünen Deck) plus ein Beiwort
const DECK_WORDS = ["Ascendant", "Control", "Legion", "Blitz", "Whispers", "Bloom", "Sparks", "Ledger", "Tides", "Carnival"];
const COLOR_NAMES = { W: "Mono-White", U: "Mono-Blue", B: "Mono-Black", R: "Mono-Red", G: "Mono-Green", WU: "Azorius", UB: "Dimir", BR: "Rakdos", RG: "Gruul", WG: "Selesnya", WB: "Orzhov", UR: "Izzet", BG: "Golgari", WR: "Boros", UG: "Simic", WUB: "Esper", UBR: "Grixis", BRG: "Jund", WRG: "Naya", WUG: "Bant", WBG: "Abzan", WUR: "Jeskai", UBG: "Sultai", WBR: "Mardu", URG: "Temur" };
const OPPONENTS = ["Vexaria", "Thornwake", "Mirrodin_Max", "Lotus_Lena", "Bolt_Dude", "Kyra_Storm", "NightOwl77", "Arcanis", "Seraph_K", "MoxRuby", "Gideon_Fan", "Sylvan_Sage", "Phyrexia_Pete", "Chandra_Cat", "Ugin_Ulf", "Tarkir_Tess"];
const PLATFORMS = ["SteamWindows", "Windows", "AndroidPhone", "iPhone", "iPad", "MacOS"];
let seed = 20260920;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const uuid = () => "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => { const r = Math.floor(rnd() * 16); return (c === "x" ? r : (r & 3) | 8).toString(16); });

// echte Basis laden
const ctx = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(src, "data.js"), "utf8"), ctx);
const D = ctx.window.MTGA_DATA;
const cardIds = Object.keys(D.cards).map(Number).filter((g) => D.cards[g] && !D.cards[g][4] && D.cards[g][3] !== "Standardland");

// Decks: bevorzugt Commander-Decks und Decks mit 60+ Karten, neue Namen und Zeitpunkte
const usable = D.decks.filter((d) => !d.archived && d.zones && (d.zones.MainDeck || []).reduce((s, [, q]) => s + q, 0) >= 55);
// je Commander nur ein Deck, damit Bilder und Namen abwechslungsreich sind
const seenCmd = new Set();
const withCmd = usable.filter((d) => { const c = d.zones.CommandZone && d.zones.CommandZone.length ? d.zones.CommandZone[0][0] : null; if (!c || seenCmd.has(c)) return false; seenCmd.add(c); return true; });
const without = usable.filter((d) => !d.zones.CommandZone || !d.zones.CommandZone.length);
const chosen = [...withCmd.slice(0, 6), ...without.slice(0, 4)].slice(0, DECK_WORDS.length);
const colorName = (d) => {
  const set = new Set();
  for (const z of ["CommandZone", "MainDeck"]) for (const [g] of d.zones[z] || []) for (const x of String((D.cards[g] || [])[6] || "").split(",").filter(Boolean)) set.add(+x);
  const key = [1, 2, 3, 4, 5].filter((x) => set.has(x)).map((x) => "WUBRG"[x - 1]).join("");
  return COLOR_NAMES[key] || (key.length === 4 ? "Four-Color" : key.length === 5 ? "Five-Color" : "Colorless");
};
const now = Date.now();
const decks = chosen.map((d, i) => ({ id: uuid(), name: colorName(d) + " " + DECK_WORDS[i], format: d.format || (d.zones.CommandZone && d.zones.CommandZone.length ? "HistoricBrawl" : "Standard"), lastUpdated: new Date(now - (i * 3 + 1) * 86400000).toISOString(), tile: d.tile, zones: d.zones }));

// Matches: 140 Stück über 60 Tage, gute Bilanz (~64 %), gelegentliche Serien
const matches = [];
const winRateOf = (i) => 0.55 + 0.25 * Math.sin(i / 9);      // Formkurve
for (let i = 0; i < 140; i++) {
  const d = decks[Math.floor(rnd() * rnd() * decks.length)];   // Lieblingsdecks häufiger
  const start = now - Math.floor(rnd() * 60 * 86400000) - 3600000;
  const won = rnd() < winRateOf(i);
  const turns = 5 + Math.floor(rnd() * 12);
  const dur = turns * (55 + Math.floor(rnd() * 40));
  const cmd = d.zones.CommandZone && d.zones.CommandZone.length ? D.cards[d.zones.CommandZone[0][0]] : null;
  const isBrawl = /brawl/i.test(d.format);
  const oppCards = Array.from({ length: 4 + Math.floor(rnd() * 6) }, () => ({ grpId: pick(cardIds), count: 1 }));
  const played = (d.zones.MainDeck || []).slice().sort(() => rnd() - .5).slice(0, 6 + Math.floor(rnd() * 8)).map(([g]) => [g, 1]);
  matches.push({ matchId: uuid(), start, end: start + dur * 1000, durationSec: dur, result: won ? "Sieg" : "Niederlage", reason: rnd() < .35 ? "Concede" : "Game",
    eventId: isBrawl ? "Play_Brawl_Historic" : (rnd() < .5 ? "Ladder_Standard" : "Play_Standard"), format: d.format, myName: PLAYER, myDeck: d.name, myDeckId: d.id, commander: cmd ? cmd[0] : "",
    opponent: pick(OPPONENTS), opponentPlatform: pick(PLATFORMS), opponentUserId: uuid().slice(0, 24).toUpperCase(),
    games: [{ number: 1, won, reason: rnd() < .35 ? "Concede" : "Game", turns }], turns, onPlay: rnd() < .5, frames: turns * 7 + 3, opponentCards: oppCards, played, tile: d.tile });
}
matches.sort((a, b) => a.start - b.start);

// Replay: Bildfolge eines echten Matches übernehmen, Namen ersetzen
const framesDir = path.join(src, "matches");
let replayId = null;
if (fs.existsSync(framesDir)) {
  const real = D.matches.filter((m) => m.frames > 30).sort((a, b) => b.frames - a.frames)[0];
  const f = real && fs.readdirSync(framesDir).find((x) => x.startsWith(real.matchId));
  if (f) {
    const m = matches[matches.length - 1];
    replayId = m.matchId;
    // das Vorschau-Deck mit demselben Commander wie das echte Match, damit Replay und Deckname zusammenpassen
    const same = decks.find((d) => d.zones.CommandZone && d.zones.CommandZone.length && D.cards[d.zones.CommandZone[0][0]] && D.cards[d.zones.CommandZone[0][0]][0] === real.commander) || decks[0];
    Object.assign(m, { myDeck: same.name, myDeckId: same.id, commander: real.commander, opponentCards: real.opponentCards, played: real.played, turns: real.turns, frames: real.frames, tile: same.tile, format: real.format, eventId: real.eventId, result: real.result, games: real.games });
    let js = fs.readFileSync(path.join(framesDir, f), "utf8");
    js = js.split(real.myName).join(PLAYER).split(real.opponent).join(m.opponent).split(real.myDeck).join(same.name);
    fs.mkdirSync(path.join(dst, "matches"), { recursive: true });
    fs.writeFileSync(path.join(dst, "matches", f.replace(real.matchId, m.matchId)), js);
  }
}

// Konto: hoher Rang, voller Tresor, viele Erfolge; Bilder wie im echten Dashboard (Routen des lokalen Servers)
const a = D.account || {};
const achGroup = (g, n, done) => ({ total: n, completed: done, list: Array.from({ length: n }, (_, i) => ({ id: (g === "Core" ? ["GoingForGold", "EventHorizon", "WeekSpot", "SpellsWithStyle", "FavoriteBasics", "SimpleMastery", "RuleOfFive", "MythicChampion", "LimitedMageTier3", "CraftmasterTier3", "LeaderOfThePackTier3", "RareDrafter", "RankedBrawlMageTier2"] : ["WhiteLifegainCumulative", "WhiteGoWideOneshot", "BlueDrawCumulative", "BlackKillCumulative", "RedTreasureCumulative", "GreenRampOneshot", "BlackDiscardCumulative", "RedImpulseDrawCumulative", "WhiteExileCumulative", "BlueCounterOneshot"])[i % (g === "Core" ? 13 : 10)] + (i >= 13 ? "Tier" + (1 + i % 3) : ""), status: i < done ? "Completed" : "Available", progress: i >= done && i % 2 === 0 ? 40 + i * 7 : null, completedAt: i < done ? new Date(now - i * 5 * 86400000).toISOString() : null })) });
const account = Object.assign({}, a, {
  takenAt: new Date(now - 600000).toISOString(), gold: 12480, gems: 3150, vault: 63.4, wildcards: { c: 42, u: 31, r: 18, m: 9 }, orbs: 41, boosters: [{ set: "HOB", count: 6 }, { set: "MSH", count: 3 }],
  rank: { season: 93, constructed: { tier: "Platin", key: "platinum", level: 2, step: 4, won: 68, lost: 39 }, limited: { tier: "Gold", key: "gold", level: 3, step: 2, won: 21, lost: 14 } },
  mastery: { pass: "HOB", level: 58, xp: 620, premium: true, active: true },
  quests: [{ name: "Boros Legion", goal: 20, progress: 14, canSwap: true, reward: { gold: 500, xp: 500 } }, { name: "Dimir Agent", goal: 30, progress: 27, canSwap: true, reward: { gold: 750, xp: 500 } }, { name: "Gruul Scrapper", goal: 15, progress: 4, canSwap: true, reward: { gold: 500, xp: 250 } }],
  achievements: { groups: { Core: achGroup("Core", 66, 54), Colors: achGroup("Colors", 50, 47) }, claimable: ["GoingForGold", "RedTreasureCumulative"], closeToComplete: ["BlackDiscardCumulative", "LeaderOfThePackTier3"], recent: ["MythicChampion"] },
  rewards: { dailyReset: new Date(now + 9 * 3600000).toISOString(), weeklyReset: new Date(now + 4 * 86400000).toISOString(), weeklySequence: 15 },
  rankIcons: { constructed: "ui/rank/constructed/platinum/2?h=128", limited: "ui/rank/limited/gold/3?h=128" }
});
try { account.uiIcons = require("../src/emblems").uiIconUrls(); } catch (e) { /* ohne Symbole */ }

// Ausgabe: echtes Web-Verzeichnis kopieren (ohne Daten), dann data.js/data.json ersetzen
fs.mkdirSync(dst, { recursive: true });
for (const f of fs.readdirSync(src)) {
  const p = path.join(src, f);
  if (fs.statSync(p).isDirectory() || /^data\.(js|json)$/.test(f)) continue;
  fs.copyFileSync(p, path.join(dst, f));
}
const data = { generatedAt: new Date(now).toISOString(), format: D.format, player: PLAYER, matches, decks, cards: D.cards, account, syncUrl: null };
fs.writeFileSync(path.join(dst, "data.js"), "window.MTGA_DATA=" + JSON.stringify(data) + ";");
fs.writeFileSync(path.join(dst, "data.json"), JSON.stringify(data));
// Bibliothek: Besitzstand aus dem echten Stand übernehmen (keine persönlichen Angaben)
for (const f of ["state.json"]) { const p = path.join(root, "out", f); if (fs.existsSync(p)) fs.copyFileSync(p, path.join(root, "out-preview", f)); }
console.log(`Vorschau: ${dst} – ${PLAYER}, ${decks.length} Decks, ${matches.length} Matches, Replay ${replayId || "–"}`);
