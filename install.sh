#!/usr/bin/env bash
# MTGA Stats – Installation für macOS, Linux und Steam Deck (SteamOS).
#   bash install.sh                 installieren, Autostart einrichten, Watcher starten, Dashboard öffnen
#   bash install.sh --no-autostart
#   bash install.sh --uninstall
# Braucht nur curl und tar. Node.js wird bei Bedarf als portable Version nach ~/.mtga-stats/node geladen (kein root).
# Laden und installieren in einem Schritt: curl -fsSL https://mtga.a16.be/install.sh | bash
# Danach: scripts/unix/mtga-stats start|stop|status|dashboard|log
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOME_DIR="${HOME:-$(eval echo ~)}"
APP_DIR="$HOME_DIR/.mtga-stats"
NODE_MIN=22
OS="$(uname -s)"; ARCH="$(uname -m)"
AUTOSTART=1; UNINSTALL=0
for a in "$@"; do case "$a" in --no-autostart) AUTOSTART=0 ;; --uninstall) UNINSTALL=1 ;; -h|--help) sed -n 2,8p "$0"; exit 0 ;; esac; done

say() { printf '\n  \033[36m%s\033[0m\n' "$1"; }
ok() { printf '    \033[32m[OK]\033[0m %s\n' "$1"; }
warn() { printf '    \033[33m[!]\033[0m %s\n' "$1"; }
# Nie stumm abbrechen: Zeile und Code nennen, damit klar ist, woran es lag
trap 'c=$?; printf "\n    \033[31m[Fehler]\033[0m Installation abgebrochen (install.sh Zeile %s, Code %s).\n" "$LINENO" "$c" >&2' ERR

# ---- Deinstallation ---------------------------------------------------------------------------------
if [ "$UNINSTALL" = 1 ]; then
  say "MTGA Stats entfernen"
  "$ROOT/scripts/unix/mtga-stats" stop >/dev/null 2>&1 || true
  if [ "$OS" = "Darwin" ]; then
    launchctl bootout "gui/$(id -u)/de.mtga-stats.watcher" >/dev/null 2>&1 || true
    rm -f "$HOME_DIR/Library/LaunchAgents/de.mtga-stats.watcher.plist"; ok "Launch-Agent entfernt"
    rm -rf "$HOME_DIR/Applications/MTGA Stats.app"; ok "Programm entfernt"
  else
    systemctl --user disable --now mtga-stats.service >/dev/null 2>&1 || true
    rm -f "$HOME_DIR/.config/systemd/user/mtga-stats.service" "$HOME_DIR/.local/share/applications/mtga-stats.desktop" "$HOME_DIR/Desktop/MTGA Stats.desktop"
    systemctl --user daemon-reload >/dev/null 2>&1 || true; ok "Dienst und Verknüpfungen entfernt"
  fi
  echo "    Deine Daten in $ROOT/out und das portable Node in $APP_DIR bleiben erhalten (bei Bedarf löschen)."
  exit 0
fi

# ---- Node.js ----------------------------------------------------------------------------------------
say "Node.js prüfen"
node_ok() { command -v "$1" >/dev/null 2>&1 && [ "$("$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge "$NODE_MIN" ]; }
NODE=""
if node_ok node; then NODE="$(command -v node)"; ok "gefunden: $NODE ($(node --version))"
elif node_ok "$APP_DIR/node/bin/node"; then NODE="$APP_DIR/node/bin/node"; ok "portable Version: $NODE ($("$NODE" --version))"
else
  case "$OS-$ARCH" in
    Darwin-arm64) NPLAT=darwin-arm64 ;; Darwin-x86_64) NPLAT=darwin-x64 ;;
    Linux-x86_64) NPLAT=linux-x64 ;; Linux-aarch64|Linux-arm64) NPLAT=linux-arm64 ;;
    *) echo "Unbekannte Plattform $OS-$ARCH – bitte Node.js $NODE_MIN+ selbst installieren (https://nodejs.org)." >&2; exit 1 ;;
  esac
  # Neueste LTS-Version ab NODE_MIN (eine Zeile pro Version, neueste zuerst). Die Liste erst ganz laden und
  # in der Pipe nichts vorzeitig beenden: sonst bricht SIGPIPE wegen pipefail das ganze Skript stumm ab.
  IDX="$(curl -fsSL --retry 3 --retry-delay 2 --retry-all-errors https://nodejs.org/dist/index.json)" || { echo "    nodejs.org ist nicht erreichbar – Internetverbindung prüfen und erneut starten." >&2; exit 1; }
  VER="$(printf '%s\n' "$IDX" | grep '"lts":"' | grep -o '"version":"v[0-9.]*"' | grep -o 'v[0-9.]*' | awk -F. -v min="$NODE_MIN" 'v == "" && substr($1, 2) + 0 >= min { v = $0 } END { print v }')"
  [ -n "$VER" ] || { echo "    Konnte keine Node.js-Version ermitteln." >&2; exit 1; }
  say "Node.js $VER wird nach $APP_DIR/node geladen (portabel, ohne root)"
  mkdir -p "$APP_DIR"; TMP="$(mktemp -d)"
  curl -fL -C - --retry 5 --retry-delay 2 --retry-all-errors --progress-bar "https://nodejs.org/dist/$VER/node-$VER-$NPLAT.tar.gz" -o "$TMP/node.tgz"
  rm -rf "$APP_DIR/node"; mkdir -p "$APP_DIR/node"; tar -xzf "$TMP/node.tgz" -C "$APP_DIR/node" --strip-components=1; rm -rf "$TMP"
  NODE="$APP_DIR/node/bin/node"; ok "installiert: $("$NODE" --version)"
