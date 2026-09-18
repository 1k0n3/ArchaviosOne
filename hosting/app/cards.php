<?php
// Kartendaten. Quelle Scryfall: alle Arena-Karten (game:arena) schrittweise per Cron in die Tabelle cards;
// fehlende Karten werden bei Bedarf einzeln nachgeladen (cards/arena/<id>). Bilder werden nie gespeichert,
// card-img leitet zum Scryfall-Link aus der Tabelle weiter. arena_id = GrpId des Companions.
declare(strict_types=1);

function sf_fetch(string $url): array {
  static $last = 0.0;
  $wait = 0.12 - (microtime(true) - $last);
  if ($wait > 0) usleep((int)($wait * 1e6));
  for ($a = 0; $a < 3; $a++) {
    $last = microtime(true);
    [$st, $body, $h] = http_request('GET', $url, ['Accept: application/json'], null, 25);
    if ($st === 429) { sleep(min(10, (int)($h['retry-after'] ?? 2) + 1)); continue; }
    return [$st, $st === 200 ? (json_decode($body, true) ?: []) : []];
  }
  return [429, []];
}

const TYPE_IDS = ['Artifact' => 1, 'Creature' => 2, 'Enchantment' => 3, 'Instant' => 4, 'Land' => 5, 'Planeswalker' => 8, 'Sorcery' => 10, 'Tribal' => 11, 'Kindred' => 11, 'Battle' => 14];
const COLOR_IDS = ['W' => 1, 'U' => 2, 'B' => 3, 'R' => 4, 'G' => 5];
const RARITY_IDS = ['common' => 2, 'uncommon' => 3, 'rare' => 4, 'mythic' => 5, 'special' => 4, 'bonus' => 4];

function row_from_scryfall(array $c): ?array {
  if (empty($c['arena_id'])) return null;
  $face = (!empty($c['card_faces']) && empty($c['image_uris'])) ? $c['card_faces'][0] : $c;
  $uris = $c['image_uris'] ?? ($c['card_faces'][0]['image_uris'] ?? null);
  $oracle = !empty($c['card_faces']) ? implode("\n//\n", array_filter(array_map(fn($f) => $f['oracle_text'] ?? '', $c['card_faces']))) : ($c['oracle_text'] ?? '');
  return [
    'arena_id' => (int)$c['arena_id'], 'scryfall_id' => $c['id'], 'name' => $c['name'], 'set_code' => $c['set'], 'collector' => (string)$c['collector_number'],
    'rarity' => $c['rarity'] ?? '', 'colors' => implode(',', $c['colors'] ?? ($face['colors'] ?? [])), 'type_line' => $c['type_line'] ?? ($face['type_line'] ?? ''),
    'mana_cost' => $c['mana_cost'] ?? ($face['mana_cost'] ?? ''), 'oracle_text' => $oracle, 'power' => $c['power'] ?? ($face['power'] ?? ''), 'toughness' => $c['toughness'] ?? ($face['toughness'] ?? ''),
    'image_uris' => $uris ? json_out(['small' => $uris['small'] ?? null, 'normal' => $uris['normal'] ?? null, 'large' => $uris['large'] ?? null]) : null, 'updated_at' => now_iso(),
  ];
}
function card_store(array $row): void { db_upsert('cards', $row, ['arena_id']); }

/**
 * Kartensync in Zeitscheiben (für Cron/Shared Hosting): arbeitet bis zu $seconds lang Seiten ab und merkt sich
 * die nächste Seite in meta. Liefert einen Statustext.
 */
