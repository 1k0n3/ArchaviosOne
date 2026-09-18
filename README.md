<p align="center">
  <img src="assets/icon-192.png" width="96" alt="MTGA Stats logo">
</p>

<h1 align="center">MTGA Stats</h1>

<p align="center">
  A local companion for <strong>Magic: The Gathering Arena</strong> on Windows.<br>
  Collection export, match recording with board replays, deck export and a game-styled dashboard.<br>
  <strong>Everything stays on your PC. No account, no cloud, no uploads.</strong>
</p>

<p align="center">
  <a href="#one-click-install"><img alt="Windows" src="https://img.shields.io/badge/Windows-10%20%7C%2011-0078D4?logo=windows&logoColor=white"></a>
  <a href="https://nodejs.org"><img alt="Node.js" src="https://img.shields.io/badge/Node.js-%E2%89%A5%2022.13-339933?logo=node.js&logoColor=white"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-f2b134"></a>
  <img alt="Dependencies: none" src="https://img.shields.io/badge/dependencies-none-2ea44f">
  <img alt="Data stays local" src="https://img.shields.io/badge/data-100%25%20local-8b5cf6">
</p>

<p align="center">
  <img src="docs/screenshots/dashboard.png" width="900" alt="Dashboard overview">
</p>

> Deutsche Kurzanleitung: [README.de.md](README.de.md)

---

## One-click install

1. **Download** the project: green **Code** button → **Download ZIP**, then unzip it anywhere (for example `C:\Games\mtga-stats`).
2. **Double-click `Install.cmd`.**
3. Done. The dashboard opens as its own window, a tray icon appears next to the clock, and the watcher records your matches from now on.

The installer checks for Node.js and installs it automatically through the Windows Package Manager (`winget`) if it is missing. It creates two Start Menu entries (**MTGA Stats** = tray + watcher, **MTGA Stats Dashboard** = the app window) and asks once whether it should start with Windows. `Uninstall.cmd` removes everything again; your data folder stays unless you ask for it to be deleted.

One thing to enable in Arena once: **Settings → Account → Detailed Logs (Plugin Support)**. Without it Arena writes no match data.

<details>
<summary>Command line instead</summary>

```bash
git clone https://github.com/YOUR-NAME/mtga-stats.git
cd mtga-stats
npm run tray        # tray icon, watcher and dashboard server
npm run app         # dashboard as its own window
npm run shortcut    # Start Menu entries
npm run autostart   # run at login
```
</details>

## What you get

| | |
|---|---|
| **Dashboard** – win-rate ring, rolling trend, matches per day, game length, play/draw split, win rate per deck, format and opponent platform, all with hover details. | **Matches** – every game with opponent, deck, result, turns, duration and the cards the opponent revealed (exportable as text). |
| **Replays** – step through any match on a board that mirrors Arena: hands, lands, permanents, stack, graveyards, life totals, phases, with a video-style player bar and an event log. | **Decks** – all your Arena decks as 3D deck boxes; open one for stats, mana curve, colour split, card list by type, search, filters and one-click Arena export. |
| **Card library** – every card in the game with owned counts, search, set, rarity, type, colour and ownership filters, sorting by wins, plays or deck usage. | **Card details** – printed card, rules text with official symbols, printings, and your own statistics: decks it sits in, matches you played it in, win rate with it, how often opponents showed it. |

<p align="center">
  <img src="docs/screenshots/replay.png" width="440" alt="Match replay">
  <img src="docs/screenshots/decks.png" width="440" alt="Deck view">
</p>
<p align="center">
  <img src="docs/screenshots/library.png" width="440" alt="Card library">
  <img src="docs/screenshots/matches.png" width="440" alt="Match list">
</p>

Also: collection export as CSV before and after every session with a running change log, live refresh of open pages when new data arrives, and an installable web app (Chrome/Edge offer "Install app").

## How it works

MTGA Stats has **no dependencies** and never talks to any server except to link card images.

