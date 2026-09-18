-- MTGA Stats Website (PHP): Schema für SQLite
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  email_verified INTEGER NOT NULL DEFAULT 0,
  password_hash TEXT,
  display_name  TEXT NOT NULL,
  handle        TEXT NOT NULL UNIQUE,
  arena_name    TEXT,
  created_at    TEXT NOT NULL,
  last_login_at TEXT
);
CREATE TABLE IF NOT EXISTS oauth_accounts (
  provider    TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email       TEXT,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (provider, provider_id)
);
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  user_agent  TEXT,
  ip          TEXT
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS email_tokens (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  used_at     TEXT
);
CREATE TABLE IF NOT EXISTS device_codes (
  code        TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  TEXT NOT NULL,
  claimed_at  TEXT
);
CREATE TABLE IF NOT EXISTS devices (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  token_hash  TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL,
  last_seen_at TEXT,
  last_sync_at TEXT,
  revoked_at  TEXT
);
CREATE TABLE IF NOT EXISTS decks (
  id          TEXT NOT NULL,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  format      TEXT,
  tile        INTEGER,
  zones       TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  visibility  TEXT NOT NULL DEFAULT 'private',
  share_slug  TEXT UNIQUE,
  deleted_at  TEXT,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS decks_public ON decks(visibility, updated_at);
CREATE TABLE IF NOT EXISTS matches (
  id          TEXT NOT NULL,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  start_at    TEXT NOT NULL,
  result      TEXT,
  deck_id     TEXT,
  summary     TEXT NOT NULL,
  replay      TEXT,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS matches_user ON matches(user_id, start_at);
CREATE TABLE IF NOT EXISTS collections (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  taken_at    TEXT NOT NULL,
  snapshot    TEXT NOT NULL,
  PRIMARY KEY (user_id, taken_at)
);
CREATE TABLE IF NOT EXISTS sync_events (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id    TEXT NOT NULL,
  kind        TEXT NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY (user_id, event_id)
);
CREATE TABLE IF NOT EXISTS cards (
  arena_id    INTEGER PRIMARY KEY,
  scryfall_id TEXT NOT NULL,
  name        TEXT NOT NULL,
  set_code    TEXT NOT NULL,
  collector   TEXT NOT NULL,
  rarity      TEXT,
  colors      TEXT,
  type_line   TEXT,
  mana_cost   TEXT,
  oracle_text TEXT,
  power       TEXT,
  toughness   TEXT,
  image_uris  TEXT,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS cards_name ON cards(name);
CREATE TABLE IF NOT EXISTS card_sets (
  code        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  icon_uri    TEXT,
  released_at TEXT
);
CREATE TABLE IF NOT EXISTS tokens (
  arena_id    INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  set_code    TEXT NOT NULL,
  collector   TEXT NOT NULL,
  type_line   TEXT,
  colors      TEXT,
  power       TEXT,
  toughness   TEXT,
  oracle_text TEXT,
  mana_cost   TEXT,
  rarity      INTEGER,
  types       TEXT,
  is_token    INTEGER NOT NULL DEFAULT 1,
  scryfall_id TEXT,
  image_uris  TEXT,
  resolved_at TEXT,
  failed_at   TEXT
);
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket      TEXT PRIMARY KEY,
  hits        INTEGER NOT NULL,
  reset_at    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
  key_name  TEXT PRIMARY KEY,
  value     TEXT
);
