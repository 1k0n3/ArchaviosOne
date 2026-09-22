#!/usr/bin/env node
/**
 * MTGA Match-Aufzeichnung
 *
 * Liest Matches aus der Player.log (GRE-Nachrichten) und speichert je Match
 *   out/matches/<matchId>.json           kompletter Verlauf (Frames für das Replay)
 *   out/matches/opponents/<...>.txt      gesehene Karten des Gegners
 *   out/matches/matches.csv              Index aller Matches
 *
 *   node matches.js [--out DIR] [--db PFAD] [--log PFAD]   liest Player-prev.log + Player.log
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const lib = require("./lib");

const ZONE_SHORT = {
  ZoneType_Battlefield: "bf", ZoneType_Stack: "st", ZoneType_Hand: "hand", ZoneType_Library: "lib",
  ZoneType_Graveyard: "gy", ZoneType_Exile: "ex", ZoneType_Command: "cmd"
};
const PHASES = { Phase_Beginning: "Beginn", Phase_Main1: "Hauptphase 1", Phase_Combat: "Kampf", Phase_Main2: "Hauptphase 2", Phase_Ending: "Ende" };
const STEPS = {
  Step_Upkeep: "Versorgung", Step_Draw: "Ziehen", Step_BeginCombat: "Kampfbeginn", Step_DeclareAttack: "Angreifer",
  Step_DeclareBlock: "Blocker", Step_CombatDamage: "Kampfschaden", Step_EndCombat: "Kampfende", Step_End: "Endsegment", Step_Cleanup: "Aufräumen", Step_Untap: "Enttappen"
};

function defaultLogDir() { return require("./paths").findLogDir(); }

function detail(a, key) {
  const d = (a.details || []).find((x) => x.key === key);
  if (!d) return undefined;
  if (d.valueInt32) return d.valueInt32[0];
  if (d.valueString) return d.valueString[0];
  if (d.valueDouble) return d.valueDouble[0];
  return undefined;
}

// ---- Parser -----------------------------------------------------------------------------------------

/**
 * Deck anhand des gespielten Inhalts erkennen. Arena schreibt bei Direktspielen und manchen Events kein
 * "EventSetDeck" ins Log, dann bliebe sonst das zuletzt gewählte Deck stehen. Der Commander muss passen
 * (bei Brawl eindeutig), sonst zählt die größte Überschneidung der Kartenliste (mindestens 60 %).
 * played: { cards: [{grpId, qty}], commander: [{grpId, qty}] }, decks: [{ id, name, format, zones }]
 */
function resolveDeck(played, decks) {
  if (!decks || !decks.length || !(played.cards || []).length) return null; // ohne gespielte Liste keine Erkennung
  const cmd = new Set((played.commander || []).map((c) => c.grpId));
  let best = null, bestScore = 0;
  for (const d of decks) {
    const z = d.zones || {};
    const dcmd = new Set((z.CommandZone || []).map(([g]) => g));
    const cmdOk = cmd.size > 0 && dcmd.size === cmd.size && [...cmd].every((g) => dcmd.has(g)); // nur ein echter Commander zählt
    const main = new Map((z.MainDeck || []).map(([g, q]) => [g, q]));
    let overlap = 0, total = 0;
    for (const c of played.cards || []) { total += c.qty; overlap += Math.min(c.qty, main.get(c.grpId) || 0); }
    const ratio = total ? overlap / total : 0;
    const score = (cmdOk ? 1000 : 0) + ratio * 100;
    if (score > bestScore) { bestScore = score; best = d; }
  }
  if (!best) return null;
  const byCommander = bestScore >= 1000, ratio = bestScore % 1000;
  if (byCommander || ratio >= 60) return { id: best.id, name: best.name, format: best.format || "", by: byCommander ? "commander" : "cards", ratio: Math.round(ratio) };
  return null;
}
/** Bekannte Decks für die Erkennung (vom Watcher gesetzt, aus dem Player.log) */
let knownDecks = [];
const setKnownDecks = (decks) => { knownDecks = decks || []; };
/** myDeck eines Matches am Inhalt prüfen und ggf. korrigieren; gibt true zurück, wenn sich etwas geändert hat */
function fixMatchDeck(m, decks) {
  const r = resolveDeck(m.myDeck, decks || knownDecks);
  if (!r) return false;
  if (m.myDeck.deckId === r.id && m.myDeck.name === r.name) { m.myDeck.resolvedBy = m.myDeck.resolvedBy || r.by; return false; }
  Object.assign(m.myDeck, { deckId: r.id, name: r.name, format: r.format || m.myDeck.format, resolvedBy: r.by });
  return true;
}

