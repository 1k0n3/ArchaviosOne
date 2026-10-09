"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawnSync } = require("node:child_process");

// Eigene Einstellungen, eigener Datenordner, nachgebautes GitHub und eigene Website: nichts geht nach draußen
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mtga-update-test-"));
const SHA_NEU = "a".repeat(40);
let url = "";
const tar = process.platform === "win32" && fs.existsSync(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe"))
  ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "tar";

// Archiv wie von GitHub: ein Oberordner mit dem Programm
const quelle = path.join(tmp, "quelle", "repo-" + SHA_NEU);
for (const [f, inhalt] of [["src/watch.js", "// neu"], ["web/neu.html", "<p>neu</p>"], ["watch-config.json", '{"standard":1}'], ["out/darf-nicht.txt", "x"], ["scripts/unix/mtga-stats", "#!/bin/sh"]]) {
  fs.mkdirSync(path.dirname(path.join(quelle, f)), { recursive: true });
  fs.writeFileSync(path.join(quelle, f), inhalt);
}
const tgz = path.join(tmp, "archiv.tar.gz");
const t = spawnSync(tar, ["-czf", tgz, "-C", path.join(tmp, "quelle"), "repo-" + SHA_NEU]);
assert.equal(t.status, 0, String(t.stderr));

const gh = http.createServer((req, res) => {
  if (req.url === "/api/v1/companion") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end('{"repo":"test/repo","branch":"main"}'); }
  if (req.url === "/repos/test/repo/commits/main" && req.headers.accept === "application/vnd.github.sha" && req.headers["user-agent"]) { res.writeHead(200); return res.end(SHA_NEU); }
  if (req.url === "/test/repo/tar.gz/" + SHA_NEU) { res.writeHead(200); return res.end(fs.readFileSync(tgz)); }
  res.writeHead(404); res.end();
});

test.before(() => new Promise((ok) => gh.listen(0, "127.0.0.1", () => {
  url = "http://127.0.0.1:" + gh.address().port;
  fs.writeFileSync(path.join(tmp, "cfg.json"), JSON.stringify({ outDir: path.join(tmp, "out"), syncUrl: url }));
  fs.mkdirSync(path.join(tmp, "out"), { recursive: true });
  process.env.MTGA_STATS_CONFIG = path.join(tmp, "cfg.json");
  process.env.MTGA_STATS_GITHUB_API = url;
  process.env.MTGA_STATS_CODELOAD = url;
  ok();
})));
test.after(() => { gh.close(); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* egal */ } });

test("Neuer Stand wird erkannt – im Entwicklungsordner aber nie eingespielt", async () => {
  const up = require("../src/update");
  const repoRoot = path.join(__dirname, "..");
  const vorher = fs.existsSync(path.join(repoRoot, ".install.json"));
  const s = await up.check();
  assert.equal(s.error, null);
  assert.equal(s.repo, "test/repo");
  assert.equal(s.latest, SHA_NEU);
  assert.equal(s.available, true);
  if (fs.existsSync(path.join(repoRoot, ".git"))) {
    assert.match(s.blocked, /Entwicklungsordner/);
    const r = await up.run({ force: true });
    assert.ok(r.blocked);
    assert.equal(fs.existsSync(path.join(repoRoot, ".install.json")), vorher, "Programmordner unangetastet");
  }
});

test("Einspielen ersetzt Programmdateien, Einstellungen und Daten bleiben", async () => {
  const up = require("../src/update");
  const ziel = path.join(tmp, "programm");
  for (const [f, inhalt] of [["src/watch.js", "// alt"], ["src/eigen.js", "// bleibt"], ["watch-config.json", '{"meins":1}'], ["out/match.json", "{}"], ["deploy-config.json", "{}"], ["scripts/unix/mtga-stats", "#!/bin/sh"], ["scripts/uninstall.ps1", "#"], ["install.sh", "#"]]) {
    fs.mkdirSync(path.dirname(path.join(ziel, f)), { recursive: true });
    fs.writeFileSync(path.join(ziel, f), inhalt);
  }
  assert.equal(up.blocker(ziel), null);
  const log = [];
  await up.applyWindows({ repo: "test/repo", latest: SHA_NEU }, (m) => log.push(m), ziel);
  assert.equal(fs.readFileSync(path.join(ziel, "src", "watch.js"), "utf8"), "// neu");
  assert.equal(fs.readFileSync(path.join(ziel, "web", "neu.html"), "utf8"), "<p>neu</p>");
  assert.equal(fs.readFileSync(path.join(ziel, "watch-config.json"), "utf8"), '{"meins":1}', "eigene Einstellungen bleiben");
  assert.equal(fs.readFileSync(path.join(ziel, "src", "eigen.js"), "utf8"), "// bleibt");
  assert.ok(!fs.existsSync(path.join(ziel, "out", "darf-nicht.txt")), "out/ wird nie angefasst");
  assert.ok(fs.existsSync(path.join(ziel, "out", "match.json")));
  assert.equal(JSON.parse(fs.readFileSync(path.join(ziel, ".install.json"), "utf8")).sha, SHA_NEU);
  assert.match(log.join("\n"), /Dateien ersetzt/);
});

test("Gesperrt, wenn der Ordner ein Git-Arbeitsordner ist", () => {
  const up = require("../src/update");
  const d = fs.mkdtempSync(path.join(tmp, "git-"));
  fs.mkdirSync(path.join(d, ".git"));
  assert.match(up.blocker(d), /Entwicklungsordner/);
});

test("Einstellung „Automatisch aktualisieren“ ist da und standardmäßig an", () => {
  const settings = require("../src/settings");
  assert.ok(settings.FIELDS.some((f) => f.key === "autoUpdate" && f.type === "bool"));
  assert.equal(settings.current().autoUpdate, true);
  const r = settings.apply({ autoUpdate: false });
  assert.equal(r.changed.autoUpdate, false);
  assert.equal(require("../src/update").status().enabled, false);
});