| Data | Source |
|---|---|
| Collection | Read from the memory of the running Arena client (read-only; Arena stopped writing it to the log in 2021). |
| Matches, decks | `Player.log` in `%LocalAppData%Low\Wizards Of The Coast\MTGA`. |
| Card names, rules text, sets | Arena's own card database (SQLite) in the game folder. |
| Card images | **Linked**, never stored: the local server resolves each card to its Scryfall image and redirects the browser to it. If a card is not on Scryfall, the artwork from Arena's asset bundles is decoded on the GPU instead, so there is always a picture. |
| Mana, tap and set symbols | Official symbol graphics, linked from Scryfall, with built-in fallbacks when offline. |

The watcher polls every few minutes whether Arena runs, exports the collection when it starts, checks for changes every minute, tails the log for matches, and rebuilds the dashboard after every match. The dashboard is plain HTML, CSS and JavaScript served by a small Node.js server on `http://localhost:8765/`.

## Requirements

- Windows 10 or 11 and MTG Arena (Steam or standalone).
- Node.js 22.13 or newer (installed automatically by `Install.cmd` if missing).
- Arena option **Detailed Logs (Plugin Support)** enabled.
- Chrome or Edge for the app window (any browser works for the normal page).

## Everyday use

- **Tray icon**: open the dashboard (also with a left click), see the status, start or stop the watcher, export the collection now, change intervals and the output folder, open the log.
- **App window**: `MTGA Stats Dashboard` in the Start Menu, or `npm run app`. Runs Chrome/Edge in app mode with its own profile, so it behaves like a program with its own taskbar entry.
- **Install as app**: open `http://localhost:8765/` in Chrome or Edge and choose "Install app" from the address bar for a native-looking entry in the Start Menu.

## Configuration

All settings live in [`watch-config.json`](watch-config.json) and can also be changed from the tray menu.

| Key | Default | Meaning |
|---|---|---|
| `pollSec` | 300 | How often to check whether Arena is running |
| `checkSec` | 60 | How often to look for collection changes while Arena runs |
| `fullScanSec` | 600 | Interval for a complete memory scan |
| `matchCheckSec` | 10 | How often the log is read for match events |
| `webPort` | 8765 | Port of the dashboard server |
| `outDir` | `out` | Where CSVs, matches and the dashboard are written |
| `prefetchCardImages` | false | Resolve image links for all known cards at start (off: resolved on demand) |

## Output files (`out\`)

Collection CSV before and after each session, `changes.csv` (running change log), `sessions.csv`, deck exports (`decks\`), one JSON per match with replay data (`matches\`), the built dashboard (`web\`) and `watch.log`. CSVs use semicolons and a BOM so Excel opens them directly.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Log says `Zugriff auf MTGA verweigert (Win32 5)` | Arena runs as administrator. Either start Arena normally or register the autostart task elevated: `npm run autostart -- -Elevated`. |
| No matches appear | Enable **Detailed Logs** in Arena (Settings → Account) and play a match. |
| Cards show artwork instead of the printed card for a minute | Scryfall rate-limits image lookups briefly; the page retries by itself. |
| `EADDRINUSE` on start | Another instance already runs on the port. Stop it via the tray or change `webPort`. |
| Page is empty in the browser | The dashboard needs the running server (tray icon). Opening `out\web\index.html` directly only works partially. |

## Development

```bash
npm test          # unit tests (node --test)
npm run build     # rebuild the dashboard from out\
npm run serve     # dashboard server only
npm run export    # one-shot collection export
npm run decks     # one-shot deck export
npm run matches   # parse matches from the log
```

```
src/        watcher, memory scan glue, log parsers, dashboard generator, HTTP server, Unity texture reader
web/        dashboard (index, matches, decks, library, replay) – static HTML/CSS/JS, no build step
scripts/    PowerShell: tray icon, installer, autostart task, shortcuts, memory scanner, icon generator
tests/      node --test suites
assets/     icons
```

Contributions are welcome, see [CONTRIBUTING.md](CONTRIBUTING.md). Bug reports: please attach the last lines of `out\watch.log`.

## License and disclaimer

MIT, see [LICENSE](LICENSE).

MTGA Stats is unofficial Fan Content permitted under the Wizards of the Coast Fan Content Policy. Not approved or endorsed by Wizards. Portions of the materials used are property of Wizards of the Coast. © Wizards of the Coast LLC. Card images and symbols are provided by [Scryfall](https://scryfall.com) and are linked, not redistributed.
