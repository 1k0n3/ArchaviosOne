# Website auf normalem Webhosting (FTP, PHP) einrichten

Diese Variante braucht **keinen SSH-Zugang und kein Node.js** – nur PHP 8.1+ (mit `pdo_sqlite` oder MySQL, `curl`, `mbstring`) und Apache mit `mod_rewrite`, was praktisch jedes Webhosting-Paket bietet. Alles läuft über `index.php`; die Datenbank ist eine SQLite-Datei in `data/` (oder MySQL).

## 1. Upload-Ordner bauen (am PC)

```bash
node scripts/build-hosting.js
```

Das erzeugt `dist/hosting/` mit allem, was auf den Server muss:

```
dist/hosting/
├── index.php, cron.php, .htaccess, config.example.php
├── app/        PHP-Code und Migrationen
├── web/        gemeinsames Frontend (Dashboard, Decks, Replay, Sprachen)
├── assets/     Icons
├── static/     site.css, favicon
└── data/       leer (hier entstehen Datenbank und Protokolle)
```

**Nicht** hochladen: `out/`, `src/`, `scripts/`, `server/`, `node_modules/` – die gehören zum Companion auf dem PC.

## 2. Per FTP hochladen

Mit FileZilla (oder WinSCP) den **Inhalt** von `dist/hosting/` in das Web-Verzeichnis der Domain laden (heißt je nach Hoster `htdocs`, `public_html`, `www` oder `html`). Die Datei `.htaccess` muss mit – in FileZilla ggf. „Server → Versteckte Dateien anzeigen“ aktivieren.

Wenn die Website in einem **Unterordner** laufen soll (z. B. `https://deine-domain.de/mtga/`), einfach dorthin hochladen; die App erkennt das Präfix selbst.

## 3. Konfigurieren

Auf dem Server `config.example.php` in `config.php` umbenennen (oder lokal kopieren, anpassen, hochladen) und mindestens diese Werte setzen:

| Einstellung | Wert |
|---|---|
| `base_url` | `https://deine-domain.de` (ohne Schrägstrich am Ende; bei Unterordner mit `/mtga`) |
| `mail.mode` | `mail` (PHP-Mailversand des Hosters) oder `smtp` mit den SMTP-Daten deines Postfachs |
| `mail.from` | Absender, z. B. `MTGA Stats <no-reply@deine-domain.de>` |
| `cron_key` | irgendein langes Zufallswort (schützt den Kartensync-Aufruf) |
| `github_repo` | `dein-name/mtga-stats` für den Download-Button (oder `download_url`) |
| `db.driver` | `sqlite` (Standard, nichts einzurichten) oder `mysql` mit den Zugangsdaten aus dem Hosting-Panel |

Danach `https://deine-domain.de/` aufrufen: beim ersten Aufruf werden die Tabellen angelegt. `https://deine-domain.de/healthz` muss `{"ok":true,"cards":0}` liefern.

## 4. Kartendaten laden (einmalig, dann täglich)

Die ~20.000 Arena-Karten kommen von Scryfall, in Häppchen von 25 Sekunden (Shared Hosting begrenzt die Laufzeit). Im Hosting-Panel einen **Cronjob** anlegen, alle 5 Minuten:

- als URL-Aufruf: `https://deine-domain.de/cron?key=DEIN-CRON-KEY`
- oder als Befehl: `php /pfad/zum/webverzeichnis/cron.php`

Ohne Cron geht es auch: die Adresse `https://deine-domain.de/cron?key=…` 8–10 Mal im Browser aufrufen (jeder Aufruf meldet den Fortschritt), fertig ist „Kartendaten aktualisiert: 20043 Arena-Karten“. Fehlende Karten holt die Seite außerdem bei Bedarf einzeln nach; Bilder werden nie gespeichert, sondern zu Scryfall weitergeleitet.

## 5. Erstes Konto und Companion verbinden

1. `https://deine-domain.de/register` → Konto anlegen; Bestätigungslink aus der E-Mail klicken. Kommt keine Mail an: der Link steht immer in `data/app.log` (per FTP lesbar). Dauerhaft entweder `mail.mode` auf `smtp` mit den Daten eines Postfachs stellen – oder `'verify_email' => false` in `config.php`, dann ist ein Konto sofort ohne Bestätigung nutzbar.
2. Einstellungen → „Code erzeugen“.
3. Am PC: Tray-Menü → **Mit Website verbinden…** → Adresse `https://deine-domain.de` und den Code eingeben.

