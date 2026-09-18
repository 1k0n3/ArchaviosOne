-- Fehlgemerkte Karten zurücksetzen: frühere Versionen merkten auch Ratenbegrenzungen (429) eine Woche als "nicht gefunden"
DELETE FROM meta WHERE key_name LIKE 'miss:%';
