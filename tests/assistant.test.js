process.env.MTGA_NO_MIRROR = "1";   // nie zur echten Website spiegeln
const test = require("node:test");
const assert = require("node:assert/strict");
const { searchCards, collectionSummary, messagesFor, toolsFor } = require("../src/assistant");

// [grpId, name, set, nr, rarity, colors, types, artId, cmc, owned, cost, isToken, isRebalanced, isPrimary, flags, power, toughness, text, typeLine]
const row = (o) => [o.id, o.name, o.set || "FDN", o.nr || "1", o.rarity != null ? o.rarity : 2, o.colors || "", o.types || "2", 0, o.cmc || 0, o.owned || 0, o.cost || "", o.token ? 1 : 0, 0, 1, o.flags || "", o.power || "", o.toughness || "", o.text || "", o.typeLine || "Creature"];

const ROWS = [
  row({ id: 1, name: "Llanowar Elves", colors: "5", types: "2", cmc: 1, owned: 4, cost: "{G}", power: "1", toughness: "1", text: "{T}: Add {G}.", typeLine: "Creature — Elf Druid" }),
  row({ id: 2, name: "Forest", rarity: 1, colors: "", types: "5", cmc: 0, owned: 12, typeLine: "Basic Land — Forest" }),
  row({ id: 3, name: "Counterspell", colors: "2", types: "4", cmc: 2, owned: 0, cost: "{U}{U}", text: "Counter target spell.", typeLine: "Instant" }),
  row({ id: 4, name: "Llanowar Elves", set: "M19", colors: "5", types: "2", cmc: 1, owned: 1, cost: "{G}", typeLine: "Creature — Elf Druid" }),
  row({ id: 5, name: "Gruul Spellbreaker", colors: "4,5", types: "2", cmc: 3, owned: 2, cost: "{R}{G}", rarity: 4, typeLine: "Creature — Human Warrior" }),
  row({ id: 6, name: "Goblin Token", types: "2", token: true, owned: 0 })
];

test("searchCards filtert nach Farbe, Typ und Manawert", () => {
  const r = searchCards(ROWS, { colors: "g", type: "kreatur", cmc_max: 1 });
  assert.deepEqual(r.cards.map((c) => c.name), ["Llanowar Elves"]);
  assert.equal(r.cards[0].owned, 4, "der Druck mit den meisten Exemplaren gewinnt");
});

test("searchCards: colors_exact grenzt auf genau diese Farben ein", () => {
  assert.deepEqual(searchCards(ROWS, { colors: "rg" }).cards.map((c) => c.name), ["Llanowar Elves", "Gruul Spellbreaker"]);   // rot ODER grün
  const ex = searchCards(ROWS, { colors: "rg", colors_exact: true }).cards;
  assert.deepEqual(ex.map((c) => c.name), ["Gruul Spellbreaker"]);
});

test("searchCards: owned, Token und Freitext", () => {
  assert.ok(searchCards(ROWS, { owned: true }).cards.every((c) => c.owned > 0));
  assert.equal(searchCards(ROWS, {}).cards.find((c) => c.name === "Goblin Token"), undefined, "Token tauchen nie auf");
  assert.deepEqual(searchCards(ROWS, { q: "counter target" }).cards.map((c) => c.name), ["Counterspell"]);
  assert.deepEqual(searchCards(ROWS, { q: "elf druid" }).cards.map((c) => c.name), ["Llanowar Elves"], "Suche greift auch in die Typzeile");
});

test("searchCards: gleiche Namen nur einmal, limit begrenzt", () => {
  const r = searchCards(ROWS, {});
  assert.equal(r.cards.filter((c) => c.name === "Llanowar Elves").length, 1);
  assert.equal(searchCards(ROWS, { limit: 2 }).cards.length, 2);
  assert.ok(r.total >= r.cards.length);
});

test("collectionSummary zählt nur Karten im Besitz", () => {
  const s = collectionSummary(ROWS);
  assert.equal(s.karten_im_besitz, 4);                 // Counterspell fehlt, Token zählt nie
  assert.equal(s.exemplare, 4 + 12 + 1 + 2);
  assert.equal(s.karten_in_arena, 5);
  assert.equal(s.nach_farbe.grün, 2);
  assert.equal(s.nach_farbe.mehrfarbig, 1);
  assert.equal(s.nach_farbe.farblos, 1);               // das Land hat keine Farbe
  assert.equal(s.nach_seltenheit.Standardland, 1);
});

const MSGS = [
  { role: "user", text: "Was fehlt mir?" },
  { role: "assistant", text: "Ich schaue nach.", calls: [{ id: "c1", name: "search_cards", args: { q: "elf" } }] },
  { role: "tool", callId: "c1", text: '{"total":1}' },
  { role: "assistant", text: "Fertig." }
];

test("messagesFor: OpenAI-Format mit Werkzeugaufruf und Ergebnis", () => {
  const m = messagesFor("openai", MSGS);
  assert.equal(m[1].tool_calls[0].function.name, "search_cards");
  assert.equal(m[1].tool_calls[0].function.arguments, '{"q":"elf"}');
  assert.deepEqual(m[2], { role: "tool", tool_call_id: "c1", content: '{"total":1}' });
  assert.equal(m[3].content, "Fertig.");
});

test("messagesFor: Anthropic-Format mit Blöcken und zusammengelegten Rollen", () => {
  const m = messagesFor("anthropic", MSGS);
  assert.deepEqual(m[1].content, [{ type: "text", text: "Ich schaue nach." }, { type: "tool_use", id: "c1", name: "search_cards", input: { q: "elf" } }]);
  assert.equal(m[2].role, "user", "Werkzeugergebnisse gehen als Nutzernachricht zurück");
  assert.equal(m[2].content[0].type, "tool_result");
  assert.equal(m.filter((x) => x.role === "user").length, 2, "keine zwei Nutzerblöcke hintereinander ohne Grund");
  for (let i = 1; i < m.length; i++) assert.notEqual(m[i].role, m[i - 1].role, "Rollen wechseln sich ab");
});

test("toolsFor: Schema je Protokoll", () => {
  const t = [{ name: "x", description: "d", parameters: { type: "object", properties: {} } }];
  assert.equal(toolsFor("openai", t)[0].function.name, "x");
  assert.equal(toolsFor("anthropic", t)[0].input_schema.type, "object");
  assert.deepEqual(toolsFor("openai", null), []);
});
