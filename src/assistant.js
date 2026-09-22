/**
 * KI-Assistent: Brücke zwischen dem Dashboard und einem Sprachmodell.
 *
 * Der Browser führt die Unterhaltung samt Werkzeugen selbst (er kennt Sammlung, Decks und Matches);
 * dieses Modul hält nur den Zugangsschlüssel, spricht das Protokoll des Anbieters und streamt die
 * Antwort als SSE zurück. Damit verlässt der Schlüssel niemals den eigenen Rechner.
 *
 * Endpunkte (alle unter /api/assistant/, nur über 127.0.0.1 erreichbar):
 *   GET  state            -> { ok, provider, model, hasKey, providers[] }
 *   POST config           -> Anbieter/Modell/Schlüssel speichern (Schlüssel wird nie zurückgegeben)
 *   GET  models           -> Modelle des Anbieters (bei OpenRouter nur kostenlose mit Werkzeugen)
 *   GET  oauth/start      -> { url } für den Browser-Login (PKCE)
 *   GET  oauth/callback   -> holt den Schlüssel ab und zeigt eine Abschlussseite
 *   POST chat             -> SSE: {t:"text"|"tool"|"done"|"err"|"usage"}
 *   GET  scryfall         -> Kartensuche/Regeln außerhalb von Arena
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const paths = require("./paths");

// ---- Einstellungen: liegen in out/assistant.json (nicht im Git, nur für den Besitzer lesbar) -----
function cfgFile() { return path.join(paths.outDir(), "assistant.json"); }
function rawCfg() { try { return JSON.parse(fs.readFileSync(cfgFile(), "utf8")); } catch (e) { return {}; } }

/**
 * Zugang und Modell gehören zum Anbieter, nicht zur Person: sie liegen unter keys/models je Anbieter.
 * Sonst wandert beim Wechsel der Schlüssel des einen Dienstes zum anderen, der ihn zurückweist.
 * Ältere Dateien haben apiKey und model flach gespeichert; die zählen zum eingetragenen Anbieter.
 */
function normCfg(raw) {
  const p = raw.provider || "openrouter";
  const keys = Object.assign({}, raw.keys && typeof raw.keys === "object" ? raw.keys : null);
  const models = Object.assign({}, raw.models && typeof raw.models === "object" ? raw.models : null);
  // Nur echte Altdateien haben den Schlüssel flach und ohne Zuordnung; dort gehört er zum
  // eingetragenen Anbieter. Liegt bereits eine Zuordnung vor, ist das flache Feld nur die
  // Rückfallebene für ältere Fassungen und darf keinem anderen Anbieter zugeschlagen werden.
  const alt = !raw.keys || typeof raw.keys !== "object";
  if (alt && raw.apiKey) keys[p] = raw.apiKey;
  if ((alt || !raw.models) && raw.model && !models[p]) models[p] = raw.model;
  return { provider: p, keys, models, baseUrl: raw.baseUrl || "" };
}

/** Flache Sicht auf den gerade gewählten Anbieter, wie der übrige Code sie erwartet */
function readCfg() {
  const n = normCfg(rawCfg());
  return { provider: n.provider, apiKey: n.keys[n.provider] || "", model: n.models[n.provider] || "", baseUrl: n.baseUrl };
}

/** Welche Anbieter schon einen Zugang haben – für den Hinweis beim Wechsel */
function connectedProviders() {
  const n = normCfg(rawCfg());
  return Object.keys(n.keys).filter((k) => n.keys[k]);
}
function writeCfg(patch, opt = {}) {
  const n = normCfg(rawCfg());
  if (patch.provider !== undefined && patch.provider !== null && patch.provider !== "") n.provider = patch.provider;
  if (patch.baseUrl !== undefined) n.baseUrl = patch.baseUrl || "";
  // Schlüssel und Modell landen beim gerade gewählten Anbieter; null löscht nur dessen Eintrag
  if (patch.apiKey === null) delete n.keys[n.provider];
  else if (typeof patch.apiKey === "string" && patch.apiKey) n.keys[n.provider] = patch.apiKey;
  if (patch.model === null) delete n.models[n.provider];
  else if (typeof patch.model === "string") { if (patch.model) n.models[n.provider] = patch.model; else delete n.models[n.provider]; }
  // Wann sich zuletzt etwas geändert hat; der Abgleich mit der Website entscheidet danach
  const c = { provider: n.provider, keys: n.keys, models: n.models, updatedAt: opt.stand || new Date().toISOString() };
  if (n.baseUrl) c.baseUrl = n.baseUrl;
  // Flache Felder bleiben zusätzlich stehen, damit eine ältere laufende Fassung die Datei noch liest
  if (n.keys[n.provider]) c.apiKey = n.keys[n.provider];
  if (n.models[n.provider]) c.model = n.models[n.provider];
  fs.mkdirSync(path.dirname(cfgFile()), { recursive: true });
  fs.writeFileSync(cfgFile(), JSON.stringify(c, null, 2), { mode: 0o600 });
  const flach = readCfg();
  // Zur Website geht nur ein vollständiger Zugang. Ein leerer Schlüssel (Wechsel, Vergessen,
  // gescheiterte Prüfung) darf dort nichts überschreiben.
  if (opt.spiegeln !== false && flach.apiKey) mirrorToSite(flach);
  return flach;
}
/** Denselben Zugang auf der Website hinterlegen, sofern das Konto verbunden ist */
function mirrorToSite(c) {
  // In Testläufen nie zur echten Website: node --test setzt NODE_TEST_CONTEXT, die Tests zusätzlich
  // MTGA_NO_MIRROR. Sonst landen Testschlüssel im Konto des Spielers.
  if (process.env.MTGA_NO_MIRROR || process.env.NODE_TEST_CONTEXT) return;
  try {
    const sync = require("./sync");
    if (!sync.device || !sync.device()) return;
    if (!sync.enqueueAssistant(c)) return;
    sync.flush(() => {}).catch(() => {});   // im Hintergrund, Fehler stören die Einstellung nicht
  } catch (e) { /* ohne Cloud-Sync */ }
}

