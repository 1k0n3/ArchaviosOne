const test = require("node:test");
const assert = require("node:assert/strict");
const { MatchParser } = require("../src/matches");

// Minimales Match: Raum geöffnet, Verbindung, ein Spielzustand, Match beendet
const lines = [
  '[UnityCrossThreadLogger]==> EventSetDeckV3 {"id":"x","request":"{\\"EventName\\":\\"Play_Brawl_Historic\\",\\"Summary\\":{\\"DeckId\\":\\"d1\\",\\"Name\\":\\"Testdeck\\",\\"Attributes\\":[{\\"name\\":\\"Format\\",\\"value\\":\\"HistoricBrawl\\"}]}}"}',
  "[UnityCrossThreadLogger]01.01.2026 12:00:00: Match to ABC: MatchGameRoomStateChangedEvent",
  JSON.stringify({ timestamp: "1700000000000", matchGameRoomStateChangedEvent: { gameRoomInfo: { gameRoomConfig: { matchId: "m1", reservedPlayers: [
    { userId: "u1", playerName: "Gegner", systemSeatId: 1, teamId: 1, platformId: "iPad", eventId: "Play_Brawl_Historic" },
    { userId: "u2", playerName: "Ich", systemSeatId: 2, teamId: 2, platformId: "Windows", eventId: "Play_Brawl_Historic" }] }, stateType: "MatchGameRoomStateType_Playing" } } }),
  "[UnityCrossThreadLogger]01.01.2026 12:00:01: Match to ABC: GreToClientEvent",
  JSON.stringify({ timestamp: "1700000001000", greToClientEvent: { greToClientMessages: [
    { type: "GREMessageType_ConnectResp", systemSeatIds: [2], connectResp: { deckMessage: { deckCards: [100, 100, 101], commanderCards: [102] } } },
    { type: "GREMessageType_GameStateMessage", systemSeatIds: [2], gameStateMessage: { type: "GameStateType_Full", gameInfo: { gameNumber: 1 },
      players: [{ systemSeatNumber: 1, lifeTotal: 25, teamId: 1 }, { systemSeatNumber: 2, lifeTotal: 25, teamId: 2 }],
      turnInfo: { turnNumber: 1, activePlayer: 2, phase: "Phase_Main1" },
      zones: [{ zoneId: 28, type: "ZoneType_Battlefield", objectInstanceIds: [9] },{ zoneId: 31, type: "ZoneType_Hand", ownerSeatId: 1, objectInstanceIds: [5, 6] }, { zoneId: 35, type: "ZoneType_Hand", ownerSeatId: 2, objectInstanceIds: [7] }, { zoneId: 32, type: "ZoneType_Library", ownerSeatId: 1, objectInstanceIds: [1, 2, 3] }],
      gameObjects: [{ instanceId: 7, grpId: 101, type: "GameObjectType_Card", zoneId: 35, ownerSeatId: 2, controllerSeatId: 2 }, { instanceId: 9, grpId: 555, type: "GameObjectType_Card", zoneId: 28, ownerSeatId: 1, controllerSeatId: 1, isTapped: true, power: { value: 2 }, toughness: { value: 3 } }],
      annotations: [{ id: 1, affectorId: 2, affectedIds: [2], type: ["AnnotationType_NewTurnStarted"] }] } }
  ] } }),
  "[UnityCrossThreadLogger]01.01.2026 12:00:02: Match to ABC: MatchGameRoomStateChangedEvent",
  JSON.stringify({ timestamp: "1700000002000", matchGameRoomStateChangedEvent: { gameRoomInfo: { gameRoomConfig: { matchId: "m1" }, stateType: "MatchGameRoomStateType_MatchCompleted",
    finalMatchResult: { resultList: [{ scope: "MatchScope_Match", result: "ResultType_WinLoss", winningTeamId: 2, reason: "ResultReason_Concede" }] } } } })
];

test("MatchParser baut ein Match mit Deck, Spielern, Frames und Ergebnis", () => {
  const out = [];
  const p = new MatchParser((m) => out.push(m));
  for (const l of lines) p.line(l);
  assert.equal(out.length, 1);
  const m = out[0];
  assert.equal(m.matchId, "m1");
  assert.equal(m.mySeat, 2);
  assert.equal(m.result, "Sieg");
  assert.equal(m.reason, "Concede");
  assert.equal(m.myDeck.name, "Testdeck");
  assert.equal(m.myDeck.format, "HistoricBrawl");
  assert.deepEqual(m.myDeck.cards, [{ grpId: 100, qty: 2 }, { grpId: 101, qty: 1 }]);
  assert.deepEqual(m.myDeck.commander, [{ grpId: 102, qty: 1 }]);
  assert.equal(m.players.find((x) => x.seat === 1).name, "Gegner");
  assert.deepEqual(m.opponentCards, [{ grpId: 555, count: 1 }]);
  assert.equal(m.frames.length, 1);
  const f = m.frames[0];
  assert.equal(f.turn, 1);
  assert.equal(f.ph, "Hauptphase 1");
  assert.deepEqual(f.life, [25, 25]);
  assert.deepEqual(f.hc, [2, 1]);
  assert.deepEqual(f.h[1], [101]);
  assert.deepEqual(f.lib, [3, 0]);
  assert.equal(f.bf.length, 1);
  assert.equal(f.bf[0][1], 555);
  assert.equal(f.bf[0][4], 1); // getappt
  assert.deepEqual(f.ev, [{ k: "turn", s: 2, v: 1 }]);
});