class MatchParser {
  constructor(onMatch) {
    this.onMatch = onMatch;
    this.lastDeck = null;
    this.expectJson = null;
    this.match = null;
    this.state = null;
    this.game = null;
  }

  resetMatch() { this.match = null; this.state = null; this.game = null; }

  line(l) {
    if (!l) return;
    if (this.expectJson && l[0] === "{") {
      const type = this.expectJson;
      this.expectJson = null;
      let o;
      try { o = JSON.parse(l); } catch (e) { return; }
      this.handleMessage(type, o);
      return;
    }
    this.expectJson = null;
    if (l[0] === "[") {
      const m = l.match(/: Match to \w+: (\w+)\s*$/);
      if (m) { this.expectJson = m[1]; return; }
      const d = l.match(/==> EventSetDeckV\d+ (\{.*\})\s*$/);
      if (d) {
        try {
          const req = JSON.parse(JSON.parse(d[1]).request);
          const s = req.Summary || {};
          const fmt = ((s.Attributes || []).find((x) => x.name === "Format") || {}).value || "";
          this.lastDeck = { id: s.DeckId, name: s.Name || "", format: fmt, event: req.EventName || "" };
        } catch (e) { /* ignorieren */ }
      }
    }
  }

  handleMessage(type, o) {
    const ts = o.timestamp ? parseInt(o.timestamp, 10) : Date.now();
    if (o.matchGameRoomStateChangedEvent) { this.handleRoom(o.matchGameRoomStateChangedEvent, ts); return; }
    if (o.greToClientEvent && this.match) {
      for (const m of o.greToClientEvent.greToClientMessages || []) {
        if (m.type === "GREMessageType_ConnectResp") {
          if (m.systemSeatIds && m.systemSeatIds.length) this.match.mySeat = m.systemSeatIds[0];
          const dm = m.connectResp && m.connectResp.deckMessage;
          if (dm) {
            this.match.myDeck.cards = countList(dm.deckCards || []);
            this.match.myDeck.commander = countList(dm.commanderCards || []);
            this.match.myDeck.sideboard = countList(dm.sideboardCards || []);
            fixMatchDeck(this.match); // Deck am Inhalt erkennen (Direktspiele ohne "EventSetDeck")
          }
        } else if (m.type === "GREMessageType_GameStateMessage" || m.type === "GREMessageType_QueuedGameStateMessage") {
          if (m.systemSeatIds && m.systemSeatIds.length && !this.match.mySeat) this.match.mySeat = m.systemSeatIds[0];
          if (m.gameStateMessage) this.handleGameState(m.gameStateMessage, ts);
        }
      }
    }
  }

  handleRoom(ev, ts) {
    const info = ev.gameRoomInfo || {};
    const cfg = info.gameRoomConfig || {};
    const matchId = cfg.matchId;
    if (info.stateType === "MatchGameRoomStateType_Playing") {
      if (!this.match || this.match.matchId !== matchId) {
        if (this.match) this.finish(ts, null);
        this.match = {
          matchId, start: ts, end: null,
          eventId: "", players: [], mySeat: 0,
          myDeck: { name: this.lastDeck ? this.lastDeck.name : "", deckId: this.lastDeck ? this.lastDeck.id : "", format: this.lastDeck ? this.lastDeck.format : "", cards: [], commander: [], sideboard: [] },
          games: [], frames: [], result: "", reason: "", winningTeam: 0, seen: {}, rootOf: {}
        };
      }
      const players = (cfg.reservedPlayers && cfg.reservedPlayers.length ? cfg.reservedPlayers : info.players) || [];
      for (const p of players) {
        if (!this.match.players.find((x) => x.seat === p.systemSeatId)) {
          this.match.players.push({ seat: p.systemSeatId, team: p.teamId, name: p.playerName || "", userId: p.userId || "", platform: p.platformId || "" });
        }
        if (p.eventId && !this.match.eventId) this.match.eventId = p.eventId;
      }
    } else if (info.stateType === "MatchGameRoomStateType_MatchCompleted") {
      if (!this.match || this.match.matchId !== matchId) return;
      this.finish(ts, info.finalMatchResult || null);
    }
  }