fi
mkdir -p "$APP_DIR"; printf '%s\n' "$NODE" > "$APP_DIR/node-path"
chmod +x "$ROOT/scripts/unix/mtga-stats" 2>/dev/null || true

# ---- Arena finden -------------------------------------------------------------------------------------
say "Arena suchen"
if MTGA_ROOT="$ROOT" "$NODE" -e "const p=require(process.env.MTGA_ROOT+'/src/paths.js'); const d=p.findDataDir(); if(!d){process.exit(3)} console.log('    Spieldaten: '+d); console.log('    Player.log: '+p.findLogFile())"; then ok "gefunden"
else warn "Arena-Spieldaten nicht gefunden. Läuft Arena über Steam/Proton oder Wine? Ordner per MTGA_DIR bzw. MTGA_LOG_DIR setzen (siehe README)."; fi
echo "    In Arena einmal einschalten: Einstellungen → Konto → Detailed Logs (Plugin Support)."

# ---- Autostart und Verknüpfungen ------------------------------------------------------------------------
CTL="$ROOT/scripts/unix/mtga-stats"
if [ "$OS" = "Darwin" ]; then
  if [ "$AUTOSTART" = 1 ]; then
    say "Autostart (Launch-Agent) einrichten"
    PL="$HOME_DIR/Library/LaunchAgents/de.mtga-stats.watcher.plist"; mkdir -p "$(dirname "$PL")"
    cat > "$PL" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>de.mtga-stats.watcher</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$ROOT/src/watch.js</string></array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$APP_DIR/watcher.out.log</string><key>StandardErrorPath</key><string>$APP_DIR/watcher.err.log</string>
</dict></plist>
EOF
    launchctl bootout "gui/$(id -u)/de.mtga-stats.watcher" >/dev/null 2>&1 || true
    launchctl bootstrap "gui/$(id -u)" "$PL" && ok "Watcher läuft im Hintergrund und startet beim Anmelden"
  else "$CTL" start; fi
  say "Programm „MTGA Stats“ anlegen"
  APP="$HOME_DIR/Applications/MTGA Stats.app"; mkdir -p "$APP/Contents/MacOS"
  printf '#!/usr/bin/env bash\nexec "%s" dashboard\n' "$CTL" > "$APP/Contents/MacOS/MTGA Stats"; chmod +x "$APP/Contents/MacOS/MTGA Stats"
  cat > "$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleName</key><string>MTGA Stats</string><key>CFBundleIdentifier</key><string>de.mtga-stats.app</string>
<key>CFBundleExecutable</key><string>MTGA Stats</string><key>CFBundlePackageType</key><string>APPL</string><key>LSUIElement</key><true/></dict></plist>
EOF
  ok "~/Applications/MTGA Stats.app öffnet das Dashboard"
else
  # Benutzerdienst: läuft auf dem Steam Deck auch im Spielmodus, solange das Gerät an ist
  if [ "$AUTOSTART" = 1 ] && command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
    say "Autostart (systemd-Benutzerdienst) einrichten"
    UD="$HOME_DIR/.config/systemd/user"; mkdir -p "$UD"
    cat > "$UD/mtga-stats.service" <<EOF
[Unit]
Description=MTGA Stats – Companion für Magic: The Gathering Arena
After=default.target

[Service]
ExecStart="$NODE" "$ROOT/src/watch.js"
WorkingDirectory=$ROOT
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
EOF
    # restart statt enable --now: bei einem Update läuft danach gleich der neue Stand
    if systemctl --user daemon-reload && systemctl --user enable mtga-stats.service >/dev/null 2>&1 && systemctl --user restart mtga-stats.service; then
      ok "Watcher läuft im Hintergrund und startet mit der Sitzung"
    else warn "Der systemd-Dienst ließ sich nicht starten – Watcher läuft jetzt ohne Autostart"; "$CTL" start; fi
    loginctl enable-linger "$(id -un)" >/dev/null 2>&1 || true
  else
    [ "$AUTOSTART" = 1 ] && warn "Kein systemd-Benutzerdienst verfügbar – der Watcher läuft bis zum Abmelden (danach: $CTL start)"
    "$CTL" start
  fi
  say "Verknüpfungen anlegen"
  AD="$HOME_DIR/.local/share/applications"; mkdir -p "$AD"
  cat > "$AD/mtga-stats.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=MTGA Stats
Comment=Dashboard für Magic: The Gathering Arena
Exec="$CTL" dashboard
Icon=$ROOT/assets/icon-192.png
Terminal=false
Categories=Game;Utility;
EOF
  chmod +x "$AD/mtga-stats.desktop"
  if [ -d "$HOME_DIR/Desktop" ]; then cp "$AD/mtga-stats.desktop" "$HOME_DIR/Desktop/MTGA Stats.desktop"; chmod +x "$HOME_DIR/Desktop/MTGA Stats.desktop"; fi
  ok "„MTGA Stats“ im Anwendungsmenü (Steam Deck: Desktop-Modus) öffnet das Dashboard"
fi

say "Fertig"
echo "    Dashboard: http://localhost:8765/   ·   Steuerung: $CTL start|stop|status|dashboard|log"
echo "    Der Ordner $ROOT ist jetzt der Programmordner – nicht löschen oder verschieben (sonst install.sh dort erneut ausführen)."
echo "    Hinweis: Die Kartensammlung (Besitzstand) liest MTGA Stats bisher nur unter Windows; Matches, Replays, Decks und Konto laufen überall."
"$CTL" dashboard >/dev/null 2>&1 || true
