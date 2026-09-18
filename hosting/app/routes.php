<?php
// Routen: Seiten (Start, Konto, Einstellungen, Freigaben, OAuth), Sync-API für den Companion, Nutzer-Dashboards.
declare(strict_types=1);

function render(string $title, string $body, array $o = [], int $status = 200): never { send($status, layout($title, $body, $o)); }
function require_user(): array { $u = current_user(); if (!$u) redirect('/login?next=' . rawurlencode(req_url())); return $u; }
function require_csrf(): void { if (!csrf_ok()) render('Fehler', page_message('Formular abgelaufen', 'Bitte die Seite neu laden und noch einmal versuchen.'), [], 403); }
function safe_next(string $n): string { return preg_match('#^/[^/\\\\]#', $n) ? $n : '/app'; }
function commander_name(array $d): string {
  $z = json_decode($d['zones'] ?? '', true) ?: [];
  $names = [];
  foreach ($z['CommandZone'] ?? [] as $p) { $r = card_row((int)$p[0]); if ($r) $names[] = $r['name']; }
  return implode(', ', $names);
}
function public_decks(int $limit, ?string $userId = null): array {
  $rows = $userId
    ? db_all("SELECT d.*, u.handle, u.display_name FROM decks d JOIN users u ON u.id = d.user_id WHERE d.user_id = ? AND d.visibility = 'public' AND d.deleted_at IS NULL ORDER BY d.updated_at DESC LIMIT $limit", $userId)
    : db_all("SELECT d.*, u.handle, u.display_name FROM decks d JOIN users u ON u.id = d.user_id WHERE d.visibility = 'public' AND d.deleted_at IS NULL ORDER BY d.updated_at DESC LIMIT $limit");
  foreach ($rows as &$d) $d['commander'] = commander_name($d);
  return $rows;
}
function set_session_cookie(string $raw): void { cookie_set(SESSION_COOKIE, $raw, (int)cfg('session_days', 30) * 86400); }

