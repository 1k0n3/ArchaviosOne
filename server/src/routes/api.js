// API für den Companion (Gerätetoken im Authorization-Header) – offline-first: der Companion sammelt Ereignisse
// und schickt sie gebündelt; jedes Ereignis hat eine ID und wird höchstens einmal verarbeitet.
const { z } = require("zod");
const db = require("../db");
const auth = require("../auth");

const Deck = z.object({ id: z.string().min(1).max(80), name: z.string().max(120), format: z.string().max(60).optional().nullable(), tile: z.number().int().optional().nullable(), lastUpdated: z.string().optional().nullable(), zones: z.record(z.array(z.tuple([z.number().int(), z.number().int()]))), cardInfo: z.any().optional() });
const Event = z.object({
  id: z.string().min(8).max(80),
  kind: z.enum(["match", "deck", "deck_deleted", "collection"]),
  at: z.string(),
  payload: z.any()
});
const SyncBody = z.object({ device: z.object({ name: z.string().max(60).optional() }).optional(), events: z.array(Event).max(200) });

module.exports = async function apiRoutes(app) {
  // Gerät verbinden: Code von der Website gegen Token tauschen
  app.post("/api/v1/device/claim", { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } }, async (req, reply) => {
    const p = z.object({ code: z.string().min(6).max(12), name: z.string().max(60).optional() }).safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: "code fehlt" });
    const r = auth.claimDeviceCode(p.data.code, p.data.name);
    if (!r) return reply.code(404).send({ error: "Code ungültig oder abgelaufen" });
    return { token: r.token, deviceId: r.deviceId, user: { handle: r.user.handle, displayName: r.user.display_name } };
  });

  const withDevice = async (req, reply) => {
    const h = String(req.headers.authorization || "");
    const r = h.startsWith("Bearer ") ? auth.deviceFromToken(h.slice(7).trim()) : null;
    if (!r) { reply.code(401).send({ error: "Gerätetoken ungültig" }); return null; }
    return r;
  };

  app.get("/api/v1/me", async (req, reply) => {
    const r = await withDevice(req, reply); if (!r) return;
    return { user: { handle: r.user.handle, displayName: r.user.display_name }, device: { id: r.device.id, name: r.device.name }, decks: db.get("SELECT COUNT(*) n FROM decks WHERE user_id = ? AND deleted_at IS NULL", r.user.id).n, matches: db.get("SELECT COUNT(*) n FROM matches WHERE user_id = ?", r.user.id).n };
  });

  app.post("/api/v1/sync", { bodyLimit: 50 * 1024 * 1024, config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (req, reply) => {
    const r = await withDevice(req, reply); if (!r) return;
    const p = SyncBody.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: "ungültige Daten", details: p.error.issues.slice(0, 3) });
    const accepted = [], skipped = [], failed = [];
    for (const ev of p.data.events) {
      if (db.get("SELECT 1 FROM sync_events WHERE user_id = ? AND event_id = ?", r.user.id, ev.id)) { skipped.push(ev.id); continue; }
      try {
        db.tx(() => {
          applyEvent(r.user.id, ev);
          db.run("INSERT INTO sync_events (user_id, event_id, kind, received_at) VALUES (?, ?, ?, ?)", r.user.id, ev.id, ev.kind, db.now());
        });
        accepted.push(ev.id);
      } catch (e) { app.log.warn({ err: e.message, event: ev.id }, "Sync-Ereignis abgelehnt"); failed.push({ id: ev.id, error: e.message }); }
    }
    db.run("UPDATE devices SET last_sync_at = ?, name = COALESCE(?, name) WHERE id = ?", db.now(), p.data.device && p.data.device.name || null, r.device.id);
    return { accepted, skipped, failed };
  });

  /** Karteninfos des Companions als Fallback merken (nur IDs, die Scryfall nicht kennt) */
  function rememberCardInfo(info) {
    for (const [g, t] of Object.entries(info || {})) {
      if (!t || !t.name || db.get("SELECT 1 FROM cards WHERE arena_id = ?", +g)) continue;
      db.run("INSERT INTO tokens (arena_id, name, set_code, collector, type_line, colors, power, toughness, oracle_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(arena_id) DO NOTHING",
        +g, String(t.name), String(t.set || "").toLowerCase(), String(t.nr || ""), t.typeLine || "", t.colors || "", t.power || "", t.toughness || "", t.text || "");
    }
  }
  function applyEvent(userId, ev) {
    const now = db.now();
    if (ev.kind === "deck") {
      const d = Deck.parse(ev.payload);
      const old = db.get("SELECT updated_at FROM decks WHERE id = ? AND user_id = ?", d.id, userId);
      const upd = d.lastUpdated || ev.at;
      if (old && old.updated_at > upd) return; // älterer Stand: ignorieren
      db.run(`INSERT INTO decks (id, user_id, name, format, tile, zones, updated_at, visibility) VALUES (?, ?, ?, ?, ?, ?, ?, 'private')
              ON CONFLICT(id) DO UPDATE SET name = excluded.name, format = excluded.format, tile = excluded.tile, zones = excluded.zones, updated_at = excluded.updated_at, deleted_at = NULL`,
        d.id, userId, d.name, d.format || null, d.tile || null, JSON.stringify(d.zones), upd);
      rememberCardInfo(d.cardInfo);
    } else if (ev.kind === "deck_deleted") {
      db.run("UPDATE decks SET deleted_at = ? WHERE id = ? AND user_id = ?", now, String(ev.payload.id), userId);
    } else if (ev.kind === "match") {
      const m = z.object({ summary: z.object({ matchId: z.string(), start: z.number(), result: z.string().optional(), myDeckId: z.string().optional() }).passthrough(), replay: z.any().optional() }).parse(ev.payload);
      db.run(`INSERT INTO matches (id, user_id, start_at, result, deck_id, summary, replay, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO UPDATE SET summary = excluded.summary, replay = COALESCE(excluded.replay, matches.replay)`,
        m.summary.matchId, userId, new Date(m.summary.start).toISOString(), m.summary.result || null, m.summary.myDeckId || null, JSON.stringify(m.summary), m.replay ? JSON.stringify(m.replay) : null, now);
      rememberCardInfo(m.replay && m.replay.cardInfo);
      // Token-Karten merken (Arena-GrpId -> Name/Set/Nummer); Bilder werden später über Scryfall aufgelöst
      for (const [g, t] of Object.entries((m.replay && m.replay.tokens) || {})) {
        if (!t || !t.name) continue;
        db.run("INSERT INTO tokens (arena_id, name, set_code, collector, type_line, colors, power, toughness, oracle_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(arena_id) DO NOTHING",
          +g, String(t.name), String(t.set || "").toLowerCase(), String(t.nr || ""), t.typeLine || "", t.colors || "", t.power || "", t.toughness || "", t.text || "");
      }
    } else if (ev.kind === "collection") {
      const c = z.object({ takenAt: z.string(), snapshot: z.array(z.tuple([z.number().int(), z.number().int()])) }).parse(ev.payload);
      db.run("INSERT OR REPLACE INTO collections (user_id, taken_at, snapshot) VALUES (?, ?, ?)", userId, c.takenAt, JSON.stringify(c.snapshot));
      // nur die letzten 30 Stände behalten
      db.run("DELETE FROM collections WHERE user_id = ? AND taken_at NOT IN (SELECT taken_at FROM collections WHERE user_id = ? ORDER BY taken_at DESC LIMIT 30)", userId, userId);
    }
  }
};
