<?php
// Daten für das gemeinsame Frontend (web/) aus der Datenbank – dasselbe Format wie data.js des Companions.
declare(strict_types=1);

function deck_out(array $r): array { return ['id' => $r['id'], 'name' => $r['name'], 'format' => $r['format'], 'lastUpdated' => $r['updated_at'], 'tile' => $r['tile'] !== null ? (int)$r['tile'] : null, 'zones' => json_decode($r['zones'], true) ?: new stdClass(), 'visibility' => $r['visibility'], 'shareSlug' => $r['share_slug']]; }
function decks_of(string $userId, bool $onlyVisible): array {
  $rows = db_all('SELECT * FROM decks WHERE user_id = ? AND deleted_at IS NULL ' . ($onlyVisible ? "AND visibility != 'private' " : '') . 'ORDER BY updated_at DESC', $userId);
  return array_map('deck_out', $rows);
}
function matches_of(string $userId): array {
  // Deckbild (tile) wie lokal ergänzen: Titelkarte des Decks, sonst Commander oder erste Karte aus dem Match
  $tiles = []; foreach (db_all('SELECT id, tile FROM decks WHERE user_id = ?', $userId) as $d) $tiles[$d['id']] = (int)$d['tile'];
  return array_map(function ($r) use ($tiles) {
    $m = json_decode($r['summary'], true) ?: [];
    if (empty($m['tile'])) $m['tile'] = $tiles[$m['myDeckId'] ?? ''] ?? (int)(($m['played'][0][0] ?? 0));
    return $m;
  }, db_all('SELECT summary FROM matches WHERE user_id = ? ORDER BY start_at', $userId));
}
function latest_collection(?string $userId): array {
  if (!$userId) return [];
  $r = db_get('SELECT snapshot FROM collections WHERE user_id = ? ORDER BY taken_at DESC LIMIT 1', $userId);
  $out = [];
  foreach ($r ? (json_decode($r['snapshot'], true) ?: []) : [] as $p) $out[(int)$p[0]] = (int)$p[1];
  return $out;
}
/** Versionsstempel der Nutzerdaten (für ETag von data.json: Live-Aktualisierung im Frontend) */
function data_version(string $userId): string {
  $a = db_val('SELECT MAX(updated_at) FROM decks WHERE user_id = ?', $userId) ?? '';
  $b = db_val('SELECT MAX(created_at) FROM matches WHERE user_id = ?', $userId) ?? '';
  $c = db_val('SELECT MAX(taken_at) FROM collections WHERE user_id = ?', $userId) ?? '';
  $d = db_val('SELECT taken_at FROM account_state WHERE user_id = ?', $userId) ?? '';
  return substr(md5("$a|$b|$c|$d"), 0, 16);
}

/** Datenpaket eines Nutzers; own = true liefert alles, sonst nur freigegebene Decks und keine Matches */
function build_data(array $user, bool $own, ?array $deckIds = null): array {
  $decks = decks_of($user['id'], !$own);
  if ($deckIds !== null) $decks = array_values(array_filter($decks, fn($d) => in_array($d['id'], $deckIds, true)));
  $matches = $own ? matches_of($user['id']) : [];
  $ids = [];
  foreach ($decks as $d) { $ids[] = $d['tile']; foreach ((array)$d['zones'] as $z) foreach ($z as $p) $ids[] = $p[0]; }
  foreach ($matches as $m) { $ids[] = $m['tile'] ?? null; foreach ($m['played'] ?? [] as $p) $ids[] = $p[0]; foreach ($m['opponentCards'] ?? [] as $c) $ids[] = $c['grpId'] ?? null; }
  $acct = $own ? db_get('SELECT data FROM account_state WHERE user_id = ?', $user['id']) : null;
  return ['generatedAt' => now_iso(), 'format' => 4, 'player' => $user['arena_name'] ?: $user['display_name'], 'matches' => $matches, 'decks' => $decks, 'cards' => (object)cards_dict($ids), 'account' => $acct ? json_decode($acct['data'], true) : null, 'site' => ['handle' => $user['handle'], 'own' => $own]];
}

/** Kartenliste für die Bibliothek mit Besitzstand aus der letzten Sammlung (als JSON-Text, wird groß) */
function library_json(?array $user): string {
  $owned = latest_collection($user['id'] ?? null);
  $parts = [];
  $st = db()->query('SELECT * FROM cards ORDER BY name');
  while ($r = $st->fetch()) $parts[] = json_out(library_row($r, $owned[(int)$r['arena_id']] ?? 0));
  return '{"generatedAt":' . json_out(now_iso()) . ',"cards":[' . implode(',', $parts) . ']}';
}

/** Kartendetails wie /api/card/<grpId> des Companions */
function card_detail(int $grpId, ?array $user): ?array {
  $r = card_row($grpId);
  if (!$r) return null;
  $owned = latest_collection($user['id'] ?? null);
  $printings = array_map(fn($p) => [(int)$p['arena_id'], strtoupper($p['set_code']), $p['collector'], 0, $owned[(int)$p['arena_id']] ?? 0], db_all('SELECT arena_id, set_code, collector FROM cards WHERE name = ? ORDER BY arena_id', $r['name']));
  $e = dict_entry($r);
  return ['grpId' => (int)$r['arena_id'], 'name' => $r['name'], 'set' => strtoupper($r['set_code']), 'nr' => $r['collector'], 'rarity' => $e[3], 'artId' => 0, 'artist' => '', 'cost' => $r['mana_cost'] ?? '', 'cmc' => cmc_of($r['mana_cost']), 'colors' => array_map('intval', array_filter(explode(',', $e[6]))), 'typeLine' => $r['type_line'] ?? '', 'text' => array_values(array_filter(explode("\n", $r['oracle_text'] ?? ''))), 'flavor' => '', 'power' => $r['power'] ?? '', 'toughness' => $r['toughness'] ?? '', 'isToken' => (bool)$e[4], 'isRebalanced' => false, 'digitalSet' => '', 'flags' => $e[8], 'owned' => $owned[(int)$r['arena_id']] ?? 0, 'printings' => $printings, 'linked' => []];
}

/** Replay-Daten eines Matches (matches/<id>.js) */
function replay_js(string $userId, string $matchId): ?string {
  $r = db_get('SELECT replay FROM matches WHERE user_id = ? AND id = ?', $userId, $matchId);
  if (!$r || empty($r['replay'])) return null;
  $rep = json_decode($r['replay'], true) ?: [];
  $ids = [];
  foreach ($rep['frames'] ?? [] as $f) {
    foreach (array_merge($f['bf'] ?? [], $f['st'] ?? [], $f['cmd'] ?? []) as $o) $ids[] = $o[1] ?? null;
    foreach (array_merge($f['h'] ?? [], $f['gy'] ?? [], $f['ex'] ?? []) as $side) foreach ((array)$side as $g) $ids[] = $g;
    foreach ($f['ev'] ?? [] as $e) { if (!empty($e['g'])) $ids[] = $e['g']; if (isset($e['t']) && is_int($e['t'])) $ids[] = $e['t']; }
  }
  $m = $rep['match'] ?? [];
  foreach (array_merge($m['myDeck']['cards'] ?? [], $m['myDeck']['commander'] ?? [], $m['opponentCards'] ?? []) as $c) $ids[] = $c['grpId'] ?? null;
  $cards = $rep['cards'] ?? cards_dict($ids);
  return 'window.MTGA_MATCH=' . json_out(['match' => $m, 'frames' => $rep['frames'] ?? [], 'cards' => (object)$cards]) . ';';
}