  finish(ts, finalResult) {
    const m = this.match;
    m.end = ts;
    let winningTeam = 0, reason = "";
    if (finalResult && finalResult.resultList) {
      const r = finalResult.resultList.find((x) => x.scope === "MatchScope_Match") || finalResult.resultList[finalResult.resultList.length - 1];
      if (r) { winningTeam = r.winningTeamId || 0; reason = r.reason || ""; }
    }
    if (!winningTeam && m.games.length) {
      const g = m.games[m.games.length - 1];
      winningTeam = g.winningTeam || 0;
      reason = g.reason || reason;
    }
    const me = m.players.find((p) => p.seat === m.mySeat);
    const myTeam = me ? me.team : m.mySeat;
    m.winningTeam = winningTeam;
    m.reason = reason.replace(/^ResultReason_/, "");
    m.result = !winningTeam ? "unbekannt" : winningTeam === myTeam ? "Sieg" : "Niederlage";
    m.opponentCards = Object.entries(m.seen).map(([grp, set]) => ({ grpId: +grp, count: set.size })).sort((a, b) => b.count - a.count);
    delete m.seen;
    delete m.rootOf;
    const out = m;
    this.resetMatch();
    this.onMatch(out);
  }

  // ---- Spielzustand ---------------------------------------------------------------------------------

  handleGameState(g, ts) {
    const m = this.match;
    if (g.type === "GameStateType_Full") {
      const num = (g.gameInfo && g.gameInfo.gameNumber) || (m.games.length + 1);
      this.game = m.games.find((x) => x.number === num);
      if (!this.game) {
        this.game = { number: num, winningTeam: 0, reason: "", turns: 0, firstFrame: m.frames.length };
        m.games.push(this.game);
      }
      this.state = { objects: new Map(), zones: new Map(), players: new Map(), turn: {}, lastBoard: "" };
    }
    if (!this.state) return;
    const st = this.state;

    for (const id of g.diffDeletedInstanceIds || []) st.objects.delete(id);
    for (const o of g.gameObjects || []) st.objects.set(o.instanceId, o);
    for (const z of g.zones || []) st.zones.set(z.zoneId, z);
    for (const p of g.players || []) st.players.set(p.systemSeatNumber, p);
    if (g.turnInfo) {
      if (g.turnInfo.phase && !g.turnInfo.step) delete st.turn.step;
      Object.assign(st.turn, g.turnInfo);
    }
    if (this.game && st.turn.turnNumber) this.game.turns = Math.max(this.game.turns, st.turn.turnNumber);

    if (g.gameInfo && g.gameInfo.results && g.gameInfo.results.length && this.game) {
      const r = g.gameInfo.results.find((x) => x.scope === "MatchScope_Game") || g.gameInfo.results[0];
      if (r && r.winningTeamId) { this.game.winningTeam = r.winningTeamId; this.game.reason = (r.reason || "").replace(/^ResultReason_/, ""); }
    }

    // Gegnerkarten merken (Lineage über ObjectIdChanged, damit Zonenwechsel nicht doppelt zählen)
    const oppSeat = m.mySeat ? (m.mySeat === 1 ? 2 : 1) : 0;
    const ann = g.annotations || [];
    for (const a of ann) {
      if ((a.type || []).includes("AnnotationType_ObjectIdChanged")) {
        const orig = detail(a, "orig_id"), nu = detail(a, "new_id");
        if (orig && nu) m.rootOf[nu] = m.rootOf[orig] || orig;
      }
    }
    if (oppSeat) {
      for (const o of g.gameObjects || []) {
        if (o.type === "GameObjectType_Card" && o.ownerSeatId === oppSeat && o.grpId) {
          const root = m.rootOf[o.instanceId] || o.instanceId;
          (m.seen[o.grpId] = m.seen[o.grpId] || new Set()).add(root);
        }
      }
    }

    // Ereignisse
    const events = this.events(ann, st);
    const frame = this.buildFrame(st, ts, events);
    const boardKey = JSON.stringify([frame.bf, frame.st, frame.h, frame.gy, frame.ex, frame.cmd, frame.life, frame.turn, frame.ph, frame.stp]);
    if (events.length || boardKey !== st.lastBoard) {
      st.lastBoard = boardKey;
      m.frames.push(frame);
    }
  }

