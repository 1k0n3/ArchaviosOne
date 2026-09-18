-- Kontodaten des Companions (Gold, Edelsteine, Wildcards, Rang, Mastery, Quests) – letzter Stand je Nutzer
CREATE TABLE IF NOT EXISTS account_state (
  user_id   TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data      TEXT NOT NULL,
  taken_at  TEXT NOT NULL
);
