-- Token-Karten: Arena-GrpIds kommen vom Companion (Name, Set, Nummer), Bilder werden bei Bedarf über das Scryfall-Token-Set aufgelöst
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
  scryfall_id TEXT,
  image_uris  TEXT,
  resolved_at TEXT,
  failed_at   TEXT
);
