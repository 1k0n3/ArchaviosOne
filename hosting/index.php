<?php
// MTGA Stats Website für Shared Hosting (PHP 8.1+, SQLite oder MySQL). Alle Anfragen laufen über diese Datei (.htaccess).
declare(strict_types=1);
require __DIR__ . '/app/bootstrap.php';
require __DIR__ . '/app/routes.php';

// Eingebauter PHP-Server (php -S): vorhandene Dateien direkt ausliefern, Rest hierher
if (PHP_SAPI === 'cli-server') {
  $f = __DIR__ . parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
  if (is_file($f) && (!str_ends_with($f, '.php') || str_ends_with($f, '/cron.php')) && !str_contains($f, '/app/') && !str_contains($f, '/data/')) return false;
}

security_headers();
try {
  db_ensure();
  dispatch(req_method(), req_path());
} catch (Throwable $e) {
  app_log('Fehler ' . req_method() . ' ' . req_path() . ': ' . $e->getMessage() . ' @ ' . $e->getFile() . ':' . $e->getLine());
  $msg = cfg('is_dev') ? $e->getMessage() . ' @ ' . basename($e->getFile()) . ':' . $e->getLine() : 'Bitte später noch einmal versuchen.';
  send(500, layout('Fehler', page_message('Da ist etwas schiefgegangen', $msg, ['href' => '/', 'text' => 'Zur Startseite'])));
}
