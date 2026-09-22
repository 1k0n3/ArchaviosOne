#!/usr/bin/env node
// Datenschutz-Sperre: findet persönliche Angaben in allem, was veröffentlicht wird – den Dateien im Git,
// dem Website-Build (dist/hosting) und den noch nicht gepushten Commits (Autor, Committer, Nachricht).
//
// Gesucht wird nach dem Anmeldenamen und dem Heimordner dieses Rechners, der Git-Identität (falls
// eingestellt) und den Begriffen aus "privat": [...] in deploy-config.json. Die Liste bleibt damit auf
// dem Rechner; in keiner öffentlichen Datei steht, wonach gesucht wird.
//
//   node scripts/privat-check.js           Git-Dateien und neue Commits
//   node scripts/privat-check.js --dist    zusätzlich dist/hosting (vor dem Website-Upload)
//   node scripts/privat-check.js --nur-dateien   ohne Commits (Website-Upload hängt nicht am Autor)
//
// scripts/deploy.js ruft die Prüfung vor Upload und Push auf, der pre-push-Hook vor jedem git push.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const root = path.join(__dirname, "..");
const BINAER = /\.(png|jpe?g|gif|ico|webp|woff2?|ttf|otf|zip|gz|tgz|pdf|mp4|webm|db|sqlite)$/i;
const git = (...a) => execFileSync("git", a, { cwd: root, stdio: ["ignore", "pipe", "ignore"], windowsHide: true, maxBuffer: 64 << 20 }).toString();

/** Suchbegriffe: vom Rechner selbst und aus deploy-config.json ("privat") */
function begriffe() {
  const b = new Set();
  const dazu = (s) => { s = String(s || "").trim(); if (s.length >= 4) b.add(s.toLowerCase()); };
  try { const u = os.userInfo().username; if (!/^(user|admin|root|runner|vagrant|ubuntu|deck)$/i.test(u)) dazu(u); } catch (e) { /* ohne Anmeldenamen */ }
  const heim = os.homedir();
  if (heim && heim.length > 4) { dazu(heim); dazu(heim.replace(/\\/g, "/")); dazu(heim.replace(/\\/g, "\\\\")); }
  // Nur die dauerhaft eingestellte Identität: "git -c user.name=…" (neutrale Identität für einen Commit)
  // erbt der Hook über die Umgebung, die darf nicht als privat gelten
  for (const k of ["user.email", "user.name"]) { try { dazu(git("config", "--global", "--get", k)); } catch (e) { /* nicht gesetzt */ } }
  try {
    const c = JSON.parse(fs.readFileSync(path.join(root, "deploy-config.json"), "utf8").replace(/^﻿/, ""));
    for (const s of Array.isArray(c.privat) ? c.privat : []) dazu(s);
  } catch (e) { /* ohne deploy-config.json nur die Angaben des Rechners */ }
  return [...b];
}

function trefferIn(text, liste, wo, out) {
  const klein = text.toLowerCase();
  for (const t of liste) {
    let i = klein.indexOf(t);
    while (i >= 0 && out.length < 200) {
      const zeile = klein.slice(0, i).split("\n").length;
      out.push(`${wo}:${zeile}: …${text.slice(Math.max(0, i - 30), i + t.length + 30).replace(/\s+/g, " ")}…`);
      i = klein.indexOf(t, i + t.length);
    }
  }
}

function dateienPruefen(liste, out) {
  const namen = git("ls-files", "-z").split("\0").filter(Boolean);
  for (const n of namen) {
    trefferIn(n, liste, "(Dateiname) " + n, out);
    if (BINAER.test(n)) continue;
    const p = path.join(root, n);
    let st; try { st = fs.statSync(p); } catch (e) { continue; }   // gelöscht, aber noch nicht committet
    if (!st.isFile() || st.size > 8 << 20) continue;
    trefferIn(fs.readFileSync(p, "utf8"), liste, n, out);
  }
}

function distPruefen(liste, out) {
  const dist = path.join(root, "dist", "hosting");
  if (!fs.existsSync(dist)) return;
  const lauf = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name), rel = "dist/hosting/" + path.relative(dist, p).replace(/\\/g, "/");
      if (e.isDirectory()) { if (rel !== "dist/hosting/data") lauf(p); continue; }
      if (BINAER.test(e.name)) continue;
      const st = fs.statSync(p);
      if (st.size <= 8 << 20) trefferIn(fs.readFileSync(p, "utf8"), liste, rel, out);
    }
  };
  lauf(dist);
}

/** Commits, die noch nicht auf GitHub sind: Autor, Committer und Nachricht */
function commitsPruefen(liste, out) {
  let shas = [];
  try { shas = git("rev-list", "@{u}..HEAD").split("\n").filter(Boolean); }
  catch (e) { return; }   // ohne Upstream gibt es nichts zu vergleichen
  for (const s of shas) trefferIn(git("show", "-s", "--format=%an <%ae> / %cn <%ce>%n%B", s), liste, "Commit " + s.slice(0, 7), out);
}

/** Prüft und liefert die Fundstellen (leer = in Ordnung) */
function pruefen({ dist = false, commits = true } = {}) {
  const liste = begriffe();
  const out = [];
  if (!liste.length) return out;
  dateienPruefen(liste, out);
  if (dist) distPruefen(liste, out);
  if (commits) commitsPruefen(liste, out);
  return out;
}

function melden(treffer) {
  console.error(`Datenschutz-Sperre: ${treffer.length} Fundstelle(n) mit persönlichen Angaben – nichts veröffentlicht.`);
  for (const t of treffer.slice(0, 40)) console.error("  " + t);
  if (treffer.length > 40) console.error("  …");
  console.error("Durch Platzhalter ersetzen (Commits: mit neutraler Identität neu schreiben), dann erneut versuchen.");
}

module.exports = { pruefen, melden, begriffe };

if (require.main === module) {
  const a = process.argv.slice(2);
  const t = pruefen({ dist: a.includes("--dist"), commits: !a.includes("--nur-dateien") });
  if (t.length) { melden(t); process.exit(1); }
  console.log("Datenschutz-Prüfung: keine persönlichen Angaben gefunden.");
}
