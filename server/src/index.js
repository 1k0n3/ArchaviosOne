#!/usr/bin/env node
// MTGA Stats Website: Konten, Deck-Freigaben, Sync-API für den Companion, Nutzer-Dashboards mit dem gemeinsamen Frontend.
const path = require("path");
const fastify = require("fastify");
const config = require("./config");
const db = require("./db");
const cards = require("./cards");

async function main() {
  db.migrate();
  const app = fastify({ logger: { level: config.isProd ? "info" : "info" }, trustProxy: config.trustProxy, bodyLimit: 2 * 1024 * 1024 });
  await app.register(require("@fastify/helmet"), {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],                       // Dashboard-Seiten haben Inline-Skripte
        scriptSrcAttr: ["'unsafe-inline'"],                             // onclick/onerror im gemeinsamen Frontend
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "https://cards.scryfall.io", "https://backs.scryfall.io", "https://svgs.scryfall.io"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'", "https://discord.com", "https://accounts.google.com"]
      }
    },
    crossOriginEmbedderPolicy: false, crossOriginResourcePolicy: { policy: "cross-origin" }
  });
  await app.register(require("@fastify/rate-limit"), { global: true, max: 600, timeWindow: "1 minute" });
  await app.register(require("@fastify/cookie"), { secret: config.sessionSecret });
  await app.register(require("@fastify/formbody"));
  // Statische Dateien: eigene (static/), das gemeinsame Frontend (web/) und Icons (assets/) unter /static/
  await app.register(require("@fastify/static"), { root: [path.join(__dirname, "..", "static"), path.join(__dirname, "..", "..", "web"), path.join(__dirname, "..", "..", "assets")], prefix: "/static/", decorateReply: false, maxAge: "1h", allowedPath: (p) => /.(css|js|png|ico|webmanifest|svg)$/.test(p) });
  app.get("/healthz", async () => ({ ok: true, cards: db.get("SELECT COUNT(*) n FROM cards").n }));
  await app.register(require("./routes/pages"));
  await app.register(require("./routes/api"));
  await app.register(require("./routes/dash"));
  app.setNotFoundHandler((req, reply) => reply.code(404).type("text/html; charset=utf-8").send(require("./views").layout({ title: "Nicht gefunden", body: require("./views").pages.message({ title: "Seite nicht gefunden", text: "", link: { href: "/", text: "Zur Startseite" } }) })));
  cards.scheduleCardSync((m) => app.log.info(m));
  await app.listen({ host: config.host, port: config.port });
  app.log.info(`MTGA Stats Website: ${config.baseUrl} (${config.env})`);
}
main().catch((e) => { console.error(e); process.exit(1); });
