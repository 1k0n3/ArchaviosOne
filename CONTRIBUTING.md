# Contributing

Thanks for helping out. A few ground rules keep the project easy to maintain.

## Setup

```bash
git clone <repo>
cd mtga-stats
npm test
```

No dependencies: everything runs on Node.js 22.13+ (`node:sqlite`, `node:test`) and Windows PowerShell 5.1.

## Layout

| Path | Purpose |
|---|---|
| `src/lib.js` | shared helpers: card database, memory scan driver, CSV, diffs |
| `src/watch.js` | background watcher (collection, matches, decks, dashboard, server) |
| `src/serve.js` | local HTTP server: dashboard files, card API, textures straight from the game bundles |
| `src/matches.js` | Player.log parser → match records and replay frames |
| `src/decks.js` | deck export from Player.log |
| `src/unity.js`, `src/bc7.js` | UnityFS bundle reader and BC7 decoder (no external tools) |
| `src/webgen.js` | builds `out/web` from templates in `web/` |
| `scripts/` | PowerShell: memory scanner, tray icon, autostart installer |
| `web/` | dashboard front end (plain HTML/CSS/JS, no build step) |
| `tests/` | `node --test` unit tests |

## Guidelines

- Keep it dependency-free. If something really needs a library, open an issue first.
- German is the UI language for now; code comments may be German or English. Identifiers are English.
- Every parser change needs a test with a small synthetic fixture (see `tests/matches.test.js`). Do not commit real logs: they contain player names and ids.
- The memory scanner is read-only by design. Do not add anything that writes to the game process.
- Run `npm test` before opening a pull request.

## Reporting log format changes

Wizards changes the log format without notice. If matches stop being recorded, attach the first 200 lines of `Player.log` (with names removed) and the output of `node src/matches.js` to the issue.
