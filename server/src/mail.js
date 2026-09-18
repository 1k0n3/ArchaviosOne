// E-Mail-Versand (Bestätigung, Passwort-Reset). Ohne SMTP_URL werden die Links ins Log geschrieben,
// damit die Entwicklung ohne Mailserver funktioniert.
const nodemailer = require("nodemailer");
const config = require("./config");

let transport = null;
function getTransport() {
  if (transport) return transport;
  transport = config.mail.smtpUrl ? nodemailer.createTransport(config.mail.smtpUrl) : null;
  return transport;
}

async function send(to, subject, text, log = console.log) {
  const t = getTransport();
  if (!t) { log(`[MAIL an ${to}] ${subject}\n${text}`); return false; }
  await t.sendMail({ from: config.mail.from, to, subject, text });
  return true;
}

module.exports = {
  send,
  verify: (to, link, log) => send(to, "MTGA Stats: E-Mail bestätigen", `Willkommen bei MTGA Stats!\n\nBitte bestätige deine E-Mail-Adresse über diesen Link (24 Stunden gültig):\n${link}\n\nWenn du dich nicht registriert hast, ignoriere diese Mail.`, log),
  reset: (to, link, log) => send(to, "MTGA Stats: Passwort zurücksetzen", `Über diesen Link kannst du ein neues Passwort setzen (2 Stunden gültig):\n${link}\n\nWenn du das nicht angefordert hast, ignoriere diese Mail. Dein Passwort bleibt unverändert.`, log)
};
