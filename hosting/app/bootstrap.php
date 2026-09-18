<?php
// Grundgerüst: Konfiguration, Pfade, Hilfsfunktionen. Wird von index.php und cron.php eingebunden.
declare(strict_types=1);
mb_internal_encoding('UTF-8');
date_default_timezone_set('UTC');
error_reporting(E_ALL);
ini_set('display_errors', '0');

define('APP_ROOT', dirname(__DIR__));
// Gemeinsames Frontend und Icons: im Auslieferungsordner (web/, assets/) oder im Repository daneben (../web, ../assets)
define('WEB_DIR', is_dir(APP_ROOT . '/web') ? APP_ROOT . '/web' : dirname(APP_ROOT) . '/web');
define('ASSETS_DIR', is_dir(APP_ROOT . '/assets') ? APP_ROOT . '/assets' : dirname(APP_ROOT) . '/assets');
define('STATIC_DIR', is_dir(APP_ROOT . '/static') ? APP_ROOT . '/static' : dirname(APP_ROOT) . '/server/static');
define('DATA_DIR', APP_ROOT . '/data');

if (!is_dir(DATA_DIR)) @mkdir(DATA_DIR, 0750, true);
if (!file_exists(DATA_DIR . '/.htaccess')) @file_put_contents(DATA_DIR . '/.htaccess', "Require all denied\n");

$cfgFile = APP_ROOT . '/config.php';
$CONFIG = file_exists($cfgFile) ? require $cfgFile : require APP_ROOT . '/config.example.php';
$CONFIG['base_url'] = rtrim((string)($CONFIG['base_url'] ?? ''), '/');
$CONFIG['is_dev'] = !file_exists($cfgFile);

function cfg(string $key, $default = null) {
  global $CONFIG;
  $v = $CONFIG;
  foreach (explode('.', $key) as $k) { if (!is_array($v) || !array_key_exists($k, $v)) return $default; $v = $v[$k]; }
  return $v;
}
/** Geheimnis für Signaturen: aus der Konfiguration, sonst einmalig erzeugt in data/secret */
function app_secret(): string {
  static $s = null;
  if ($s !== null) return $s;
  $s = (string)cfg('secret', '');
  if ($s === '') {
    $f = DATA_DIR . '/secret';
    if (!file_exists($f)) file_put_contents($f, rtrim(strtr(base64_encode(random_bytes(48)), '+/', '-_'), '='));
    $s = trim((string)file_get_contents($f));
  }
  return $s;
}
function now_iso(): string { return gmdate('Y-m-d\TH:i:s.v\Z'); }
function iso_in(int $seconds): string { return gmdate('Y-m-d\TH:i:s.v\Z', time() + $seconds); }
function random_id(int $bytes = 24): string { return rtrim(strtr(base64_encode(random_bytes($bytes)), '+/', '-_'), '='); }
function esc($s): string { return htmlspecialchars((string)($s ?? ''), ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8'); }
function json_out($data, int $flags = 0): string { return json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | $flags); }
function app_log(string $msg): void {
  @file_put_contents(DATA_DIR . '/app.log', '[' . now_iso() . '] ' . $msg . "\n", FILE_APPEND);
}

require __DIR__ . '/db.php';
require __DIR__ . '/http.php';
require __DIR__ . '/auth.php';
require __DIR__ . '/mail.php';
require __DIR__ . '/cards.php';
require __DIR__ . '/data.php';
require __DIR__ . '/views.php';
