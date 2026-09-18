// Konten, Passwörter, Sitzungen, Gerätetoken, CSRF, OAuth (Discord, Google).
// Passwörter: scrypt (Node-Bordmittel, OWASP-konform), Salt je Nutzer, konstante Vergleichszeit.
// Sitzungen: zufällige ID im HttpOnly-Cookie, in der Datenbank nur als SHA-256-Hash abgelegt.
const crypto = require("crypto");
const db = require("./db");
const config = require("./config");

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const randomId = (bytes = 24) => crypto.randomBytes(bytes).toString("base64url");
const days = (n) => new Date(Date.now() + n * 86400000).toISOString();

// ---- Passwörter ---------------------------------------------------------------------------------
const SCRYPT = { N: 1 << 15, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw.normalize("NFKC"), salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}
function verifyPassword(pw, stored) {
  try {
    const [alg, N, r, p, salt, key] = String(stored || "").split("$");
    if (alg !== "scrypt") return false;
    const want = Buffer.from(key, "base64");
    const got = crypto.scryptSync(pw.normalize("NFKC"), Buffer.from(salt, "base64"), want.length, { N: +N, r: +r, p: +p, maxmem: SCRYPT.maxmem });
    return crypto.timingSafeEqual(want, got);
  } catch (e) { return false; }
}
const passwordProblem = (pw) => (typeof pw !== "string" || pw.length < 10) ? "Das Passwort braucht mindestens 10 Zeichen." : pw.length > 200 ? "Das Passwort ist zu lang." : null;

