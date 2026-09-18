<?php
// Serverseitig gerenderte Seiten (Konto, Einstellungen, Startseite). Nutzt das Design-System des Dashboards (app.css).
declare(strict_types=1);

function logo_svg(): string {
  $bars = ''; $cols = ['#f3e9c8', '#3d7fd6', '#9a8fb3', '#d8482f', '#3f9a4f']; $hs = [34, 25, 17, 25, 34];
  foreach ($cols as $i => $c) $bars .= '<rect x="' . (8.5 + $i * 10) . '" y="' . (50 - $hs[$i]) . '" width="7" height="' . $hs[$i] . '" rx="3" fill="' . $c . '"/>';
  return '<svg class="mark" viewBox="0 0 64 64" width="40" height="40" aria-hidden="true"><defs><linearGradient id="lg-bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2c2018"/><stop offset="1" stop-color="#100d0b"/></linearGradient></defs><rect x="2" y="2" width="60" height="60" rx="15" fill="url(#lg-bg)" stroke="#f2b134" stroke-opacity=".55" stroke-width="1.6"/>' . $bars . '</svg>';
}

function layout(string $title, string $body, array $o = []): string {
  $user = $o['user'] ?? current_user(); $csrf = csrf_token(); $flash = $o['flash'] ?? null; $wide = !empty($o['wide']);
  if ($user && empty($o['plain'])) return layout_app($title, $body, $user, $flash, $o['active'] ?? '');
  $nav = $user
    ? '<a href="/u/' . esc($user['handle']) . '/">Mein Dashboard</a><a href="/u/' . esc($user['handle']) . '/decks.html">Meine Decks</a><a href="/settings">Einstellungen</a><form method="post" action="/logout" class="inline"><input type="hidden" name="csrf" value="' . $csrf . '"><button class="ghost small" type="submit">Abmelden</button></form>'
    : '<a href="/decks">Öffentliche Decks</a><a href="/login">Anmelden</a><a class="btn" href="/register">Registrieren</a>';
  $flashHtml = $flash ? '<div class="flash ' . esc($flash['kind'] ?? 'info') . '">' . esc($flash['text'] ?? '') . '</div>' : '';
  return '<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>' . esc($title) . ' · MTGA Stats</title>
<link rel="icon" href="/static/favicon.ico" sizes="any"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cinzel:wght@600;700;800&display=swap"><link rel="stylesheet" href="/static/app.css"><link rel="stylesheet" href="/static/site.css"></head>
<body class="site"><header class="site-head"><a class="brand" href="/">' . logo_svg() . '<span><b>MTGA Stats</b><small>Decks, Matches, Sammlung</small></span></a><nav>' . $nav . '</nav></header>
<main class="site-main ' . ($wide ? 'wide' : '') . ' ' . esc($o['main'] ?? '') . '">' . $flashHtml . $body . '</main>
<footer class="site-foot">MTGA Stats ist inoffizieller Fan-Inhalt gemäß der Fan Content Policy von Wizards of the Coast. Kartenbilder von <a href="https://scryfall.com" rel="noopener">Scryfall</a>. · <a href="/impressum">Impressum</a> · <a href="/datenschutz">Datenschutz</a></footer></body></html>';
}

