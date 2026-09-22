const test = require("node:test");
const assert = require("node:assert/strict");
const { playedByMe } = require("../src/matches");

test("playedByMe zählt nur meine gelegten Länder und gewirkten Zauber", () => {
  const m = {
    mySeat: 2,
    frames: [
      { ev: [{ k: "land", s: 2, g: 100 }, { k: "cast", s: 1, g: 200 }] },
      { ev: [{ k: "cast", s: 2, g: 300 }, { k: "cast", s: 2, g: 300 }, { k: "draw", s: 2, g: 400 }] },
      { ev: [{ k: "land", s: 2 }] }
    ]
  };
  assert.deepEqual(playedByMe(m), [[100, 1], [300, 2]]);
  assert.deepEqual(playedByMe({ mySeat: 1, frames: [] }), []);
});