/**
 * Holt den Zugang von der Website, falls dieses Gerät mit einem Konto verbunden ist. Verbindet der
 * Spieler den Assistenten auf der Website, ist er damit auch hier angemeldet, ohne zweite Eingabe.
 * Übernommen wird nur ein Zugang, der hier noch unbekannt und dort neuer ist. Gelöscht wird hier nie
 * etwas: ein Abgleich soll keine Verbindung kappen.
 */
let letzterAbgleich = 0;
async function pullFromSite(force, opt = {}) {
  let sync;
  try { sync = require("./sync"); } catch (e) { return { ok: false, grund: "ohne Sync" }; }
  const dev = sync.device && sync.device();
  const url = sync.baseUrl && sync.baseUrl();
  if (!dev || !dev.token || !url) return { ok: false, grund: "nicht verbunden" };
  if (!force && Date.now() - letzterAbgleich < 60000) return { ok: true, neu: false };
  letzterAbgleich = Date.now();
  const ac = new AbortController(), to = setTimeout(() => ac.abort(), 12000);
  let r;
  try { r = await fetch(url + "/api/v1/assistant", { headers: { Authorization: "Bearer " + dev.token }, signal: ac.signal }); }
  finally { clearTimeout(to); }
  if (!r.ok) return { ok: false, grund: "HTTP " + r.status };
  const j = await r.json().catch(() => null);
  if (!j || !j.provider || !j.key || !PROVIDERS[j.provider]) return { ok: true, neu: false };
  const roh = rawCfg(), n = normCfg(roh);
  if (n.keys[j.provider] === j.key) return { ok: true, neu: false };
  const lokal = Date.parse(roh.updatedAt || "") || 0, fern = Date.parse(j.updatedAt || "") || 0;
  if (lokal && fern && fern <= lokal) return { ok: true, neu: false };
  // Erst prüfen, dann übernehmen: ein veralteter oder ungültiger Schlüssel auf der Website soll hier
  // keinen funktionierenden Zugang verdrängen
  if (!opt.ungeprueft) {
    const v = await verifyKey({ provider: j.provider, apiKey: j.key, model: j.model || "" }).catch(() => ({ ok: false }));
    if (!v.ok && v.auth) return { ok: true, neu: false, abgelehnt: true };
  }
  const patch = { provider: j.provider, apiKey: j.key };
  if (j.model) patch.model = j.model;
  writeCfg(patch, { spiegeln: false, stand: j.updatedAt || undefined });
  return { ok: true, neu: true, provider: j.provider };
}

