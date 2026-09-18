#!/usr/bin/env node
// Baut den Upload-Ordner für Shared Hosting (FTP): dist/hosting/ = hosting/ (PHP-Website) + web/ + assets/ + static/
// Ausgeschlossen: hosting/data (Datenbank, Geheimnisse) und hosting/config.php (eigene Einstellungen bleiben auf dem Server)
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");
const out = path.join(root, "dist", "hosting");

function copyDir(src, dst, skip = () => false) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (skip(path.relative(root, s).replace(/\\/g, "/"))) continue;
    if (e.isDirectory()) copyDir(s, d, skip); else fs.copyFileSync(s, d);
  }
}
fs.rmSync(out, { recursive: true, force: true });
copyDir(path.join(root, "hosting"), out, (rel) => rel === "hosting/data" || rel === "hosting/config.php" || rel.endsWith(".log"));
copyDir(path.join(root, "web"), path.join(out, "web"), (rel) => rel.endsWith("sw.js"));
copyDir(path.join(root, "assets"), path.join(out, "assets"));
fs.mkdirSync(path.join(out, "static"), { recursive: true });
for (const f of ["site.css", "favicon.ico"]) fs.copyFileSync(path.join(root, "server", "static", f), path.join(out, "static", f));
fs.mkdirSync(path.join(out, "data"), { recursive: true });
fs.writeFileSync(path.join(out, "data", ".htaccess"), "Require all denied\n");
const count = (dir) => fs.readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? count(path.join(dir, e.name)) : 1), 0);
console.log(`Upload-Ordner gebaut: ${out} (${count(out)} Dateien)`);
console.log("Inhalt per FTP in das Web-Verzeichnis (htdocs / public_html) hochladen, dann config.example.php als config.php anpassen.");
