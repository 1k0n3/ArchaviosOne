// Kontodaten aus der Player.log: Gold, Edelsteine, Wildcards, Tresor, Rang, Mastery-Level, Tagesquests.
// Arena schreibt die Serverantworten als JSON-Zeilen ins Log (InventoryInfo, RankGetCombinedRankInfo,
// GraphGetGraphState für den Battle-Pass, QuestGetQuests). Der Parser hängt sich an denselben Log-Tailer
// wie die Match-Erkennung und liefert bei Änderungen ein zusammengeführtes Objekt.
const fs = require("fs");
const path = require("path");

const RANK_NAMES = { Bronze: "Bronze", Silver: "Silber", Gold: "Gold", Platinum: "Platin", Diamond: "Diamant", Mythic: "Mythic", Unranked: "Ohne Rang" };

class AccountParser {
  constructor(onUpdate) {
    this.onUpdate = onUpdate;
    this.state = {};                 // zusammengeführte Kontodaten
    this.pending = null;             // erwartete JSON-Antwort: { name, graph }
    this.graphIds = new Map();       // Request-Id -> GraphId (Battle-Pass-Anfragen)
    this.lastJson = "";
  }
  line(l) {
    const s = l.trim();
    if (!s) return;
    // Anfragen an den Graph-Dienst merken, damit die Antwort dem Battle-Pass zugeordnet werden kann
    let m = s.match(/==> GraphGetGraphState (\{.*\})$/);
    if (m) { try { const j = JSON.parse(m[1]); const r = JSON.parse(j.request || "{}"); if (j.id && r.GraphId) this.graphIds.set(j.id, r.GraphId); } catch (e) { /* ignorieren */ } return; }
    m = s.match(/^<== ([A-Za-z_]+)\(([^)]*)\)/);
    if (m) { this.pending = { name: m[1], graph: this.graphIds.get(m[2]) || null }; return; }
    if (s[0] !== "{") { this.pending = null; return; }
    const pending = this.pending; this.pending = null;
    if (!pending && !s.startsWith("{ \"InventoryInfo\"") && !s.startsWith("{\"InventoryInfo\"")) return;
    let j; try { j = JSON.parse(s); } catch (e) { return; }
    if (j.InventoryInfo) this.inventory(j.InventoryInfo);
    else if (pending && pending.name === "RankGetCombinedRankInfo") this.rank(j);
    else if (pending && pending.name === "GraphGetGraphState" && /^BattlePass_/.test(pending.graph || "")) this.mastery(pending.graph, j);
    else if (pending && pending.name === "QuestGetQuests" && Array.isArray(j.quests)) this.quests(j.quests);
    else return;
    this.changed();
  }
  inventory(i) {
    const boosters = (i.Boosters || []).map((b) => ({ set: b.SetCode || b.CollationId, count: b.Count || 0 })).filter((b) => b.count);
    const tokens = i.CustomTokens || {};
    const orbs = Object.entries(tokens).filter(([k]) => /BattlePass_.*_Orb$/.test(k)).reduce((s, [, v]) => s + (+v || 0), 0);
    Object.assign(this.state, {
      gold: i.Gold || 0, gems: i.Gems || 0,
      vault: Math.round((i.TotalVaultProgress || 0)) / 10,          // Tresor in Prozent (Wert kommt in Zehnteln)
      wildcards: { c: i.WildCardCommons || 0, u: i.WildCardUnCommons || 0, r: i.WildCardRares || 0, m: i.WildCardMythics || 0 },
      wcTrack: i.WcTrackPosition || 0,
      draftTokens: i.DraftTokens || 0, sealedTokens: i.SealedTokens || 0, orbs,
      boosters, vouchers: (i.Vouchers || []).length,
      cosmetics: i.Cosmetics ? { avatars: (i.Cosmetics.Avatars || []).length, sleeves: (i.Cosmetics.Sleeves || []).length, pets: (i.Cosmetics.Pets || []).length, styles: (i.Cosmetics.ArtStyles || []).length } : undefined
    });
  }
  rank(r) {
    this.state.rank = {
      season: r.constructedSeasonOrdinal || null,
      // key = englischer Stufenname in Kleinbuchstaben (für die Embleme aus den Spieldaten)
      constructed: { tier: RANK_NAMES[r.constructedClass] || r.constructedClass || "", key: String(r.constructedClass || "unranked").toLowerCase(), level: r.constructedLevel || 0, step: r.constructedStep || 0, won: r.constructedMatchesWon || 0, lost: r.constructedMatchesLost || 0 },
      limited: { tier: RANK_NAMES[r.limitedClass] || r.limitedClass || "", key: String(r.limitedClass || "unranked").toLowerCase(), level: r.limitedLevel || 0, step: r.limitedStep || 0, won: r.limitedMatchesWon || 0, lost: r.limitedMatchesLost || 0 }
    };
  }
  mastery(graph, j) {
    const nodes = j.NodeStates || {};
    let level = 0;
    for (const [k, v] of Object.entries(nodes)) { const m = k.match(/^LevelTrack_Level_(\d+)$/); if (m && v && v.Status === "Completed") level = Math.max(level, +m[1]); }
    const xp = (JSON.stringify(j).match(/"CurrentProgress":(\d+)/) || [])[1];
    // Arena fragt auch alte Pässe ab, und auch die haben einen "offenen" nächsten Level. Verlässliches Merkmal für den
    // laufenden Pass ist der XP-Fortschritt (CurrentProgress): nur er hat einen. Ein Pass ohne XP ersetzt nie einen mit XP.
    const active = Object.entries(nodes).some(([k, v]) => /^LevelTrack_Level_\d+$/.test(k) && v && v.Status === "Available");
    const cur = this.state.mastery;
    if (cur && cur.xp != null && xp == null) return;
    if (cur && cur.active && !active && xp == null) return;
    this.state.mastery = { pass: graph.replace(/^BattlePass_/, ""), level, xp: xp != null ? +xp : null, premium: !!(nodes.RewardTierUpgrade && nodes.RewardTierUpgrade.Status === "Completed"), active };
  }
  quests(list) {
    this.state.quests = list.map((q) => ({
      name: String(q.locKey || "").replace(/^Quests\/Quest_/, "").replace(/_/g, " "),
      goal: q.goal || 0,
      reward: q.chestDescription ? { gold: q.chestDescription.locParams && q.chestDescription.locParams.number1 || +q.chestDescription.quantity || 0, xp: q.chestDescription.locParams && q.chestDescription.locParams.number2 || 0 } : null,
      isNew: !!q.isNewQuest
    }));
  }
  changed() {
    const json = JSON.stringify(this.state);
    if (json === this.lastJson) return;
    this.lastJson = json;
    if (this.onUpdate) this.onUpdate(Object.assign({ takenAt: new Date().toISOString() }, this.state));
  }
}

