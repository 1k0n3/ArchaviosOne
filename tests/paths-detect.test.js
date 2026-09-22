// Pfaderkennung mit nachgebauten Verzeichnisbäumen (Steam-Deck/Proton, Mac-App-Bundle) – läuft auf jeder Plattform
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const paths = require("../src/paths");

test("Steam Deck: Proton-Präfix mit Player.log wird gewählt", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mtga-deck-"));
  const logDir = path.join(home, ".local", "share", "Steam", "steamapps", "compatdata", "2141910", "pfx", "drive_c", "users", "steamuser", "AppData", "LocalLow", "Wizards Of The Coast", "MTGA");
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, "Player.log"), "Mono path[0] = 'C:/Program Files/Wizards of the Coast/MTGA/MTGA_Data/Managed'\n");
  const picked = paths.pickLogDir(paths.logDirCandidates("linux", home, {}));
  assert.strictEqual(picked, logDir);
  // Windows-Pfad aus dem Proton-Log darf unter Linux nicht als Installationsordner gelten
  assert.strictEqual(paths.installFromLogHead(fs.readFileSync(path.join(logDir, "Player.log"), "utf8"), "linux"), null);
  // dafür der Steam-Ordner aus den Kandidaten
  const inst = path.join(home, ".local", "share", "Steam", "steamapps", "common", "MTGA");
  assert.ok(paths.installDirCandidates("linux", home, {}).includes(inst));
});

test("macOS: Installationsordner und Datenordner „Data“ aus dem Log", () => {
  const r = paths.installFromLogHead("Mono path[0] = '/Applications/MTGA.app/Contents/Resources/Data/Managed'\nMono config path = …", "darwin");
  assert.deepStrictEqual(r, { dir: "/Applications/MTGA.app/Contents/Resources", dataDir: "Data" });
});

test("Windows: MTGA_Data aus dem Log, Schrägstriche werden Backslashes", () => {
  const r = paths.installFromLogHead("Mono path[0] = 'E:/SteamLibrary/steamapps/common/MTGA/MTGA_Data/Managed'", "win32");
  assert.deepStrictEqual(r, { dir: "E:\\SteamLibrary\\steamapps\\common\\MTGA", dataDir: "MTGA_Data" });
});

test("ohne Player.log: erster vorhandener Ordner, sonst erster Kandidat", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mtga-mac-"));
  const c = paths.logDirCandidates("darwin", home, {});
  assert.strictEqual(paths.pickLogDir(c), c[0]);
  fs.mkdirSync(c[0], { recursive: true });
  assert.strictEqual(paths.pickLogDir(c), c[0]);
});
