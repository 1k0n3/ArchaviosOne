# Homebrew-Formel für MTGA Stats (macOS). Dieses Repository ist selbst der Tap: Homebrew sucht Formeln
# im Ordner Formula/. Installation siehe README ("Package managers"). Bei neuem Release tag und version
# anpassen.
class MtgaStats < Formula
  desc "Companion for Magic: The Gathering Arena: matches, replays, decks, dashboard"
  homepage "https://mtga.a16.be"
  # Quelle ist der Tap selbst: "brew tap" hat dieses Repository samt Tags geklont, installiert wird der
  # Stand des Release-Tags daraus. So braucht die Formel keine feste Adresse.
  url "file://#{File.expand_path("..", File.dirname(__FILE__))}", using: :git, tag: "v1.5.0"
  version "1.5.0"
  license "MIT"

  depends_on "node"

  def install
    libexec.install Dir["*"]
    chmod 0755, libexec/"scripts/unix/mtga-stats"
    # Einstellungen und Daten liegen im Benutzerordner (~/.config/mtga-stats, ~/.local/share/mtga-stats), libexec bleibt unverändert
    (bin/"mtga-stats").write <<~EOS
      #!/bin/bash
      export MTGA_STATS_CONFIG="${MTGA_STATS_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/mtga-stats/watch-config.json}"
      exec "#{libexec}/scripts/unix/mtga-stats" "$@"
    EOS
  end

  service do
    run [opt_bin/"mtga-stats", "run"]
    keep_alive true
    working_dir HOMEBREW_PREFIX
    log_path var/"log/mtga-stats.log"
    error_log_path var/"log/mtga-stats.log"
  end

  def caveats
    <<~EOS
      Watcher im Hintergrund starten (auch beim Anmelden): brew services start mtga-stats
      Dashboard öffnen: mtga-stats dashboard   ·   Status: mtga-stats status
      In Arena einmal einschalten: Einstellungen → Konto → Detailed Logs (Plugin Support).
      Hinweis: Die Kartensammlung (Besitzstand) gibt es nur unter Windows; Matches, Replays, Decks und Konto laufen auf dem Mac.
    EOS
  end

  test do
    assert_match "Watcher", shell_output("#{bin}/mtga-stats status")
  end
end
