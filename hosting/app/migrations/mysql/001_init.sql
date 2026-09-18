-- MTGA Stats Website (PHP): Schema für MySQL/MariaDB (utf8mb4)
CREATE TABLE IF NOT EXISTS users (
  id            VARCHAR(64) PRIMARY KEY,
  email         VARCHAR(191) NOT NULL UNIQUE,
  email_verified TINYINT NOT NULL DEFAULT 0,
  password_hash VARCHAR(255),
  display_name  VARCHAR(80) NOT NULL,
  handle        VARCHAR(64) NOT NULL UNIQUE,
  arena_name    VARCHAR(80),
  created_at    VARCHAR(32) NOT NULL,
  last_login_at VARCHAR(32)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS oauth_accounts (
  provider    VARCHAR(32) NOT NULL,
  provider_id VARCHAR(128) NOT NULL,
  user_id     VARCHAR(64) NOT NULL,
  email       VARCHAR(191),
  created_at  VARCHAR(32) NOT NULL,
  PRIMARY KEY (provider, provider_id),
  KEY oauth_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS sessions (
  id          VARCHAR(64) PRIMARY KEY,
  user_id     VARCHAR(64) NOT NULL,
  created_at  VARCHAR(32) NOT NULL,
  expires_at  VARCHAR(32) NOT NULL,
  user_agent  VARCHAR(255),
  ip          VARCHAR(64),
  KEY sessions_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS email_tokens (
  token_hash  VARCHAR(64) PRIMARY KEY,
  user_id     VARCHAR(64) NOT NULL,
  kind        VARCHAR(16) NOT NULL,
  expires_at  VARCHAR(32) NOT NULL,
  used_at     VARCHAR(32)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS device_codes (
  code        VARCHAR(16) PRIMARY KEY,
  user_id     VARCHAR(64) NOT NULL,
  expires_at  VARCHAR(32) NOT NULL,
  claimed_at  VARCHAR(32)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS devices (
  id          VARCHAR(64) PRIMARY KEY,
  user_id     VARCHAR(64) NOT NULL,
  name        VARCHAR(80) NOT NULL,
  token_hash  VARCHAR(64) NOT NULL UNIQUE,
  created_at  VARCHAR(32) NOT NULL,
  last_seen_at VARCHAR(32),
  last_sync_at VARCHAR(32),
  revoked_at  VARCHAR(32),
  KEY devices_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS decks (
  id          VARCHAR(80) NOT NULL,
  user_id     VARCHAR(64) NOT NULL,
  name        VARCHAR(191) NOT NULL,
  format      VARCHAR(64),
  tile        INT,
  zones       MEDIUMTEXT NOT NULL,
  updated_at  VARCHAR(32) NOT NULL,
  visibility  VARCHAR(16) NOT NULL DEFAULT 'private',
  share_slug  VARCHAR(32) UNIQUE,
  deleted_at  VARCHAR(32),
  PRIMARY KEY (user_id, id),
  KEY decks_public (visibility, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS matches (
  id          VARCHAR(80) NOT NULL,
  user_id     VARCHAR(64) NOT NULL,
  start_at    VARCHAR(32) NOT NULL,
  result      VARCHAR(32),
  deck_id     VARCHAR(80),
  summary     MEDIUMTEXT NOT NULL,
  replay      LONGTEXT,
  created_at  VARCHAR(32) NOT NULL,
  PRIMARY KEY (user_id, id),
  KEY matches_user (user_id, start_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS collections (
  user_id     VARCHAR(64) NOT NULL,
  taken_at    VARCHAR(32) NOT NULL,
  snapshot    MEDIUMTEXT NOT NULL,
  PRIMARY KEY (user_id, taken_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS sync_events (
  user_id     VARCHAR(64) NOT NULL,
  event_id    VARCHAR(120) NOT NULL,
  kind        VARCHAR(16) NOT NULL,
  received_at VARCHAR(32) NOT NULL,
  PRIMARY KEY (user_id, event_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS cards (
  arena_id    INT PRIMARY KEY,
  scryfall_id VARCHAR(64) NOT NULL,
  name        VARCHAR(191) NOT NULL,
  set_code    VARCHAR(16) NOT NULL,
  collector   VARCHAR(32) NOT NULL,
  rarity      VARCHAR(16),
  colors      VARCHAR(32),
  type_line   VARCHAR(191),
  mana_cost   VARCHAR(64),
  oracle_text TEXT,
  power       VARCHAR(8),
  toughness   VARCHAR(8),
  image_uris  TEXT,
  updated_at  VARCHAR(32) NOT NULL,
  KEY cards_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS card_sets (
  code        VARCHAR(16) PRIMARY KEY,
  name        VARCHAR(191) NOT NULL,
  icon_uri    VARCHAR(255),
  released_at VARCHAR(16)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS tokens (
  arena_id    INT PRIMARY KEY,
  name        VARCHAR(191) NOT NULL,
  set_code    VARCHAR(16) NOT NULL,
  collector   VARCHAR(32) NOT NULL,
  type_line   VARCHAR(191),
  colors      VARCHAR(32),
  power       VARCHAR(8),
  toughness   VARCHAR(8),
  oracle_text TEXT,
  mana_cost   VARCHAR(64),
  rarity      INT,
  types       VARCHAR(32),
  is_token    INT NOT NULL DEFAULT 1,
  scryfall_id VARCHAR(64),
  image_uris  TEXT,
  resolved_at VARCHAR(32),
  failed_at   VARCHAR(32)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket      VARCHAR(191) PRIMARY KEY,
  hits        INT NOT NULL,
  reset_at    INT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS meta (
  key_name  VARCHAR(64) PRIMARY KEY,
  value     TEXT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
