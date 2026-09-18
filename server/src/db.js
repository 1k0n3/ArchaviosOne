// Datenbankzugriff. Standard: SQLite über node:sqlite (keine nativen Abhängigkeiten).
// Alle Aufrufer nutzen nur get/all/run/tx mit Standard-SQL und "?"-Platzhaltern, damit ein
// Postgres-Adapter (pg) später an dieser Stelle eingehängt werden kann, ohne Routen zu ändern.
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const config = require("./config");

let db = null;
function open() {
  if (db) return db;
  db = new DatabaseSync(config.dbFile);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  return db;
}

const api = {
  get: (sql, ...p) => open().prepare(sql).get(...p),
  all: (sql, ...p) => open().prepare(sql).all(...p),
  run: (sql, ...p) => open().prepare(sql).run(...p),
  /** Mehrere Schreibzugriffe atomar */
  tx(fn) {
    const d = open();
    d.exec("BEGIN");
    try { const r = fn(); d.exec("COMMIT"); return r; }
    catch (e) { d.exec("ROLLBACK"); throw e; }
  },
  now: () => new Date().toISOString(),
  /** Migrationen aus server/migrations der Reihe nach einspielen (jede genau einmal) */
  migrate() {
    const d = open();
    d.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
    const done = new Set(d.prepare("SELECT name FROM schema_migrations").all().map((r) => r.name));
    const dir = path.join(__dirname, "..", "migrations");
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    let applied = 0;
    for (const f of files) {
      if (done.has(f)) continue;
      d.exec("BEGIN");
      try {
        d.exec(fs.readFileSync(path.join(dir, f), "utf8"));
        d.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(f, api.now());
        d.exec("COMMIT"); applied++;
      } catch (e) { d.exec("ROLLBACK"); throw new Error(`Migration ${f}: ${e.message}`); }
    }
    return applied;
  },
  close() { if (db) { db.close(); db = null; } }
};
module.exports = api;

if (require.main === module && process.argv[2] === "migrate") {
  console.log(`Migrationen eingespielt: ${api.migrate()} (${config.dbFile})`);
}