/** Seiten für angemeldete Nutzer im Layout des Dashboards: Seitenleiste wie in der App, Inhalt rechts */
function layout_app(string $title, string $body, array $user, ?array $flash, string $active = '/settings'): string {
  $h = esc($user['handle']); $csrf = csrf_token();
  $icons = [
    'dash' => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="8" height="8" rx="2"/><rect x="13" y="3" width="8" height="5" rx="2"/><rect x="13" y="10" width="8" height="11" rx="2"/><rect x="3" y="13" width="8" height="8" rx="2"/></svg>',
    'matches' => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.5 3.5 20.5 9.5 9 21H3v-6z"/><path d="m12 6 6 6"/></svg>',
    'decks' => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="3" width="12" height="16" rx="2"/><path d="M9 7h4M9 11h4"/><path d="M17 7h1a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2"/></svg>',
    'lib' => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v14"/><path d="M4 19a2 2 0 0 0 2 2h14"/><path d="M8 7h8M8 11h6"/></svg>',
    'build' => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 4 20 10 10 20H4v-6z"/><path d="M12 6l6 6"/><path d="M3 21h6"/></svg>',
    'gear' => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
    'globe' => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>',
    'out' => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 17l5-5-5-5M15 12H3M21 3v18"/></svg>',
  ];
  $pages = [["/u/$h/index.html", 'Übersicht', 'dash'], ["/u/$h/matches.html", 'Matches', 'matches'], ["/u/$h/decks.html", 'Decks', 'decks'], ["/u/$h/library.html", 'Bibliothek', 'lib'], ["/u/$h/builder.html", 'Deckbau', 'build']];
  $nav = '';
  foreach ($pages as [$href, $label, $ic]) $nav .= '<a class="nav" href="' . $href . '">' . $icons[$ic] . '<span>' . $label . '</span></a>';
  $nav .= '<div class="nav-sep"></div><form method="post" action="/logout" class="inline"><input type="hidden" name="csrf" value="' . $csrf . '"><button class="nav" type="submit">' . $icons['out'] . '<span>Abmelden</span></button></form>';
  $name = $user['arena_name'] ?: $user['display_name'];
  $flashHtml = $flash ? '<div class="flash ' . esc($flash['kind'] ?? 'info') . '">' . esc($flash['text'] ?? '') . '</div>' : '';
  return '<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>' . esc($title) . ' · MTGA Stats</title>
<link rel="icon" href="/static/favicon.ico" sizes="any"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cinzel:wght@600;700;800&display=swap"><link rel="stylesheet" href="/static/app.css"><link rel="stylesheet" href="/static/site.css"></head>
<body class="site app"><div class="shell"><aside class="side-nav">
  <a class="brand" href="/?site=1" title="Zur Website">' . logo_svg() . '<div><div class="t1">MTGA Stats</div><div class="t2">Website</div></div></a>' . $nav . '
  <div class="spacer"></div>
  <a class="player link ' . ($active === '/settings' ? 'active' : '') . '" href="/settings" title="Konto &amp; Geräte"><div class="av">' . esc(mb_strtoupper(mb_substr($name, 0, 1))) . '</div><div><div class="n">' . esc($name) . '</div><div class="s">' . esc($user['email']) . '</div></div></a>
  <div class="foot">' . esc(cfg('base_url')) . '</div>
</aside><main class="content">' . $flashHtml . $body . '</main></div></body></html>';
}

function field(string $label, string $name, string $type = 'text', string $extra = ''): string { return '<label class="fld"><span>' . esc($label) . '</span><input name="' . $name . '" type="' . $type . '" ' . $extra . '></label>'; }
function oauth_buttons(): string {
  $d = oauth_enabled('discord'); $g = oauth_enabled('google');
  if (!$d && !$g) return '';
  return '<div class="oauth"><span class="muted small">oder</span>' . ($d ? '<a class="btn oauth-btn discord" href="/auth/discord">Mit Discord anmelden</a>' : '') . ($g ? '<a class="btn oauth-btn google" href="/auth/google">Mit Google anmelden</a>' : '') . '</div>';
}
function csrf_field(): string { return '<input type="hidden" name="csrf" value="' . csrf_token() . '">'; }

