#!/usr/bin/env node
// Website-Upload: hält die Online-Version (Shared Hosting, FTP) auf dem Stand der lokalen Version.
//
//   node scripts/deploy.js              baut dist/hosting neu und lädt nur geänderte Dateien hoch
//   node scripts/deploy.js check        nur vergleichen (lokaler Build ↔ Server-Manifest ↔ /healthz), nichts ändern
//   node scripts/deploy.js --all        alle Dateien hochladen (Manifest auf dem Server ignorieren)
//   node scripts/deploy.js install-hook Git-Hook anlegen: nach jedem Commit automatisch hochladen
//
// Zugangsdaten stehen in deploy-config.json (Vorlage: deploy-config.example.json, nicht im Git).
// Übertragen wird mit curl.exe (in Windows enthalten), verschlüsselt per FTPS (AUTH TLS). Auf dem Server
// liegt data/deploy-manifest.json mit den Prüfsummen der zuletzt hochgeladenen Dateien; nur Abweichungen
// werden übertragen, aus dem Manifest verschwundene Dateien gelöscht. config.php und data/ bleiben unangetastet.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync, execFileSync } = require("child_process");

const root = path.join(__dirname, "..");
const dist = path.join(root, "dist", "hosting");
const configFile = path.join(root, "deploy-config.json");
const MANIFEST = "data/deploy-manifest.json";
const BATCH = 25;                                      // Dateien pro curl-Aufruf

const args = process.argv.slice(2);
const cmd = args.find((a) => !a.startsWith("--")) || "upload";
const flag = (n) => args.includes("--" + n);

function readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, "")); }
const cfgHas = (k) => { try { return !!readJson(configFile)[k]; } catch (e) { return false; } };
/** Optional: nach erfolgreichem Upload auch zu GitHub pushen ("pushGit": true in deploy-config.json) */
function pushGit() {
  try {
    const out = execFileSync("git", ["push", "-q", "origin", "HEAD"], { cwd: root, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }).toString().trim();
    console.log("GitHub: gepusht" + (out ? " (" + out + ")" : ""));
  } catch (e) { console.log("GitHub-Push fehlgeschlagen: " + ((e.stderr || "").toString().trim() || e.message).split("\n")[0]); }
}
function loadConfig() {
  if (!fs.existsSync(configFile)) {
    if (flag("quiet-if-unconfigured")) process.exit(0);
    console.log("deploy-config.json fehlt. Vorlage kopieren und FTP-Zugangsdaten eintragen:\n  copy deploy-config.example.json deploy-config.json");
    process.exit(2);
  }
  const c = readJson(configFile);
  for (const k of ["host", "user", "password"]) if (!c[k]) { console.error(`deploy-config.json: "${k}" fehlt`); process.exit(2); }
  if (!c.url) { try { c.url = readJson(path.join(root, "watch-config.json")).syncUrl || ""; } catch (e) { /* ohne Website-Adresse keine Prüfung */ } }
  c.url = String(c.url || "").replace(/\/$/, "");
  c.remoteDir = String(c.remoteDir == null ? "" : c.remoteDir).replace(/\\/g, "/").replace(/\/+$/, "");
  if (c.tls == null) c.tls = true;
  if (c.tlsVerify == null) c.tlsVerify = true;
  return c;
}

// ---- lokaler Build und Manifest ------------------------------------------------------------------
function build() {
  const r = spawnSync(process.execPath, [path.join(__dirname, "build-hosting.js")], { cwd: root, encoding: "utf8", windowsHide: true });
  if (r.status !== 0) { console.error("Build fehlgeschlagen:\n" + (r.stdout || "") + (r.stderr || "")); process.exit(1); }
}
function sha1(file) { return crypto.createHash("sha1").update(fs.readFileSync(file)).digest("hex"); }
function localManifest() {
  const files = {};
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f); else files[path.relative(dist, f).replace(/\\/g, "/")] = sha1(f);
    }
  };
  walk(dist);
  return files;
}
function localVersion() {
  try { const t = fs.readFileSync(path.join(dist, "app", "version.php"), "utf8"); return { commit: (t.match(/'commit' => '([^']*)'/) || [])[1] || "", build: (t.match(/'build' => '([^']*)'/) || [])[1] || "" }; }
  catch (e) { return { commit: "", build: "" }; }
}
// Nie anfassen: eigene Konfiguration und Daten auf dem Server (data/.htaccess darf mit, schützt den Ordner)
const protectedPath = (rel) => rel === "config.php" || (rel.startsWith("data/") && rel !== "data/.htaccess");

