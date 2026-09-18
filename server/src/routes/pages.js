// Seiten: Start, Konto (Registrieren, Anmelden, E-Mail bestätigen, Passwort), Einstellungen, Freigaben, OAuth
const { z } = require("zod");
const db = require("../db");
const config = require("../config");
const auth = require("../auth");
const mail = require("../mail");
const { layout, pages, esc } = require("../views");
const data = require("../data");

const SESSION_COOKIE = "mtgs_session";
const cookieOpts = () => ({ path: "/", httpOnly: true, sameSite: "lax", secure: config.isProd, maxAge: config.sessionDays * 86400 });

module.exports = async function pagesRoutes(app) {
  const enabled = { discord: auth.oauthEnabled("discord"), google: auth.oauthEnabled("google") };
  const render = (reply, opts) => reply.type("text/html; charset=utf-8").send(layout(Object.assign({ user: reply.request.user, csrf: reply.request.csrf }, opts)));
  const flashOf = (req) => { const f = req.cookies.mtgs_flash; if (!f) return null; try { return JSON.parse(Buffer.from(f, "base64url").toString()); } catch (e) { return null; } };
  const redirectFlash = (reply, to, kind, text) => reply.setCookie("mtgs_flash", Buffer.from(JSON.stringify({ kind, text })).toString("base64url"), { path: "/", httpOnly: true, sameSite: "lax", secure: config.isProd, maxAge: 60 }).redirect(to);
  const requireCsrf = (req, reply) => { if (!auth.csrfOk(req.cookies[SESSION_COOKIE], req.body && req.body.csrf)) { reply.code(403); render(reply, { title: "Fehler", body: pages.message({ title: "Formular abgelaufen", text: "Bitte die Seite neu laden und noch einmal versuchen." }) }); return false; } return true; };
  const requireUser = (req, reply) => { if (!req.user) { reply.redirect("/login?next=" + encodeURIComponent(req.url)); return false; } return true; };
  const safeNext = (n) => (typeof n === "string" && /^\/[^/\\]/.test(n) ? n : "/app");
  const publicDecks = (limit) => db.all(`SELECT d.*, u.handle, u.display_name FROM decks d JOIN users u ON u.id = d.user_id WHERE d.visibility = 'public' AND d.deleted_at IS NULL ORDER BY d.updated_at DESC LIMIT ?`, limit).map((d) => Object.assign(d, { commander: commanderName(d) }));
  const cards = require("../cards");
  const commanderName = (d) => { try { const z = JSON.parse(d.zones); return (z.CommandZone || []).map(([g]) => (cards.cardRow(g) || {}).name).filter(Boolean).join(", "); } catch (e) { return ""; } };

  // Nutzer aus Sitzung, CSRF-Token für Formulare, Flash-Meldung
  app.addHook("onRequest", async (req, reply) => {
    req.user = auth.sessionUser(req.cookies[SESSION_COOKIE]);
    req.csrf = auth.csrfToken(req.cookies[SESSION_COOKIE]);
    req.flash = flashOf(req);
    if (req.flash) reply.clearCookie("mtgs_flash", { path: "/" });
  });

  app.get("/", async (req, reply) => {
    const stats = { users: db.get("SELECT COUNT(*) n FROM users").n, decks: db.get("SELECT COUNT(*) n FROM decks WHERE visibility = 'public' AND deleted_at IS NULL").n, matches: db.get("SELECT COUNT(*) n FROM matches").n };
    render(reply, { title: "Start", flash: req.flash, body: pages.home({ decks: publicDecks(12), stats }) });
  });
  app.get("/decks", async (req, reply) => render(reply, { title: "Öffentliche Decks", body: pages.deckList(publicDecks(60)) }));
  app.get("/download", async (req, reply) => render(reply, { title: "Companion", body: pages.download() }));
  app.get("/impressum", async (req, reply) => render(reply, { title: "Impressum", body: pages.legal("Impressum", "Angaben zum Betreiber bitte hier eintragen (Name, Anschrift, Kontakt).") }));
  app.get("/datenschutz", async (req, reply) => render(reply, { title: "Datenschutz", body: pages.legal("Datenschutz", "Gespeichert werden E-Mail-Adresse, Anzeigename, verknüpfte Konten sowie die vom Companion synchronisierten Spieldaten (Decks, Matches, Sammlung). Kartenbilder werden von Scryfall geladen. Sitzungen laufen über ein HttpOnly-Cookie.") }));
  app.get("/app", async (req, reply) => { if (!requireUser(req, reply)) return; reply.redirect(`/u/${req.user.handle}/`); });

  // ---- Registrierung ----
  app.get("/register", async (req, reply) => render(reply, { title: "Registrieren", flash: req.flash, body: pages.register({ csrf: req.csrf, enabled }) }));
  app.post("/register", { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } }, async (req, reply) => {
    if (!requireCsrf(req, reply)) return;
    if (!config.registrationOpen) return render(reply, { title: "Registrieren", body: pages.message({ title: "Registrierung geschlossen", text: "Zurzeit werden keine neuen Konten angelegt." }) });
    const p = z.object({ name: z.string().trim().min(2).max(40), email: z.string().trim().email().max(200), password: z.string().min(10).max(200) }).safeParse(req.body);
    if (!p.success) return render(reply, { title: "Registrieren", flash: { kind: "error", text: "Bitte Name, gültige E-Mail und ein Passwort mit mindestens 10 Zeichen angeben." }, body: pages.register({ csrf: req.csrf, enabled, values: req.body }) });
    const pw = auth.passwordProblem(p.data.password);
    if (pw) return render(reply, { title: "Registrieren", flash: { kind: "error", text: pw }, body: pages.register({ csrf: req.csrf, enabled, values: req.body }) });
    let user = auth.getUserByEmail(p.data.email);
    if (user) {
      // Keine Auskunft, ob die Adresse existiert: gleiche Antwort wie bei Erfolg
    } else {
      user = auth.createUser({ email: p.data.email, password: p.data.password, displayName: p.data.name });
      const token = auth.createEmailToken(user.id, "verify", 24);
      await mail.verify(user.email, `${config.baseUrl}/verify/${token}`, app.log.info.bind(app.log));
    }
    render(reply, { title: "Fast geschafft", body: pages.message({ title: "Bitte E-Mail bestätigen", text: `Wir haben eine Nachricht an ${p.data.email} geschickt. Klicke den Link darin, dann kannst du dich anmelden.`, link: { href: "/login", text: "Zur Anmeldung" } }) });
  });
  app.get("/verify/resend", async (req, reply) => {
    if (!requireUser(req, reply)) return;
    if (!req.user.email_verified) { const token = auth.createEmailToken(req.user.id, "verify", 24); await mail.verify(req.user.email, `${config.baseUrl}/verify/${token}`, app.log.info.bind(app.log)); }
    redirectFlash(reply, "/settings", "ok", "Bestätigungsmail gesendet.");
  });
  app.get("/verify/:token", async (req, reply) => {
    const user = auth.consumeEmailToken(req.params.token, "verify");
    if (!user) return render(reply, { title: "Link ungültig", body: pages.message({ title: "Link ungültig oder abgelaufen", text: "Fordere in den Einstellungen eine neue Bestätigungsmail an.", link: { href: "/login", text: "Zur Anmeldung" } }) });
    db.run("UPDATE users SET email_verified = 1 WHERE id = ?", user.id);
    redirectFlash(reply, "/login", "ok", "E-Mail bestätigt. Du kannst dich jetzt anmelden.");
  });

  // ---- Anmelden / Abmelden ----
  app.get("/login", async (req, reply) => render(reply, { title: "Anmelden", flash: req.flash, body: pages.login({ csrf: req.csrf, enabled, next: req.query.next }) }));
  app.post("/login", { config: { rateLimit: { max: 20, timeWindow: "15 minutes" } } }, async (req, reply) => {
    if (!requireCsrf(req, reply)) return;
    const p = z.object({ email: z.string().trim().email(), password: z.string().min(1).max(200), next: z.string().optional() }).safeParse(req.body);
    const user = p.success ? auth.getUserByEmail(p.data.email) : null;
    const ok = user && user.password_hash && auth.verifyPassword(p.data.password, user.password_hash);
    if (!ok) { if (!user) auth.verifyPassword("x", auth.hashPassword("gleiche-zeit")); return render(reply, { title: "Anmelden", flash: { kind: "error", text: "E-Mail oder Passwort stimmen nicht." }, body: pages.login({ csrf: req.csrf, enabled, next: p.success ? p.data.next : "" }) }); }
    if (!user.email_verified) return render(reply, { title: "Anmelden", flash: { kind: "error", text: "Bitte zuerst die E-Mail-Adresse bestätigen (Link in der Mail)." }, body: pages.login({ csrf: req.csrf, enabled }) });
    const raw = auth.createSession(user.id, req);
    reply.setCookie(SESSION_COOKIE, raw, cookieOpts()).redirect(safeNext(p.data.next));
  });
  app.post("/logout", async (req, reply) => {
    if (!requireCsrf(req, reply)) return;
    auth.destroySession(req.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: "/" }).redirect("/");
  });

  // ---- Passwort vergessen / zurücksetzen ----
  app.get("/forgot", async (req, reply) => render(reply, { title: "Passwort zurücksetzen", body: pages.forgot({ csrf: req.csrf }) }));
  app.post("/forgot", { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } }, async (req, reply) => {
    if (!requireCsrf(req, reply)) return;
    const user = auth.getUserByEmail((req.body || {}).email);
    if (user && user.password_hash) { const token = auth.createEmailToken(user.id, "reset", 2); await mail.reset(user.email, `${config.baseUrl}/reset/${token}`, app.log.info.bind(app.log)); }
    render(reply, { title: "Passwort zurücksetzen", body: pages.message({ title: "Mail unterwegs", text: "Wenn ein Konto zu dieser Adresse existiert, ist ein Link zum Zurücksetzen unterwegs (2 Stunden gültig)." }) });
  });
  app.get("/reset/:token", async (req, reply) => render(reply, { title: "Neues Passwort", body: pages.reset({ csrf: req.csrf, token: req.params.token }) }));
  app.post("/reset/:token", async (req, reply) => {
    if (!requireCsrf(req, reply)) return;
    const pw = auth.passwordProblem((req.body || {}).password);
    if (pw) return render(reply, { title: "Neues Passwort", flash: { kind: "error", text: pw }, body: pages.reset({ csrf: req.csrf, token: req.params.token }) });
    const user = auth.consumeEmailToken(req.params.token, "reset");
    if (!user) return render(reply, { title: "Link ungültig", body: pages.message({ title: "Link ungültig oder abgelaufen", text: "Bitte einen neuen Link anfordern.", link: { href: "/forgot", text: "Neuen Link anfordern" } }) });
    db.run("UPDATE users SET password_hash = ?, email_verified = 1 WHERE id = ?", auth.hashPassword(req.body.password), user.id);
    auth.destroyAllSessions(user.id);
    redirectFlash(reply, "/login", "ok", "Passwort geändert. Bitte neu anmelden.");
  });

  // ---- OAuth ----
  app.get("/auth/:provider", async (req, reply) => {
    const p = req.params.provider;
    if (!enabled[p]) return reply.code(404).send("nicht aktiviert");
    const state = auth.randomId(16);
    reply.setCookie("mtgs_oauth", JSON.stringify({ p, state }), { path: "/auth", httpOnly: true, sameSite: "lax", secure: config.isProd, maxAge: 600 }).redirect(auth.oauthStart(p, state));
  });
  app.get("/auth/:provider/callback", async (req, reply) => {
    const p = req.params.provider;
    let st = null; try { st = JSON.parse(req.cookies.mtgs_oauth || "null"); } catch (e) { /* ungültig */ }
    reply.clearCookie("mtgs_oauth", { path: "/auth" });
    if (!enabled[p] || !st || st.p !== p || st.state !== req.query.state || !req.query.code) return redirectFlash(reply, "/login", "error", "Anmeldung über " + p + " abgebrochen.");
    try {
      const profile = await auth.oauthFinish(p, req.query.code);
      if (req.user) { db.run("INSERT OR IGNORE INTO oauth_accounts (provider, provider_id, user_id, email, created_at) VALUES (?, ?, ?, ?, ?)", p, profile.id, req.user.id, profile.email, db.now()); return redirectFlash(reply, "/settings", "ok", p + " verknüpft."); }
      const user = auth.userForOAuth(p, profile);
      if (!user) return redirectFlash(reply, "/login", "error", "Registrierung ist geschlossen.");
      const raw = auth.createSession(user.id, req);
      reply.setCookie(SESSION_COOKIE, raw, cookieOpts()).redirect("/app");
    } catch (e) { app.log.warn(e); redirectFlash(reply, "/login", "error", "Anmeldung über " + p + " fehlgeschlagen."); }
  });

  // ---- Einstellungen ----
  const settingsPage = (req, reply, deviceCode) => render(reply, { title: "Einstellungen", flash: req.flash, wide: true, body: pages.settings({
    csrf: req.csrf, user: req.user, enabled, deviceCode,
    devices: db.all("SELECT * FROM devices WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at", req.user.id),
    oauth: db.all("SELECT provider FROM oauth_accounts WHERE user_id = ?", req.user.id),
    decks: db.all("SELECT id, name, format, visibility, share_slug FROM decks WHERE user_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC", req.user.id)
  }) });
  app.get("/settings", async (req, reply) => { if (!requireUser(req, reply)) return; settingsPage(req, reply, null); });
  app.post("/settings/device-code", async (req, reply) => { if (!requireUser(req, reply) || !requireCsrf(req, reply)) return; settingsPage(req, reply, auth.createDeviceCode(req.user.id)); });
  app.post("/settings/devices/:id/revoke", async (req, reply) => { if (!requireUser(req, reply) || !requireCsrf(req, reply)) return; db.run("UPDATE devices SET revoked_at = ? WHERE id = ? AND user_id = ?", db.now(), req.params.id, req.user.id); redirectFlash(reply, "/settings", "ok", "Gerät getrennt."); });
  app.post("/settings/profile", async (req, reply) => {
    if (!requireUser(req, reply) || !requireCsrf(req, reply)) return;
    const p = z.object({ name: z.string().trim().min(2).max(40), handle: z.string().trim().regex(/^[a-z0-9-]{3,24}$/), arena_name: z.string().trim().max(40).optional() }).safeParse(req.body);
    if (!p.success) return redirectFlash(reply, "/settings", "error", "Ungültige Eingaben (Profilname: 3–24 Zeichen, a–z, 0–9, Bindestrich).");
    if (db.get("SELECT 1 FROM users WHERE handle = ? AND id != ?", p.data.handle, req.user.id)) return redirectFlash(reply, "/settings", "error", "Dieser Profilname ist schon vergeben.");
    db.run("UPDATE users SET display_name = ?, handle = ?, arena_name = ? WHERE id = ?", p.data.name, p.data.handle, p.data.arena_name || null, req.user.id);
    redirectFlash(reply, "/settings", "ok", "Profil gespeichert.");
  });
  app.post("/settings/password", async (req, reply) => {
    if (!requireUser(req, reply) || !requireCsrf(req, reply)) return;
    const b = req.body || {};
    if (req.user.password_hash && !auth.verifyPassword(String(b.current || ""), req.user.password_hash)) return redirectFlash(reply, "/settings", "error", "Das aktuelle Passwort stimmt nicht.");
    const pw = auth.passwordProblem(b.password); if (pw) return redirectFlash(reply, "/settings", "error", pw);
    db.run("UPDATE users SET password_hash = ? WHERE id = ?", auth.hashPassword(b.password), req.user.id);
    redirectFlash(reply, "/settings", "ok", "Passwort geändert.");
  });
  app.post("/settings/logout-all", async (req, reply) => { if (!requireUser(req, reply) || !requireCsrf(req, reply)) return; auth.destroyAllSessions(req.user.id); reply.clearCookie(SESSION_COOKIE, { path: "/" }).redirect("/login"); });
  app.post("/decks/:id/visibility", async (req, reply) => {
    if (!requireUser(req, reply) || !requireCsrf(req, reply)) return;
    const v = (req.body || {}).visibility;
    if (!["private", "link", "public"].includes(v)) return reply.code(400).send("ungültig");
    const d = db.get("SELECT share_slug FROM decks WHERE id = ? AND user_id = ?", req.params.id, req.user.id);
    if (!d) return reply.code(404).send("nicht gefunden");
    const slug = d.share_slug || auth.randomId(8);
    db.run("UPDATE decks SET visibility = ?, share_slug = ? WHERE id = ? AND user_id = ?", v, slug, req.params.id, req.user.id);
    redirectFlash(reply, "/settings", "ok", "Freigabe geändert.");
  });

  // ---- Öffentliches Profil ----
  app.get("/p/:handle", async (req, reply) => {
    const u = auth.getUserByHandle(req.params.handle);
    if (!u) return reply.code(404).type("text/html").send(layout({ title: "Nicht gefunden", user: req.user, csrf: req.csrf, body: pages.message({ title: "Profil nicht gefunden", text: "" }) }));
    const decks = db.all("SELECT d.*, u.handle, u.display_name FROM decks d JOIN users u ON u.id = d.user_id WHERE d.user_id = ? AND d.visibility = 'public' AND d.deleted_at IS NULL ORDER BY d.updated_at DESC", u.id).map((d) => Object.assign(d, { commander: commanderName(d) }));
    render(reply, { title: u.display_name, body: `<h1>${esc(u.display_name)}</h1><p class="muted">${esc(u.arena_name ? "Arena: " + u.arena_name : "")}</p><h2>Öffentliche Decks</h2>${require("../views").deckList(decks)}` });
  });
};
module.exports.SESSION_COOKIE = SESSION_COOKIE;