/** Verteilt eine Anfrage; $m = Methode, $p = Pfad */
function dispatch(string $m, string $p): void {
  // ---- statische Dateien: eigene (static/), Frontend (web/), Icons (assets/) ----
  if (preg_match('#^/static/([A-Za-z0-9_.-]+)$#', $p, $x) && preg_match('/\.(css|js|png|jpg|ico|webmanifest|svg)$/', $x[1])) {
    foreach ([STATIC_DIR, WEB_DIR, ASSETS_DIR] as $dir) if (is_file("$dir/{$x[1]}")) send_file("$dir/{$x[1]}", mime_of($x[1]), 'public, max-age=3600');
    send(404, 'nicht gefunden', 'text/plain');
  }
  if ($p === '/cron') {   // URL-Cron ohne .php (gleich wie cron.php)
    if (cfg('cron_key', '') === '' || !hash_equals((string)cfg('cron_key'), query('key'))) send(403, "key fehlt oder falsch\n", 'text/plain; charset=utf-8');
    set_time_limit(120); $msg = cards_sync_step(25); app_log('Cron: ' . $msg); send(200, $msg . "\n", 'text/plain; charset=utf-8');
  }
  if ($p === '/mailtest') {   // Mailversand prüfen: /mailtest?key=CRON_KEY&to=du@example.de
    if (cfg('cron_key', '') === '' || !hash_equals((string)cfg('cron_key'), query('key'))) send(403, "key fehlt oder falsch\n", 'text/plain; charset=utf-8');
    $to = trim(query('to')); if (!filter_var($to, FILTER_VALIDATE_EMAIL)) send(400, "to=E-Mail-Adresse fehlt\n", 'text/plain; charset=utf-8');
    $before = @filesize(DATA_DIR . '/app.log') ?: 0;
    $ok = mail_send($to, 'MTGA Stats: Testmail', "Wenn du das liest, funktioniert der Mailversand (Modus: " . cfg('mail.mode', 'mail') . ").\n" . cfg('base_url'));
    $log = @file_get_contents(DATA_DIR . '/app.log', false, null, $before) ?: '';
    send(200, "Modus: " . cfg('mail.mode', 'mail') . "\nAbsender: " . cfg('mail.from') . "\nErgebnis: " . ($ok ? 'gesendet (Postfach und Spam-Ordner prüfen)' : 'FEHLGESCHLAGEN') . "\n" . ($log ? "Protokoll:\n" . $log : ''), 'text/plain; charset=utf-8');
  }
  if ($p === '/healthz') send_json(200, ['ok' => true, 'cards' => (int)db_val('SELECT COUNT(*) FROM cards')]);
  if (preg_match('#^/card-img/(\d+)$#', $p, $x)) card_img((int)$x[1]);

  // ---- API für den Companion ----
  if (str_starts_with($p, '/api/v1/')) { api_dispatch($m, $p); return; }

  // ---- Dashboards ----
  if (preg_match('#^/u/([a-z0-9-]+)(/.*)?$#', $p, $x)) { dash_user($x[1], $x[2] ?? ''); return; }
  if (preg_match('#^/d/([A-Za-z0-9_-]+)(/.*)?$#', $p, $x)) { dash_deck($x[1], $x[2] ?? ''); return; }

  $flash = flash_take();
  $user = current_user();

  if ($p === '/' && $m === 'GET') {
    if ($user && query('site') === '') redirect('/app');   // angemeldet: direkt ins Dashboard (Startseite über /?site=1 erreichbar)
    $stats = ['users' => db_val('SELECT COUNT(*) FROM users'), 'decks' => db_val("SELECT COUNT(*) FROM decks WHERE visibility = 'public' AND deleted_at IS NULL"), 'matches' => db_val('SELECT COUNT(*) FROM matches')];
    render('Start', page_home(public_decks(8), $stats), ['flash' => $flash, 'wide' => true, 'main' => 'home', 'plain' => true]);
  }
  if ($p === '/decks') render('Öffentliche Decks', '<h1>Öffentliche Decks</h1>' . deck_list(public_decks(60)));
  if ($p === '/download') { $repo = (string)cfg('github_repo', ''); $dl = (string)cfg('download_url', '') ?: ($repo ? "https://github.com/$repo/archive/refs/heads/main.zip" : ''); render('Companion', page_download($dl, $repo ? "https://github.com/$repo" : '')); }
  if ($p === '/impressum') render('Impressum', page_legal('Impressum', 'Angaben zum Betreiber bitte hier eintragen (Name, Anschrift, Kontakt).'));
  if ($p === '/datenschutz') render('Datenschutz', page_legal('Datenschutz', 'Gespeichert werden E-Mail-Adresse, Anzeigename, verknüpfte Konten sowie die vom Companion synchronisierten Spieldaten (Decks, Matches, Sammlung). Kartenbilder werden von Scryfall geladen. Sitzungen laufen über ein HttpOnly-Cookie.'));
  if ($p === '/app' || $p === '/app/') { $u = require_user(); redirect('/u/' . $u['handle'] . '/'); }

  // ---- Registrierung ----
  if ($p === '/register' && $m === 'GET') render('Registrieren', page_register(), ['flash' => $flash]);
  if ($p === '/register' && $m === 'POST') {
    rate_limit('register', 10, 900); require_csrf();
    if (!cfg('registration_open', true)) render('Registrieren', page_message('Registrierung geschlossen', 'Zurzeit werden keine neuen Konten angelegt.'));
    $name = trim(post('name')); $email = trim(post('email')); $pw = post('password');
    if (mb_strlen($name) < 2 || mb_strlen($name) > 40 || !filter_var($email, FILTER_VALIDATE_EMAIL) || mb_strlen($email) > 200 || password_problem($pw))
      render('Registrieren', page_register($_POST), ['flash' => ['kind' => 'error', 'text' => password_problem($pw) ?: 'Bitte Name, gültige E-Mail und ein Passwort mit mindestens 10 Zeichen angeben.']]);
    $verify = cfg('verify_email', true);
    if (!get_user_by_email($email)) {   // keine Auskunft, ob die Adresse existiert
      $u = create_user($email, $pw, $name, !$verify);
      if ($verify) {
        $token = create_email_token($u['id'], 'verify', 24);
        $link = cfg('base_url') . "/verify/$token";
        $sent = mail_verify($u['email'], $link);
        app_log("Bestätigungslink für $email" . ($sent ? '' : ' (Mail nicht gesendet)') . ": $link");   // immer protokollieren, falls die Mail nicht ankommt
      }
    }
    if (!$verify) { $nu = get_user_by_email($email); if ($nu && verify_password($pw, $nu['password_hash'])) { set_session_cookie(create_session($nu['id'])); redirect('/app'); } flash_set('ok', 'Konto angelegt. Du kannst dich jetzt anmelden.'); redirect('/login'); }
    render('Fast geschafft', page_message('Bitte E-Mail bestätigen', "Wir haben eine Nachricht an $email geschickt. Klicke den Link darin, dann kannst du dich anmelden.", ['href' => '/login', 'text' => 'Zur Anmeldung']));
  }
  if ($p === '/verify/resend') {
    $u = require_user();
    if (!$u['email_verified']) { $token = create_email_token($u['id'], 'verify', 24); $link = cfg('base_url') . "/verify/$token"; $sent = mail_verify($u['email'], $link); app_log("Bestätigungslink für {$u['email']}" . ($sent ? '' : ' (Mail nicht gesendet)') . ": $link"); }
    flash_set('ok', 'Bestätigungsmail gesendet.'); redirect('/settings');
  }
  if (preg_match('#^/verify/([A-Za-z0-9_-]+)$#', $p, $x)) {
    $u = consume_email_token($x[1], 'verify');
    if (!$u) render('Link ungültig', page_message('Link ungültig oder abgelaufen', 'Fordere in den Einstellungen eine neue Bestätigungsmail an.', ['href' => '/login', 'text' => 'Zur Anmeldung']));
    db_run('UPDATE users SET email_verified = 1 WHERE id = ?', $u['id']);
    set_session_cookie(create_session($u['id'])); redirect('/app');   // bestätigt = angemeldet, direkt ins Dashboard
  }

  // ---- Anmelden / Abmelden ----
  if ($p === '/login' && $m === 'GET') render('Anmelden', page_login(query('next')), ['flash' => $flash]);
  if ($p === '/login' && $m === 'POST') {
    rate_limit('login', 20, 900); require_csrf();
    $u = get_user_by_email(post('email')); $next = post('next');
    $ok = $u && verify_password(post('password'), $u['password_hash']);
    if (!$ok) { if (!$u) verify_password('x', hash_password('gleiche-zeit')); render('Anmelden', page_login($next), ['flash' => ['kind' => 'error', 'text' => 'E-Mail oder Passwort stimmen nicht.']]); }
    if (!$u['email_verified'] && cfg('verify_email', true)) render('Anmelden', page_login($next, $u['email']), ['flash' => ['kind' => 'error', 'text' => 'Bitte zuerst die E-Mail-Adresse bestätigen – Link in der Mail, oder unten eine neue anfordern.']]);
    set_session_cookie(create_session($u['id'])); redirect(safe_next($next));
  }
  if ($p === '/logout' && $m === 'POST') { require_csrf(); destroy_session(cookie(SESSION_COOKIE)); cookie_clear(SESSION_COOKIE); redirect('/'); }

  // ---- Passwort vergessen / zurücksetzen ----
  if ($p === '/forgot' && $m === 'GET') render('Passwort zurücksetzen', page_forgot());
  if ($p === '/forgot' && $m === 'POST') {
    rate_limit('forgot', 5, 900); require_csrf();
    $u = get_user_by_email(post('email'));
    if ($u && $u['password_hash']) { $token = create_email_token($u['id'], 'reset', 2); $link = cfg('base_url') . "/reset/$token"; $sent = mail_reset($u['email'], $link); app_log("Reset-Link für {$u['email']}" . ($sent ? '' : ' (Mail nicht gesendet)') . ": $link"); }
    render('Passwort zurücksetzen', page_message('Mail unterwegs', 'Wenn ein Konto zu dieser Adresse existiert, ist ein Link zum Zurücksetzen unterwegs (2 Stunden gültig).'));
  }
  if (preg_match('#^/reset/([A-Za-z0-9_-]+)$#', $p, $x)) {
    if ($m === 'GET') render('Neues Passwort', page_reset($x[1]));
    require_csrf();
    if ($e = password_problem(post('password'))) render('Neues Passwort', page_reset($x[1]), ['flash' => ['kind' => 'error', 'text' => $e]]);
    $u = consume_email_token($x[1], 'reset');
    if (!$u) render('Link ungültig', page_message('Link ungültig oder abgelaufen', 'Bitte einen neuen Link anfordern.', ['href' => '/forgot', 'text' => 'Neuen Link anfordern']));
    db_run('UPDATE users SET password_hash = ?, email_verified = 1 WHERE id = ?', hash_password(post('password')), $u['id']);
    destroy_all_sessions($u['id']);
    flash_set('ok', 'Passwort geändert. Bitte neu anmelden.'); redirect('/login');
  }

  // ---- OAuth ----
  if (preg_match('#^/auth/(discord|google)$#', $p, $x)) {
    if (!oauth_enabled($x[1])) send(404, 'nicht aktiviert', 'text/plain');
    $state = random_id(16);
    cookie_set('mtgs_oauth', json_out(['p' => $x[1], 'state' => $state]), 600, '/auth');
    redirect(oauth_start($x[1], $state));
  }
  if (preg_match('#^/auth/(discord|google)/callback$#', $p, $x)) {
    $prov = $x[1]; $st = json_decode(cookie('mtgs_oauth'), true); cookie_clear('mtgs_oauth', '/auth');
    if (!oauth_enabled($prov) || !is_array($st) || ($st['p'] ?? '') !== $prov || ($st['state'] ?? '') !== query('state') || query('code') === '') { flash_set('error', "Anmeldung über $prov abgebrochen."); redirect('/login'); }
    try {
      $profile = oauth_finish($prov, query('code'));
      if ($user) { db_insert_ignore('oauth_accounts', ['provider' => $prov, 'provider_id' => $profile['id'], 'user_id' => $user['id'], 'email' => $profile['email'], 'created_at' => now_iso()]); flash_set('ok', "$prov verknüpft."); redirect('/settings'); }
      $u = user_for_oauth($prov, $profile);
      if (!$u) { flash_set('error', 'Registrierung ist geschlossen.'); redirect('/login'); }
      set_session_cookie(create_session($u['id'])); redirect('/app');
    } catch (Throwable $e) { app_log('OAuth: ' . $e->getMessage()); flash_set('error', "Anmeldung über $prov fehlgeschlagen."); redirect('/login'); }
  }

  // ---- Einstellungen ----
  $settings = function (?string $code) use ($flash) {
    $u = require_user();
    render('Einstellungen', page_settings($u,
      db_all('SELECT * FROM devices WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at', $u['id']),
      db_all('SELECT provider FROM oauth_accounts WHERE user_id = ?', $u['id']), $code,
      db_all('SELECT id, name, format, visibility, share_slug FROM decks WHERE user_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC', $u['id'])), ['flash' => $flash, 'wide' => true, 'active' => '/settings']);
  };
  if ($p === '/settings') $settings(null);
  if ($p === '/settings/device-code' && $m === 'POST') { $u = require_user(); require_csrf(); $settings(create_device_code($u['id'])); }
  if (preg_match('#^/settings/devices/([A-Za-z0-9_-]+)/revoke$#', $p, $x) && $m === 'POST') { $u = require_user(); require_csrf(); db_run('UPDATE devices SET revoked_at = ? WHERE id = ? AND user_id = ?', now_iso(), $x[1], $u['id']); flash_set('ok', 'Gerät getrennt.'); redirect('/settings'); }
  if ($p === '/settings/profile' && $m === 'POST') {
    $u = require_user(); require_csrf();
    $name = trim(post('name')); $handle = trim(post('handle')); $arena = trim(post('arena_name'));
    if (mb_strlen($name) < 2 || mb_strlen($name) > 40 || !preg_match('/^[a-z0-9-]{3,24}$/', $handle) || mb_strlen($arena) > 40) { flash_set('error', 'Ungültige Eingaben (Profilname: 3–24 Zeichen, a–z, 0–9, Bindestrich).'); redirect('/settings'); }
    if (db_get('SELECT 1 FROM users WHERE handle = ? AND id != ?', $handle, $u['id'])) { flash_set('error', 'Dieser Profilname ist schon vergeben.'); redirect('/settings'); }
    db_run('UPDATE users SET display_name = ?, handle = ?, arena_name = ? WHERE id = ?', $name, $handle, $arena ?: null, $u['id']);
    flash_set('ok', 'Profil gespeichert.'); redirect('/settings');
  }
  if ($p === '/settings/password' && $m === 'POST') {
    $u = require_user(); require_csrf();
    if ($u['password_hash'] && !verify_password(post('current'), $u['password_hash'])) { flash_set('error', 'Das aktuelle Passwort stimmt nicht.'); redirect('/settings'); }
    if ($e = password_problem(post('password'))) { flash_set('error', $e); redirect('/settings'); }
    db_run('UPDATE users SET password_hash = ? WHERE id = ?', hash_password(post('password')), $u['id']);
    flash_set('ok', 'Passwort geändert.'); redirect('/settings');
  }
  if ($p === '/settings/email' && $m === 'POST') {
    $u = require_user(); require_csrf();
    $email = norm_email(post('email'));
    if (!filter_var($email, FILTER_VALIDATE_EMAIL) || mb_strlen($email) > 200) { flash_set('error', 'Bitte eine gültige E-Mail-Adresse angeben.'); redirect('/settings'); }
    if ($u['password_hash'] && !verify_password(post('current'), $u['password_hash'])) { flash_set('error', 'Das Passwort stimmt nicht.'); redirect('/settings'); }
    if ($email === $u['email']) { flash_set('ok', 'Das ist bereits deine Adresse.'); redirect('/settings'); }
    if (db_get('SELECT 1 FROM users WHERE email = ? AND id != ?', $email, $u['id'])) { flash_set('error', 'Diese Adresse wird schon verwendet.'); redirect('/settings'); }
    $verify = cfg('verify_email', true);
    db_run('UPDATE users SET email = ?, email_verified = ? WHERE id = ?', $email, $verify ? 0 : 1, $u['id']);
    if ($verify) { $token = create_email_token($u['id'], 'verify', 24); $link = cfg('base_url') . "/verify/$token"; $sent = mail_verify($email, $link); app_log("Bestätigungslink für $email" . ($sent ? '' : ' (Mail nicht gesendet)') . ": $link"); flash_set('ok', 'E-Mail geändert. Bitte die neue Adresse über den zugeschickten Link bestätigen.'); }
    else flash_set('ok', 'E-Mail geändert.');
    redirect('/settings');
  }
  if ($p === '/verify/resend-email' && $m === 'POST') {   // von der Anmeldeseite, ohne Sitzung (keine Auskunft, ob die Adresse existiert)
    rate_limit('resend', 5, 900); require_csrf();
    $u = get_user_by_email(post('email'));
    if ($u && !$u['email_verified']) { $token = create_email_token($u['id'], 'verify', 24); $link = cfg('base_url') . "/verify/$token"; $sent = mail_verify($u['email'], $link); app_log("Bestätigungslink für {$u['email']}" . ($sent ? '' : ' (Mail nicht gesendet)') . ": $link"); }
    render('Bestätigung', page_message('Mail unterwegs', 'Wenn zu dieser Adresse ein unbestätigtes Konto existiert, ist ein neuer Bestätigungslink unterwegs (24 Stunden gültig).', ['href' => '/login', 'text' => 'Zur Anmeldung']));
  }
  if ($p === '/settings/logout-all' && $m === 'POST') { $u = require_user(); require_csrf(); destroy_all_sessions($u['id']); cookie_clear(SESSION_COOKIE); redirect('/login'); }
  if (preg_match('#^/decks/([^/]+)/visibility$#', $p, $x) && $m === 'POST') {
    $u = require_user(); require_csrf();
    $v = post('visibility'); $id = rawurldecode($x[1]);
    if (!in_array($v, ['private', 'link', 'public'], true)) send(400, 'ungültig', 'text/plain');
    $d = db_get('SELECT share_slug FROM decks WHERE id = ? AND user_id = ?', $id, $u['id']);
    if (!$d) send(404, 'nicht gefunden', 'text/plain');
    db_run('UPDATE decks SET visibility = ?, share_slug = ? WHERE id = ? AND user_id = ?', $v, $d['share_slug'] ?: random_id(8), $id, $u['id']);
    flash_set('ok', 'Freigabe geändert.'); redirect('/settings');
  }

  // ---- Öffentliches Profil ----
  if (preg_match('#^/p/([a-z0-9-]+)$#', $p, $x)) {
    $u = get_user_by_handle($x[1]);
    if (!$u) render('Nicht gefunden', page_message('Profil nicht gefunden', ''), [], 404);
    render($u['display_name'], '<h1>' . esc($u['display_name']) . '</h1><p class="muted">' . esc($u['arena_name'] ? 'Arena: ' . $u['arena_name'] : '') . '</p><h2>Öffentliche Decks</h2>' . deck_list(public_decks(100, $u['id'])));
  }

  render('Nicht gefunden', page_message('Seite nicht gefunden', '', ['href' => '/', 'text' => 'Zur Startseite']), [], 404);
}

