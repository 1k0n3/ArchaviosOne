-- Kontodaten des Companions (Gold, Edelsteine, Wildcards, Rang, Mastery, Quests) – letzter Stand je Nutzer
CREATE TABLE IF NOT EXISTS account_state (
  user_id   VARCHAR(64) PRIMARY KEY,
  data      MEDIUMTEXT NOT NULL,
  taken_at  VARCHAR(32) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
