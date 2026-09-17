const test = require("node:test");
const assert = require("node:assert/strict");
const unity = require("../src/unity");
const { decodeBC7 } = require("../src/bc7");

test("LZ4-Block: Literale und Rückverweis", () => {
  // Token 0x35: 3 Literale, Match-Länge 5+4 = 9; Offset 3 -> "abc" + 9× Wiederholung
  const src = Buffer.from([0x35, 0x61, 0x62, 0x63, 0x03, 0x00]);
  assert.equal(unity.lz4Decompress(src, 12).toString("ascii"), "abcabcabcabc");
});

test("LZ4-Block: nur Literale am Ende", () => {
  const src = Buffer.from([0x40, 0x77, 0x78, 0x79, 0x7a]);
  assert.equal(unity.lz4Decompress(src, 4).toString("ascii"), "wxyz");
});

test("BC7: Modus 6 mit gleichen Endpunkten ergibt einfarbigen Block", () => {
  // Modus 6: 1 Subset, 7-Bit-Farben + 7-Bit-Alpha, ein P-Bit je Endpunkt, 4-Bit-Indizes.
  // Bitfolge: 0000001 (Modus 6), dann R0 R1 G0 G1 B0 B1 A0 A1 je 7 Bit, 2 P-Bits, Indizes.
  const bits = [];
  const push = (v, n) => { for (let i = 0; i < n; i++) bits.push((v >> i) & 1); };
  push(0b1000000, 7);          // Modus 6 (sechs Nullen, dann eine Eins)
  push(0x7f, 7); push(0x7f, 7); // R0, R1 = 127 -> mit P-Bit 1 -> 255
  push(0, 7); push(0, 7);       // G = 0
  push(0x7f, 7); push(0x7f, 7); // B = 255
  push(0x7f, 7); push(0x7f, 7); // A = 255
  push(0, 1); push(0, 1);       // P-Bits 0: 127 -> 254, 0 -> 0
  push(0, 3); for (let i = 1; i < 16; i++) push(0, 4); // Indizes (Anker 3 Bit)
  const data = Buffer.alloc(16);
  bits.forEach((b, i) => { if (b) data[i >> 3] |= 1 << (i & 7); });
  const rgba = decodeBC7(data, 4, 4);
  for (let i = 0; i < 16; i++) assert.deepEqual([rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2], rgba[i * 4 + 3]], [254, 0, 254, 254]);
});

test("toPng erzeugt eine gültige PNG-Signatur", () => {
  const png = unity.toPng(Buffer.alloc(16, 255), 2, 2, false, true);
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
});