/** Anbieter: wire = Protokoll (openai-kompatibel oder Anthropic), oauth = Anmeldung im Browser möglich */
const PROVIDERS = {
  openrouter: { label: "OpenRouter", wire: "openai", base: "https://openrouter.ai/api/v1", oauth: true, free: true, model: "nvidia/nemotron-3-ultra-550b-a55b:free", keyUrl: "https://openrouter.ai/keys", accountUrl: "https://openrouter.ai/settings/credits", hint: "Kostenlose Modelle, Anmeldung direkt im Browser." },
  google: { label: "Google Gemini", wire: "openai", base: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-3.6-flash", prefer: ["^gemini-[0-9.]+-flash$", "^gemini-[0-9.]+-flash"], free: true, keyUrl: "https://aistudio.google.com/apikey", accountUrl: "https://aistudio.google.com/", hint: "Großzügiges Gratiskontingent, Schlüssel aus dem AI Studio." },
  anthropic: { label: "Anthropic Claude", wire: "anthropic", base: "https://api.anthropic.com", model: "claude-sonnet-5", prefer: ["sonnet", "haiku"], keyUrl: "https://console.anthropic.com/settings/keys", accountUrl: "https://console.anthropic.com/settings/billing", hint: "Stärkste Werkzeugnutzung, kostenpflichtig." },
  openai: { label: "OpenAI", wire: "openai", base: "https://api.openai.com/v1", model: "gpt-4.1-mini", prefer: ["^gpt-[0-9.]+-mini$", "mini"], keyUrl: "https://platform.openai.com/api-keys", accountUrl: "https://platform.openai.com/usage", hint: "Kostenpflichtig." },
  groq: { label: "Groq", wire: "openai", base: "https://api.groq.com/openai/v1", free: true, keyUrl: "https://console.groq.com/keys", accountUrl: "https://console.groq.com/settings/limits", hint: "Sehr schnell, Gratiskontingent mit Tageslimit." },
  ollama: { label: "Ollama (lokal)", wire: "openai", base: "http://localhost:11434/v1", noKey: true, hint: "Läuft offline auf dem eigenen Rechner, braucht starke Hardware." },
  custom: { label: "Eigener Anbieter", wire: "openai", base: "", hint: "Beliebiger OpenAI-kompatibler Dienst: Adresse und Modell selbst eintragen." }
};
const prov = (c) => PROVIDERS[c.provider] || PROVIDERS.openrouter;
// Eine eigene Adresse gilt nur für "Eigener Anbieter". Sonst ginge nach einem Ausflug dorthin der
// Schlüssel von OpenAI oder Anthropic an die zuletzt eingetragene fremde Adresse.
const baseUrl = (c) => String((c.provider === "custom" ? c.baseUrl : "") || prov(c).base || "").replace(/\/$/, "");
const modelOf = (c) => c.model || prov(c).model || "";

// ---- Anfragen an den Anbieter -------------------------------------------------------------------
function authHeaders(c) {
  const p = prov(c), h = { "Content-Type": "application/json" };
  if (p.noKey) return h;
  if (p.wire === "anthropic") { h["x-api-key"] = c.apiKey || ""; h["anthropic-version"] = "2023-06-01"; }
  else h.Authorization = "Bearer " + (c.apiKey || "");
  if (c.provider === "openrouter") { h["HTTP-Referer"] = "https://mtga.a16.be"; h["X-Title"] = "MTGA Stats"; }
  return h;
}
async function apiFetch(c, url, init = {}, timeoutMs = 120000) {
  const ac = new AbortController(), to = setTimeout(() => ac.abort(), timeoutMs);
  const signal = init.signal ? AbortSignal.any([ac.signal, init.signal]) : ac.signal;
  try { return await fetch(url, Object.assign({ headers: authHeaders(c) }, init, { signal })); }
  catch (e) {
    // Abbruch von außen (Stopp) unverändert weitergeben
    if (init.signal && init.signal.aborted) throw e;
    // "fetch failed" sagt nichts. Der eigentliche Grund steckt in e.cause (Zeitüberschreitung,
    // Verbindung zurückgesetzt, Name nicht auflösbar …).
    let host = ""; try { host = new URL(url).host; } catch (x) { /* egal */ }
    const ursache = ac.signal.aborted ? "Zeitüberschreitung" : ((e.cause && (e.cause.code || e.cause.message)) || e.message || "");
    const err = new Error("Keine Verbindung zu " + (host || "dem Anbieter") + (ursache ? " (" + ursache + ")" : ""));
    err.netz = true;
    throw err;
  }
  finally { clearTimeout(to); }
}
/** Wie apiFetch, aber ein Netzaussetzer wird nach kurzer Pause einmal wiederholt */
async function apiFetchNochmal(c, url, init = {}, timeoutMs) {
  try { return await apiFetch(c, url, init, timeoutMs); }
  catch (e) {
    if (!e.netz) throw e;
    await new Promise((ok) => setTimeout(ok, 900));
    return apiFetch(c, url, init, timeoutMs);
  }
}

/**
 * Auskunft über den hinterlegten Zugang. Nur OpenRouter liefert dazu etwas Brauchbares: verbrauchtes
 * Guthaben, ob der Gratistarif gilt und die Anfragebremse. Alles andere meldet schlicht nichts, statt
 * Zahlen zu erfinden.
 */
async function keyInfo(c) {
  if (c.provider !== "openrouter" || !c.apiKey) return { ok: true, known: false };
  const r = await apiFetch(c, baseUrl(c) + "/key", {}, 15000);
  if (!r.ok) return { ok: true, known: false };
  const j = await r.json().catch(() => null);
  const d = (j && j.data) || null;
  if (!d) return { ok: true, known: false };
  const t = d.free_model_daily_requests || null;
  const zahl = (v) => (typeof v === "number" ? v : null);
  return {
    ok: true, known: true,
    frei: d.is_free_tier !== false,
    tagBenutzt: t ? zahl(t.used) : null,
    tagGrenze: t ? zahl(t.limit) : null,
    tagRest: t ? zahl(t.remaining) : null,
    heute: zahl(d.usage_daily),
    guthabenRest: zahl(d.limit_remaining)
  };
}

/**
 * Prüft, ob der hinterlegte Schlüssel wirklich gilt. Die Modellliste taugt dafür nicht: Google gibt
 * sie auch ohne gültigen Schlüssel heraus. Bei OpenRouter fragen wir die Auskunft zum Schlüssel, die
 * kostet nichts vom Tageskontingent. Sonst genügt eine Antwort von einem einzigen Token.
 */
/** Kürzt auf höchstens n Zeichen, aber an einer Satz- oder Wortgrenze */
function kurz(t, n = 360) {
  t = String(t || "").replace(/\s+/g, " ").trim();
  if (t.length <= n) return t;
  const s = t.slice(0, n), satz = s.lastIndexOf(". ");
  return (satz > n * 0.5 ? s.slice(0, satz + 1) : s.slice(0, s.lastIndexOf(" ")) + " …");
}
function fehlerText(roh) {
  let j = null;
  try { j = JSON.parse(roh); } catch (x) { return ""; }
  const o = Array.isArray(j) ? j[0] : j;          // Google antwortet mit einer Liste
  const e = o && o.error;
  return typeof e === "string" ? e : String((e && e.message) || (o && o.message) || "");
}

async function verifyKey(c) {
  const p = prov(c), base = baseUrl(c);
  if (p.noKey) return { ok: true };
  if (!base) return { ok: false, error: "Kein Anbieter eingerichtet." };
  if (!String(c.apiKey || "").trim()) return { ok: false, auth: true, error: "Kein Schlüssel hinterlegt." };
  // Geprüft wird über eine Abfrage, die einen gültigen Schlüssel verlangt und kein Modell braucht:
  // bei OpenRouter die Auskunft zum Schlüssel, sonst die Modellliste. So scheitert die Prüfung nie
  // an einem Modellnamen, den der Anbieter inzwischen abgeschaltet hat.
  const url = c.provider === "openrouter" ? base + "/key" : (p.wire === "anthropic" ? base + "/v1/models" : base + "/models");
  let r;
  try { r = await apiFetchNochmal(c, url, { method: "GET" }, 20000); }
  catch (e) { return { ok: false, netz: !!e.netz, error: e.message }; }
  if (r.ok) return { ok: true };
  const text = fehlerText(await r.text());
  // Abgelehnt ist der Schlüssel nur bei 401/403 oder wenn der Anbieter es ausdrücklich sagt; bei
  // allem anderen (Netz, Wartung, 404) bleibt er gespeichert.
  const auth = r.status === 401 || r.status === 403 || /api.?key|authenticat|credential|unauthori/i.test(text);
  return { ok: false, auth, status: r.status, error: "HTTP " + r.status + (text ? " – " + kurz(text) : "") };
}

/**
 * Die Listen der Anbieter enthalten auch Modelle, mit denen man nicht chatten kann: Vektoren,
 * Sprache, Bilder, Videos, Moderation. Die fliegen raus, sonst wählt jemand eines davon und der
 * Assistent schweigt.
 */
const KEIN_CHAT = /embed|whisper|tts|transcri|speech|audio|realtime|moderation|guard|dall-e|imagen|image-|-image|veo|aqa|babbage|davinci|computer-use|robotics|antigravity|deep-research|search-preview|-live|lyria|learnlm|playai|distil/i;
function nurChatModelle(provider, list) {
  let l = list.filter((m) => !KEIN_CHAT.test(m.id));
  if (provider === "google") l = l.filter((m) => /^(gemini|gemma)-/i.test(m.id));
  return l;
}

/** Modellliste des Anbieters; bei OpenRouter nur kostenlose Modelle, die Werkzeuge beherrschen */
async function listModels(c) {
  const p = prov(c), base = baseUrl(c);
  if (!base) return [];
  const url = p.wire === "anthropic" ? base + "/v1/models" : base + "/models";
  const r = await apiFetchNochmal(c, url, { method: "GET" }, 20000);
  // Die Anbieter verpacken den Grund unterschiedlich tief; hier bleibt nur der lesbare Satz übrig
  if (!r.ok) {
    const roh = await r.text();
    const grund = fehlerText(roh);
    throw new Error("HTTP " + r.status + (grund ? " – " + kurz(grund) : " " + kurz(roh, 200)));
  }
  const j = await r.json();
  let list = (j.data || j.models || []).map((m) => ({
    id: String(m.id || m.name || "").replace(/^models\//, ""),
    label: m.display_name || m.name || m.id,
    ctx: m.context_length || m.context_window || 0,
    free: /(^|\/)[^/]*:free$/.test(String(m.id || "")) || (m.pricing && Number(m.pricing.prompt) === 0),
    tools: !m.supported_parameters || m.supported_parameters.includes("tools")
  }));
  if (c.provider === "openrouter") list = list.filter((m) => m.free && m.tools);
  list = nurChatModelle(c.provider, list);
  list.sort((a, b) => (b.ctx || 0) - (a.ctx || 0) || a.id.localeCompare(b.id));
  return list;
}

// ---- Werkzeuge und Nachrichten in das Format des Anbieters übersetzen ----------------------------
const toolsFor = (wire, tools) => (tools || []).map((t) => (wire === "anthropic"
  ? { name: t.name, description: t.description, input_schema: t.parameters }
  : { type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));

/** Neutrale Nachricht: { role: "user"|"assistant"|"tool", text, calls:[{id,name,args}], callId } */
function messagesFor(wire, msgs) {
  const out = [];
  for (const m of msgs) {
    if (wire === "anthropic") {
      if (m.role === "tool") { out.push({ role: "user", content: [{ type: "tool_result", tool_use_id: m.callId, content: String(m.text || "") }] }); continue; }
      const blocks = [];
      if (m.text) blocks.push({ type: "text", text: m.text });
      for (const c of m.calls || []) blocks.push({ type: "tool_use", id: c.id, name: c.name, input: c.args || {} });
      if (blocks.length) out.push({ role: m.role, content: blocks });
      continue;
    }
    if (m.role === "tool") { out.push({ role: "tool", tool_call_id: m.callId, content: String(m.text || "") }); continue; }
    if (m.role === "assistant" && (m.calls || []).length) {
      out.push({ role: "assistant", content: m.text || null, tool_calls: m.calls.map((c) => Object.assign({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args || {}) } }, c.extra || null)) });
      continue;
    }
    out.push({ role: m.role, content: m.text || "" });
  }
  // Anthropic verlangt abwechselnde Rollen: aufeinanderfolgende gleiche Rollen zusammenlegen
  if (wire !== "anthropic") return out;
  const merged = [];
  for (const m of out) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) last.content = [].concat(last.content, m.content);
    else merged.push(m);
  }
  return merged;
}