// ---- FTP über curl ------------------------------------------------------------------------------------
let cfg;
const q = (s) => '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
function ftpUrl(rel) {
  // Pfad relativ zum FTP-Anmeldeverzeichnis; führender Schrägstrich = absoluter Pfad (%2F)
  let dir = cfg.remoteDir;
  const abs = dir.startsWith("/"); if (abs) dir = dir.slice(1);
  const parts = [...dir.split("/"), ...rel.split("/")].filter(Boolean).map(encodeURIComponent);
  return `${cfg.tls === "implicit" ? "ftps" : "ftp"}://${cfg.host}${cfg.port ? ":" + cfg.port : ""}/${abs ? "%2F" : ""}${parts.join("/")}`;
}
function baseLines() {
  const l = ["silent", "show-error", "connect-timeout = 30", "max-time = 600", `user = ${q(cfg.user + ":" + cfg.password)}`, "ftp-create-dirs", "disable-epsv"];
  if (cfg.tls === true) l.push("ssl-reqd");
  if (cfg.tls && cfg.tlsVerify === false) l.push("insecure");
  return l;
}
function curl(requests) {
  // requests: Liste von Zeilengruppen; jede Gruppe ist eine Übertragung (durch "next" getrennt)
  const conf = requests.map((r) => [...baseLines(), ...r].join("\n")).join("\nnext\n") + "\n";
  const r = spawnSync("curl.exe", ["-K", "-"], { input: conf, encoding: "utf8", windowsHide: true });
  if (r.error) { console.error("curl.exe nicht gefunden – Windows 10 1803 oder neuer nötig."); process.exit(1); }
  return { code: r.status, err: (r.stderr || "").trim(), out: r.stdout || "" };
}
function explain(code, err) {
  const hints = { 6: "Hostname nicht auflösbar", 7: "keine Verbindung zum FTP-Server (Host/Port/Firewall)", 35: "TLS-Handshake fehlgeschlagen – tls auf false setzen, falls der Hoster kein FTPS bietet", 60: "Zertifikat nicht vertrauenswürdig – tlsVerify auf false setzen", 67: "Anmeldung abgelehnt (Benutzer/Passwort)", 9: "Zugriff auf den Pfad verweigert (remoteDir prüfen)", 25: "Upload abgelehnt (Schreibrechte/remoteDir prüfen)" };
  return (hints[code] ? hints[code] + " · " : "") + err;
}
function remoteManifest() {
  const tmp = path.join(require("os").tmpdir(), "mtga-deploy-manifest.json");
  try { fs.unlinkSync(tmp); } catch (e) { /* nicht vorhanden */ }
  const r = curl([[`url = ${q(ftpUrl(MANIFEST))}`, `output = ${q(tmp.replace(/\\/g, "/"))}`]]);
  if (r.code === 0) { try { return readJson(tmp); } catch (e) { return null; } }
  if (r.code === 78 || r.code === 19) return null;                    // Datei fehlt: erster Upload
  console.error("FTP-Fehler " + r.code + ": " + explain(r.code, r.err)); process.exit(1);
}
function upload(files) {
  for (let i = 0; i < files.length; i += BATCH) {
    const chunk = files.slice(i, i + BATCH);
    const r = curl(chunk.map((rel) => [`url = ${q(ftpUrl(rel))}`, `upload-file = ${q(path.join(dist, rel).replace(/\\/g, "/"))}`]));
    if (r.code !== 0) { console.error(`Upload fehlgeschlagen bei "${chunk[0]}" … (curl ${r.code}): ${explain(r.code, r.err)}`); process.exit(1); }
    process.stdout.write(`  ${Math.min(i + BATCH, files.length)}/${files.length} Dateien hochgeladen\r`);
  }
  if (files.length) console.log("");
}
function remove(files) {
  // DELE-Befehle vor einer harmlosen Verzeichnisliste; fehlende Dateien gelten als gelöscht
  for (const rel of files) {
    const r = curl([[`url = ${q(ftpUrl("") + "/")}`, "list-only", `quote = ${q("DELE " + (cfg.remoteDir ? cfg.remoteDir.replace(/^\//, "/") + "/" : "") + rel)}`, `output = ${q(path.join(require("os").tmpdir(), "mtga-deploy-list.txt").replace(/\\/g, "/"))}`]]);
    if (r.code !== 0 && r.code !== 21) console.log(`  Hinweis: "${rel}" konnte nicht gelöscht werden (${r.err})`);
  }
}
function putManifest(manifest) {
  const tmp = path.join(require("os").tmpdir(), "mtga-deploy-manifest-up.json");
  fs.writeFileSync(tmp, JSON.stringify(manifest));
  const r = curl([[`url = ${q(ftpUrl(MANIFEST))}`, `upload-file = ${q(tmp.replace(/\\/g, "/"))}`]]);
  if (r.code !== 0) console.log("  Hinweis: Manifest konnte nicht gespeichert werden (" + explain(r.code, r.err) + ") – nächster Lauf lädt alles erneut.");
}

// ---- Kontrolle über die Website -------------------------------------------------------------------
async function onlineVersion() {
  if (!cfg.url) return null;
  try {
    const r = await fetch(cfg.url + "/healthz?t=" + Date.now(), { signal: AbortSignal.timeout(20000), headers: { "cache-control": "no-cache" } });
    const j = await r.json();
    return j.version || { commit: "", build: "" };
  } catch (e) { return { error: e.message }; }
}
const fmtVersion = (v) => v ? (v.commit ? v.commit : "ohne Stempel") + (v.build ? " vom " + v.build.slice(0, 16).replace("T", " ") : "") : "unbekannt";