// ---- Nutzer -------------------------------------------------------------------------------------
const normEmail = (e) => String(e || "").trim().toLowerCase();
function handleFrom(name) {
  const base = String(name || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "spieler";
  let h = base, i = 1;
  while (db.get("SELECT 1 FROM users WHERE handle = ?", h)) h = `${base}-${++i}`;
  return h;
}
function createUser({ email, password, displayName, verified = false }) {
  const id = randomId(12);
  db.run("INSERT INTO users (id, email, email_verified, password_hash, display_name, handle, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    id, normEmail(email), verified ? 1 : 0, password ? hashPassword(password) : null, displayName, handleFrom(displayName), db.now());
  return getUser(id);
}
const getUser = (id) => db.get("SELECT * FROM users WHERE id = ?", id) || null;
const getUserByEmail = (email) => db.get("SELECT * FROM users WHERE email = ?", normEmail(email)) || null;
const getUserByHandle = (h) => db.get("SELECT * FROM users WHERE handle = ?", String(h || "").toLowerCase()) || null;

// ---- Sitzungen ----------------------------------------------------------------------------------
function createSession(userId, req) {
  const raw = randomId(32);
  db.run("INSERT INTO sessions (id, user_id, created_at, expires_at, user_agent, ip) VALUES (?, ?, ?, ?, ?, ?)",
    sha256(raw), userId, db.now(), days(config.sessionDays), String(req.headers["user-agent"] || "").slice(0, 200), req.ip);
  db.run("UPDATE users SET last_login_at = ? WHERE id = ?", db.now(), userId);
  return raw;
}
function sessionUser(raw) {
  if (!raw) return null;
  const s = db.get("SELECT user_id, expires_at FROM sessions WHERE id = ?", sha256(raw));
  if (!s || s.expires_at < db.now()) return null;
  return getUser(s.user_id);
}
const destroySession = (raw) => raw && db.run("DELETE FROM sessions WHERE id = ?", sha256(raw));
const destroyAllSessions = (userId) => db.run("DELETE FROM sessions WHERE user_id = ?", userId);

// ---- E-Mail-Token (Bestätigung, Passwort-Reset) --------------------------------------------------
function createEmailToken(userId, kind, hours = 24) {
  const raw = randomId(32);
  db.run("DELETE FROM email_tokens WHERE user_id = ? AND kind = ?", userId, kind);
  db.run("INSERT INTO email_tokens (token_hash, user_id, kind, expires_at) VALUES (?, ?, ?, ?)", sha256(raw), userId, kind, new Date(Date.now() + hours * 3600000).toISOString());
  return raw;
}
function consumeEmailToken(raw, kind) {
  const t = db.get("SELECT * FROM email_tokens WHERE token_hash = ? AND kind = ?", sha256(String(raw || "")), kind);
  if (!t || t.used_at || t.expires_at < db.now()) return null;
  db.run("UPDATE email_tokens SET used_at = ? WHERE token_hash = ?", db.now(), t.token_hash);
  return getUser(t.user_id);
}

// ---- Geräte (Companion) ---------------------------------------------------------------------------
/** Kurzer Code, den die Website anzeigt; der Companion tauscht ihn gegen ein Gerätetoken */
function createDeviceCode(userId) {
  const code = Array.from({ length: 8 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[crypto.randomInt(32)]).join("");
  db.run("DELETE FROM device_codes WHERE user_id = ? OR expires_at < ?", userId, db.now());
  db.run("INSERT INTO device_codes (code, user_id, expires_at) VALUES (?, ?, ?)", code, userId, new Date(Date.now() + 15 * 60000).toISOString());
  return code.slice(0, 4) + "-" + code.slice(4);
}
function claimDeviceCode(code, deviceName) {
  const c = db.get("SELECT * FROM device_codes WHERE code = ?", String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, ""));
  if (!c || c.claimed_at || c.expires_at < db.now()) return null;
  const raw = "mtgs_" + randomId(32);
  const id = randomId(9);
  db.tx(() => {
    db.run("UPDATE device_codes SET claimed_at = ? WHERE code = ?", db.now(), c.code);
    db.run("INSERT INTO devices (id, user_id, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)", id, c.user_id, String(deviceName || "PC").slice(0, 60), sha256(raw), db.now());
  });
  return { token: raw, deviceId: id, user: getUser(c.user_id) };
}
function deviceFromToken(raw) {
  if (!raw || !raw.startsWith("mtgs_")) return null;
  const d = db.get("SELECT * FROM devices WHERE token_hash = ? AND revoked_at IS NULL", sha256(raw));
  if (!d) return null;
  db.run("UPDATE devices SET last_seen_at = ? WHERE id = ?", db.now(), d.id);
  return { device: d, user: getUser(d.user_id) };
}

// ---- CSRF: Token in der Sitzung abgeleitet (HMAC über Sitzungs-ID), in Formularen mitgeschickt ----
const csrfToken = (rawSession) => crypto.createHmac("sha256", config.sessionSecret).update("csrf:" + (rawSession || "anon")).digest("base64url").slice(0, 32);
const csrfOk = (rawSession, token) => { const want = csrfToken(rawSession); return typeof token === "string" && token.length === want.length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(token)); };

// ---- OAuth (Discord, Google) -----------------------------------------------------------------------
const OAUTH = {
  discord: { auth: "https://discord.com/oauth2/authorize", token: "https://discord.com/api/oauth2/token", me: "https://discord.com/api/users/@me", scope: "identify email" },
  google: { auth: "https://accounts.google.com/o/oauth2/v2/auth", token: "https://oauth2.googleapis.com/token", me: "https://openidconnect.googleapis.com/v1/userinfo", scope: "openid email profile" }
};
const oauthEnabled = (p) => !!(config.oauth[p] && config.oauth[p].id && config.oauth[p].secret);
function oauthStart(provider, state) {
  const o = OAUTH[provider];
  const q = new URLSearchParams({ client_id: config.oauth[provider].id, redirect_uri: `${config.baseUrl}/auth/${provider}/callback`, response_type: "code", scope: o.scope, state, prompt: provider === "google" ? "select_account" : "consent" });
  return `${o.auth}?${q}`;
}
async function oauthFinish(provider, code) {
  const o = OAUTH[provider];
  const body = new URLSearchParams({ client_id: config.oauth[provider].id, client_secret: config.oauth[provider].secret, grant_type: "authorization_code", code, redirect_uri: `${config.baseUrl}/auth/${provider}/callback` });
  const tr = await fetch(o.token, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body });
  if (!tr.ok) throw new Error(`${provider}: Token-Antwort ${tr.status}`);
  const tok = await tr.json();
  const mr = await fetch(o.me, { headers: { Authorization: `Bearer ${tok.access_token}` } });
  if (!mr.ok) throw new Error(`${provider}: Profil-Antwort ${mr.status}`);
  const me = await mr.json();
  if (provider === "discord") return { id: String(me.id), email: me.verified ? me.email : null, name: me.global_name || me.username };
  return { id: String(me.sub), email: me.email_verified ? me.email : null, name: me.name || (me.email || "").split("@")[0] };
}
/** Nutzer zu einem OAuth-Profil finden oder anlegen; gleiche bestätigte E-Mail wird verknüpft */
function userForOAuth(provider, profile) {
  const linked = db.get("SELECT user_id FROM oauth_accounts WHERE provider = ? AND provider_id = ?", provider, profile.id);
  if (linked) return getUser(linked.user_id);
  let user = profile.email ? getUserByEmail(profile.email) : null;
  if (!user) {
    if (!config.registrationOpen) return null;
    user = createUser({ email: profile.email || `${provider}-${profile.id}@no-email.local`, password: null, displayName: profile.name || provider, verified: !!profile.email });
  }
  db.run("INSERT INTO oauth_accounts (provider, provider_id, user_id, email, created_at) VALUES (?, ?, ?, ?, ?)", provider, profile.id, user.id, profile.email, db.now());
  return user;
}

module.exports = { hashPassword, verifyPassword, passwordProblem, normEmail, createUser, getUser, getUserByEmail, getUserByHandle, createSession, sessionUser, destroySession, destroyAllSessions, createEmailToken, consumeEmailToken, createDeviceCode, claimDeviceCode, deviceFromToken, csrfToken, csrfOk, oauthEnabled, oauthStart, oauthFinish, userForOAuth, randomId, sha256 };