function page_home(array $decks, array $stats): string {
  $ic = [
    'chart' => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19V5M4 19h16"/><path d="M8 15l3-4 3 2 5-6"/></svg>',
    'replay' => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M10 8l6 4-6 4z" fill="currentColor"/></svg>',
    'deck' => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="3" width="12" height="16" rx="2"/><path d="M17 7h1a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2"/></svg>',
    'lib' => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v14"/><path d="M4 19a2 2 0 0 0 2 2h14"/><path d="M8 7h8M8 11h6"/></svg>',
    'cloud' => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 18a4 4 0 0 1-.5-8 6 6 0 0 1 11.3-1.5A4.5 4.5 0 0 1 17 18z"/><path d="M12 12v6M9 15l3-3 3 3"/></svg>',
    'share' => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4"/></svg>',
    'lock' => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
    'lang' => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>',
    'phone' => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/></svg>',
  ];
  $feature = fn($icon, $title, $text) => '<div class="feat"><div class="fi">' . $ic[$icon] . '</div><h3>' . $title . '</h3><p>' . $text . '</p></div>';
  $shot = fn($file, $cap) => '<figure class="shot"><img src="/static/' . $file . '" alt="' . esc($cap) . '" loading="lazy"><figcaption>' . esc($cap) . '</figcaption></figure>';
  return '<section class="hero-site"><div class="hero-text"><span class="eyebrow">Companion für Magic: The Gathering Arena</span><h1>Dein Arena-Dashboard.<br>Auf dem PC, im Browser, auf dem Handy.</h1>
      <p>MTGA Stats liest Sammlung, Decks und Matches direkt aus Arena, spielt jedes Match als Replay ab und zeigt dir, welche Karten und Decks wirklich gewinnen – offline auf dem PC und synchronisiert hierher, sobald du online bist.</p>
      <p class="cta"><a class="btn primary big" href="/register">Kostenlos registrieren</a> <a class="btn big" href="/download">Companion herunterladen</a></p>
      <p class="muted small">Windows 10/11 · keine Kontodaten von Arena nötig · Bilder kommen von Scryfall, nichts wird lokal kopiert</p></div>
    <div class="hero-shot"><img src="/static/shot-dashboard.jpg" alt="Übersicht mit Winrate, Kacheln und Diagrammen"></div></section>
  <section class="stats-site"><div><b>' . (int)$stats['users'] . '</b><span>Spieler</span></div><div><b>' . (int)$stats['decks'] . '</b><span>geteilte Decks</span></div><div><b>' . (int)$stats['matches'] . '</b><span>aufgezeichnete Matches</span></div></section>

  <section class="features"><h2 class="sec-title">Was drinsteckt</h2><div class="feat-grid">' .
    $feature('chart', 'Statistik, die Fragen beantwortet', 'Winrate-Verlauf, Matches pro Tag, Spiellänge, Play/Draw, Tageszeiten, Winrate je Deck, Format und Gegner-Plattform – mit Zeitraum-, Format- und Deck-Filter.') .
    $feature('replay', 'Match-Replays wie in Arena', 'Jedes Match Schritt für Schritt: Spielfeld mit Ländern, Kreaturen, Stapel und Kommandozone, Handkarten, Lebenspunkte, Phasenleiste und Ereignisprotokoll. Mit Autoplay, Tempo und Vollbild.') .
    $feature('deck', 'Decks mit Tiefgang', 'Alle Arena-Decks als Boxen mit Artwork, Manakurve, Farbverteilung, Typenanteil und Matches je Deck. Export im Arena-Importformat mit einem Klick.') .
    $feature('lib', 'Bibliothek mit Besitzstand', 'Jede Arena-Karte mit deinen Exemplaren, Sets mit offiziellen Symbolen, Seltenheit, Typ, Farben – sortierbar nach Siegen, Einsätzen und Decks.') .
    $feature('cloud', 'Offline zuerst, Cloud danach', 'Der Companion arbeitet komplett ohne Internet. Sobald du online bist, gleicht er Matches, Decks und Sammlung mit dieser Website ab – idempotent, ohne Doppelungen.') .
    $feature('share', 'Decks teilen', 'Privat, per Link oder öffentlich: jede Deckseite hat eine eigene Adresse mit Kartenraster, Statistik und Export – auch für Leute ohne Konto.') .
  '</div></section>

  <section class="gallery"><h2 class="sec-title">Die Oberfläche</h2><div class="shots">' .
    $shot('shot-replay.jpg', 'Replay: Spielfeld, Stapel, Lebenspunkte und Protokoll – auch als Textkarten ohne Bilder') .
    $shot('shot-decks.jpg', 'Deckansicht: Artwork-Box, Kennzahlen, Manakurve, Farben und alle Karten nach Typ') .
    $shot('shot-builder.jpg', 'Deckbau: aus allen Karten des Spiels, Formatregeln, Export und Alternativen aus deiner Sammlung') .
    $shot('shot-library.jpg', 'Bibliothek: dein Besitzstand über alle Sets, filterbar und sortierbar') .
  '</div></section>

  <section class="how"><h2 class="sec-title">So funktioniert es</h2><ol class="steps">
    <li><b>1</b><h3>Companion installieren</h3><p>ZIP laden, <code>Install.cmd</code> doppelklicken. Läuft als Symbol im Infobereich, ohne Fenster, mit Autostart – Node.js wird bei Bedarf mitinstalliert.</p></li>
    <li><b>2</b><h3>Arena spielen</h3><p>Der Companion liest Sammlung und Decks aus dem Spiel und schreibt jedes Match mit – auch offline. Das Dashboard läuft lokal als eigenes App-Fenster.</p></li>
    <li><b>3</b><h3>Verbinden und teilen</h3><p>Konto anlegen, Code in den Einstellungen erzeugen, im Tray-Menü eingeben. Ab dann synchronisiert alles automatisch; Decks teilst du per Link.</p></li>
  </ol></section>

  <section class="trust"><div class="feat-grid three">' .
    $feature('lock', 'Sicher gebaut', 'Passwörter mit Argon2, Sitzungen als HttpOnly-Cookie, CSRF-Schutz, Rate-Limits, strikte Content-Security-Policy. Deine Daten bleiben auf deinem PC und auf dieser Seite – sonst nirgends.') .
    $feature('lang', 'Sieben Sprachen', 'Deutsch, Englisch, Französisch, Spanisch, Italienisch, Portugiesisch, Japanisch. Kartennamen und -texte bleiben wie in Arena auf Englisch.') .
    $feature('phone', 'Auch unterwegs', 'Die Website ist für das Handy optimiert: kompakte Navigation, einklappbare Abschnitte, Decks und Statistik in der Hosentasche.') .
  '</div></section>

  <section class="public"><h2 class="sec-title">Neue öffentliche Decks</h2>' . deck_list($decks) . '<p class="cta-line"><a class="btn primary" href="/register">Jetzt mitmachen</a> <a class="btn" href="/decks">Alle öffentlichen Decks</a></p></section>';
}
function page_register(array $values = []): string {
  return '<div class="card-form"><h1>Konto anlegen</h1><form method="post" action="/register">' . csrf_field() .
    field('Anzeigename', 'name', 'text', 'required maxlength="40" value="' . esc($values['name'] ?? '') . '"') . field('E-Mail', 'email', 'email', 'required autocomplete="email" value="' . esc($values['email'] ?? '') . '"') . field('Passwort (mindestens 10 Zeichen)', 'password', 'password', 'required minlength="10" autocomplete="new-password"') .
    '<button class="primary" type="submit">Registrieren</button></form>' . oauth_buttons() . '<p class="muted small">Schon ein Konto? <a href="/login">Anmelden</a></p></div>';
}
function page_login(string $next = '', string $resendFor = ''): string {
  $resend = $resendFor !== '' ? '<form method="post" action="/verify/resend-email" class="resend">' . csrf_field() . '<input type="hidden" name="email" value="' . esc($resendFor) . '"><button class="primary" type="submit">Bestätigungsmail erneut senden</button></form>' : '';
  return '<div class="card-form"><h1>Anmelden</h1>' . $resend . '<form method="post" action="/login">' . csrf_field() . '<input type="hidden" name="next" value="' . esc($next) . '">' .
    field('E-Mail', 'email', 'email', 'required autocomplete="email" value="' . esc($resendFor) . '"') . field('Passwort', 'password', 'password', 'required autocomplete="current-password"') .
    '<button class="primary" type="submit">Anmelden</button></form>' . oauth_buttons() . '<p class="muted small"><a href="/forgot">Passwort vergessen?</a> · Neu hier? <a href="/register">Registrieren</a></p></div>';
}
function page_forgot(): string { return '<div class="card-form"><h1>Passwort zurücksetzen</h1><form method="post" action="/forgot">' . csrf_field() . field('E-Mail', 'email', 'email', 'required') . '<button class="primary" type="submit">Link senden</button></form></div>'; }
function page_reset(string $token): string { return '<div class="card-form"><h1>Neues Passwort</h1><form method="post" action="/reset/' . esc($token) . '">' . csrf_field() . field('Neues Passwort (mindestens 10 Zeichen)', 'password', 'password', 'required minlength="10" autocomplete="new-password"') . '<button class="primary" type="submit">Speichern</button></form></div>'; }
function page_message(string $title, string $text, ?array $link = null): string { return '<div class="card-form"><h1>' . esc($title) . '</h1><p>' . esc($text) . '</p>' . ($link ? '<p><a class="btn" href="' . esc($link['href']) . '">' . esc($link['text']) . '</a></p>' : '') . '</div>'; }
function page_legal(string $title, string $text): string { return '<div class="card-form"><h1>' . esc($title) . '</h1><p>' . esc($text) . '</p></div>'; }
function page_download(string $downloadUrl, string $repoUrl): string {
  $btns = ($downloadUrl ? '<a class="btn primary" href="' . esc($downloadUrl) . '" download>⬇ ZIP herunterladen</a> ' : '') . ($repoUrl ? '<a class="btn" href="' . esc($repoUrl) . '" target="_blank" rel="noopener">Quellcode auf GitHub</a>' : '') . (!$downloadUrl && !$repoUrl ? '<span class="muted">Download noch nicht eingerichtet (github_repo in config.php).</span>' : '');
  return '<div class="card-form"><h1>Companion herunterladen</h1><p>Das lokale Tool läuft auf deinem Windows-PC neben Arena, funktioniert offline und synchronisiert hierher, sobald du online bist.</p><p>' . $btns . '</p>
    <ol><li>ZIP entpacken (z. B. nach <code>Dokumente\\MTGA Stats</code>).</li><li><code>Install.cmd</code> doppelklicken – installiert Node.js falls nötig, legt Startmenü-Einträge und Autostart an.</li><li>Hier unter <a href="/settings">Einstellungen</a> einen Verbindungscode erzeugen und im Tray-Menü unter „Mit Website verbinden…“ eingeben.</li></ol>
    <p class="muted small">Windows 10/11 · keine Adminrechte nötig (außer MTGA läuft selbst als Administrator).</p></div>';
}
function page_settings(array $user, array $devices, array $oauth, ?string $deviceCode, array $decks): string {
  $csrf = csrf_field();
  $providers = array_column($oauth, 'provider');
  $verify = cfg('verify_email', true);
  $devHtml = $devices ? '<table><tbody>' . implode('', array_map(fn($d) => '<tr><td><b>' . esc($d['name']) . '</b><div class="muted small">verbunden ' . esc(substr($d['created_at'], 0, 10)) . ' · zuletzt ' . esc(str_replace('T', ' ', substr((string)($d['last_sync_at'] ?: $d['last_seen_at'] ?: ''), 0, 16)) ?: 'nie') . '</div></td><td><form method="post" action="/settings/devices/' . esc($d['id']) . '/revoke">' . $csrf . '<button class="ghost small" type="submit">Trennen</button></form></td></tr>', $devices)) . '</tbody></table>' : '<p class="muted small">Noch kein Gerät verbunden.</p>';
  $sel = fn($d, $v) => $d['visibility'] === $v ? 'selected' : '';
  $deckHtml = $decks ? '<table><tbody>' . implode('', array_map(fn($d) => '<tr><td><b>' . esc($d['name']) . '</b><div class="muted small">' . esc($d['format'] ?? '') . ($d['share_slug'] && $d['visibility'] !== 'private' ? ' · <a href="/d/' . esc($d['share_slug']) . '/">/d/' . esc($d['share_slug']) . '</a>' : '') . '</div></td><td><form method="post" action="/decks/' . esc($d['id']) . '/visibility" class="inline">' . $csrf . '<select name="visibility" onchange="this.form.submit()"><option value="private" ' . $sel($d, 'private') . '>Privat</option><option value="link" ' . $sel($d, 'link') . '>Link</option><option value="public" ' . $sel($d, 'public') . '>Öffentlich</option></select></form></td></tr>', $decks)) . '</tbody></table>' : '<p class="muted small">Noch keine Decks synchronisiert.</p>';
  $mailState = $user['email_verified'] || !$verify
    ? '<span class="badge win">bestätigt</span>'
    : '<span class="badge loss">nicht bestätigt</span> <form method="post" action="/verify/resend" class="inline">' . $csrf . '<button class="primary small" type="submit">Bestätigungsmail senden</button></form>';
  return '<div class="topbar"><div><h1>Einstellungen</h1><div class="sub">Konto, Companion, Freigaben</div></div></div>
  <div class="settings-grid">
    <section class="panel"><h3>Profil</h3><form method="post" action="/settings/profile">' . $csrf .
      field('Anzeigename', 'name', 'text', 'required maxlength="40" value="' . esc($user['display_name']) . '"') . field('Profilname (Adresse /u/…)', 'handle', 'text', 'required pattern="[a-z0-9-]{3,24}" value="' . esc($user['handle']) . '"') . field('Arena-Name', 'arena_name', 'text', 'maxlength="40" value="' . esc($user['arena_name'] ?? '') . '"') .
      '<button class="primary" type="submit">Speichern</button></form></section>
    <section class="panel"><h3>E-Mail</h3><p class="small">' . esc($user['email']) . ' ' . $mailState . '</p>
      <form method="post" action="/settings/email">' . $csrf . field('Neue E-Mail-Adresse', 'email', 'email', 'required autocomplete="email"') . ($user['password_hash'] ? field('Passwort zur Bestätigung', 'current', 'password', 'required autocomplete="current-password"') : '') . '<button type="submit">E-Mail ändern</button></form>' .
      ($verify ? '<p class="muted small">Nach der Änderung schicken wir einen Bestätigungslink an die neue Adresse.</p>' : '') . '</section>
    <section class="panel"><h3>Companion verbinden</h3><p class="muted small">Im Tray-Menü des lokalen Tools „Mit Website verbinden…“ wählen und diesen Code eingeben. Er gilt 15 Minuten.</p>' .
      ($deviceCode ? '<div class="device-code">' . esc($deviceCode) . '</div>' : '') . '<form method="post" action="/settings/device-code">' . $csrf . '<button class="primary" type="submit">' . ($deviceCode ? 'Neuen Code erzeugen' : 'Code erzeugen') . '</button></form>
      <h3 style="margin-top:18px">Verbundene Geräte</h3>' . $devHtml . '</section>
    <section class="panel"><h3>Passwort</h3><form method="post" action="/settings/password">' . $csrf . ($user['password_hash'] ? field('Aktuelles Passwort', 'current', 'password', 'required autocomplete="current-password"') : '') . field('Neues Passwort (mindestens 10 Zeichen)', 'password', 'password', 'required minlength="10" autocomplete="new-password"') . '<button type="submit">Passwort ändern</button></form>
      <h3 style="margin-top:18px">Verknüpfte Konten</h3><p class="muted small">' . ($providers ? implode(' ', array_map(fn($p) => '<span class="badge unk">' . esc($p) . '</span>', $providers)) : 'keine') . '</p>' . (oauth_enabled('discord') && !in_array('discord', $providers, true) ? '<a class="btn small" href="/auth/discord">Discord verknüpfen</a> ' : '') . (oauth_enabled('google') && !in_array('google', $providers, true) ? '<a class="btn small" href="/auth/google">Google verknüpfen</a>' : '') . '
      <h3 style="margin-top:18px">Sitzungen</h3><form method="post" action="/settings/logout-all">' . $csrf . '<button class="ghost small" type="submit">Überall abmelden</button></form></section>
    <section class="panel wide"><h3>Deck-Freigaben</h3><p class="muted small">Privat: nur du. Link: jeder mit dem Link. Öffentlich: zusätzlich auf der Startseite und in deinem Profil.</p>' . $deckHtml . '</section>
  </div>';
}
function deck_list(array $decks): string {
  if (!$decks) return '<p class="muted">Noch keine öffentlichen Decks.</p>';
  return '<div class="deck-cards">' . implode('', array_map(fn($d) => '<a class="deck-card" href="/d/' . esc($d['share_slug']) . '/"><div class="art"><img src="/card-img/' . (int)($d['tile'] ?? 0) . '?v=normal" alt="" loading="lazy" onerror="this.remove()"></div><div class="body"><b>' . esc($d['name']) . '</b><span class="muted small">' . esc($d['format'] ?? '') . ' · ' . esc($d['commander'] ?? '') . '</span><span class="muted small">von <a href="/p/' . esc($d['handle']) . '">' . esc($d['display_name']) . '</a> · ' . esc(substr((string)$d['updated_at'], 0, 10)) . '</span></div></a>', $decks)) . '</div>';
}
