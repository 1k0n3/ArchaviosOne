<?php
// HTTP-Hilfen: Anfrage lesen, Antworten senden, Cookies, Rate-Limits, Sicherheits-Header, HTTP-Client für Scryfall/OAuth.
declare(strict_types=1);

function req_method(): string { return strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET'); }
function req_path(): string {
  $p = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
  // Wenn die App in einem Unterordner liegt, dessen Präfix abschneiden
  $script = str_replace('\\', '/', $_SERVER['SCRIPT_NAME'] ?? '/index.php');
  $base = basename($script) === 'index.php' ? rtrim(dirname($script), '/') : '';
  if ($base !== '' && strpos($p, $base) === 0) $p = substr($p, strlen($base));
  return $p === '' ? '/' : rawurldecode($p);
}
function req_ip(): string {
  if (cfg('trust_proxy') && !empty($_SERVER['HTTP_X_FORWARDED_FOR'])) return trim(explode(',', $_SERVER['HTTP_X_FORWARDED_FOR'])[0]);
  return $_SERVER['REMOTE_ADDR'] ?? '0.0.0.0';
}
function req_url(): string { return $_SERVER['REQUEST_URI'] ?? '/'; }
function req_is_https(): bool { return (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') || ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https' || str_starts_with(cfg('base_url', ''), 'https://'); }
function req_json(): ?array {
  $raw = file_get_contents('php://input');
  if ($raw === '' || $raw === false) return null;
  if (($_SERVER['HTTP_CONTENT_ENCODING'] ?? '') === 'gzip') { $raw = @gzdecode($raw); if ($raw === false) return null; }
  $j = json_decode($raw, true);
  return is_array($j) ? $j : null;
}
function post(string $k, $default = ''): string { $v = $_POST[$k] ?? $default; return is_string($v) ? $v : (string)$default; }
function query(string $k, $default = ''): string { $v = $_GET[$k] ?? $default; return is_string($v) ? $v : (string)$default; }

// ---- Antworten ----------------------------------------------------------------------------------
function security_headers(): void {
  header("Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: https://cards.scryfall.io https://backs.scryfall.io https://svgs.scryfall.io; connect-src 'self'; font-src 'self' https://fonts.gstatic.com; frame-ancestors 'none'; form-action 'self' https://discord.com https://accounts.google.com");
  header('X-Content-Type-Options: nosniff');
  header('Referrer-Policy: strict-origin-when-cross-origin');
  header('X-Frame-Options: DENY');
  if (req_is_https()) header('Strict-Transport-Security: max-age=31536000; includeSubDomains');
}
function send(int $status, string $body, string $type = 'text/html; charset=utf-8', array $headers = []): never {
  http_response_code($status);
  header('Content-Type: ' . $type);
  foreach ($headers as $k => $v) header("$k: $v");
  if (req_method() !== 'HEAD') echo $body;
  exit;
}
function send_json(int $status, $data, array $headers = []): never { send($status, json_out($data), 'application/json; charset=utf-8', $headers); }
function redirect(string $to, int $status = 302): never { http_response_code($status); header('Location: ' . $to); exit; }
function send_file(string $path, string $type, string $cache = 'no-cache'): never {
  if (!is_file($path)) send(404, 'nicht gefunden', 'text/plain; charset=utf-8');
  $etag = '"' . substr(md5($path . filemtime($path) . filesize($path)), 0, 20) . '"';
  if (($_SERVER['HTTP_IF_NONE_MATCH'] ?? '') === $etag) { http_response_code(304); exit; }
  http_response_code(200);
  header('Content-Type: ' . $type); header('Cache-Control: ' . $cache); header('ETag: ' . $etag); header('Content-Length: ' . filesize($path));
  if (req_method() !== 'HEAD') readfile($path);
  exit;
}
const MIME = ['html' => 'text/html; charset=utf-8', 'js' => 'text/javascript; charset=utf-8', 'css' => 'text/css; charset=utf-8', 'json' => 'application/json', 'webmanifest' => 'application/manifest+json', 'png' => 'image/png', 'ico' => 'image/x-icon', 'svg' => 'image/svg+xml', 'jpg' => 'image/jpeg'];
function mime_of(string $name): string { return MIME[strtolower(pathinfo($name, PATHINFO_EXTENSION))] ?? 'application/octet-stream'; }

// ---- Cookies -------------------------------------------------------------------------------------
function cookie_set(string $name, string $value, int $maxAge, string $path = '/'): void {
  setcookie($name, $value, ['expires' => $maxAge > 0 ? time() + $maxAge : 1, 'path' => $path, 'httponly' => true, 'samesite' => 'Lax', 'secure' => req_is_https()]);
}
function cookie_clear(string $name, string $path = '/'): void { cookie_set($name, '', -1, $path); }
function cookie(string $name): string { $v = $_COOKIE[$name] ?? ''; return is_string($v) ? $v : ''; }
/** Kurzlebige Meldung für die nächste Seite (nach einer Weiterleitung) */
function flash_set(string $kind, string $text): void { cookie_set('mtgs_flash', rtrim(strtr(base64_encode(json_out(['kind' => $kind, 'text' => $text])), '+/', '-_'), '='), 60); }
function flash_take(): ?array {
  $c = cookie('mtgs_flash'); if ($c === '') return null;
  cookie_clear('mtgs_flash');
  $j = json_decode((string)base64_decode(strtr($c, '-_', '+/')), true);
  return is_array($j) ? $j : null;
}

// ---- Rate-Limit (Datenbank, pro IP und Aktion) ------------------------------------------------------
function rate_limit(string $action, int $max, int $windowSec): void {
  $bucket = $action . ':' . req_ip();
  $now = time();
  $r = db_get('SELECT hits, reset_at FROM rate_limits WHERE bucket = ?', $bucket);
  if (!$r || (int)$r['reset_at'] <= $now) { db_upsert('rate_limits', ['bucket' => $bucket, 'hits' => 1, 'reset_at' => $now + $windowSec], ['bucket']); if (mt_rand(1, 50) === 1) db_run('DELETE FROM rate_limits WHERE reset_at < ?', $now); return; }
  if ((int)$r['hits'] >= $max) send(429, 'Zu viele Anfragen, bitte später erneut versuchen.', 'text/plain; charset=utf-8', ['Retry-After' => (string)max(1, (int)$r['reset_at'] - $now)]);
  db_run('UPDATE rate_limits SET hits = hits + 1 WHERE bucket = ?', $bucket);
}

// ---- HTTP-Client (curl, sonst Streams) ------------------------------------------------------------
/** GET/POST; liefert [status, body, headers]; $body als Array = Formular, als String = roh */
function http_request(string $method, string $url, array $headers = [], $body = null, int $timeout = 20): array {
  $headers[] = 'User-Agent: MTGAStatsSite/1.0 (+https://github.com/mtga-stats)';
  if (is_array($body)) { $body = http_build_query($body); $headers[] = 'Content-Type: application/x-www-form-urlencoded'; }
  if (function_exists('curl_init')) {
    $ch = curl_init($url);
    curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_HEADER => true, CURLOPT_FOLLOWLOCATION => false, CURLOPT_TIMEOUT => $timeout, CURLOPT_HTTPHEADER => $headers, CURLOPT_CUSTOMREQUEST => $method]);
    if ($body !== null) curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
    $res = curl_exec($ch);
    if ($res === false) { $e = curl_error($ch); curl_close($ch); throw new RuntimeException('HTTP: ' . $e); }
    $hs = curl_getinfo($ch, CURLINFO_HEADER_SIZE); $status = curl_getinfo($ch, CURLINFO_RESPONSE_CODE); curl_close($ch);
    $rawH = substr($res, 0, $hs); $out = substr($res, $hs);
  } else {
    $ctx = stream_context_create(['http' => ['method' => $method, 'header' => implode("\r\n", $headers), 'content' => $body ?? '', 'timeout' => $timeout, 'ignore_errors' => true, 'follow_location' => 0]]);
    $out = @file_get_contents($url, false, $ctx);
    if ($out === false) throw new RuntimeException('HTTP: keine Verbindung zu ' . parse_url($url, PHP_URL_HOST));
    $rawH = implode("\r\n", $http_response_header ?? []);
    $status = (int)(preg_match('#HTTP/\S+\s+(\d+)#', $rawH, $m) ? $m[1] : 0);
  }
  $h = [];
  foreach (preg_split('/\r?\n/', $rawH) as $line) if (preg_match('/^([^:]+):\s*(.*)$/', $line, $m)) $h[strtolower($m[1])] = trim($m[2]);
  return [$status, $out, $h];
}