// ---- Antwort streamen ---------------------------------------------------------------------------
const sse = (res, o) => { try { res.write("data: " + JSON.stringify(o) + "\n\n"); } catch (e) { /* Verbindung zu */ } };

/**
 * Eine Runde mit dem Modell: Text wird stückweise gesendet, Werkzeugaufrufe am Ende vollständig.
 * Der Browser führt die Werkzeuge aus und ruft danach erneut auf.
 */
/**
 * Gemini verlangt zu jedem Werkzeugaufruf im Verlauf eine Signatur aus seinem eigenen Denkprozess.
 * Fehlt sie – weil die Runde von einem anderen Anbieter stammt oder aus einer älteren Fassung –,
 * weist Gemini die ganze Anfrage ab. Dann wird aus der Runde schlichter Text: der Verlauf bleibt
 * erhalten, die Anfrage geht durch.
 */
function ohneSignatur(msgs) {
  const out = [];
  for (const m of msgs || []) {
    const calls = m.calls || [];
    if (m.role === "assistant" && calls.length && !calls.some((c) => c && c.extra)) {
      const namen = calls.map((c) => c.name).filter(Boolean).join(", ");
      out.push({ role: "assistant", text: (m.text ? m.text + "\n" : "") + "[Werkzeug benutzt: " + namen + "]" });
      continue;
    }
    if (m.role === "tool" && !out.some((x) => (x.calls || []).some((c) => c.id === m.callId))) {
      out.push({ role: "user", text: "[Ergebnis des Werkzeugs]\n" + String(m.text || "") });
      continue;
    }
    out.push(m);
  }
  return out;
}

/**
 * Schaltet ein Anbieter ein Modell ab, nennt er oft den Nachfolger ("use models/gemini-3.6-flash").
 * Dann nehmen wir den und merken ihn uns, statt dem Spieler einen Fehler zu zeigen. Ohne Hinweis
 * greift das Standardmodell des Anbieters.
 */
