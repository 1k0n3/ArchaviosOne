<p align="center">
  <img src="assets/icon-192.png" width="96" alt="MTGA Stats Logo">
</p>

<h1 align="center">MTGA Stats</h1>

<p align="center">
  Lokaler Begleiter für <strong>Magic: The Gathering Arena</strong> unter Windows.<br>
  Sammlungs-Export, Match-Aufzeichnung mit Replays, Deck-Export und ein Dashboard im Stil des Spiels.<br>
  <strong>Alles bleibt auf deinem PC. Kein Konto, keine Cloud, kein Upload.</strong>
</p>

<p align="center">
  <img src="docs/screenshots/dashboard.png" width="900" alt="Dashboard">
</p>

> Ausführliche Dokumentation auf Englisch: [README.md](README.md)

## Installation mit einem Klick

1. **Herunterladen**: grüner Button **Code** → **Download ZIP**, dann irgendwo entpacken (zum Beispiel `C:\Spiele\mtga-stats`).
2. **Doppelklick auf `Install.cmd`.**
3. Fertig. Das Dashboard öffnet sich als eigenes Fenster, neben der Uhr erscheint ein Tray-Symbol, und ab jetzt werden deine Matches aufgezeichnet.

Der Installer prüft Node.js und installiert es bei Bedarf automatisch über den Windows-Paketmanager (`winget`). Er legt zwei Startmenü-Einträge an (**MTGA Stats** = Tray und Watcher, **MTGA Stats Dashboard** = das App-Fenster) und fragt einmal, ob alles beim Windows-Start mitlaufen soll. `Uninstall.cmd` entfernt alles wieder; deine Daten bleiben, wenn du es nicht anders willst.

Einmal in Arena einschalten: **Einstellungen → Konto → Detaillierte Protokolle (Plugin-Unterstützung)**. Ohne diese Option schreibt Arena keine Match-Daten.

## Was du bekommst

- **Übersicht**: Winrate, Verlauf, Matches pro Tag, Spiellänge, Spielbeginn, Winrate je Deck, Format und Gegner-Plattform.
- **Matches**: jedes Spiel mit Gegner, Deck, Ergebnis, Zügen, Dauer und den gesehenen Gegnerkarten.
- **Replays**: jedes Match Schritt für Schritt auf einem Spielfeld wie in Arena, mit Player-Leiste und Ereignisprotokoll.
- **Decks**: alle Arena-Decks als 3D-Deckboxen; Detailansicht mit Statistik, Manakurve, Farben, Kartenliste nach Typ, Suche, Filtern und Arena-Export.
- **Bibliothek**: alle Karten des Spiels mit Besitzstand, Suche, Filtern und Sortierung nach Siegen, Spielen oder Deck-Nutzung.
- **Kartendetails**: gedruckte Karte, Regeltext mit offiziellen Symbolen, Drucke und deine eigene Statistik zur Karte.
- **Sammlungs-Export** als CSV vor und nach jeder Sitzung mit fortlaufendem Änderungslog.

<p align="center">
  <img src="docs/screenshots/replay.png" width="440" alt="Replay">
  <img src="docs/screenshots/decks.png" width="440" alt="Decks">
</p>

## Woher die Daten kommen

- **Sammlung** aus dem Arbeitsspeicher des laufenden Clients (nur lesend; seit 2021 steht sie nicht mehr im Log).
- **Matches und Decks** aus der `Player.log`.
- **Kartennamen, Texte, Sets** aus der Kartendatenbank des Spiels.
- **Kartenbilder und Symbole** werden nur **verlinkt** (Scryfall), nie gespeichert. Fehlt eine Karte online, wird das Artwork aus den Spieldaten angezeigt, es ist also immer ein Bild da.

## Bedienung

- **Tray-Symbol**: Dashboard öffnen (auch per Linksklick), Status, Watcher starten/stoppen, Sammlung jetzt exportieren, Intervalle und Speicherort ändern, Protokoll öffnen.
- **App-Fenster**: Startmenü-Eintrag „MTGA Stats Dashboard“ oder `npm run app`.
- **Als App installieren**: `http://localhost:8765/` in Chrome oder Edge öffnen und „App installieren“ wählen.

## Voraussetzungen

Windows 10 oder 11, MTG Arena, Node.js 22.13 oder neuer (installiert `Install.cmd` bei Bedarf), in Arena die Option „Detaillierte Protokolle“.

## Wenn etwas nicht klappt

| Problem | Ursache und Lösung |
|---|---|
| Im Log steht `Zugriff auf MTGA verweigert (Win32 5)` | Arena läuft als Administrator. Arena normal starten oder den Autostart erhöht einrichten: `npm run autostart -- -Elevated`. |
| Keine Matches | In Arena „Detaillierte Protokolle“ einschalten und ein Match spielen. |
| Karten zeigen kurz nur das Artwork | Scryfall drosselt kurz die Bildabfragen, die Seite versucht es von selbst erneut. |
| `EADDRINUSE` beim Start | Es läuft schon eine Instanz. Über das Tray stoppen oder `webPort` ändern. |

## Lizenz

MIT, siehe [LICENSE](LICENSE). MTGA Stats ist inoffizieller Fan-Inhalt gemäß der Fan Content Policy von Wizards of the Coast und wird von Wizards weder unterstützt noch genehmigt. Kartenbilder und Symbole stammen von [Scryfall](https://scryfall.com) und werden verlinkt, nicht weiterverbreitet.