function card_img(int $grpId): never {
  $v = query('v'); $v = in_array($v, ['small', 'large', 'art'], true) ? $v : 'normal';
  $url = card_image_url($grpId, $v);
  if (!$url) send(404, '', 'text/plain');
  header('Cache-Control: public, max-age=86400'); redirect($url);
}

// ---- API für den Companion (Gerätetoken im Authorization-Header) ------------------------------------
function api_device(): array {
  $h = (string)($_SERVER['HTTP_AUTHORIZATION'] ?? ($_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? ''));
  $r = str_starts_with($h, 'Bearer ') ? device_from_token(trim(substr($h, 7))) : null;
  if (!$r) send_json(401, ['error' => 'Gerätetoken ungültig']);
  return $r;
}
function api_dispatch(string $m, string $p): void {
  if ($p === '/api/v1/device/claim' && $m === 'POST') {
    rate_limit('claim', 10, 900);
    $b = req_json() ?: [];
    $code = (string)($b['code'] ?? '');
    if (strlen($code) < 6 || strlen($code) > 12) send_json(400, ['error' => 'code fehlt']);
    $r = claim_device_code($code, isset($b['name']) ? (string)$b['name'] : null);
    if (!$r) send_json(404, ['error' => 'Code ungültig oder abgelaufen']);
    send_json(200, ['token' => $r['token'], 'deviceId' => $r['deviceId'], 'user' => ['handle' => $r['user']['handle'], 'displayName' => $r['user']['display_name']]]);
  }
  if ($p === '/api/v1/me') {
    $r = api_device();
    send_json(200, ['user' => ['handle' => $r['user']['handle'], 'displayName' => $r['user']['display_name']], 'device' => ['id' => $r['device']['id'], 'name' => $r['device']['name']],
      'decks' => (int)db_val('SELECT COUNT(*) FROM decks WHERE user_id = ? AND deleted_at IS NULL', $r['user']['id']), 'matches' => (int)db_val('SELECT COUNT(*) FROM matches WHERE user_id = ?', $r['user']['id']),
      'limits' => ['postMaxBytes' => ini_bytes(ini_get('post_max_size'))]]);
  }
  if ($p === '/api/v1/sync' && $m === 'POST') {
    $r = api_device(); rate_limit('sync', 120, 60);
    $b = req_json();
    if (!$b || !isset($b['events']) || !is_array($b['events']) || count($b['events']) > 200) send_json(400, ['error' => 'ungültige Daten']);
    $accepted = []; $skipped = []; $failed = [];
    foreach ($b['events'] as $ev) {
      $id = (string)($ev['id'] ?? ''); $kind = (string)($ev['kind'] ?? '');
      if (strlen($id) < 8 || strlen($id) > 80 || !in_array($kind, ['match', 'deck', 'deck_deleted', 'collection', 'account'], true)) { $failed[] = ['id' => $id, 'error' => 'ungültiges Ereignis']; continue; }
      if (db_get('SELECT 1 FROM sync_events WHERE user_id = ? AND event_id = ?', $r['user']['id'], $id)) { $skipped[] = $id; continue; }
      try {
        db_tx(function () use ($r, $ev, $id, $kind) { apply_event($r['user']['id'], $kind, $ev['payload'] ?? null, (string)($ev['at'] ?? now_iso())); db_run('INSERT INTO sync_events (user_id, event_id, kind, received_at) VALUES (?, ?, ?, ?)', $r['user']['id'], $id, $kind, now_iso()); });
        $accepted[] = $id;
      } catch (Throwable $e) { app_log("Sync-Ereignis $id abgelehnt: " . $e->getMessage()); $failed[] = ['id' => $id, 'error' => $e->getMessage()]; }
    }
    db_run('UPDATE devices SET last_sync_at = ?, name = COALESCE(?, name) WHERE id = ?', now_iso(), isset($b['device']['name']) ? mb_substr((string)$b['device']['name'], 0, 60) : null, $r['device']['id']);
    send_json(200, ['accepted' => $accepted, 'skipped' => $skipped, 'failed' => $failed]);
  }
  send_json(404, ['error' => 'nicht gefunden']);
}
function ini_bytes(string $v): int { $v = trim($v); $n = (int)$v; return match (strtolower(substr($v, -1))) { 'g' => $n << 30, 'm' => $n << 20, 'k' => $n << 10, default => $n }; }
function apply_event(string $userId, string $kind, $pl, string $at): void {
  $now = now_iso();
  if ($kind === 'deck') {
    if (!is_array($pl) || empty($pl['id']) || !isset($pl['zones']) || !is_array($pl['zones'])) throw new InvalidArgumentException('Deck unvollständig');
    $id = mb_substr((string)$pl['id'], 0, 80);
    $upd = (string)($pl['lastUpdated'] ?? $at);
    $old = db_get('SELECT updated_at FROM decks WHERE id = ? AND user_id = ?', $id, $userId);
    if ($old && $old['updated_at'] > $upd) return;   // älterer Stand: ignorieren
    $zones = [];
    foreach ($pl['zones'] as $z => $list) { if (!is_array($list)) continue; $zones[(string)$z] = array_values(array_map(fn($p) => [(int)($p[0] ?? 0), (int)($p[1] ?? 0)], array_filter($list, 'is_array'))); }
    $row = ['id' => $id, 'user_id' => $userId, 'name' => mb_substr((string)($pl['name'] ?? ''), 0, 120), 'format' => isset($pl['format']) ? mb_substr((string)$pl['format'], 0, 60) : null, 'tile' => isset($pl['tile']) ? (int)$pl['tile'] : null, 'zones' => json_out($zones), 'updated_at' => $upd, 'deleted_at' => null];
    remember_card_info($pl['cardInfo'] ?? null);
    if ($old) db_run('UPDATE decks SET name = ?, format = ?, tile = ?, zones = ?, updated_at = ?, deleted_at = NULL WHERE id = ? AND user_id = ?', $row['name'], $row['format'], $row['tile'], $row['zones'], $upd, $id, $userId);
    else { $row['visibility'] = 'private'; db_run('INSERT INTO decks (id, user_id, name, format, tile, zones, updated_at, visibility) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', $id, $userId, $row['name'], $row['format'], $row['tile'], $row['zones'], $upd, 'private'); }
  } elseif ($kind === 'deck_deleted') {
    db_run('UPDATE decks SET deleted_at = ? WHERE id = ? AND user_id = ?', $now, (string)($pl['id'] ?? ''), $userId);
  } elseif ($kind === 'match') {
    $s = $pl['summary'] ?? null;
    if (!is_array($s) || empty($s['matchId']) || !isset($s['start'])) throw new InvalidArgumentException('Match unvollständig');
    $replay = isset($pl['replay']) && is_array($pl['replay']) ? json_out($pl['replay']) : null;
    $startAt = gmdate('Y-m-d\TH:i:s.v\Z', (int)((int)$s['start'] / 1000));
    if (db_get('SELECT 1 FROM matches WHERE user_id = ? AND id = ?', $userId, (string)$s['matchId']))
      db_run('UPDATE matches SET summary = ?, replay = COALESCE(?, replay), start_at = ?, result = ?, deck_id = ? WHERE user_id = ? AND id = ?', json_out($s), $replay, $startAt, $s['result'] ?? null, $s['myDeckId'] ?? null, $userId, (string)$s['matchId']);
    else db_run('INSERT INTO matches (id, user_id, start_at, result, deck_id, summary, replay, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', (string)$s['matchId'], $userId, $startAt, $s['result'] ?? null, $s['myDeckId'] ?? null, json_out($s), $replay, $now);
    remember_card_info($pl['replay']['cardInfo'] ?? null);
    foreach ((array)($pl['replay']['tokens'] ?? []) as $g => $t) {
      if (!is_array($t) || empty($t['name'])) continue;
      db_insert_ignore('tokens', ['arena_id' => (int)$g, 'name' => (string)$t['name'], 'set_code' => strtolower((string)($t['set'] ?? '')), 'collector' => (string)($t['nr'] ?? ''), 'type_line' => (string)($t['typeLine'] ?? ''), 'colors' => (string)($t['colors'] ?? ''), 'power' => (string)($t['power'] ?? ''), 'toughness' => (string)($t['toughness'] ?? ''), 'oracle_text' => (string)($t['text'] ?? '')]);
    }
  } elseif ($kind === 'account') {
    if (!is_array($pl)) throw new InvalidArgumentException('Konto unvollständig');
    db_upsert('account_state', ['user_id' => $userId, 'data' => json_out($pl), 'taken_at' => (string)($pl['takenAt'] ?? $at)], ['user_id']);
  } elseif ($kind === 'collection') {
    if (!is_array($pl) || empty($pl['takenAt']) || !isset($pl['snapshot']) || !is_array($pl['snapshot'])) throw new InvalidArgumentException('Sammlung unvollständig');
    $snap = array_values(array_map(fn($p) => [(int)$p[0], (int)$p[1]], array_filter($pl['snapshot'], 'is_array')));
    db_upsert('collections', ['user_id' => $userId, 'taken_at' => (string)$pl['takenAt'], 'snapshot' => json_out($snap)], ['user_id', 'taken_at']);
    $keep = array_column(db_all('SELECT taken_at FROM collections WHERE user_id = ? ORDER BY taken_at DESC LIMIT 30', $userId), 'taken_at');
    if (count($keep) >= 30) db_run('DELETE FROM collections WHERE user_id = ? AND taken_at < ?', $userId, end($keep));
  }
}

