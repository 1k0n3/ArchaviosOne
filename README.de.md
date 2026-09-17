# MTGA Stats (deutsche Kurzfassung)

Lokaler Begleiter für MTG Arena unter Windows: Sammlungs-Export, Match-Aufzeichnung mit Replay,
Deck-Export und ein Dashboard im Stil des Spiels. Kartenbilder kommen direkt aus den Spieldaten,
nichts wird heruntergeladen oder hochgeladen. Vollständige Dokumentation: [README.md](README.md).

## Schnellstart

```bash
npm run tray        # Tray-Icon: startet Watcher und Dashboard-Server, Linksklick öffnet das Dashboard
npm run autostart   # Tray-Icon bei der Windows-Anmeldung starten (keine Adminrechte)
npm run shortcut    # Verknüpfung "MTGA Stats" im Startmenü anlegen
```

Dashboard: <http://localhost:8765/> (solange der Watcher läuft). Weitere Befehle: `npm start`,
`npm run export`, `npm run decks`, `npm run matches`, `npm run serve`, `npm test`.

## Voraussetzungen

Windows, MTG Arena, Node.js 22.13 oder neuer, in MTGA die Option **Detailed Logs** aktiv.

## Tray-Menü

Dashboard öffnen (ganz oben, auch per Linksklick), Status, Watcher starten/stoppen, Sammlung
exportieren, Intervalle (Prüfen ob MTGA läuft, Änderungsprüfung, kompletter Scan), Speicherort,
Ausgabeordner, Protokoll, Einstellungen (JSON), Beenden. Farbe des Statuspunkts: grün = Watcher
läuft und MTGA offen, blau = wartet auf MTGA, grau = gestoppt.

## Woher die Daten kommen

- **Sammlung** aus dem Arbeitsspeicher des laufenden Clients (seit 2021 nicht mehr im Log). Nur Lesezugriff.
- **Matches und Decks** aus der `Player.log`.
- **Kartennamen, Texte, Sets** aus der Kartendatenbank des Spiels (SQLite).
- **Kartenbilder**: immer die echte gedruckte Karte, direkt von Scryfall verlinkt. Der lokale Server löst nur
  den Link auf (Set + Sammlernummer, dann Arena-ID, dann Name; nur im Speicher, gedrosselt) und leitet den
  Browser dorthin weiter. Nichts wird lokal abgelegt. Wird eine Karte online nicht gefunden, zeigt das
  Dashboard das Artwork aus den Spieldaten, es ist also immer ein Bild da. Deckboxen nutzen das Artwork direkt.
- **Kartendetails mit Statistik**: Regeltext, Drucke, Links sowie Decks, in denen die Karte liegt, Matches, in
  denen sie gespielt wurde (mit Winrate), und wie oft Gegner sie gezeigt haben.
- **Schnell und robust**: Gzip und ETag beim Ausliefern, Skeleton-Platzhalter und Lade-Animationen, erneuter
  Bildversuch, wenn Scryfall drosselt; der Watcher protokolliert unerwartete Fehler statt stehenzubleiben.

## Ausgabedateien (`out\`)

Vorher-/Nachher-CSV der Sammlung je Sitzung, `changes.csv` (fortlaufendes Änderungslog),
`sessions.csv`, Decks (`decks\`), Matches (`matches\`, je Match JSON mit Replay, Gegnerkarten als
Text), Dashboard (`web\`), `watch.log`. CSV mit Semikolon und BOM für Excel.

## Hinweise

Das Auslesen des Prozessspeichers ist kein von Wizards vorgesehener Weg; Nutzung auf eigene
Verantwortung. Die Gegnerhand steht nicht im Log und bleibt verdeckt. Sleeves und Avatare liegen
nicht in den Kartenbild-Bundles, das Replay nutzt generierte.