function ersatzModell(c, status, text, jetzt) {
  if (status !== 404 && status !== 400) return "";
  const t = String(text || "");
  if (!/no longer available|not found|does not exist|deprecated|not supported|unknown model|invalid model/i.test(t)) return "";
  const m = t.match(/use (?:models\/)?([a-z0-9][\w.\-]*[a-z0-9])/i);
  const neu = m ? m[1] : (prov(c).model || "");
  return neu && neu !== jetzt ? neu : "";
}

async function chat(c, body, res) {
  const p = prov(c), base = baseUrl(c), model = modelOf(c);
  if (!base) { sse(res, { t: "err", m: "Kein Anbieter eingerichtet." }); return; }
  if (!model) { sse(res, { t: "err", m: "Kein Modell gewählt." }); return; }
  if (!String(c.apiKey || "").trim() && !p.noKey) { sse(res, { t: "err", m: "Kein Zugangsschlüssel für " + p.label + " hinterlegt." }); return; }
  const msgs = c.provider === "google" ? ohneSignatur(body.messages || []) : (body.messages || []);
  const req = p.wire === "anthropic"
    ? { model, max_tokens: body.maxTokens || 4096, stream: true, system: body.system || "", messages: messagesFor("anthropic", msgs), tools: toolsFor("anthropic", body.tools) }
    : { model, stream: true, messages: [{ role: "system", content: body.system || "" }].concat(messagesFor("openai", msgs)), tools: toolsFor("openai", body.tools) };
  // Verbrauchszahlen nur bei Diensten anfragen, die das Feld kennen; andere antworten sonst mit 400
  if (p.wire !== "anthropic" && (c.provider === "openai" || c.provider === "openrouter")) req.stream_options = { include_usage: true };
  if (!req.tools || !req.tools.length) delete req.tools;
  const url = p.wire === "anthropic" ? base + "/v1/messages" : base + "/chat/completions";

  // Schließt der Browser die Verbindung (Stopp), bricht auch die Anfrage beim Anbieter ab: sonst
  // rechnet ein bezahlter Dienst weiter. Kommt 90 Sekunden lang nichts, gilt die Antwort als hängend.
  const halt = new AbortController();
  let ruhe = null, haengt = false;
  const wecken = () => { clearTimeout(ruhe); ruhe = setTimeout(() => { haengt = true; halt.abort(); }, 90000); };
  res.on("close", () => { clearTimeout(ruhe); halt.abort(); });
  wecken();
  let r;
  try { r = await apiFetchNochmal(c, url, { method: "POST", body: JSON.stringify(req), signal: halt.signal }); }
  catch (e) { clearTimeout(ruhe); if (!halt.signal.aborted || haengt) sse(res, { t: "err", m: e.message }); return; }
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    const neu = ersatzModell(c, r.status, fehlerText(txt) || txt, req.model);
    if (neu) {
      req.model = neu;
      try { writeCfg({ model: neu }); } catch (e) { /* nur merken, wenn es geht */ }
      sse(res, { t: "model", model: neu });
      r = await apiFetch(c, url, { method: "POST", body: JSON.stringify(req), signal: halt.signal });
    } else {
      const msg = fehlerText(txt) || txt;
      sse(res, { t: "err", m: "Anbieter: HTTP " + r.status + (msg ? " – " + kurz(msg, 500) : ""), status: r.status });
      return;
    }
  }
  if (!r.ok || !r.body) {
    const txt = await r.text().catch(() => "");
    const msg = fehlerText(txt) || txt;
    sse(res, { t: "err", m: "Anbieter: HTTP " + r.status + (msg ? " – " + kurz(msg, 500) : ""), status: r.status });
    return;
  }
  const calls = new Map();   // index/id -> { id, name, args }
  const sentCalls = new Set();
  let buf = "", stop = "end", usage = null;
  const flushCall = (k) => {
    const v = calls.get(k);
    if (!v || sentCalls.has(k)) return;
    sentCalls.add(k);
    let args = {}; try { args = JSON.parse(v.raw || "{}"); } catch (e) { args = {}; }
    sse(res, { t: "tool", id: v.id, name: v.name, args, extra: v.extra || null });
  };

  // Ein Umlaut kann auf zwei Netzpakete verteilt ankommen; der Decoder hält die Hälfte fest
  const dec = new TextDecoder("utf-8");
  let abgeschnitten = false;
  try {
  for await (const chunk of r.body) {
    wecken();
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i); buf = buf.slice(i + 2);
      const line = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
      if (!line || line === "[DONE]") continue;
      let ev; try { ev = JSON.parse(line); } catch (e) { continue; }
      if (p.wire === "anthropic") {
        if (ev.type === "content_block_start" && ev.content_block && ev.content_block.type === "tool_use") calls.set(ev.index, { id: ev.content_block.id, name: ev.content_block.name, raw: "" });
        else if (ev.type === "content_block_delta" && ev.delta) {
          if (ev.delta.type === "text_delta") sse(res, { t: "text", d: ev.delta.text });
          else if (ev.delta.type === "input_json_delta") { const v = calls.get(ev.index); if (v) v.raw += ev.delta.partial_json || ""; }
        } else if (ev.type === "content_block_stop") flushCall(ev.index);
        else if (ev.type === "message_delta") { if (ev.delta && ev.delta.stop_reason === "tool_use") stop = "tool"; if (ev.usage) usage = { out: ev.usage.output_tokens }; }
        else if (ev.type === "error") sse(res, { t: "err", m: (ev.error && ev.error.message) || "Fehler beim Anbieter" });
        continue;
      }
      if (ev.usage) usage = { in: ev.usage.prompt_tokens, out: ev.usage.completion_tokens };
      const ch = (ev.choices || [])[0];
      if (!ch) continue;
      const d = ch.delta || {};
      if (d.content) sse(res, { t: "text", d: d.content });
      for (const tc of d.tool_calls || []) {
        const k = tc.index != null ? tc.index : tc.id;
        if (!calls.has(k)) calls.set(k, { id: tc.id || "call_" + k, name: "", raw: "", extra: null });
        const v = calls.get(k);
        if (tc.id) v.id = tc.id;
        // Manche Anbieter hängen an den Aufruf eigene Angaben, die beim nächsten Mal wieder
        // mitkommen müssen – Gemini etwa die Signatur seines Denkprozesses. Was wir nicht kennen,
        // reichen wir unverändert durch.
        for (const [kk, vv] of Object.entries(tc)) {
          if (kk === "index" || kk === "id" || kk === "type" || kk === "function") continue;
          v.extra = Object.assign(v.extra || {}, { [kk]: vv });
        }
        if (tc.function && tc.function.name) v.name += tc.function.name;
        if (tc.function && tc.function.arguments) v.raw += tc.function.arguments;
      }
      if (ch.finish_reason === "length") abgeschnitten = true;
      else if (ch.finish_reason === "tool_calls") { stop = "tool"; for (const k of calls.keys()) flushCall(k); }
      else if (ch.finish_reason) stop = "end";
    }
  }
  } catch (e) {
    clearTimeout(ruhe);
    if (haengt) sse(res, { t: "err", m: "Der Anbieter antwortet nicht mehr. Bitte noch einmal fragen." });
    return;
  }
  clearTimeout(ruhe);
  // Bei "length" ist ein Werkzeugaufruf mitten im Text abgebrochen; mit halben Angaben ausgeführt,
  // täte er etwas anderes als gemeint
  if (abgeschnitten) { if (calls.size) sse(res, { t: "err", m: "Die Antwort wurde abgeschnitten, bevor der Werkzeugaufruf vollständig war." }); calls.clear(); }
  // Nicht jeder Anbieter schickt ein sauberes Ende: übrig gebliebene Werkzeugaufrufe jetzt senden
  if (sentCalls.size < calls.size) { for (const k of calls.keys()) if (!sentCalls.has(k)) { stop = "tool"; flushCall(k); } }
  if (usage) sse(res, { t: "usage", in: usage.in || 0, out: usage.out || 0 });
  sse(res, { t: "done", stop });
}