// ---- Dashboards mit dem gemeinsamen Frontend ---------------------------------------------------------
function web_files(): array { static $f = null; if ($f === null) { $f = []; foreach (scandir(WEB_DIR) ?: [] as $n) if (is_file(WEB_DIR . "/$n")) $f[$n] = true; } return $f; }
/** Gemeinsame Unterrouten für ein Datenpaket; $ctx = [user, own, start, pages?, data (callable)] */
function dash_serve(string $prefix, string $rest, array $ctx): never {
  if ($rest === '' || $rest === '/') redirect("$prefix/" . $ctx['start']);
  $f = ltrim($rest, '/');
  if ($f === 'data.js') send(200, 'window.MTGA_DATA=' . json_out($ctx['data']()) . ';', 'text/javascript; charset=utf-8', ['Cache-Control' => 'no-cache']);
  if ($f === 'data.json') {
    $etag = '"' . ($ctx['user'] ? data_version($ctx['user']['id']) : 'shared') . '"';
    if (req_method() === 'HEAD') send(200, '', 'application/json', ['Cache-Control' => 'no-cache', 'ETag' => $etag]);
    send(200, json_out($ctx['data']()), 'application/json', ['Cache-Control' => 'no-cache', 'ETag' => $etag]);
  }
  if ($f === 'card-back') redirect(CARD_BACK);
  if (preg_match('#^card-img/(\d+)$#', $f, $x)) card_img((int)$x[1]);
  if (preg_match('#^api/card/(\d+)$#', $f, $x)) { $c = card_detail((int)$x[1], $ctx['user']); if (!$c) send_json(404, new stdClass()); send_json(200, $c, ['Cache-Control' => 'no-cache']); }
  if ($f === 'api/sets') send_json(200, (object)set_names(), ['Cache-Control' => 'public, max-age=3600']);
  if ($f === 'api/cards') { if (!$ctx['own']) send_json(403, new stdClass()); send(200, library_json($ctx['user']), 'application/json', ['Cache-Control' => 'no-cache']); }
  if (preg_match('#^matches/([\w-]+)\.js$#', $f, $x)) { $js = $ctx['own'] ? replay_js($ctx['user']['id'], $x[1]) : null; if (!$js) send(404, '', 'text/plain'); send(200, $js, 'text/javascript; charset=utf-8', ['Cache-Control' => 'public, max-age=86400']); }
  if ($f === 'sw.js' || !isset(web_files()[$f])) send(404, 'nicht gefunden', 'text/plain');
  if (!empty($ctx['pages']) && str_ends_with($f, '.html') && !in_array($f, $ctx['pages'], true)) redirect("$prefix/" . $ctx['start']);
  send_file(WEB_DIR . "/$f", mime_of($f), 'no-cache');
}
function dash_user(string $handle, string $rest): never {
  $u = get_user_by_handle($handle);
  if (!$u) send(404, 'Profil nicht gefunden', 'text/plain; charset=utf-8');
  $me = current_user();
  if (!$me || $me['id'] !== $u['id']) redirect('/login?next=' . rawurlencode(req_url()));
  dash_serve("/u/$handle", $rest, ['user' => $u, 'own' => true, 'start' => 'index.html', 'data' => function () use ($u) { $d = build_data($u, true); $d['site']['csrf'] = csrf_token(); return $d; }]);
}
function dash_deck(string $slug, string $rest): never {
  $d = db_get("SELECT d.*, u.handle FROM decks d JOIN users u ON u.id = d.user_id WHERE d.share_slug = ? AND d.visibility != 'private' AND d.deleted_at IS NULL", $slug);
  if (!$d) send(404, 'Deck nicht gefunden oder nicht freigegeben', 'text/plain; charset=utf-8');
  $u = get_user($d['user_id']);
  dash_serve("/d/$slug", $rest, ['user' => null, 'own' => false, 'start' => 'decks.html?deck=' . rawurlencode($d['name']), 'pages' => ['decks.html'],
    'data' => function () use ($u, $d) { $x = build_data($u, false, [$d['id']]); $x['site'] = ['handle' => $u['handle'], 'own' => false, 'shared' => true]; return $x; }]);
}
