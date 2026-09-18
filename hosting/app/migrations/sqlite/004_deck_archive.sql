-- Decks, die in Arena gelöscht wurden, bleiben als Archiv erhalten (Zeitpunkt der Archivierung)
ALTER TABLE decks ADD COLUMN archived_at TEXT;
