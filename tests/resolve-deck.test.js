const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveDeck, fixMatchDeck } = require("../src/matches");

const decks = [
  { id: "angel", name: "BWL Angel", format: "Brawl", zones: { CommandZone: [[100, 1]], MainDeck: [[1, 30], [2, 20], [3, 10]] } },
  { id: "vamp", name: "BWL Vampire", format: "Brawl", zones: { CommandZone: [[200, 1]], MainDeck: [[1, 30], [4, 20], [5, 10]] } },
  { id: "std", name: "Standard Rot", format: "Standard", zones: { MainDeck: [[7, 20], [8, 20], [9, 20]] } }
];

test("Deck wird am Commander erkannt, auch wenn das zuletzt gesetzte Deck ein anderes war", () => {
  const m = { myDeck: { deckId: "angel", name: "BWL Angel", format: "Brawl", cards: [{ grpId: 1, qty: 30 }, { grpId: 4, qty: 20 }], commander: [{ grpId: 200, qty: 1 }] } };
  assert.equal(fixMatchDeck(m, decks), true);
  assert.equal(m.myDeck.deckId, "vamp");
  assert.equal(m.myDeck.resolvedBy, "commander");
});

test("Ohne Commander zählt die Überschneidung der Kartenliste (mindestens 60 %)", () => {
  const r = resolveDeck({ cards: [{ grpId: 7, qty: 20 }, { grpId: 8, qty: 20 }, { grpId: 99, qty: 20 }], commander: [] }, decks);
  assert.equal(r && r.id, "std");
  assert.equal(r.by, "cards");
  assert.equal(resolveDeck({ cards: [{ grpId: 7, qty: 10 }, { grpId: 99, qty: 50 }], commander: [] }, decks), null);
});

test("Ohne gespielte Kartenliste wird nichts umgestellt", () => {
  const m = { myDeck: { deckId: "angel", name: "BWL Angel", cards: [], commander: [] } };
  assert.equal(fixMatchDeck(m, decks), false);
  assert.equal(m.myDeck.deckId, "angel");
});
