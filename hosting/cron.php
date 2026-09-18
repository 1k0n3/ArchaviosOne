<?php
// Kartendaten von Scryfall schrittweise laden. Aufruf per Cronjob alle 5 Minuten:
//   php /pfad/zu/cron.php            (Kommandozeile)
//   https://deine-domain.de/cron.php?key=CRON_KEY   (URL-Cron des Hosters)
declare(strict_types=1);
require __DIR__ . '/app/bootstrap.php';
if (PHP_SAPI !== 'cli') {
  header('Content-Type: text/plain; charset=utf-8');
  if (!hash_equals((string)cfg('cron_key', ''), (string)($_GET['key'] ?? '')) || cfg('cron_key', '') === '') { http_response_code(403); echo "key fehlt oder falsch\n"; exit; }
}
set_time_limit(120);
db_ensure();
$msg = cards_sync_step(PHP_SAPI === 'cli' ? 60 : 25);
app_log('Cron: ' . $msg);
echo $msg, "\n";