// ---- Befehle ------------------------------------------------------------------------------------------
function diff(local, remote) {
  const changed = Object.keys(local).filter((f) => !protectedPath(f) && (!remote || remote.files[f] !== local[f])).sort();
  const removed = remote ? Object.keys(remote.files).filter((f) => !(f in local) && !protectedPath(f)).sort() : [];
  return { changed, removed };
}
function installHook() {
  const hooks = path.join(root, ".git", "hooks");
  if (!fs.existsSync(hooks)) { console.error("Kein Git-Repository (.git/hooks fehlt)."); process.exit(1); }
  const hook = path.join(hooks, "post-commit");
  const marker = "# mtga-stats deploy";
  const p = (f) => path.join(root, f).replace(/\\/g, "/");
  const block = [
    marker,
    `node "${p("src/webgen.js")}" >/dev/null 2>&1 || echo "Dashboard-Neuaufbau fehlgeschlagen (node src/webgen.js)"`,     // lokales Dashboard auf den neuen Stand
    `node "${p("scripts/deploy.js")}" --quiet-if-unconfigured || echo "Website-Upload fehlgeschlagen (node scripts/deploy.js)"`,
    `git diff --quiet HEAD~1 HEAD -- src scripts/tray.ps1 2>/dev/null || echo "Hinweis: Companion-Code geändert – Watcher über das Tray-Menü neu starten (stoppen/starten)"`,
    ""
  ].join("\n");
  let body = fs.existsSync(hook) ? fs.readFileSync(hook, "utf8") : "#!/bin/sh\n";
  // vorhandenen Block ersetzen (Zeilen des Markers und unsere Befehle), sonst anhängen
  body = body.split("\n").filter((l) => !(l.includes(marker) || /deploy\.js|webgen\.js|Watcher über das Tray/.test(l))).join("\n");
  fs.writeFileSync(hook, body.replace(/\s*$/, "\n") + block);
  console.log("Git-Hook eingerichtet: " + hook + "\nNach jedem Commit: Dashboard neu bauen, Website hochladen (sobald deploy-config.json existiert)" + (cfgHas("pushGit") ? ", git push" : "") + ".");
}

async function main() {
  if (cmd === "install-hook") return installHook();
  cfg = loadConfig();
  build();
  const local = localManifest();
  const version = localVersion();
  const remote = flag("all") ? null : remoteManifest();
  const { changed, removed } = diff(local, remote);
  const online = await onlineVersion();

  if (cmd === "check") {
    console.log(`Lokal:  ${fmtVersion(version)} (${Object.keys(local).length} Dateien)`);
    console.log(`Server: ${remote ? fmtVersion(remote.version) + " laut Manifest" : "kein Manifest (noch nie per Skript hochgeladen)"}`);
    if (online) console.log(`Online: ${online.error ? "nicht erreichbar (" + online.error + ")" : fmtVersion(online)}${cfg.url ? " – " + cfg.url : ""}`);
    if (!changed.length && !removed.length) console.log("Website ist auf dem Stand der lokalen Version.");
    else {
      console.log(`${changed.length} Datei(en) zu übertragen, ${removed.length} zu löschen:`);
      for (const f of [...changed.map((f) => "  + " + f), ...removed.map((f) => "  - " + f)].slice(0, 40)) console.log(f);
      if (changed.length + removed.length > 40) console.log("  …");
    }
    return;
  }

  if (flag("dry-run")) { console.log(`Würde ${changed.length} Datei(en) hochladen und ${removed.length} löschen.`); return; }
  if (changed.length || removed.length) {
    console.log(`Übertrage ${changed.length} Datei(en)${removed.length ? `, lösche ${removed.length}` : ""} nach ${cfg.host}${cfg.remoteDir ? "/" + cfg.remoteDir.replace(/^\//, "") : ""} …`);
    upload(changed);
    remove(removed);
    // config.example.php / data/.htaccess & Co. sind im Manifest; geschützte Pfade werden nie geführt
    const manifest = { version, uploadedAt: new Date().toISOString(), files: Object.fromEntries(Object.entries(local).filter(([f]) => !protectedPath(f))) };
    putManifest(manifest);
  } else console.log("Keine Änderungen – Server hat bereits alle Dateien.");

  // Nach dem Upload prüfen, ob die Website den neuen Stand ausliefert
  const after = (changed.length || removed.length) ? await onlineVersion() : online;
  if (!after) console.log(`Website-Stand: ${fmtVersion(version)} (keine Website-Adresse zum Prüfen – "url" in deploy-config.json oder syncUrl setzen)`);
  else if (after.error) console.log(`Website nicht erreichbar: ${after.error}`);
  else if (after.commit && version.commit && after.commit !== version.commit) { console.log(`ACHTUNG: Website meldet ${fmtVersion(after)}, lokal ist ${fmtVersion(version)} – Upload prüfen (remoteDir richtig?).`); process.exitCode = 1; }
  else console.log(`Website aktuell: ${fmtVersion(after)}${changed.length ? ` (${changed.length} Datei(en) übertragen)` : ""}`);
  if (cfg.pushGit && !process.exitCode) pushGit();
}
main().catch((e) => { console.error(e.message); process.exit(1); });
