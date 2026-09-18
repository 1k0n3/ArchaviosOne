<?php
// Datenbankzugriff über PDO. Standard SQLite (Datei in data/), alternativ MySQL/MariaDB.
// Aufrufer nutzen db_get/db_all/db_run/db_tx mit "?"-Platzhaltern und Standard-SQL; Upserts über db_upsert.
declare(strict_types=1);

function db(): PDO {
  static $pdo = null;
  if ($pdo) return $pdo;
  $driver = cfg('db.driver', 'sqlite');
  if ($driver === 'mysql') {
    $m = cfg('db.mysql', []);
    $pdo = new PDO(sprintf('mysql:host=%s;dbname=%s;charset=%s', $m['host'] ?? 'localhost', $m['name'] ?? '', $m['charset'] ?? 'utf8mb4'), $m['user'] ?? '', $m['pass'] ?? '',
      [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC, PDO::ATTR_EMULATE_PREPARES => false]);
    $pdo->exec("SET sql_mode = 'STRICT_ALL_TABLES'");
  } else {
    $file = cfg('db.sqlite_file', DATA_DIR . '/mtga-stats.sqlite');
    $pdo = new PDO('sqlite:' . $file, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]);
    $pdo->exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  }
  return $pdo;
}
function db_is_mysql(): bool { return cfg('db.driver', 'sqlite') === 'mysql'; }

function db_get(string $sql, ...$p): ?array { $st = db()->prepare($sql); $st->execute($p); $r = $st->fetch(); return $r === false ? null : $r; }
function db_all(string $sql, ...$p): array { $st = db()->prepare($sql); $st->execute($p); return $st->fetchAll(); }
function db_run(string $sql, ...$p): int { $st = db()->prepare($sql); $st->execute($p); return $st->rowCount(); }
function db_val(string $sql, ...$p) { $r = db_get($sql, ...$p); return $r ? reset($r) : null; }
/** Mehrere Schreibzugriffe atomar (verschachtelte Aufrufe laufen in der äußeren Transaktion) */
function db_tx(callable $fn) {
  $d = db();
  if ($d->inTransaction()) return $fn();
  $d->beginTransaction();
  try { $r = $fn(); $d->commit(); return $r; }
  catch (Throwable $e) { if ($d->inTransaction()) $d->rollBack(); throw $e; }
}
/** Einfügen oder aktualisieren; $keys = Spalten des Primär-/Unique-Schlüssels */
function db_upsert(string $table, array $row, array $keys): void {
  $cols = array_keys($row);
  $upd = array_values(array_diff($cols, $keys));
  $sql = "INSERT INTO $table (" . implode(', ', $cols) . ') VALUES (' . implode(', ', array_fill(0, count($cols), '?')) . ')';
  if (db_is_mysql()) $sql .= $upd ? ' ON DUPLICATE KEY UPDATE ' . implode(', ', array_map(fn($c) => "$c = VALUES($c)", $upd)) : ' ON DUPLICATE KEY UPDATE ' . $keys[0] . ' = ' . $keys[0];
  else $sql .= ' ON CONFLICT(' . implode(', ', $keys) . ')' . ($upd ? ' DO UPDATE SET ' . implode(', ', array_map(fn($c) => "$c = excluded.$c", $upd)) : ' DO NOTHING');
  db_run($sql, ...array_values($row));
}
/** Einfügen, vorhandene Schlüssel ignorieren */
function db_insert_ignore(string $table, array $row): void {
  $cols = array_keys($row);
  $sql = (db_is_mysql() ? 'INSERT IGNORE INTO' : 'INSERT OR IGNORE INTO') . " $table (" . implode(', ', $cols) . ') VALUES (' . implode(', ', array_fill(0, count($cols), '?')) . ')';
  db_run($sql, ...array_values($row));
}

/** Migrationen aus app/migrations/<dialekt>/ der Reihe nach einspielen (jede genau einmal) */
function db_migrate(): int {
  $d = db();
  $d->exec(db_is_mysql() ? 'CREATE TABLE IF NOT EXISTS schema_migrations (name VARCHAR(191) PRIMARY KEY, applied_at VARCHAR(32) NOT NULL)' : 'CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  $done = array_column(db_all('SELECT name FROM schema_migrations'), 'name');
  $dir = __DIR__ . '/migrations/' . (db_is_mysql() ? 'mysql' : 'sqlite');
  $files = glob($dir . '/*.sql'); sort($files);
  $n = 0;
  foreach ($files as $f) {
    $name = basename($f);
    if (in_array($name, $done, true)) continue;
    $sql = preg_replace('/^\s*--.*$/m', '', (string)file_get_contents($f));   // Kommentarzeilen entfernen
    // Anweisungen einzeln ausführen (MySQL-PDO kann keine Mehrfachanweisungen mit emulierten Prepares)
    foreach (array_filter(array_map('trim', preg_split('/;\s*\n/', $sql))) as $stmt) { if ($stmt !== '') $d->exec($stmt); }
    db_run('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)', $name, now_iso());
    $n++;
  }
  return $n;
}
/** Schema beim ersten Aufruf anlegen; danach nur noch ein schneller Blick auf meta */
function db_ensure(): void {
  // Schema anlegen bzw. neue Migrationen einspielen (Prüfung über die Anzahl der Migrationsdateien, sehr günstig)
  $files = glob(__DIR__ . '/migrations/' . (db_is_mysql() ? 'mysql' : 'sqlite') . '/*.sql') ?: [];
  try { $done = (int)db_val('SELECT COUNT(*) FROM schema_migrations'); } catch (Throwable $e) { $done = -1; }
  if ($done !== count($files)) { db_migrate(); db_upsert('meta', ['key_name' => 'schema', 'value' => (string)count($files)], ['key_name']); }
}
function meta_get(string $key): ?string { $r = db_get('SELECT value FROM meta WHERE key_name = ?', $key); return $r ? $r['value'] : null; }
function meta_set(string $key, ?string $value): void { if ($value === null) db_run('DELETE FROM meta WHERE key_name = ?', $key); else db_upsert('meta', ['key_name' => $key, 'value' => $value], ['key_name']); }
