#!/usr/bin/env bash
# Flatpak-Startskript: Einstellungen und Daten liegen im Sandbox-Datenordner (~/.var/app/be.a16.mtga.Stats),
# der Programmordner /app ist schreibgeschützt. Ohne Argument: Watcher starten und Dashboard öffnen.
# Ein Flatpak endet mit seinem Startprozess und nimmt alles darin mit – darum läuft der Watcher hier im
# Vordergrund (mtga-stats app) statt im Hintergrund. Beenden: flatpak kill be.a16.mtga.Stats
export PATH="/app/node/bin:$PATH"
export MTGA_STATS_CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/mtga-stats/watch-config.json"
export XDG_DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
CTL=/app/share/mtga-stats/scripts/unix/mtga-stats
case "${1:-app}" in
  app|dashboard|start) exec "$CTL" app ;;
  *) exec "$CTL" "$@" ;;
esac