  events(ann, st) {
    const out = [];
    const grpOf = (id) => { const o = st.objects.get(id); return o ? o.grpId : 0; };
    const seatOf = (id) => { const o = st.objects.get(id); return o ? (o.controllerSeatId || o.ownerSeatId) : (id === 1 || id === 2 ? id : 0); };
    for (const a of ann) {
      const types = a.type || [];
      const ids = a.affectedIds || [];
      if (types.includes("AnnotationType_ZoneTransfer")) {
        const cat = detail(a, "category") || "";
        const dest = st.zones.get(detail(a, "zone_dest"));
        const src = st.zones.get(detail(a, "zone_src"));
        const id = ids[0];
        const grp = grpOf(id);
        let seat = seatOf(id);
        if (!seat && dest && dest.ownerSeatId) seat = dest.ownerSeatId;
        if (!seat && src && src.ownerSeatId) seat = src.ownerSeatId;
        const kinds = { PlayLand: "land", CastSpell: "cast", Draw: "draw", Resolve: "resolve", Exile: "exile", Put: "put", Sacrifice: "sacrifice", Destroy: "destroy", Discard: "discard", Mill: "mill", Return: "return", SBA_Damage: "dies", SBA_LegendRule: "legend", SBA_Commander: "cmdzone", Surveil: "surveil", Seek: "seek", Conjure: "conjure" };
        const k = kinds[cat];
        if (k) out.push({ k, s: seat, g: grp, z: dest ? ZONE_SHORT[dest.type] || "" : "" });
      } else if (types.includes("AnnotationType_DamageDealt")) {
        const dmg = detail(a, "damage") || 0;
        const target = ids[0];
        out.push({ k: "dmg", s: seatOf(a.affectorId), g: grpOf(a.affectorId), v: dmg, t: target === 1 || target === 2 ? "s" + target : grpOf(target) });
      } else if (types.includes("AnnotationType_ModifiedLife")) {
        const v = detail(a, "life") || 0;
        const p = st.players.get(ids[0]);
        out.push({ k: "life", s: ids[0], v, l: p ? p.lifeTotal : undefined, g: grpOf(a.affectorId) });
      } else if (types.includes("AnnotationType_NewTurnStarted")) {
        out.push({ k: "turn", s: a.affectorId, v: st.turn.turnNumber || 0 });
      } else if (types.includes("AnnotationType_TokenCreated")) {
        out.push({ k: "token", s: seatOf(ids[0]), g: grpOf(ids[0]) });
      } else if (types.includes("AnnotationType_LossOfGame")) {
        out.push({ k: "lose", s: ids[0] });
      } else if (types.includes("AnnotationType_Scry")) {
        out.push({ k: "scry", s: a.affectorId });
      } else if (types.includes("AnnotationType_CardRevealed") || types.includes("AnnotationType_RevealedCardCreated")) {
        out.push({ k: "reveal", s: seatOf(ids[0]), g: grpOf(ids[0]) });
      }
    }
    return out;
  }