// ---- Anmeldung im Browser (PKCE, ohne Schlüssel tippen) -----------------------------------------
const pkce = new Map();   // state -> { verifier, at }
function oauthStart(port) {
  const verifier = crypto.randomBytes(48).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const state = crypto.randomBytes(12).toString("hex");
  pkce.set(state, { verifier, at: Date.now() });
  for (const [k, v] of pkce) if (Date.now() - v.at > 10 * 60 * 1000) pkce.delete(k);
  const cb = `http://localhost:${port}/api/assistant/oauth/callback?state=${state}`;
  return { url: `https://openrouter.ai/auth?callback_url=${encodeURIComponent(cb)}&code_challenge=${challenge}&code_challenge_method=S256` };
}
async function oauthFinish(code, state) {
  const e = pkce.get(state);
  if (!e) throw new Error("Anmeldung abgelaufen – bitte erneut starten.");
  pkce.delete(state);
  const r = await fetch("https://openrouter.ai/api/v1/auth/keys", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, code_verifier: e.verifier, code_challenge_method: "S256" })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.key) throw new Error("OpenRouter: " + (j.error || ("HTTP " + r.status)));
  const cfg = writeCfg({ provider: "openrouter", apiKey: j.key });
  if (!cfg.model) {
    try {
      const l = await listModels(readCfg()), want = PROVIDERS.openrouter.model;
      if (l.length) writeCfg({ model: l.some((m) => m.id === want) ? want : l[0].id });
    } catch (x) { /* Modell später wählen */ }
  }
  return true;
}

// ---- Kartensuche über die Arena-Datenbank (Werkzeug des Assistenten) -----------------------------
const COLOR_ID = { w: "1", u: "2", b: "3", r: "4", g: "5" };
const TYPE_ID = { artefakt: 1, artifact: 1, kreatur: 2, creature: 2, verzauberung: 3, enchantment: 3, spontanzauber: 4, instant: 4, land: 5, planeswalker: 8, hexerei: 10, sorcery: 10, schlacht: 14, battle: 14 };
const RARITY_ID = { land: 1, common: 2, uncommon: 3, rare: 4, mythic: 5 };

/**
 * Sucht in allen Arena-Karten. Felder je Treffer sind knapp gehalten, damit viele Treffer in den
 * Kontext des Modells passen. rows: [grpId, name, set, nr, rarity, colors, types, artId, cmc, owned,
 * cost, isToken, isRebalanced, isPrimary, flags, power, toughness, text, typeLine]
 */