Danach synchronisiert der Companion nach jedem Match, bei Deck-Änderungen und alle 5 Minuten; offline wird gesammelt und später nachgeschickt.

## 6. Updates einspielen – automatisch per Skript

Damit Online-Version und lokale Version immer gleich sind, lädt `scripts/deploy.js` per FTP hoch – nur die Dateien, die sich geändert haben. Einmalig einrichten:

1. `deploy-config.example.json` als `deploy-config.json` kopieren (bleibt lokal, nicht im Git) und eintragen: `host`, `user`, `password` aus dem Hosting-Panel, `remoteDir` (Web-Verzeichnis relativ zum FTP-Anmeldeordner, z. B. `public_html`; leer lassen, wenn der FTP-Zugang direkt dort landet) und `url` der Website.
2. Testen:

```bash
npm run deploy:check
```

zeigt lokalen Stand, Server-Stand und die Dateien, die sich unterscheiden – ohne etwas zu ändern. Dann:

```bash
npm run deploy
```

baut `dist/hosting/` neu, überträgt die Unterschiede (verschlüsselt per FTPS; `"tls": false`, falls der Hoster kein FTPS bietet, `"tlsVerify": false` bei Zertifikatsfehlern), löscht nicht mehr vorhandene Dateien und prüft danach über `/healthz`, ob die Website den neuen Stand meldet. `config.php` und `data/` werden nie angefasst; neue Migrationen laufen beim nächsten Aufruf automatisch. Den Stand der Website sieht man auch in den Einstellungen unter „Companion verbinden“ (Website-Stand) und unter `/healthz`.

Dasselbe gibt es im Tray-Menü als **Website hochladen (FTP)** – der Eintrag erscheint, sobald `deploy-config.json` existiert. Wer mit Git arbeitet, lässt es ganz automatisch laufen:

```bash
node scripts/deploy.js install-hook
```

legt einen `post-commit`-Hook an: nach jedem Commit wird das lokale Dashboard neu gebaut, die Website hochgeladen und – mit `"pushGit": true` in `deploy-config.json` – auch zu GitHub gepusht. So sind Desktop-App, Website und GitHub nach jedem Commit auf demselben Stand; hat sich Companion-Code (`src/`) geändert, erinnert der Hook daran, den Watcher über das Tray-Menü neu zu starten. `node scripts/deploy.js --all` überträgt einmal alles (z. B. nach manuellem Herumkopieren per Cyberduck/FileZilla).

Ohne Skript geht es weiterhin von Hand: `node scripts/build-hosting.js` und `dist/hosting/` per FTP **überschreibend** hochladen.

## 7. Backup

`data/mtga-stats.sqlite` per FTP herunterladen (bei MySQL: Export im Hosting-Panel).

## Häufige Fragen

- **„Seite nicht gefunden“ für alles außer der Startseite?** `.htaccess` fehlt oder `mod_rewrite` ist aus – Datei prüfen (versteckte Dateien!) bzw. beim Hoster aktivieren lassen.
- **Fehlerseite „Da ist etwas schiefgegangen“?** Details stehen in `data/app.log`. Häufig: PHP-Version unter 8.1 (im Hosting-Panel umstellen) oder `pdo_sqlite` fehlt (dann `db.driver` auf `mysql`).
- **Sync meldet HTTP 413?** Die Upload-Grenze des Hosters ist klein; der Companion halbiert dann die Paketgröße automatisch. Notfalls `post_max_size` im Hosting-Panel erhöhen.
- **Mailversand testen:** `https://deine-domain.de/mailtest?key=DEIN-CRON-KEY&to=deine@adresse.de` zeigt Modus, Ergebnis und die Fehlermeldung des Hosters bzw. SMTP-Servers.
- **Registrierung schließen** (nur Freunde): `'registration_open' => false` in `config.php`.
- **Alte Installation mit dem Node-Server (Docker)?** Siehe `server/DEPLOY.md` – beide Varianten nutzen dieselbe API und dasselbe Frontend.
