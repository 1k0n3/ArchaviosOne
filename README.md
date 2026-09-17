# MTGA Stats

A local companion for **Magic: The Gathering Arena** on Windows. It exports your collection,
records every match with a full board replay, exports your decks and shows everything in a
dashboard styled after the game. Nothing leaves your machine: card art is read straight from
the game's own asset files, no image downloads, no accounts, no uploads.

*Deutsche Kurzfassung: [README.de.md](README.de.md)*

## Features

- **Collection export** as CSV (name, set, quantity, number, rarity) with a before/after
  snapshot per play session and a running change log.
- **Match recording** from `Player.log`: opponent, deck, result, turns, duration, cards the
  opponent revealed, and a step-by-step **replay** of the board (hands, lands, creatures,
  stack, graveyards, life totals) with a video-style player bar.
- **Deck export** of all your Arena decks (CSV plus Arena import format), shown as 3D deck boxes.
- **Dashboard**: win rate ring, rolling win-rate trend, matches per day, game length, play/draw
  split, win rates per deck, format and opponent platform, all with hover details.
- **Card library**: every card in the game with search, set, rarity, colour, type and
  ownership filters; click any card for rules text, printings, links and **card statistics** (decks
  it sits in, matches you played it in, win rate with it, how often opponents showed it).
- **Fast and robust**: gzip + ETag delivery, skeleton placeholders and loading animations, image
  retry when Scryfall throttles, and a watcher that logs unexpected errors instead of stopping.
- **Real card images**: the dashboard always shows the printed card, linked straight from Scryfall.
  The local server only resolves each card to its image link (set + collector number, then Arena
  id, then name; kept in memory, throttled to Scryfall's limits) and redirects the browser to it.
  Nothing is stored on disk. If a card cannot be found online, the card art from the game's own
  asset bundles is shown instead (read with `src/unity.js`, decoded on the GPU), so there is always
  an image. Deck boxes use the game art directly.
- **Tray icon** to start/stop the watcher, change intervals and the output folder, open the
  dashboard (left click) and see status notifications.

## Requirements

- Windows 10/11, MTG Arena (Steam or standalone install; the install path is detected from the log)
- [Node.js](https://nodejs.org) 22.13 or newer (uses the built-in `node:sqlite`, no npm packages)
- MTGA option **Detailed Logs (Plugin Support)** enabled for match recording

## Quick start

```bash
git clone <repo-url> mtga-stats
cd mtga-stats
npm run tray          # tray icon: starts the watcher + dashboard server, left click opens the dashboard
```

Or run pieces individually:

```bash
npm start             # watcher + server in the foreground (Ctrl+C to stop)
npm run export        # collection once -> out/mtga-collection_<date>.csv
npm run decks         # decks once -> out/decks/
npm run matches       # import matches from Player-prev.log + Player.log, build the dashboard
npm run serve         # dashboard server only: http://localhost:8765/
npm run autostart     # register the tray icon to start at Windows logon (no admin rights)
npm run shortcut      # "MTGA Stats" shortcut in the Start Menu (add -Desktop for the desktop)
npm test
```

The dashboard lives at <http://localhost:8765/> while the watcher (or `npm run serve`) is running.

## How it works

| Data | Source | Notes |
|---|---|---|
| Collection | memory of the running `MTGA.exe` | Arena stopped writing the collection to the log in 2021. The scanner (`scripts/scan-memory.ps1`, PowerShell + embedded C#) looks for the block of (card id, quantity) pairs and validates every id against the card database. Read-only. |
| Matches, decks | `%AppData%\..\LocalLow\Wizards Of The Coast\MTGA\Player.log` | GRE game-state messages are folded into compact board frames. |
| Card names, sets, rules text | `MTGA_Data\Downloads\Raw\Raw_CardDatabase_*.mtga` | SQLite, read with `node:sqlite`. |
| Card art | `MTGA_Data\Downloads\AssetBundle\*_CardArt_*.mtga` | UnityFS bundles (LZ4) with one DXT1/DXT5/BC7 texture each; `src/unity.js` parses them without external tools. |

The watcher (`src/watch.js`) polls for the game every 5 minutes, snapshots the collection when it
starts, checks for changes every minute (only re-reading the known memory block), tails the log
for matches every 10 seconds, and writes the after-snapshot, session summary, deck export and
dashboard when the game closes. All intervals are in `watch-config.json` or the tray menu.

## Output (`out/`)

| File | Content |
|---|---|
| `mtga-collection_<session>_vorher.csv` / `_nachher.csv` | collection at game start / end |
| `mtga-collection_<session>_aenderungen.csv` | differences of that session (only when there are any) |
| `changes.csv`, `sessions.csv`, `state.json` | running change log, one row per session, last known state |
| `decks/decks_<date>.csv`, `decks/txt/<deck>.txt` | all decks, table + Arena import format |
| `matches/<matchId>.json`, `matches/matches.csv` | full match record with replay frames, index |
| `matches/opponents/<date>_<opponent>_<id>.txt` | cards the opponent revealed, Arena format |
| `web/` | generated dashboard (`data.js`, `matches/*.js`) |
| `watch.log` | watcher log |

CSV files are semicolon-separated with a BOM so they open directly in Excel.

## Project layout

```
src/        Node.js modules (watcher, server, parsers, bundle reader)
scripts/    PowerShell (memory scanner, tray icon, autostart installer)
web/        dashboard front end (plain HTML/CSS/JS, no build step)
tests/      node --test unit tests
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for details.

## Notes and limitations

- Reading the game's process memory is not an interface Wizards provides. It is read-only and
  works like other trackers, but use it at your own risk and read the Arena terms of service.
- The opponent's hand is never visible in the log, so it is shown as card backs.
- Sleeves and avatars are not stored in the card-art bundles; the replay uses generated ones.
- The log format changes without notice. If matches stop appearing, open an issue with the
  first lines of `Player.log` (names removed).

## License

MIT. Unofficial Fan Content permitted under the Wizards of the Coast Fan Content Policy.
Not approved or endorsed by Wizards. Card images and names are property of Wizards of the Coast.