function searchCards(rows, q) {
  const text = String(q.q || "").toLowerCase().trim();
  const words = text ? text.split(/\s+/) : [];
  const colors = String(q.colors || "").toLowerCase().replace(/[^wubrg]/g, "").split("").map((x) => COLOR_ID[x]);
  const type = String(q.type || "").toLowerCase().trim();
  const typeId = TYPE_ID[type];
  const rarity = RARITY_ID[String(q.rarity || "").toLowerCase()];
  const set = String(q.set || "").toUpperCase().trim();
  const cmcMin = q.cmc_min != null ? +q.cmc_min : (q.cmc != null ? +q.cmc : null);
  const cmcMax = q.cmc_max != null ? +q.cmc_max : (q.cmc != null ? +q.cmc : null);
  const owned = q.owned === true || q.owned === "true" || q.owned === 1;
  const limit = Math.min(60, Math.max(1, +q.limit || 20));
  const out = [];
  for (const r of rows) {
    if (r[11]) continue;                                        // Token überspringen
    if (owned && !r[9]) continue;
    if (typeId && !String(r[6] || "").split(",").includes(String(typeId))) continue;
    if (rarity && r[4] !== rarity) continue;
    if (set && String(r[2] || "").toUpperCase() !== set) continue;
    if (cmcMin != null && r[8] < cmcMin) continue;
    if (cmcMax != null && r[8] > cmcMax) continue;
    if (colors.length) {
      const cc = String(r[5] || "").split(",").filter(Boolean);
      if (q.colors_exact ? (cc.length !== colors.length || !colors.every((x) => cc.includes(x))) : !colors.some((x) => cc.includes(x))) continue;
    }
    if (words.length) {
      const hay = (r[1] + " " + (r[18] || "") + " " + (r[17] || "")).toLowerCase();
      if (!words.every((w) => hay.includes(w))) continue;
    }
    out.push(r);
    if (out.length > 400) break;
  }
  // Eigene Karten zuerst, dann günstige: das ist die Reihenfolge, die beim Deckbau zählt
  out.sort((a, b) => (b[9] ? 1 : 0) - (a[9] ? 1 : 0) || a[8] - b[8] || a[1].localeCompare(b[1]));
  const seen = new Set(), res = [];
  for (const r of out) {
    if (seen.has(r[1])) continue;                               // pro Kartenname nur ein Druck
    seen.add(r[1]);
    res.push({ id: r[0], name: r[1], cost: r[10], cmc: r[8], type: r[18], pt: r[15] !== "" && r[16] !== "" ? r[15] + "/" + r[16] : "", text: String(r[17] || "").replace(/\s+/g, " ").slice(0, 300), set: r[2], rarity: ["Token", "Land", "Common", "Uncommon", "Rare", "Mythic"][r[4]] || "", owned: r[9] });
    if (res.length >= limit) break;
  }
  return { total: out.length, cards: res };
}

/** Überblick über die Sammlung: Zahlen, die beim Deckbau und bei Kaufentscheidungen zählen */
function collectionSummary(rows) {
  const RAR = ["Token", "Standardland", "Common", "Uncommon", "Rare", "Mythic"];
  const COLOR = { 1: "weiß", 2: "blau", 3: "schwarz", 4: "rot", 5: "grün" };
  const TYPE = { 1: "Artefakt", 2: "Kreatur", 3: "Verzauberung", 4: "Spontanzauber", 5: "Land", 8: "Planeswalker", 10: "Hexerei", 14: "Schlacht" };
  const rar = {}, col = { mehrfarbig: 0, farblos: 0 }, typ = {}, sets = new Set();
  let distinct = 0, copies = 0, total = 0;
  for (const r of rows) {
    if (r[11]) continue;
    total++;
    if (!r[9]) continue;
    distinct++; copies += r[9];
    sets.add(r[2]);
    rar[RAR[r[4]] || "?"] = (rar[RAR[r[4]] || "?"] || 0) + 1;
    const cc = String(r[5] || "").split(",").filter(Boolean);
    if (cc.length > 1) col.mehrfarbig++;
    else if (!cc.length) col.farblos++;
    else col[COLOR[cc[0]] || "?"] = (col[COLOR[cc[0]] || "?"] || 0) + 1;
    for (const t of String(r[6] || "").split(",").filter(Boolean)) if (TYPE[t]) typ[TYPE[t]] = (typ[TYPE[t]] || 0) + 1;
  }
  return { karten_im_besitz: distinct, exemplare: copies, karten_in_arena: total, anteil_prozent: total ? Math.round(100 * distinct / total) : 0, sets: sets.size, nach_seltenheit: rar, nach_farbe: col, nach_typ: typ };
}

// ---- Scryfall für Karten und Regeln außerhalb von Arena ------------------------------------------
let sfAt = 0;
async function scryfall(kind, q) {
  const wait = Math.max(0, 120 - (Date.now() - sfAt));
  if (wait) await new Promise((r) => setTimeout(r, wait));
  sfAt = Date.now();
  const url = kind === "card" ? "https://api.scryfall.com/cards/named?fuzzy=" + encodeURIComponent(q)
    : kind === "rulings" ? "https://api.scryfall.com/cards/named?fuzzy=" + encodeURIComponent(q) + "&format=json"
      : "https://api.scryfall.com/cards/search?q=" + encodeURIComponent(q) + "&order=edhrec&unique=cards";
  const r = await fetch(url, { headers: { "User-Agent": "MTGAStats/1.0 (lokales Dashboard)", Accept: "application/json" } });
  const j = await r.json().catch(() => null);
  if (!j) throw new Error("Scryfall antwortet nicht");
  if (j.object === "error") return { error: j.details || "nicht gefunden" };
  const pick = (c) => ({ name: c.name, cost: c.mana_cost, cmc: c.cmc, type: c.type_line, text: c.oracle_text, pt: c.power ? c.power + "/" + c.toughness : "", legal: c.legalities && { standard: c.legalities.standard, historic: c.legalities.historic, brawl: c.legalities.brawl, commander: c.legalities.commander }, set: c.set_name, rank: c.edhrec_rank });
  if (j.object === "card") {
    if (kind !== "rulings") return pick(j);
    const rr = await fetch(j.rulings_uri, { headers: { Accept: "application/json" } }).then((x) => x.json()).catch(() => null);
    return { name: j.name, text: j.oracle_text, rulings: ((rr && rr.data) || []).map((x) => x.comment).slice(0, 12) };
  }
  return { total: j.total_cards || 0, cards: (j.data || []).slice(0, 20).map(pick) };
}

