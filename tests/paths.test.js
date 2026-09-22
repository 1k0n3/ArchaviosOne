const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const paths = require("../src/paths");

test("Log-Ordner je Plattform", () => {
  const win = paths.logDirCandidates("win32", "C:\\Users\\x", {});
  assert.ok(win[0].endsWith(path.join("AppData", "LocalLow", "Wizards Of The Coast", "MTGA")));
  const mac = paths.logDirCandidates("darwin", "/Users/x", {});
  assert.strictEqual(mac[0], path.join("/Users/x", "Library", "Logs", "Wizards Of The Coast", "MTGA"));
  const lin = paths.logDirCandidates("linux", "/home/deck", {});
  assert.ok(lin.some((d) => d.includes(path.join("compatdata", "2141910", "pfx", "drive_c", "users", "steamuser"))), "Steam-Proton-Präfix");
  assert.ok(lin.some((d) => d.includes(".var")), "Flatpak-Steam");
});

test("Umgebungsvariable geht vor", () => {
  assert.strictEqual(paths.logDirCandidates("linux", "/home/x", { MTGA_LOG_DIR: "/tmp/logs" })[0], "/tmp/logs");
  assert.strictEqual(paths.installDirCandidates("darwin", "/Users/x", { MTGA_DIR: "/opt/mtga" })[0], "/opt/mtga");
});

test("Installationsordner je Plattform", () => {
  assert.ok(paths.installDirCandidates("darwin", "/Users/x", {}).includes("/Applications/MTGA.app/Contents/Resources"));
  assert.ok(paths.installDirCandidates("linux", "/home/deck", {}).some((d) => d.endsWith(path.join("steamapps", "common", "MTGA"))));
  assert.ok(paths.installDirCandidates("win32", "C:\\Users\\x", {}).some((d) => d.includes("Wizards of the Coast")));
});

test("Speicher-Scan nur unter Windows", () => {
  assert.strictEqual(paths.memoryScanSupported(), process.platform === "win32");
});
