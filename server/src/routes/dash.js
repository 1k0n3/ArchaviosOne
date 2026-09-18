// Nutzer-Dashboard mit dem gemeinsamen Frontend aus ../web:
//   /u/<handle>/…   eigenes Dashboard (nur angemeldeter Besitzer): index, matches, decks, library, replay
//   /d/<slug>/…     ein per Link oder öffentlich freigegebenes Deck (Deckseite, schreibgeschützt)
// Beide liefern data.js aus der Datenbank, card-img als 302 zu Scryfall, api/card, api/sets, api/cards.
const fs = require("fs");
const path = require("path");
const db = require("../db");
const auth = require("../auth");
const cards = require("../cards");
const data = require("../data");

const WEB = path.join(__dirname, "..", "..", "..", "web");
const FILES = new Set(fs.readdirSync(WEB).filter((f) => fs.statSync(path.join(WEB, f)).isFile()));
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".webmanifest": "application/manifest+json" };

module.exports = async function dashRoutes(app) {
  const sendFile = (reply, name) => reply.type(MIME[path.extname(name)] || "application/octet-stream").header("Cache-Control", "no-cache").send(fs.readFileSync(path.join(WEB, name)));
  const sendJs = (reply, js) => reply.type("text/javascript; charset=utf-8").header("Cache-Control", "no-cache").send(js);

  // Gemeinsame Unterrouten für ein Datenpaket (Besitzer-Dashboard oder freigegebenes Deck)
  function mount(prefix, resolve) {
    app.get(`${prefix}/`, async (req, reply) => { const ctx = await resolve(req, reply); if (!ctx) return; reply.redirect(`${req.url.replace(/\/$/, "")}/${ctx.start || "index.html"}`); });
    app.get(`${prefix}/:file`, async (req, reply) => {
      const ctx = await resolve(req, reply); if (!ctx) return;
      const f = req.params.file;
      if (f === "data.js") return sendJs(reply, "window.MTGA_DATA=" + JSON.stringify(ctx.data()) + ";");
      if (f === "data.json") return reply.type("application/json").header("Cache-Control", "no-cache").send(JSON.stringify(ctx.data()));
      if (f === "card-back") return reply.redirect(cards.cardBackUrl());
      if (f === "sw.js") return reply.code(404).send("");                      // kein Service Worker auf der Website
      if (!FILES.has(f)) return reply.code(404).send("nicht gefunden");
      if (ctx.pages && !ctx.pages.includes(f) && f.endsWith(".html")) return reply.redirect(`${prefix.replace(/:\w+/g, (m) => req.params[m.slice(1)])}/${ctx.start}`);
      sendFile(reply, f);
    });
    app.get(`${prefix}/card-img/:grpId`, async (req, reply) => {
      const url = await cards.cardImageUrl(+req.params.grpId, ["small", "large", "art"].includes(req.query.v) ? req.query.v : "normal");
      if (!url) return reply.code(404).send("");
      reply.header("Cache-Control", "public, max-age=86400").redirect(url);
    });
    app.get(`${prefix}/api/card/:grpId`, async (req, reply) => { const ctx = await resolve(req, reply); if (!ctx) return; const c = data.cardDetail(+req.params.grpId, ctx.user); if (!c) return reply.code(404).send({}); reply.header("Cache-Control", "no-cache").send(c); });
    app.get(`${prefix}/api/sets`, async (req, reply) => reply.header("Cache-Control", "public, max-age=3600").send(cards.setNames()));
    app.get(`${prefix}/api/cards`, async (req, reply) => { const ctx = await resolve(req, reply); if (!ctx) return; if (!ctx.own) return reply.code(403).send({}); reply.type("application/json").header("Cache-Control", "no-cache").send(data.libraryJson(ctx.user)); });
    app.get(`${prefix}/matches/:file`, async (req, reply) => {
      const ctx = await resolve(req, reply); if (!ctx) return;
      const m = req.params.file.match(/^([\w-]+)\.js$/);
      if (!ctx.own || !m) return reply.code(404).send("");
      const js = data.replayJs(ctx.user.id, m[1]);
      if (!js) return reply.code(404).send("");
      reply.header("Cache-Control", "public, max-age=86400"); sendJs(reply, js);
    });
  }

  // Kartenbilder auch ohne Präfix (Startseite, Profil, Deck-Listen)
  app.get("/card-img/:grpId", async (req, reply) => {
    const url = await cards.cardImageUrl(+req.params.grpId, ["small", "large", "art"].includes(req.query.v) ? req.query.v : "normal");
    if (!url) return reply.code(404).send("");
    reply.header("Cache-Control", "public, max-age=86400").redirect(url);
  });

  // Eigenes Dashboard: nur der angemeldete Besitzer
  mount("/u/:handle", async (req, reply) => {
    const u = auth.getUserByHandle(req.params.handle);
    const me = auth.sessionUser(req.cookies.mtgs_session);
    if (!u) { reply.code(404).send("Profil nicht gefunden"); return null; }
    if (!me || me.id !== u.id) { reply.redirect("/login?next=" + encodeURIComponent(req.url)); return null; }
    return { user: u, own: true, start: "index.html", data: () => Object.assign(data.buildData(u, { own: true }), { site: { handle: u.handle, own: true, csrf: auth.csrfToken(req.cookies.mtgs_session) } }) };
  });

  // Freigegebenes Deck: per Link (visibility link/public)
  mount("/d/:slug", async (req, reply) => {
    const d = db.get("SELECT d.*, u.handle FROM decks d JOIN users u ON u.id = d.user_id WHERE d.share_slug = ? AND d.visibility != 'private' AND d.deleted_at IS NULL", req.params.slug);
    if (!d) { reply.code(404).send("Deck nicht gefunden oder nicht freigegeben"); return null; }
    const u = auth.getUser(d.user_id);
    return { user: null, own: false, start: "decks.html?deck=" + encodeURIComponent(d.name), pages: ["decks.html"], data: () => Object.assign(data.buildData(u, { own: false, deckIds: [d.id] }), { site: { handle: u.handle, own: false, shared: true } }) };
  });
};