  buildFrame(st, ts, events) {
    const zonesByType = {};
    for (const z of st.zones.values()) {
      const key = ZONE_SHORT[z.type];
      if (!key) continue;
      (zonesByType[key] = zonesByType[key] || []).push(z);
    }
    // Kampfwerte: Arena lässt Nullwerte im Protokoll weg. Eine Kreatur mit Stärke 0 (Goat 0/1, Wall
    // 0/4) hat dann kein power-Feld, wohl aber toughness; fehlt eines von beiden, ist es 0.
    const pt = (o) => {
      if (o.power == null && o.toughness == null) return [null, null];
      const v = (x) => (x == null ? 0 : (typeof x === "object" ? (x.value || 0) : x));
      return [v(o.power), v(o.toughness)];
    };
    const enc = (o) => [
      o.instanceId, o.grpId || 0, o.controllerSeatId || o.ownerSeatId || 0, o.ownerSeatId || 0,
      o.isTapped ? 1 : 0, o.attackState === "AttackState_Attacking" ? 1 : (o.blockState === "BlockState_Blocking" ? 2 : 0),
      ...pt(o), o.damage || 0,
      o.type === "GameObjectType_Token" ? 1 : (o.type === "GameObjectType_Ability" ? 2 : 0), o.parentId || 0,
      o.hasSummoningSickness ? 1 : 0, o.loyalty != null ? (typeof o.loyalty === "object" ? o.loyalty.value : o.loyalty) : null,
      o.objectSourceGrpId || 0
    ];
    const objsIn = (zones) => {
      const out = [];
      for (const z of zones || []) for (const id of z.objectInstanceIds || []) { const o = st.objects.get(id); if (o) out.push(enc(o)); }
      return out;
    };
    const perSeat = (zones, mode) => {
      const r = { 1: mode === "count" ? 0 : [], 2: mode === "count" ? 0 : [] };
      for (const z of zones || []) {
        const seat = z.ownerSeatId;
        if (!seat) continue;
        const ids = z.objectInstanceIds || [];
        if (mode === "count") r[seat] += ids.length;
        else if (mode === "grp") r[seat] = ids.map((id) => { const o = st.objects.get(id); return o ? o.grpId || 0 : 0; });
      }
      return [r[1], r[2]];
    };
    const life = [1, 2].map((s) => { const p = st.players.get(s); return p ? p.lifeTotal : null; });
    return {
      t: ts, g: this.game ? this.game.number : 1,
      turn: st.turn.turnNumber || 0, act: st.turn.activePlayer || 0, pri: st.turn.priorityPlayer || 0,
      ph: PHASES[st.turn.phase] || (st.turn.phase || "").replace("Phase_", ""),
      stp: STEPS[st.turn.step] || (st.turn.step || "").replace("Step_", ""),
      life,
      bf: objsIn(zonesByType.bf), st: objsIn(zonesByType.st), cmd: objsIn(zonesByType.cmd),
      h: perSeat(zonesByType.hand, "grp"), hc: perSeat(zonesByType.hand, "count"),
      lib: perSeat(zonesByType.lib, "count"), gy: perSeat(zonesByType.gy, "grp"), ex: perSeat(zonesByType.ex, "grp"),
      ev: events
    };
  }
}

function countList(ids) {
  const m = new Map();
  for (const id of ids) m.set(id, (m.get(id) || 0) + 1);
  return [...m].map(([grpId, qty]) => ({ grpId, qty }));
}

// ---- Log lesen (inkrementell) -----------------------------------------------------------------------

class LogTailer {
  constructor(file, parser) { this.file = file; this.parser = parser; this.offset = 0; this.rest = ""; }
  poll() {
    if (!fs.existsSync(this.file)) return 0;
    const size = fs.statSync(this.file).size;
    if (size < this.offset) { this.offset = 0; this.rest = ""; this.parser.resetMatch(); }
    if (size === this.offset) return 0;
    const fd = fs.openSync(this.file, "r");
    const buf = Buffer.alloc(size - this.offset);
    fs.readSync(fd, buf, 0, buf.length, this.offset);
    fs.closeSync(fd);
    this.offset = size;
    const text = this.rest + buf.toString("utf8");
    const lines = text.split(/\r?\n/);
    this.rest = lines.pop();
    for (const l of lines) this.parser.line(l);
    return lines.length;
  }
}

