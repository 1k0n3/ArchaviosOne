"use strict";
process.env.MTGA_NO_MIRROR = "1";   // nie zur echten Website spiegeln
const test = require("node:test");
const assert = require("node:assert");
const { messagesFor } = require("../src/assistant");
const { ohneSignatur } = require("../src/assistant")._test;

test("Zusatzangaben eines Werkzeugaufrufs gehen unverändert zurück", () => {
  const sig = { extra_content: { google: { thought_signature: "AbC123" } } };
  const out = messagesFor("openai", [
    { role: "user", text: "Was fehlt?" },
    { role: "assistant", text: "", calls: [{ id: "c1", name: "deck_details", args: { id: 7 }, extra: sig }] },
    { role: "tool", callId: "c1", text: "{}" }
  ]);
  const a = out.find((m) => m.role === "assistant");
  assert.ok(a, "die Antwort mit dem Werkzeugaufruf fehlt");
  assert.equal(a.tool_calls.length, 1);
  assert.deepEqual(a.tool_calls[0].extra_content, sig.extra_content, "die Signatur muss mitgehen");
  assert.equal(a.tool_calls[0].function.name, "deck_details");
});

test("Ohne Zusatzangaben bleibt der Aufruf schlank", () => {
  const out = messagesFor("openai", [
    { role: "assistant", text: "", calls: [{ id: "c1", name: "my_decks", args: {} }] }
  ]);
  const a = out.find((m) => m.role === "assistant");
  assert.deepEqual(Object.keys(a.tool_calls[0]).sort(), ["function", "id", "type"]);
});

test("Runden ohne Signatur werden zu Text, damit Gemini sie annimmt", () => {
  const msgs = ohneSignatur([
    { role: "user", text: "Was fehlt?" },
    { role: "assistant", text: "Ich schaue nach.", calls: [{ id: "c1", name: "deck_details", args: {} }] },
    { role: "tool", callId: "c1", text: "{\"karten\":60}" },
    { role: "assistant", text: "Es fehlen Länder." }
  ]);
  assert.equal(msgs.length, 4);
  assert.equal(msgs[1].role, "assistant");
  assert.ok(!msgs[1].calls, "der Aufruf ohne Signatur darf nicht mehr als Aufruf gelten");
  assert.match(msgs[1].text, /deck_details/);
  assert.equal(msgs[2].role, "user", "das Ergebnis wird zur Nachricht des Benutzers");
  assert.match(msgs[2].text, /karten/);
});

test("Runden mit Signatur bleiben unangetastet", () => {
  const sig = { extra_content: { google: { thought_signature: "AbC123" } } };
  const ein = [
    { role: "assistant", text: "", calls: [{ id: "c1", name: "my_decks", args: {}, extra: sig }] },
    { role: "tool", callId: "c1", text: "[]" }
  ];
  const aus = ohneSignatur(ein);
  assert.equal(aus[0].calls.length, 1);
  assert.equal(aus[1].role, "tool");
});
