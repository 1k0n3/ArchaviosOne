const test = require("node:test");
const assert = require("node:assert/strict");
const lib = require("../src/lib");

test("diffSnapshots erkennt neue, geänderte und entfernte Drucke", () => {
  const a = new Map([[1, 4], [2, 1], [3, 2]]);
  const b = new Map([[1, 4], [2, 3], [4, 1]]);
  assert.deepEqual(lib.diffSnapshots(a, b), [
    { grpId: 2, before: 1, after: 3, delta: 2 },
    { grpId: 3, before: 2, after: 0, delta: -2 },
    { grpId: 4, before: 0, after: 1, delta: 1 }
  ]);
});

test("csvLine quotet Werte und verdoppelt Anführungszeichen", () => {
  assert.equal(lib.csvLine(["a", 'b "c"', 3, null]), '"a";"b ""c""";"3";""');
});

test("totalCards summiert Mengen", () => {
  assert.equal(lib.totalCards(new Map([[1, 4], [2, 2]])), 6);
});

test("toRows sortiert nach Name, Set und Nummer", () => {
  const cards = new Map([
    [10, { GrpId: 10, Name: "Forest", ExpansionCode: "FDN", CollectorNumber: "10", Rarity: 1, IsRebalanced: 0 }],
    [11, { GrpId: 11, Name: "Forest", ExpansionCode: "FDN", CollectorNumber: "2", Rarity: 1, IsRebalanced: 0 }],
    [12, { GrpId: 12, Name: "Bear", ExpansionCode: "KHM", CollectorNumber: "1", Rarity: 2, IsRebalanced: 1 }]
  ]);
  const rows = lib.toRows(new Map([[10, 4], [11, 1], [12, 2]]), cards);
  assert.deepEqual(rows.map((r) => [r.name, r.collectorNumber, r.quantity, r.rarity, r.isRebalanced]), [["Bear", "1", 2, "Common", true], ["Forest", "2", 1, "Standardland", false], ["Forest", "10", 4, "Standardland", false]]);
});