function cards_sync_step(int $seconds = 20): string {
  $t0 = time();
  $url = meta_get('cards_sync_next');
  $last = meta_get('cards_synced_at');
  if (!$url) {
    if ($last && time() - strtotime($last) < 24 * 3600) return 'Kartendaten aktuell (' . $last . ')';
    $url = 'https://api.scryfall.com/cards/search?' . http_build_query(['q' => 'game:arena', 'unique' => 'prints', 'order' => 'set', 'include_extras' => 'true']);
    meta_set('cards_sync_count', '0');
  }
  $n = (int)meta_get('cards_sync_count');
  while ($url && time() - $t0 < $seconds) {
    try { [$st, $j] = sf_fetch($url); } catch (Throwable $e) { meta_set('cards_sync_error', $e->getMessage()); return "Scryfall nicht erreichbar (" . $e->getMessage() . "), nächster Versuch beim nächsten Aufruf"; }
    if ($st !== 200) { meta_set('cards_sync_error', "Scryfall $st bei $url"); return "Scryfall antwortet $st, nächster Versuch beim nächsten Aufruf"; }
    db_tx(function () use ($j, &$n) { foreach ($j['data'] ?? [] as $c) { $row = row_from_scryfall($c); if ($row) { card_store($row); $n++; } } });
    $url = !empty($j['has_more']) ? $j['next_page'] : null;
    meta_set('cards_sync_next', $url); meta_set('cards_sync_count', (string)$n);
  }
  if ($url) return "Kartensync läuft: $n Karten, wird beim nächsten Aufruf fortgesetzt";
  [$st, $j] = sf_fetch('https://api.scryfall.com/sets');
  if ($st === 200) db_tx(function () use ($j) { foreach ($j['data'] ?? [] as $s) db_upsert('card_sets', ['code' => $s['code'], 'name' => $s['name'], 'icon_uri' => $s['icon_svg_uri'] ?? null, 'released_at' => $s['released_at'] ?? null], ['code']); });
  meta_set('cards_synced_at', now_iso()); meta_set('cards_sync_error', null);
  return "Kartendaten aktualisiert: $n Arena-Karten";
}

/** Einzelne Karte bei Bedarf von Scryfall holen (wenn der Sync sie noch nicht hat) */
function card_fetch_one(int $arenaId): ?array {
  if ($arenaId <= 0) return null;
  static $tried = [];
  if (isset($tried[$arenaId])) return null;
  $tried[$arenaId] = true;
  // Fehlschläge eine Woche lang merken, damit nicht jede Seite erneut anfragt
  $miss = meta_get('miss:' . $arenaId);
  if ($miss && time() - strtotime($miss) < 7 * 86400) return null;
  try { [$st, $j] = sf_fetch('https://api.scryfall.com/cards/arena/' . $arenaId); } catch (Throwable $e) { return null; }
  $row = $st === 200 ? row_from_scryfall($j) : null;
  if (!$row) { meta_set('miss:' . $arenaId, now_iso()); return null; }
  card_store($row);
  return $row;
}