function parseLogFile(file, onMatch) {
  const p = new MatchParser(onMatch);
  const t = new LogTailer(file, p);
  t.poll();
  if (t.rest) p.line(t.rest);
  return p;
}

// ---- Speichern ---------------------------------------------------------------------------------------

function matchDir(outDir) { return path.join(outDir, "matches"); }

function saveMatch(match, outDir, cards) {
  const dir = matchDir(outDir);
  fs.mkdirSync(path.join(dir, "opponents"), { recursive: true });
  const file = path.join(dir, match.matchId + ".json");
  if (fs.existsSync(file)) return { file, isNew: false };
  fs.writeFileSync(file, JSON.stringify(match));

  const opp = match.players.find((p) => p.seat !== match.mySeat) || {};
  const d = new Date(match.start);
  const stamp = lib.stampDate(d) + "_" + lib.stampTime(d);
  const safe = (s) => String(s || "unbekannt").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 40);
  const lines = [
    `# Gegner: ${opp.name || "?"} (${opp.platform || "?"}) · ${lib.stampFull(d)} · ${match.result} · Event ${match.eventId}`,
    `# Gesehene Karten (${match.opponentCards.length} verschiedene). Anzahl = wie oft unterschiedliche Exemplare gesehen wurden.`,
    ""
  ];
  for (const c of match.opponentCards) {
    const card = cards.get(c.grpId);
    if (!card || card.IsToken) continue;
    lines.push(`${c.count} ${card.Name} (${card.ExpansionCode}) ${card.CollectorNumber}`);
  }
  fs.writeFileSync(path.join(dir, "opponents", `${stamp}_${safe(opp.name)}_${match.matchId.slice(0, 8)}.txt`), lines.join("\r\n") + "\r\n");
  return { file, isNew: true };
}

function loadMatches(outDir) {
  const dir = matchDir(outDir);
  if (!fs.existsSync(dir)) return [];
  const list = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try { list.push(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))); } catch (e) { /* ignorieren */ }
  }
  list.sort((a, b) => a.start - b.start);
  return list;
}

/** Von mir gespielte Karten (Länder gelegt, Zauber gewirkt): [[grpId, Anzahl], ...] */
function playedByMe(m) {
  const counts = new Map();
  for (const f of m.frames || []) for (const e of f.ev || []) {
    if ((e.k === "cast" || e.k === "land") && e.s === m.mySeat && e.g) counts.set(e.g, (counts.get(e.g) || 0) + 1);
  }
  return [...counts.entries()];
}

function matchSummary(m, cards) {
  const me = m.players.find((p) => p.seat === m.mySeat) || {};
  const opp = m.players.find((p) => p.seat !== m.mySeat) || {};
  const turns = m.games.reduce((s, g) => Math.max(s, g.turns || 0), 0);
  const first = m.frames.length ? m.frames.find((f) => f.act) : null;
  const onPlay = first ? first.act === m.mySeat : null;
  const cmd = (m.myDeck.commander || []).map((c) => (cards.get(c.grpId) || {}).Name || "?").join(", ");
  return {
    matchId: m.matchId, start: m.start, end: m.end, durationSec: m.end && m.start ? Math.round((m.end - m.start) / 1000) : 0,
    result: m.result, reason: m.reason, eventId: m.eventId, format: m.myDeck.format || "",
    myName: me.name || "", myDeck: m.myDeck.name || "", myDeckId: m.myDeck.deckId || "", commander: cmd,
    opponent: opp.name || "", opponentPlatform: opp.platform || "", opponentUserId: opp.userId || "",
    games: m.games.map((g) => ({ number: g.number, won: g.winningTeam ? g.winningTeam === (me.team || m.mySeat) : null, reason: g.reason, turns: g.turns })),
    turns, onPlay, frames: m.frames.length,
    opponentCards: m.opponentCards || [],
    played: playedByMe(m)
  };
}