const accountFile = (outDir) => path.join(outDir, "account.json");
function saveAccount(outDir, account) { fs.writeFileSync(accountFile(outDir), JSON.stringify(account, null, 1)); }
function loadAccount(outDir) { try { return JSON.parse(fs.readFileSync(accountFile(outDir), "utf8")); } catch (e) { return null; } }

module.exports = { AccountParser, saveAccount, loadAccount };

if (require.main === module) {
  // node src/account.js            gesamte Player.log lesen und das Ergebnis ausgeben
  // node src/account.js --save     zusätzlich out/account.json schreiben, zur Website senden und das Dashboard neu bauen
  const args = process.argv.slice(2);
  const save = args.includes("--save");
  const file = args.find((a) => !a.startsWith("--")) || path.join(require("os").homedir(), "AppData", "LocalLow", "Wizards Of The Coast", "MTGA", "Player.log");
  let last = null;
  const p = new AccountParser((a) => { last = a; });
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch (e) { console.error("Player.log nicht lesbar: " + e.message); process.exit(1); }
  for (const l of text.split(/\r?\n/)) p.line(l);
  if (!last) { console.log("Keine Kontodaten im Log. In Arena unter Optionen → Konto die „Detaillierten Protokolle (Plugin-Unterstützung)“ einschalten und das Spiel neu starten."); process.exit(save ? 2 : 0); }
  if (!save) { console.log(JSON.stringify(last, null, 2)); process.exit(0); }
  const cfgFile = path.join(__dirname, "..", "watch-config.json");
  let outDir = path.join(__dirname, "..", "out");
  try { const c = JSON.parse(fs.readFileSync(cfgFile, "utf8").replace(/^﻿/, "")); if (c.outDir) outDir = path.isAbsolute(c.outDir) ? c.outDir : path.join(__dirname, "..", c.outDir); } catch (e) { /* Standard */ }
  fs.mkdirSync(outDir, { recursive: true });
  saveAccount(outDir, last);
  const w = last.wildcards || {};
  console.log(`Konto eingelesen: ${last.gold} Gold, ${last.gems} Edelsteine, Wildcards ${[w.c, w.u, w.r, w.m].join("/")}` + (last.rank ? `, Rang ${last.rank.constructed.tier} ${last.rank.constructed.level}` : "") + (last.mastery ? `, Mastery ${last.mastery.pass} Level ${last.mastery.level}` : ""));
  (async () => {
    try {
      const sync = require("./sync");
      if (sync.device()) {
        // Rang-Embleme aus den Spieldaten klein mitschicken (die Website hat keine Spieldaten)
        let icons = null; try { icons = require("./emblems").rankIconsDataUrls(last); } catch (e) { /* ohne Embleme */ }
        sync.enqueueAccount(icons ? Object.assign({}, last, { rankIcons: icons }) : last); await sync.flush(); console.log("Website: Kontodaten gesendet" + (icons ? " (mit Rang-Emblemen)" : "") + ".");
      } else console.log("Website: nicht verbunden (Tray → Mit Website verbinden…)");
    } catch (e) { console.log("Website: " + e.message); }
    try { require("child_process").execFileSync(process.execPath, [path.join(__dirname, "webgen.js")], { stdio: "ignore", windowsHide: true }); console.log("Dashboard neu gebaut."); } catch (e) { console.log("Dashboard: " + e.message); }
  })();
}
