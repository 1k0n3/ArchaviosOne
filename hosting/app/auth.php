<?php
// Konten, Passwörter, Sitzungen, Gerätetoken, CSRF, OAuth (Discord, Google).
// Passwörter: password_hash (Argon2id, sonst bcrypt). Sitzungen: zufällige ID im HttpOnly-Cookie, in der DB nur als SHA-256.
declare(strict_types=1);

const SESSION_COOKIE = 'mtgs_session';

function sha256(string $s): string { return hash('sha256', $s); }
function hash_password(string $pw): string { return password_hash(mb_convert_encoding($pw, 'UTF-8'), defined('PASSWORD_ARGON2ID') ? PASSWORD_ARGON2ID : PASSWORD_DEFAULT); }
function verify_password(string $pw, ?string $stored): bool { return $stored !== null && $stored !== '' && password_verify($pw, $stored); }
function password_problem($pw): ?string {
  if (!is_string($pw) || mb_strlen($pw) < 10) return 'Das Passwort braucht mindestens 10 Zeichen.';
  if (mb_strlen($pw) > 200) return 'Das Passwort ist zu lang.';
  return null;
}

// ---- Nutzer -------------------------------------------------------------------------------------
function norm_email($e): string { return mb_strtolower(trim((string)$e)); }
function handle_from(string $name): string {
  $base = mb_strtolower($name);
  $base = @iconv('UTF-8', 'ASCII//TRANSLIT//IGNORE', $base) ?: $base;
  $base = trim(preg_replace('/[^a-z0-9]+/', '-', $base) ?? '', '-');
  $base = substr($base, 0, 24) ?: 'spieler';
  $h = $base; $i = 1;
  while (db_get('SELECT 1 FROM users WHERE handle = ?', $h)) $h = $base . '-' . (++$i);
  return $h;
}
function create_user(string $email, ?string $password, string $displayName, bool $verified = false): array {
  $id = random_id(12);
  db_run('INSERT INTO users (id, email, email_verified, password_hash, display_name, handle, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    $id, norm_email($email), $verified ? 1 : 0, $password !== null ? hash_password($password) : null, $displayName, handle_from($displayName), now_iso());
  return get_user($id);
}
function get_user(?string $id): ?array { return $id ? db_get('SELECT * FROM users WHERE id = ?', $id) : null; }
function get_user_by_email($email): ?array { return db_get('SELECT * FROM users WHERE email = ?', norm_email($email)); }
function get_user_by_handle($h): ?array { return db_get('SELECT * FROM users WHERE handle = ?', mb_strtolower(trim((string)$h))); }

// ---- Sitzungen ----------------------------------------------------------------------------------
function create_session(string $userId): string {
  $raw = random_id(32);
  db_run('INSERT INTO sessions (id, user_id, created_at, expires_at, user_agent, ip) VALUES (?, ?, ?, ?, ?, ?)',
    sha256($raw), $userId, now_iso(), iso_in((int)cfg('session_days', 30) * 86400), substr((string)($_SERVER['HTTP_USER_AGENT'] ?? ''), 0, 200), req_ip());
  db_run('UPDATE users SET last_login_at = ? WHERE id = ?', now_iso(), $userId);
  return $raw;
}
function session_user(string $raw): ?array {
  if ($raw === '') return null;
  $s = db_get('SELECT user_id, expires_at FROM sessions WHERE id = ?', sha256($raw));
  if (!$s || $s['expires_at'] < now_iso()) return null;
  return get_user($s['user_id']);
}
function destroy_session(string $raw): void { if ($raw !== '') db_run('DELETE FROM sessions WHERE id = ?', sha256($raw)); }
function destroy_all_sessions(string $userId): void { db_run('DELETE FROM sessions WHERE user_id = ?', $userId); }
function current_user(): ?array { static $u = false; if ($u === false) $u = session_user(cookie(SESSION_COOKIE)); return $u; }

// ---- E-Mail-Token (Bestätigung, Passwort-Reset) --------------------------------------------------
function create_email_token(string $userId, string $kind, int $hours = 24): string {
  $raw = random_id(32);
  db_run('DELETE FROM email_tokens WHERE user_id = ? AND kind = ?', $userId, $kind);
  db_run('INSERT INTO email_tokens (token_hash, user_id, kind, expires_at) VALUES (?, ?, ?, ?)', sha256($raw), $userId, $kind, iso_in($hours * 3600));
  return $raw;
}
function consume_email_token(string $raw, string $kind): ?array {
  $t = db_get('SELECT * FROM email_tokens WHERE token_hash = ? AND kind = ?', sha256($raw), $kind);
  if (!$t || $t['used_at'] || $t['expires_at'] < now_iso()) return null;
  db_run('UPDATE email_tokens SET used_at = ? WHERE token_hash = ?', now_iso(), $t['token_hash']);
  return get_user($t['user_id']);
}

// ---- Geräte (Companion) ---------------------------------------------------------------------------
function create_device_code(string $userId): string {
  $alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; $code = '';
  for ($i = 0; $i < 8; $i++) $code .= $alphabet[random_int(0, 31)];
  db_run('DELETE FROM device_codes WHERE user_id = ? OR expires_at < ?', $userId, now_iso());
  db_run('INSERT INTO device_codes (code, user_id, expires_at) VALUES (?, ?, ?)', $code, $userId, iso_in(15 * 60));
  return substr($code, 0, 4) . '-' . substr($code, 4);
}
function claim_device_code(string $code, ?string $deviceName): ?array {
  $c = db_get('SELECT * FROM device_codes WHERE code = ?', preg_replace('/[^A-Z0-9]/', '', strtoupper($code)));
  if (!$c || $c['claimed_at'] || $c['expires_at'] < now_iso()) return null;
  $raw = 'mtgs_' . random_id(32); $id = random_id(9);
  db_tx(function () use ($c, $id, $deviceName, $raw) {
    db_run('UPDATE device_codes SET claimed_at = ? WHERE code = ?', now_iso(), $c['code']);
    db_run('INSERT INTO devices (id, user_id, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)', $id, $c['user_id'], mb_substr($deviceName ?: 'PC', 0, 60), sha256($raw), now_iso());
  });
  return ['token' => $raw, 'deviceId' => $id, 'user' => get_user($c['user_id'])];
}
function device_from_token(string $raw): ?array {
  if (!str_starts_with($raw, 'mtgs_')) return null;
  $d = db_get('SELECT * FROM devices WHERE token_hash = ? AND revoked_at IS NULL', sha256($raw));
  if (!$d) return null;
  db_run('UPDATE devices SET last_seen_at = ? WHERE id = ?', now_iso(), $d['id']);
  return ['device' => $d, 'user' => get_user($d['user_id'])];
}

// ---- CSRF: aus der Sitzungs-ID abgeleitet (HMAC), in Formularen mitgeschickt ------------------------
function csrf_token(): string { return substr(rtrim(strtr(base64_encode(hash_hmac('sha256', 'csrf:' . (cookie(SESSION_COOKIE) ?: 'anon'), app_secret(), true)), '+/', '-_'), '='), 0, 32); }
function csrf_ok(): bool { $t = post('csrf'); return $t !== '' && hash_equals(csrf_token(), $t); }

// ---- OAuth (Discord, Google) -----------------------------------------------------------------------
const OAUTH = [
  'discord' => ['auth' => 'https://discord.com/oauth2/authorize', 'token' => 'https://discord.com/api/oauth2/token', 'me' => 'https://discord.com/api/users/@me', 'scope' => 'identify email'],
  'google' => ['auth' => 'https://accounts.google.com/o/oauth2/v2/auth', 'token' => 'https://oauth2.googleapis.com/token', 'me' => 'https://openidconnect.googleapis.com/v1/userinfo', 'scope' => 'openid email profile'],
];
function oauth_enabled(string $p): bool { return isset(OAUTH[$p]) && cfg("oauth.$p.id", '') !== '' && cfg("oauth.$p.secret", '') !== ''; }
function oauth_start(string $p, string $state): string {
  $q = ['client_id' => cfg("oauth.$p.id"), 'redirect_uri' => cfg('base_url') . "/auth/$p/callback", 'response_type' => 'code', 'scope' => OAUTH[$p]['scope'], 'state' => $state, 'prompt' => $p === 'google' ? 'select_account' : 'consent'];
  return OAUTH[$p]['auth'] . '?' . http_build_query($q);
}
function oauth_finish(string $p, string $code): array {
  [$st, $body] = http_request('POST', OAUTH[$p]['token'], ['Accept: application/json'], ['client_id' => cfg("oauth.$p.id"), 'client_secret' => cfg("oauth.$p.secret"), 'grant_type' => 'authorization_code', 'code' => $code, 'redirect_uri' => cfg('base_url') . "/auth/$p/callback"]);
  if ($st !== 200) throw new RuntimeException("$p: Token-Antwort $st");
  $tok = json_decode($body, true);
  [$st, $body] = http_request('GET', OAUTH[$p]['me'], ['Authorization: Bearer ' . ($tok['access_token'] ?? '')]);
  if ($st !== 200) throw new RuntimeException("$p: Profil-Antwort $st");
  $me = json_decode($body, true) ?: [];
  if ($p === 'discord') return ['id' => (string)($me['id'] ?? ''), 'email' => !empty($me['verified']) ? ($me['email'] ?? null) : null, 'name' => $me['global_name'] ?? ($me['username'] ?? 'Discord')];
  return ['id' => (string)($me['sub'] ?? ''), 'email' => !empty($me['email_verified']) ? ($me['email'] ?? null) : null, 'name' => $me['name'] ?? explode('@', (string)($me['email'] ?? 'google'))[0]];
}
/** Nutzer zu einem OAuth-Profil finden oder anlegen; gleiche bestätigte E-Mail wird verknüpft */
function user_for_oauth(string $p, array $profile): ?array {
  $linked = db_get('SELECT user_id FROM oauth_accounts WHERE provider = ? AND provider_id = ?', $p, $profile['id']);
  if ($linked) return get_user($linked['user_id']);
  $user = $profile['email'] ? get_user_by_email($profile['email']) : null;
  if (!$user) {
    if (!cfg('registration_open', true)) return null;
    $user = create_user($profile['email'] ?: "$p-{$profile['id']}@no-email.local", null, $profile['name'] ?: $p, (bool)$profile['email']);
  }
  db_insert_ignore('oauth_accounts', ['provider' => $p, 'provider_id' => $profile['id'], 'user_id' => $user['id'], 'email' => $profile['email'], 'created_at' => now_iso()]);
  return $user;
}
