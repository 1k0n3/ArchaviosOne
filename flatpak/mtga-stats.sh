#!/usr/bin/env bash
# Flatpak-Startskript: Einstellungen und Daten liegen im Sandbox-Datenordner (~/.var/app/be.a16.mtga.Stats),
# der Programmordner /app ist schreibgeschützt. Ohne Argument: Watcher starten und Dashboard öffnen.
export PATH="/app/node/bin:$PATH"
export MTGA_STATS_CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/mtga-stats/watch-config.json"
export XDG_DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
exec /app/share/mtga-stats/scripts/unix/mtga-stats "${1:-dashboard}" "${@:2}"