function writeIndexCsv(outDir, cards) {
  const list = loadMatches(outDir);
  const head = ["Datum", "Zeit", "Ergebnis", "Grund", "Mein Deck", "Commander", "Gegner", "Plattform", "Event", "Format", "Spiele", "Züge", "Dauer (min)", "Am Zug begonnen", "MatchId"];
  const lines = [lib.csvLine(head)];
  for (const m of list) {
    const s = matchSummary(m, cards);
    const d = new Date(s.start);
    lines.push(lib.csvLine([
      lib.stampDate(d), lib.stampFull(d).slice(11), s.result, s.reason, s.myDeck, s.commander, s.opponent, s.opponentPlatform,
      s.eventId, s.format, s.games.length, s.turns, Math.round(s.durationSec / 60), s.onPlay === null ? "" : (s.onPlay ? "ja" : "nein"), s.matchId
    ]));
  }
  fs.mkdirSync(matchDir(outDir), { recursive: true });
  fs.writeFileSync(path.join(matchDir(outDir), "matches.csv"), "﻿" + lines.join("\r\n") + "\r\n");
  return list.length;
}

module.exports = { MatchParser, LogTailer, parseLogFile, saveMatch, loadMatches, matchSummary, playedByMe, writeIndexCsv, defaultLogDir, resolveDeck, setKnownDecks, fixMatchDeck };

// ---- CLI ---------------------------------------------------------------------------------------------

if (require.main === module && process.argv.includes("--fix-decks")) {
  // Gespeicherte Matches am Inhalt neu zuordnen (nach falscher Zuordnung bei Direktspielen)
  const out = path.join(__dirname, "..", "out");
  const { cards } = lib.loadCards(lib.findCardDb());
  const decks = require("./webgen").readDecks(cards);
  let changed = 0;
  for (const f of fs.readdirSync(matchDir(out)).filter((x) => x.endsWith(".json"))) {
    const p = path.join(matchDir(out), f);
    const m = JSON.parse(fs.readFileSync(p, "utf8"));
    const before = m.myDeck.name;
    if (fixMatchDeck(m, decks)) { fs.writeFileSync(p, JSON.stringify(m)); changed++; console.log(`${lib.stampFull(new Date(m.start))}  ${before} -> ${m.myDeck.name} (${m.myDeck.resolvedBy})`); }
  }
  writeIndexCsv(out, cards);
  console.log(`${changed} Matches korrigiert.`);
} else if (require.main === module) {
  const args = process.argv.slice(2);
  const opt = { out: path.join(__dirname, "..", "out"), db: "", log: "" };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = () => args[++i];
    if (a === "--out") opt.out = next();
    else if (a === "--db") opt.db = next();
    else if (a === "--log") opt.log = next();
    else if (a === "-h" || a === "--help") { console.log(fs.readFileSync(__filename, "utf8").split("*/")[0]); process.exit(0); }
    else { console.error("Unbekannte Option: " + a); process.exit(1); }
  }
  const { cards } = lib.loadCards(lib.findCardDb(opt.db));
  const files = opt.log ? [opt.log] : [path.join(defaultLogDir(), "Player-prev.log"), path.join(defaultLogDir(), "Player.log")];
  let found = 0, saved = 0;
  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    parseLogFile(f, (m) => {
      found++;
      const r = saveMatch(m, opt.out, cards);
      if (r.isNew) saved++;
      const s = matchSummary(m, cards);
      console.log(`${lib.stampFull(new Date(s.start))}  ${s.result.padEnd(10)} ${(s.myDeck || "?").padEnd(22).slice(0, 22)} vs ${s.opponent.padEnd(16).slice(0, 16)} ${s.turns} Züge, ${s.frames} Frames${r.isNew ? "" : "  (bereits gespeichert)"}`);
    });
  }
  const total = writeIndexCsv(opt.out, cards);
  console.log(`\n${found} Matches im Log, ${saved} neu gespeichert, ${total} insgesamt in ${matchDir(opt.out)}`);
  try {
    const webgen = require("./webgen");
    const r = webgen.build(opt.out, cards);
    console.log(`Web-Dashboard aktualisiert: ${r.index}`);
  } catch (e) {
    console.log("Web-Dashboard nicht erstellt: " + e.message);
  }
}
