// Konfiguration aus Umgebungsvariablen (siehe .env.example). Läuft ohne .env mit sicheren Entwicklungswerten.
const path = require("path");
const fs = require("fs");

function loadDotEnv() {
  const p = path.join(__dirname, "..", ".env");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
loadDotEnv();

const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== "" ? process.env[k] : d);
const dataDir = path.resolve(env("DATA_DIR", path.join(__dirname, "..", "data")));
fs.mkdirSync(dataDir, { recursive: true });

// Geheimnis für Cookie-Signaturen: aus der Umgebung, sonst einmalig erzeugt und in data/ abgelegt
function secret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const f = path.join(dataDir, "session-secret");
  if (fs.existsSync(f)) return fs.readFileSync(f, "utf8").trim();
  const s = require("crypto").randomBytes(48).toString("base64url");
  fs.writeFileSync(f, s, { mode: 0o600 });
  return s;
}

module.exports = {
  env: env("NODE_ENV", "development"),
  isProd: env("NODE_ENV", "development") === "production",
  host: env("HOST", "0.0.0.0"),
  port: +env("PORT", 3000),
  baseUrl: env("BASE_URL", "http://localhost:3000").replace(/\/$/, ""),
  dataDir,
  dbFile: path.join(dataDir, env("DB_FILE", "mtga-stats.sqlite")),
  sessionSecret: secret(),
  sessionDays: +env("SESSION_DAYS", 30),
  trustProxy: env("TRUST_PROXY", "1") === "1",
  mail: {
    from: env("MAIL_FROM", "MTGA Stats <no-reply@localhost>"),
    smtpUrl: env("SMTP_URL", ""),          // z. B. smtps://user:pass@smtp.example.com:465
  },
  oauth: {
    discord: { id: env("DISCORD_CLIENT_ID", ""), secret: env("DISCORD_CLIENT_SECRET", "") },
    google: { id: env("GOOGLE_CLIENT_ID", ""), secret: env("GOOGLE_CLIENT_SECRET", "") }
  },
  scryfall: { userAgent: "MTGAStatsServer/0.1 (+https://github.com/mtga-stats)" },
  registrationOpen: env("REGISTRATION_OPEN", "1") === "1"
};
