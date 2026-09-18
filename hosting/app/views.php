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
  $nav = $user
    ? '<a href="/u/' . esc($user['handle']) . '/">Mein Dashboard</a><a href="/u/' . esc($user['handle']) . '/decks.html">Meine Decks</a><a href="/settings">Einstellungen</a><form method="post" action="/logout" class="inline"><input type="hidden" name="csrf" value="' . $csrf . '"><button class="ghost small" type="submit">Abmelden</button></form>'
    : '<a href="/decks">Öffentliche Decks</a><a href="/login">Anmelden</a><a class="btn" href="/register">Registrieren</a>';
  $flashHtml = $flash ? '<div class="flash ' . esc($flash['kind'] ?? 'info') . '">' . esc($flash['text'] ?? '') . '</div>' : '';
  return '<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>' . esc($title) . ' · MTGA Stats</title>
<link rel="icon" href="/static/favicon.ico" sizes="any"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Cinzel:wght@600;700;800&display=swap"><link rel="stylesheet" href="/static/app.css"><link rel="stylesheet" href="/static/site.css"></head>
<body class="site"><header class="site-head"><a class="brand" href="/">' . logo_svg() . '<span><b>MTGA Stats</b><small>Decks, Matches, Sammlung</small></span></a><nav>' . $nav . '</nav></header>
<main class="site-main ' . ($wide ? 'wide' : '') . '">' . $flashHtml . $body . '</main>
<footer class="site-foot">MTGA Stats ist inoffizieller Fan-Inhalt gemäß der Fan Content Policy von Wizards of the Coast. Kartenbilder von <a href="https://scryfall.com" rel="noopener">Scryfall</a>. · <a href="/impressum">Impressum</a> · <a href="/datenschutz">Datenschutz</a></footer></body></html>';
}

function field(string $label, string $name, string $type = 'text', string $extra = ''): string { return '<label class="fld"><span>' . esc($label) . '</span><input name="' . $name . '" type="' . $type . '" ' . $extra . '></label>'; }
function oauth_buttons(): string {
  $d = oauth_enabled('discord'); $g = oauth_enabled('google');
  if (!$d && !$g) return '';
  return '<div class="oauth"><span class="muted small">oder</span>' . ($d ? '<a class="btn oauth-btn discord" href="/auth/discord">Mit Discord anmelden</a>' : '') . ($g ? '<a class="btn oauth-btn google" href="/auth/google">Mit Google anmelden</a>' : '') . '</div>';
}
function csrf_field(): string { return '<input type="hidden" name="csrf" value="' . csrf_token() . '">'; }

