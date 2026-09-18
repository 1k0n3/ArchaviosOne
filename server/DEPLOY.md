# Website auf den Hetzner-Server bringen

Kurzfassung: **drei Ordner hochladen, `.env` und `Caddyfile` anpassen, `docker compose up -d --build`.** Der Rest (HTTPS-Zertifikat, Datenbank, Kartendaten) passiert automatisch.

## 1. Was hochgeladen wird – und was nicht

| Hochladen | Warum |
|---|---|
| `server/` (ohne `data/`, `node_modules/`, `.env`) | Server-Code, Migrationen, Dockerfile, docker-compose.yml, Caddyfile |
| `web/` | gemeinsames Frontend (Dashboard, Decks, Replay, Sprachen) |
| `assets/` | Icons |

| **Nicht** hochladen | Warum |
|---|---|
| `out/` | deine Sammlung, Matches, Sync-Warteschlange, Gerätetoken – bleibt lokal |
| `server/data/` | lokale Test-Datenbank und Sitzungsgeheimnis |
| `server/.env` | lokale Einstellungen; auf dem Server wird eine eigene angelegt |
| `node_modules/` | werden im Docker-Build installiert |
| `src/`, `scripts/`, `tests/`, `docs/`, `Install.cmd` | nur für den Companion auf dem PC |

Die Struktur auf dem Server muss so aussehen (das Dockerfile erwartet `server/`, `web/` und `assets/` nebeneinander):

```
/opt/mtga-stats/
├── server/
├── web/
└── assets/
```

## 2. Server vorbereiten (einmalig)

Auf dem Hetzner-Server (Ubuntu/Debian) per SSH:

```bash
curl -fsSL https://get.docker.com | sh
```

Bei Hetzner Cloud zusätzlich in der Firewall die Ports **80** und **443** öffnen. Im DNS einen **A-Record** deiner Domain (z. B. `mtga.deine-domain.de`) auf die Server-IP setzen.

## 3. Dateien hochladen (von deinem Windows-PC)

PowerShell im Projektordner (`C:\Users\1k0n3\claude\mtga-collection`). Ersetze `root@SERVER-IP`:

```powershell
ssh root@SERVER-IP "mkdir -p /opt/mtga-stats"
scp -r web assets root@SERVER-IP:/opt/mtga-stats/
scp -r server/src server/migrations server/static server/package.json server/package-lock.json server/Dockerfile server/docker-compose.yml server/Caddyfile server/.env.example root@SERVER-IP:/opt/mtga-stats/server/
```

(Alternative mit weniger Tipparbeit: `git clone`, sobald das Repo auf GitHub liegt – dann `git pull` für Updates.)

## 4. Konfigurieren

```bash
ssh root@SERVER-IP
cd /opt/mtga-stats/server
cp .env.example .env
nano .env
```

Mindestens eintragen:

| Variable | Wert |
|---|---|
| `BASE_URL` | `https://mtga.deine-domain.de` (genau die Domain aus dem DNS) |
| `SMTP_URL` | z. B. `smtps://benutzer:passwort@smtp.deine-domain.de:465` – ohne SMTP landen Bestätigungs-Links nur im Log |
| `MAIL_FROM` | Absender, z. B. `MTGA Stats <no-reply@deine-domain.de>` |
| `GITHUB_REPO` | `dein-name/mtga-stats` für den Download-Button (oder `DOWNLOAD_URL` direkt) |
| `DISCORD_CLIENT_ID/SECRET`, `GOOGLE_CLIENT_ID/SECRET` | optional, siehe README.md |

Dann die Domain im `Caddyfile` eintragen:

```bash
sed -i 's/mtga.example.de/mtga.deine-domain.de/' Caddyfile
```

## 5. Starten

```bash
docker compose up -d --build
docker compose logs -f app
```

Beim ersten Start werden die Migrationen ausgeführt und die ~20.000 Arena-Karten von Scryfall geladen (ein paar Minuten, im Log als „Kartensync“). Caddy holt das HTTPS-Zertifikat automatisch. Prüfen:

```bash
curl -s https://mtga.deine-domain.de/healthz
```

Antwort `{"ok":true,"cards":20043}` (Zahl wächst während des Kartensyncs).

## 6. Erstes Konto und Companion verbinden

1. `https://mtga.deine-domain.de/register` → Konto anlegen, Link aus der E-Mail (oder aus `docker compose logs app`) bestätigen.
2. Einstellungen → „Code erzeugen“.
3. Am PC: Tray-Menü → **Mit Website verbinden…** → Adresse `https://mtga.deine-domain.de` und den Code eingeben.

Ab dann synchronisiert der Companion nach jedem Match, bei Deck-Änderungen und alle 5 Minuten – offline wird gesammelt und später nachgeschickt.

## 7. Updates einspielen

Geänderte Dateien wie in Schritt 3 hochladen, dann:

```bash
cd /opt/mtga-stats/server && docker compose up -d --build
```

Datenbank und Geheimnisse liegen im Docker-Volume `mtga-data` und bleiben erhalten.

## 8. Backup

```bash
docker compose exec app sh -c 'cp /data/mtga-stats.sqlite /data/backup-$(date +%F).sqlite'
docker cp $(docker compose ps -q app):/data/backup-$(date +%F).sqlite ./
```

## Häufige Fragen

- **Kein HTTPS-Zertifikat?** DNS zeigt noch nicht auf den Server oder Port 80/443 ist zu. `docker compose logs caddy` zeigt den Grund.
- **Bestätigungs-Mail kommt nicht?** `SMTP_URL` prüfen; der Link steht immer auch im App-Log.
- **Registrierung schließen** (nur Freunde): `REGISTRATION_OPEN=0` in `.env`, dann `docker compose up -d`.
- **Bilder?** Werden nie auf dem Server gespeichert – `card-img/…` leitet zu Scryfall weiter.