// ---- Kartenformat für das gemeinsame Frontend (wie im Companion) ----------------------------------
function type_ids(?string $typeLine): array { $out = []; foreach (TYPE_IDS as $t => $id) if (preg_match('/\b' . $t . '\b/', $typeLine ?? '')) $out[] = $id; return array_values(array_unique($out)); }
function color_ids(?string $colors): array { $out = []; foreach (array_filter(explode(',', $colors ?? '')) as $c) if (isset(COLOR_IDS[$c])) $out[] = COLOR_IDS[$c]; return $out; }
function rarity_name(?string $r): string { return ['common' => 'Common', 'uncommon' => 'Uncommon', 'rare' => 'Rare', 'mythic' => 'Mythic', 'special' => 'Rare', 'bonus' => 'Rare'][$r] ?? ''; }
function is_basic(array $row): bool { return (bool)preg_match('/^Basic Land/', $row['type_line'] ?? ''); }
function cmc_of(?string $cost): int { $n = 0; if (preg_match_all('/\{([^}]+)\}/', $cost ?? '', $m)) foreach ($m[1] as $s) { if (is_numeric($s)) $n += (int)$s; elseif ($s !== 'X') $n += 1; } return $n; }
/** [Name, Set, Nr, Seltenheit, Token, ArtId, Farben, Typen, Flags, P, T, Text, Typzeile, Kosten] */
function dict_entry(array $r): array {
  $token = preg_match('/\bToken\b/', $r['type_line'] ?? '') ? 1 : 0;
  return [$r['name'], strtoupper($r['set_code']), $r['collector'], is_basic($r) ? 'Standardland' : rarity_name($r['rarity']), $token, 0, implode(',', color_ids($r['colors'])), implode(',', type_ids($r['type_line'])), str_contains($r['type_line'] ?? '', 'Legendary') ? 'L' : '', $r['power'] ?? '', $r['toughness'] ?? '', $r['oracle_text'] ?? '', $r['type_line'] ?? '', $r['mana_cost'] ?? ''];
}
/** [grpId, name, set, nr, rarity, colors, types, artId, cmc, owned, cost, isToken, isRebalanced, isPrimary, flags, power, toughness, text, typeLine] */
function library_row(array $r, int $owned): array {
  $token = preg_match('/\bToken\b/', $r['type_line'] ?? '') ? 1 : 0;
  return [(int)$r['arena_id'], $r['name'], strtoupper($r['set_code']), $r['collector'], is_basic($r) ? 1 : (RARITY_IDS[$r['rarity']] ?? 0), implode(',', color_ids($r['colors'])), implode(',', type_ids($r['type_line'])), 0, cmc_of($r['mana_cost']), $owned, $r['mana_cost'] ?? '', $token, 0, 1, str_contains($r['type_line'] ?? '', 'Legendary') ? 'L' : '', $r['power'] ?? '', $r['toughness'] ?? '', $r['oracle_text'] ?? '', $r['type_line'] ?? ''];
}
function card_row(int $arenaId, bool $fetch = true): ?array {
  static $cache = [];
  if (array_key_exists($arenaId, $cache)) return $cache[$arenaId];
  $r = db_get('SELECT * FROM cards WHERE arena_id = ?', $arenaId);
  if (!$r && $fetch && !token_row($arenaId)) $r = card_fetch_one($arenaId);
  return $cache[$arenaId] = $r;
}
function token_row(int $arenaId): ?array { return db_get('SELECT * FROM tokens WHERE arena_id = ?', $arenaId); }
const ARENA_RARITY = [0 => 'Token', 1 => 'Standardland', 2 => 'Common', 3 => 'Uncommon', 4 => 'Rare', 5 => 'Mythic'];
/** Wörterbuch-Eintrag aus den Companion-Karteninfos (Token oder Karte, die Scryfall unter der Arena-ID nicht kennt) */
function token_entry(array $t): array {
  $token = (int)($t['is_token'] ?? 1);
  return [$t['name'], strtoupper($t['set_code']), $t['collector'], $token ? 'Token' : (ARENA_RARITY[(int)($t['rarity'] ?? 0)] ?? ''), $token, 0, $t['colors'] ?? '', $t['types'] ?? '', str_contains($t['type_line'] ?? '', 'Legendary') ? 'L' : '', $t['power'] ?? '', $t['toughness'] ?? '', $t['oracle_text'] ?? '', $t['type_line'] ?? '', $t['mana_cost'] ?? ''];
}
/** Karteninfos des Companions merken (nur IDs, die die Kartentabelle nicht kennt) */
function remember_card_info($info): void {
  if (!is_array($info)) return;
  $ids = array_values(array_filter(array_map('intval', array_keys($info))));
  $known = [];
  foreach (array_chunk($ids, 400) as $chunk) foreach (db_all('SELECT arena_id FROM cards WHERE arena_id IN (' . implode(',', array_fill(0, count($chunk), '?')) . ')', ...$chunk) as $r) $known[(int)$r['arena_id']] = 1;
  foreach ($info as $g => $t) {
    if (isset($known[(int)$g]) || !is_array($t) || empty($t['name'])) continue;
    db_insert_ignore('tokens', ['arena_id' => (int)$g, 'name' => mb_substr((string)$t['name'], 0, 191), 'set_code' => strtolower((string)($t['set'] ?? '')), 'collector' => (string)($t['nr'] ?? ''), 'type_line' => mb_substr((string)($t['typeLine'] ?? ''), 0, 191), 'colors' => (string)($t['colors'] ?? ''), 'power' => (string)($t['power'] ?? ''), 'toughness' => (string)($t['toughness'] ?? ''), 'oracle_text' => (string)($t['text'] ?? ''), 'mana_cost' => (string)($t['cost'] ?? ''), 'rarity' => (int)($t['rarity'] ?? 0), 'types' => (string)($t['types'] ?? ''), 'is_token' => !empty($t['token']) ? 1 : 0]);
  }
}
/** Wörterbuch für eine ID-Liste; unbekannte Karten werden einzeln nachgeladen (höchstens $fetchMax pro Aufruf) */
function cards_dict(array $ids, int $fetchMax = 25): array {
  $ids = array_values(array_unique(array_filter(array_map('intval', $ids))));
  $out = [];
  foreach (array_chunk($ids, 400) as $chunk) {
    foreach (db_all('SELECT * FROM cards WHERE arena_id IN (' . implode(',', array_fill(0, count($chunk), '?')) . ')', ...$chunk) as $r) $out[(int)$r['arena_id']] = dict_entry($r);
  }
  $missing = array_diff($ids, array_keys($out));
  if ($missing) {
    foreach (array_chunk(array_values($missing), 400) as $chunk) {
      foreach (db_all('SELECT * FROM tokens WHERE arena_id IN (' . implode(',', array_fill(0, count($chunk), '?')) . ')', ...$chunk) as $t) $out[(int)$t['arena_id']] = token_entry($t);
    }
    $fetched = 0;
    foreach ($missing as $g) { if (isset($out[$g]) || $fetched >= $fetchMax) continue; $r = card_fetch_one((int)$g); $fetched++; if ($r) $out[(int)$g] = dict_entry($r); }
  }
  return $out;
}
/** Token-Bild über das Scryfall-Token-Set auflösen (t<set>/<nr>, Name im Token-Set, Token-Suche); Ergebnis wird gemerkt */
function resolve_token(array $t): ?array {
  if (!empty($t['image_uris'])) return json_decode($t['image_uris'], true);
  if (!empty($t['failed_at']) && time() - strtotime($t['failed_at']) < 86400) return null;   // Fehlschläge einen Tag lang nicht wiederholen
  $isToken = (int)($t['is_token'] ?? 1) === 1;
  $set = strtolower($t['set_code']); $tset = 't' . $set; $card = null;
  $name = $t['name']; $nr = rawurlencode($t['collector']); $en = rawurlencode($name);
  $q = rawurlencode('!"' . $name . '" t:token');
  // Token: im Token-Set des Sets; normale Karte (Scryfall kennt die Arena-ID nicht, z. B. rebalancte Version): Set+Nr, sonst irgendein Druck
  $urls = $isToken
    ? ["https://api.scryfall.com/cards/$tset/$nr", "https://api.scryfall.com/cards/named?exact=$en&set=$tset", "https://api.scryfall.com/cards/search?q=$q+set%3A$tset&unique=prints", "https://api.scryfall.com/cards/search?q=$q&unique=prints&order=released"]
    : ["https://api.scryfall.com/cards/$set/$nr", "https://api.scryfall.com/cards/named?exact=" . rawurlencode(preg_replace('/^A-/', '', $name)) . "&set=$set", "https://api.scryfall.com/cards/named?exact=" . rawurlencode(preg_replace('/^A-/', '', $name))];
  $plain = preg_replace('/^A-/', '', $name);
  foreach ($urls as $url) {
    try { [$st, $j] = sf_fetch($url); } catch (Throwable $e) { continue; }
    if ($st !== 200) continue;
    if (($j['object'] ?? '') === 'list') $j = $j['data'][0] ?? null;
    if (!$j) continue;
    $jn = $j['name'] ?? '';
    if (strcasecmp($jn, $name) !== 0 && strcasecmp($jn, $plain) !== 0 && strcasecmp(explode(' // ', $jn)[0], $plain) !== 0) continue;
    if ($isToken && !preg_match('/Token|Emblem|Card/', $j['type_line'] ?? '')) continue;
    $card = $j; break;
  }
  $uris = $card ? ($card['image_uris'] ?? ($card['card_faces'][0]['image_uris'] ?? null)) : null;
  if ($uris) { $u = ['small' => $uris['small'] ?? null, 'normal' => $uris['normal'] ?? null, 'large' => $uris['large'] ?? null]; db_run('UPDATE tokens SET scryfall_id = ?, image_uris = ?, resolved_at = ? WHERE arena_id = ?', $card['id'], json_out($u), now_iso(), $t['arena_id']); return $u; }
  db_run('UPDATE tokens SET failed_at = ? WHERE arena_id = ?', now_iso(), $t['arena_id']);
  return null;
}
function set_names(): array { $o = []; foreach (db_all('SELECT code, name FROM card_sets') as $r) $o[$r['code']] = $r['name']; return $o; }

const CARD_BACK = 'https://backs.scryfall.io/normal/0/a/0aeebaf5-8c7d-4636-9e82-8c27447861f7.jpg';
function card_image_url(int $arenaId, string $version = 'normal'): ?string {
  $row = card_row($arenaId);
  $uris = ($row && !empty($row['image_uris'])) ? json_decode($row['image_uris'], true) : null;
  if (!$uris) { $t = token_row($arenaId); if ($t) $uris = resolve_token($t); }
  if (!$uris) return null;
  return $uris[$version] ?? ($uris['normal'] ?? null);
}
