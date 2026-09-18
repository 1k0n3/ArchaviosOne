# MTGA Stats – Website und Cloud-Sync

Der Server ergänzt den lokalen Companion um Konten, Deck-Freigaben und Synchronisation. Er nutzt dasselbe Frontend (`../web`) wie das lokale Tool, deshalb sehen Dashboard, Decks, Bibliothek und Replays auf der Website genauso aus.

## Was der Server macht

- **Konten**: E-Mail + Passwort (scrypt, E-Mail-Bestätigung, Passwort-Reset), optional Discord und Google (OAuth). Sitzungen als HttpOnly-Cookie, CSRF-Schutz für alle Formulare, Rate-Limits für Login/Registrierung, Sicherheits-Header (Helmet).
- **Sync-API** für den Companion: Gerät per Code verbinden, dann `POST /api/v1/sync` mit Ereignissen (Matches mit Replay, Decks, Sammlungsstände). Jedes Ereignis wird höchstens einmal verarbeitet, der Companion arbeitet offline weiter und sendet, sobald er wieder online ist.
- **Dashboards**: `/u/<name>/` ist das eigene Dashboard (nur für den Besitzer). `/d/<slug>/` zeigt ein freigegebenes Deck (per Link oder öffentlich). Öffentliche Decks erscheinen auf der Startseite und im Profil `/p/<name>`.
- **Karten**: täglich alle Arena-Karten von Scryfall in die Tabelle `cards` (Namen, Texte, Bild-Links). Bilder werden nicht gespeichert, `card-img/<GrpId>` leitet zu Scryfall weiter.
- **Datenbank**: SQLite über `node:sqlite` (keine nativen Module). Alle Zugriffe laufen über `src/db.js` mit Standard-SQL, ein Postgres-Adapter kann dort eingehängt werden. Migrationen liegen in `migrations/`.

## Lokal starten

```bash
cd server
npm install
npm run migrate
npm run cards          # einmalig Kartendaten laden (einige Minuten)
npm start              # http://localhost:3000
```

Ohne `SMTP_URL` werden Bestätigungs- und Reset-Links ins Log geschrieben.

## Betrieb auf einem Hetzner-Server (Docker)

Voraussetzung: ein Linux-Server mit SSH und Docker (Hetzner Cloud, z. B. CX22). Ein reines Webhosting-Paket ohne SSH reicht nicht, weil der Node-Prozess dauerhaft laufen muss.

```bash
git clone https://github.com/DEIN-NAME/mtga-stats.git && cd mtga-stats/server
cp .env.example .env      # BASE_URL, SMTP, OAuth eintragen
nano Caddyfile            # Domain eintragen (DNS A-Record auf den Server)
docker compose up -d --build
docker compose logs -f app
```

Die SQLite-Datei liegt im Volume `mtga-data` (`/data/mtga-stats.sqlite`). Backup:

```bash
docker compose exec app sh -c 'cp /data/mtga-stats.sqlite /data/backup-$(date +%F).sqlite'
```

Ohne Docker: Node.js 22.13+ installieren, `.env` anlegen, `npm ci --omit=dev`, `npm run migrate`, `npm start`, und davor einen Reverse-Proxy (Caddy oder Nginx) mit HTTPS.

## OAuth einrichten

- Discord: Developer Portal → Anwendung → OAuth2 → Redirect `https://DEINE-DOMAIN/auth/discord/callback`, Scopes `identify email`.
- Google: Cloud Console → OAuth-Client (Webanwendung) → Redirect `https://DEINE-DOMAIN/auth/google/callback`.

## Companion verbinden

Website → Einstellungen → „Code erzeugen“. Im Companion: Tray-Menü → „Mit Website verbinden…“ → Adresse und Code eingeben. Danach synchronisiert der Companion nach jedem Match, bei Deck-Änderungen und alle 5 Minuten. Trennen geht auf beiden Seiten.

## API (Kurzfassung)

| Route | Zweck |
|---|---|
| `POST /api/v1/device/claim` `{code, name}` | Gerätetoken holen |
| `GET /api/v1/me` (Bearer) | Konto und Zähler |
| `POST /api/v1/sync` (Bearer) `{device, events[]}` | Ereignisse `match`, `deck`, `deck_deleted`, `collection` |
| `GET /healthz` | Status und Kartenzahl |
