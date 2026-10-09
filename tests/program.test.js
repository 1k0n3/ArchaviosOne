"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const { spawnSync } = require("node:child_process");

// Eigene Einstellungen: Datenordner liegt im nachgebauten Programmordner
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mtga-program-"));
process.env.MTGA_STATS_CONFIG = path.join(tmp, "cfg.json");
const program = require("../src/program");
test.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* egal */ } });

/** Nachgebauter Programmordner; die echten Abläufe hinterlassen nur eine Markierung */
function fakeRoot(name) {
  const r = path.join(tmp, name);
  const files = {
    "src/watch.js": "// watcher", "web/index.html": "<p>", "watch-config.json": '{"meins":1}', "out/matches/m1.json": "{}",
    "scripts/uninstall.ps1": 'param([switch]$Data)\nSet-Content -LiteralPath (Join-Path $PSScriptRoot "..\\out\\uninstall-lief.txt") -Value ("Data=" + $Data)\n',
    "install.sh": 'echo "uninstall $*" > "$(dirname "$0")/out/uninstall-lief.txt"\n', "scripts/unix/mtga-stats": "#!/bin/sh\n"
  };
  for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(r, f)), { recursive: true }); fs.writeFileSync(path.join(r, f), c); }
  fs.writeFileSync(process.env.MTGA_STATS_CONFIG, JSON.stringify({ outDir: path.join(r, "out") }));
  return r;
}
/** Den erzeugten Ablauf direkt (und wartend) ausführen statt losgelöst */
function ausfuehren(r) {
  const [cmd, args] = process.platform === "win32" ? ["powershell", r.args] : ["bash", r.args];
  const p = spawnSync(cmd, args.filter((x) => x !== "-WindowStyle" && x !== "Hidden"), { encoding: "utf8", timeout: 60000 });
  assert.equal(p.status, 0, p.stdout + p.stderr);
  return p.stdout;
}

test("Installationsart: Entwicklungsordner, Programmordner, Flatpak, Homebrew", () => {
  const d = fakeRoot("art");
  assert.equal(program.kindOf(d), process.platform === "win32" ? "windows" : process.platform === "darwin" ? "mac" : "linux");
  fs.mkdirSync(path.join(d, ".git"));
  assert.equal(program.kindOf(d), "dev");
  assert.match(program.updateBlocker(d), /Entwicklungsordner/);
  const ui = program.uninstallInfo(d);
  assert.equal(ui.can, false);
  assert.match(ui.hint, /Entwicklungsordner/);
  assert.equal(program.kindOf("/app/share/mtga-stats"), "flatpak");
  assert.match(program.uninstallInfo("/app/share/mtga-stats").command, /^flatpak uninstall /);
  assert.equal(program.kindOf("/opt/homebrew/Cellar/mtga-stats/1.5.0/libexec"), "brew");
  assert.match(program.uninstallInfo("/opt/homebrew/Cellar/mtga-stats/1.5.0/libexec").command, /brew uninstall mtga-stats/);
});

test("Datenordner wird nur gelöscht, wenn er eindeutig zu MTGA Stats gehört", () => {
  const r = path.join(tmp, "x");
  assert.equal(program.dataDirSafe(path.join(r, "out"), r), true);
  assert.equal(program.dataDirSafe(path.join(os.homedir(), ".local", "share", "mtga-stats"), r), true);
  assert.equal(program.dataDirSafe(os.homedir(), r), false);
  assert.equal(program.dataDirSafe(r, r), false);
  assert.equal(program.dataDirSafe(path.join(os.homedir(), "Dokumente"), r), false);
});

test("Deinstallieren ohne Daten: Programm weg, Daten und Einstellungen bleiben", () => {
  const r = fakeRoot("ohne-daten");
  const u = program.uninstall({ root: r, data: false, dryRun: true });
  assert.equal(u.dataDeleted, false);
  ausfuehren(u);
  assert.ok(!fs.existsSync(path.join(r, "src")), "Programmdateien entfernt");
  assert.ok(!fs.existsSync(path.join(r, "web")));
  assert.ok(fs.existsSync(path.join(r, "out", "matches", "m1.json")), "Daten bleiben");
  assert.equal(fs.readFileSync(path.join(r, "watch-config.json"), "utf8"), '{"meins":1}', "Einstellungen bleiben");
  const lief = fs.readFileSync(path.join(r, "out", "uninstall-lief.txt"), "utf8");
  assert.match(lief, process.platform === "win32" ? /Data=False/ : /uninstall --uninstall/, "der plattformeigene Ablauf lief");
  assert.ok(!fs.existsSync(u.script), "Ablauf räumt sich selbst weg");
});

test("Deinstallieren mit Daten: alles weg", () => {
  const r = fakeRoot("mit-daten");
  const u = program.uninstall({ root: r, data: true, dryRun: true });
  assert.equal(u.dataDeleted, true);
  ausfuehren(u);
  assert.ok(!fs.existsSync(r), "Programmordner samt Daten entfernt");
});

test("Endpunkt: ohne Bestätigung nichts, im Entwicklungsordner gesperrt", async () => {
  const settings = require("../src/settings");
  const call = (pfad, method, body) => new Promise((ok) => {
    const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
    req.method = method; req.headers = { "content-type": "application/json" };
    const res = { code: 0, writeHead(c) { this.code = c; }, end(b) { ok({ code: this.code, json: JSON.parse(String(b)) }); } };
    settings.handle(req, res, new URL("http://localhost" + pfad), 8765);
  });
  let r = await call("/api/uninstall/run", "POST", { data: true });
  assert.equal(r.code, 400);
  assert.match(r.json.error, /Bestätigung/);
  r = await call("/api/uninstall/info", "GET");
  assert.equal(r.code, 200);
  assert.ok(r.json.kind);
  if (fs.existsSync(path.join(__dirname, "..", ".git"))) {
    r = await call("/api/uninstall/run", "POST", { confirm: "entfernen", data: false });
    assert.equal(r.code, 409, "der echte Entwicklungsordner wird nie deinstalliert");
    assert.match(r.json.error, /Entwicklungsordner/);
  }
});