function page_home(array $decks, array $stats): string {
  return '<section class="hero-site"><div><h1>Dein Arena-Dashboard, überall.</h1><p>Der lokale Begleiter zeichnet Sammlung, Decks und Matches auf deinem PC auf und synchronisiert sie hierher, sobald du online bist. Teile Decks per Link, vergleiche Statistiken, behalte alles im Blick.</p><p><a class="btn primary" href="/register">Kostenlos registrieren</a> <a class="btn" href="/download">Companion herunterladen</a></p></div>
    <div class="stats-site"><div><b>' . (int)$stats['users'] . '</b><span>Spieler</span></div><div><b>' . (int)$stats['decks'] . '</b><span>geteilte Decks</span></div><div><b>' . (int)$stats['matches'] . '</b><span>Matches</span></div></div></section>
    <h2>Neue öffentliche Decks</h2>' . deck_list($decks);
}
function page_register(array $values = []): string {
  return '<div class="card-form"><h1>Konto anlegen</h1><form method="post" action="/register">' . csrf_field() .
    field('Anzeigename', 'name', 'text', 'required maxlength="40" value="' . esc($values['name'] ?? '') . '"') . field('E-Mail', 'email', 'email', 'required autocomplete="email" value="' . esc($values['email'] ?? '') . '"') . field('Passwort (mindestens 10 Zeichen)', 'password', 'password', 'required minlength="10" autocomplete="new-password"') .
    '<button class="primary" type="submit">Registrieren</button></form>' . oauth_buttons() . '<p class="muted small">Schon ein Konto? <a href="/login">Anmelden</a></p></div>';
}
function page_login(string $next = ''): string {
  return '<div class="card-form"><h1>Anmelden</h1><form method="post" action="/login">' . csrf_field() . '<input type="hidden" name="next" value="' . esc($next) . '">' .
    field('E-Mail', 'email', 'email', 'required autocomplete="email"') . field('Passwort', 'password', 'password', 'required autocomplete="current-password"') .
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
  $devHtml = $devices ? '<table><tbody>' . implode('', array_map(fn($d) => '<tr><td><b>' . esc($d['name']) . '</b><div class="muted small">verbunden ' . esc(substr($d['created_at'], 0, 10)) . ' · zuletzt ' . esc(str_replace('T', ' ', substr((string)($d['last_sync_at'] ?: $d['last_seen_at'] ?: ''), 0, 16)) ?: 'nie') . '</div></td><td><form method="post" action="/settings/devices/' . esc($d['id']) . '/revoke">' . $csrf . '<button class="ghost small" type="submit">Trennen</button></form></td></tr>', $devices)) . '</tbody></table>' : '<p class="muted small">Noch kein Gerät verbunden.</p>';
  $sel = fn($d, $v) => $d['visibility'] === $v ? 'selected' : '';
  $deckHtml = $decks ? '<table><tbody>' . implode('', array_map(fn($d) => '<tr><td><b>' . esc($d['name']) . '</b><div class="muted small">' . esc($d['format'] ?? '') . ($d['share_slug'] && $d['visibility'] !== 'private' ? ' · <a href="/d/' . esc($d['share_slug']) . '/">/d/' . esc($d['share_slug']) . '</a>' : '') . '</div></td><td><form method="post" action="/decks/' . esc($d['id']) . '/visibility" class="inline">' . $csrf . '<select name="visibility" onchange="this.form.submit()"><option value="private" ' . $sel($d, 'private') . '>Privat</option><option value="link" ' . $sel($d, 'link') . '>Link</option><option value="public" ' . $sel($d, 'public') . '>Öffentlich</option></select></form></td></tr>', $decks)) . '</tbody></table>' : '<p class="muted small">Noch keine Decks synchronisiert.</p>';
  return '<h1>Einstellungen</h1><div class="grid c2">
    <div class="panel"><h3>Profil</h3><form method="post" action="/settings/profile">' . $csrf .
      field('Anzeigename', 'name', 'text', 'required maxlength="40" value="' . esc($user['display_name']) . '"') . field('Profilname (Adresse /u/…)', 'handle', 'text', 'required pattern="[a-z0-9-]{3,24}" value="' . esc($user['handle']) . '"') . field('Arena-Name', 'arena_name', 'text', 'maxlength="40" value="' . esc($user['arena_name'] ?? '') . '"') .
      '<p class="muted small">E-Mail: ' . esc($user['email']) . ' ' . ($user['email_verified'] ? '<span class="badge win">bestätigt</span>' : '<span class="badge loss">nicht bestätigt</span> <a href="/verify/resend">erneut senden</a>') . '</p><button class="primary" type="submit">Speichern</button></form></div>
    <div class="panel"><h3>Companion verbinden</h3><p class="muted small">Im Tray-Menü des lokalen Tools „Mit Website verbinden…“ wählen und diesen Code eingeben. Er gilt 15 Minuten.</p>' .
      ($deviceCode ? '<div class="device-code">' . esc($deviceCode) . '</div>' : '') . '<form method="post" action="/settings/device-code">' . $csrf . '<button type="submit">' . ($deviceCode ? 'Neuen Code erzeugen' : 'Code erzeugen') . '</button></form>
      <h3 style="margin-top:18px">Verbundene Geräte</h3>' . $devHtml . '</div>
    <div class="panel"><h3>Passwort</h3><form method="post" action="/settings/password">' . $csrf . ($user['password_hash'] ? field('Aktuelles Passwort', 'current', 'password', 'required autocomplete="current-password"') : '') . field('Neues Passwort (mindestens 10 Zeichen)', 'password', 'password', 'required minlength="10" autocomplete="new-password"') . '<button type="submit">Passwort ändern</button></form>
      <h3 style="margin-top:18px">Verknüpfte Konten</h3><p class="muted small">' . ($providers ? implode(' ', array_map(fn($p) => '<span class="badge unk">' . esc($p) . '</span>', $providers)) : 'keine') . '</p>' . (oauth_enabled('discord') && !in_array('discord', $providers, true) ? '<a class="btn small" href="/auth/discord">Discord verknüpfen</a> ' : '') . (oauth_enabled('google') && !in_array('google', $providers, true) ? '<a class="btn small" href="/auth/google">Google verknüpfen</a>' : '') . '</div>
    <div class="panel"><h3>Deck-Freigaben</h3><p class="muted small">Privat: nur du. Link: jeder mit dem Link. Öffentlich: zusätzlich auf der Startseite und in deinem Profil.</p>' . $deckHtml . '</div>
    <div class="panel"><h3>Sitzungen</h3><form method="post" action="/settings/logout-all">' . $csrf . '<button class="ghost" type="submit">Überall abmelden</button></form></div></div>';
}
function deck_list(array $decks): string {
  if (!$decks) return '<p class="muted">Noch keine öffentlichen Decks.</p>';
  return '<div class="deck-cards">' . implode('', array_map(fn($d) => '<a class="deck-card" href="/d/' . esc($d['share_slug']) . '/"><div class="art"><img src="/card-img/' . (int)($d['tile'] ?? 0) . '?v=normal" alt="" loading="lazy" onerror="this.remove()"></div><div class="body"><b>' . esc($d['name']) . '</b><span class="muted small">' . esc($d['format'] ?? '') . ' · ' . esc($d['commander'] ?? '') . '</span><span class="muted small">von <a href="/p/' . esc($d['handle']) . '">' . esc($d['display_name']) . '</a> · ' . esc(substr((string)$d['updated_at'], 0, 10)) . '</span></div></a>', $decks)) . '</div>';
}
