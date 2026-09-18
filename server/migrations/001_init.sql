-- MTGA Stats server: initial schema (SQLite; standard SQL so a Postgres adapter can replay it)
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  email_verified INTEGER NOT NULL DEFAULT 0,
  password_hash TEXT,
  display_name  TEXT NOT NULL,
  handle        TEXT NOT NULL UNIQUE,           -- public profile name, lowercase
  arena_name    TEXT,
  created_at    TEXT NOT NULL,
  last_login_at TEXT
);
CREATE TABLE IF NOT EXISTS oauth_accounts (
  provider    TEXT NOT NULL,                    -- discord | google
  provider_id TEXT NOT NULL,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email       TEXT,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (provider, provider_id)
);
CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,                 -- random, stored hashed
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
  kind        TEXT NOT NULL,                    -- verify | reset
  expires_at  TEXT NOT NULL,
  used_at     TEXT
);
CREATE TABLE IF NOT EXISTS device_codes (      -- short codes shown on the website to link the companion
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
  id          TEXT PRIMARY KEY,                 -- Arena deck id (per user unique)
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  format      TEXT,
  tile        INTEGER,
  zones       TEXT NOT NULL,                    -- JSON { MainDeck: [[grpId, qty]], CommandZone: [...], ... }
  updated_at  TEXT NOT NULL,
  visibility  TEXT NOT NULL DEFAULT 'private',  -- private | link | public
  share_slug  TEXT UNIQUE,
  deleted_at  TEXT,
  UNIQUE (user_id, id)
);
CREATE INDEX IF NOT EXISTS decks_user ON decks(user_id);
CREATE INDEX IF NOT EXISTS decks_public ON decks(visibility, updated_at);
CREATE TABLE IF NOT EXISTS matches (
  id          TEXT PRIMARY KEY,                 -- Arena match id
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  start_at    TEXT NOT NULL,
  result      TEXT,
  deck_id     TEXT,
  summary     TEXT NOT NULL,                    -- JSON: matchSummary() of the companion
  replay      TEXT,                             -- JSON: frames + card dict (optional, can be large)
  created_at  TEXT NOT NULL,
  UNIQUE (user_id, id)
);
CREATE INDEX IF NOT EXISTS matches_user ON matches(user_id, start_at);
CREATE TABLE IF NOT EXISTS collections (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  taken_at    TEXT NOT NULL,
  snapshot    TEXT NOT NULL,                    -- JSON [[grpId, qty], ...]
  PRIMARY KEY (user_id, taken_at)
);
CREATE TABLE IF NOT EXISTS sync_events (        -- idempotency log of companion uploads
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id    TEXT NOT NULL,
  kind        TEXT NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY (user_id, event_id)
);
CREATE TABLE IF NOT EXISTS cards (              -- from Scryfall bulk data, refreshed daily
  arena_id    INTEGER PRIMARY KEY,
  scryfall_id TEXT NOT NULL,
  name        TEXT NOT NULL,
  set_code    TEXT NOT NULL,
  collector   TEXT NOT NULL,
  rarity      TEXT,
  colors      TEXT,                             -- e.g. "W,U"
  type_line   TEXT,
  mana_cost   TEXT,
  oracle_text TEXT,
  power       TEXT,
  toughness   TEXT,
  image_uris  TEXT,                             -- JSON {small, normal, large}
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS cards_name ON cards(name);
CREATE INDEX IF NOT EXISTS cards_set ON cards(set_code, collector);
CREATE TABLE IF NOT EXISTS card_sets (
  code        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  icon_uri    TEXT,
  released_at TEXT
);
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