// ---- HTTP ---------------------------------------------------------------------------------------
function readBody(req, max = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let n = 0; const parts = [];
    req.on("data", (c) => { n += c.length; if (n > max) { reject(new Error("Anfrage zu groß")); req.destroy(); return; } parts.push(c); });
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(parts).toString("utf8") || "{}")); } catch (e) { reject(new Error("Ungültige Anfrage")); } });
    req.on("error", reject);
  });
}
const json = (res, o, code = 200) => { const b = Buffer.from(JSON.stringify(o)); res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-cache", "Content-Length": b.length }); res.end(b); };

/** Anbieterliste für die Einstellungen – ohne Schlüssel, nur was die Oberfläche braucht */
const providerList = () => Object.entries(PROVIDERS).map(([k, p]) => ({ id: k, label: p.label, hint: p.hint, oauth: !!p.oauth, free: !!p.free, noKey: !!p.noKey, keyUrl: p.keyUrl || "", accountUrl: p.accountUrl || "", base: p.base || "", model: p.model || "", prefer: p.prefer || [] }));

/**
 * Behandelt /api/assistant/* und /api/cards/search. Gibt true zurück, wenn die Anfrage erledigt ist.
 * cardRows() liefert die Kartenliste des Servers (gleiche Daten wie /api/cards).
 */
function handle(req, res, url, cardRows, port) {
  const p = url.pathname;
  if (p === "/api/cards/search") {
    const q = Object.fromEntries(url.searchParams);
    try { json(res, searchCards(cardRows(), q)); } catch (e) { json(res, { error: e.message }, 500); }
    return true;
  }
  if (!p.startsWith("/api/assistant/")) return false;
  const rest = p.slice("/api/assistant/".length);
  const c = readCfg();

  if (rest === "sync" && req.method === "POST") {
    pullFromSite(true).then((v) => json(res, v)).catch((e) => json(res, { ok: false, grund: String(e.message || e) }));
    return true;
  }
  if (rest === "state" && req.method === "GET") {
    const antworten = () => { const c = readCfg(); json(res, { ok: true, provider: c.provider || "", model: modelOf(c), baseUrl: baseUrl(c), hasKey: !!c.apiKey || !!prov(c).noKey, connected: connectedProviders(), providers: providerList(), abgleich: (() => { try { const s = require("./sync"); return !!(s.device && s.device()); } catch (e) { return false; } })() }); };
    // Kurz auf die Website warten, damit ein dort verbundener Zugang gleich hier erscheint
    Promise.race([pullFromSite().catch(() => null), new Promise((ok) => setTimeout(ok, 4000))]).then(antworten, antworten);
    return true;
  }
  if (rest === "config" && req.method === "POST") {
    readBody(req).then((b) => {
      const patch = {};
      for (const k of ["provider", "model", "baseUrl"]) if (b[k] !== undefined) patch[k] = String(b[k] || "");
      if (typeof b.apiKey === "string" && b.apiKey.trim()) patch.apiKey = b.apiKey.trim();
      if (b.forget) { patch.apiKey = null; patch.model = null; }
      const n = writeCfg(patch);
      json(res, { ok: true, provider: n.provider || "", model: modelOf(n), hasKey: !!n.apiKey || !!prov(n).noKey });
    }).catch((e) => json(res, { error: e.message }, 400));
    return true;
  }
  if (rest === "verify" && req.method === "GET") {
    verifyKey(c).then((v) => json(res, v)).catch((e) => json(res, { ok: false, error: String(e.message || e) }));
    return true;
  }
  if (rest === "quota" && req.method === "GET") {
    keyInfo(c).then((q) => json(res, q)).catch((e) => json(res, { error: e.message }, 502));
    return true;
  }
  if (rest === "models" && req.method === "GET") {
    listModels(c).then((l) => json(res, { models: l })).catch((e) => json(res, { error: e.message }, 502));
    return true;
  }
  if (rest === "oauth/start" && req.method === "GET") { json(res, oauthStart(port)); return true; }
  if (rest === "oauth/callback" && req.method === "GET") {
    const page = (title, text) => { const b = Buffer.from(`<!doctype html><meta charset="utf-8"><title>${title}</title><body style="background:#100d0b;color:#f5eee2;font:16px/1.6 system-ui;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center;max-width:420px"><h1 style="font:700 22px Georgia,serif;color:#f2b134">${title}</h1><p>${text}</p><button onclick="window.close()" style="background:linear-gradient(180deg,#ffd36b,#f2b134);border:0;border-radius:10px;padding:10px 18px;font-weight:700;cursor:pointer">Fenster schließen</button></div><script>try{window.opener&&window.opener.postMessage("mtga-assistant-oauth","*")}catch(e){}</script>`, "utf8"); res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": b.length }); res.end(b); };
    const code = url.searchParams.get("code"), state = url.searchParams.get("state") || "";
    if (!code) { page("Abgebrochen", "Es wurde kein Zugang erteilt."); return true; }
    oauthFinish(code, state).then(() => page("Verbunden", "Der Assistent ist bereit. Du kannst dieses Fenster schließen."))
      .catch((e) => page("Fehlgeschlagen", String(e.message || e)));
    return true;
  }
  if (rest === "collection" && req.method === "GET") {
    try { json(res, collectionSummary(cardRows())); } catch (e) { json(res, { error: e.message }, 500); }
    return true;
  }
  if (rest === "scryfall" && req.method === "GET") {
    scryfall(url.searchParams.get("kind") || "search", url.searchParams.get("q") || "")
      .then((r) => json(res, r)).catch((e) => json(res, { error: e.message }, 502));
    return true;
  }
  if (rest === "chat" && req.method === "POST") {
    readBody(req).then(async (b) => {
      res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
      try { await chat(readCfg(), b, res); }
      catch (e) { sse(res, { t: "err", m: String((e && e.message) || e) }); }
      res.end();
    }).catch((e) => json(res, { error: e.message }, 400));
    return true;
  }
  json(res, { error: "unbekannt" }, 404);
  return true;
}

module.exports = { handle, searchCards, collectionSummary, messagesFor, toolsFor, readCfg, writeCfg, connectedProviders, pullFromSite, PROVIDERS, listModels, _test: { readCfg, writeCfg, connectedProviders, normCfg, ohneSignatur, nurChatModelle, ersatzModell, kurz, chat } };
