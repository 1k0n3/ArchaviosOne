// Gemeinsame Hilfsfunktionen. Datenquelle: window.MTGA_DATA (data.js), alternativ data.json vom Server.
// Kartenbilder: der lokale Server liefert die komprimierte Textur direkt aus den MTGA-Spieldaten
// (/art/<ArtId>), der Browser dekodiert sie per WebGL auf der Grafikkarte. Nichts wird umgewandelt oder gespeichert.
window.App = (function () {
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => [...(root || document).querySelectorAll(sel)];
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const pad = (n) => String(n).padStart(2, "0");
  /** Zahl in der Schreibweise der UI-Sprache (de: 63,4 und 12.480); d = feste Nachkommastellen */
  const num = (x, d) => Number(x || 0).toLocaleString(window.I18N ? window.I18N.lang : undefined, d == null ? undefined : { minimumFractionDigits: d, maximumFractionDigits: d });
  let DATA = window.MTGA_DATA || null;
  // Übersetzung (web/i18n.js); ohne Modul bleiben die deutschen Texte, Platzhalter werden trotzdem ersetzt
  const tr = window.I18N ? window.I18N.t : (k, vars) => { let s = k; if (vars) for (const x of Object.keys(vars)) s = s.split("{" + x + "}").join(vars[x]); return s; };
  for (const href of ["https://cards.scryfall.io", "https://backs.scryfall.io", "https://svgs.scryfall.io"]) { const l = document.createElement("link"); l.rel = "preconnect"; l.href = href; l.crossOrigin = ""; document.head.appendChild(l); }
  // Set-Namen (Code -> Name) vom Server, einmal je Seite; ohne Server bleiben die Codes
  let SETS = null, setsPromise = null;
  function loadSets() {
    if (!setsPromise) setsPromise = fetch("api/sets").then((r) => r.ok ? r.json() : {}).then((j) => { SETS = j || {}; return SETS; }).catch(() => (SETS = {}));
    return setsPromise;
  }
  const setName = (code) => (SETS && SETS[String(code || "").toLowerCase()]) || code || "";

  async function load(url) {
    if (!DATA) { const r = await fetch(url || "data.json"); DATA = await r.json(); }
    return DATA;
  }

  // ---- Texturen per WebGL --------------------------------------------------------------------
  const Art = (() => {
    const cv = document.createElement("canvas");
    const gl = cv.getContext("webgl", { premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false, alpha: true });
    const s3tc = gl && gl.getExtension("WEBGL_compressed_texture_s3tc");
    const bptc = gl && gl.getExtension("EXT_texture_compression_bptc");
    const FMT = gl ? { 10: s3tc && s3tc.COMPRESSED_RGB_S3TC_DXT1_EXT, 12: s3tc && s3tc.COMPRESSED_RGBA_S3TC_DXT5_EXT, 25: bptc && bptc.COMPRESSED_RGBA_BPTC_UNORM_EXT } : {};
    let prog, tex, posLoc;
    if (gl) {
      const vs = gl.createShader(gl.VERTEX_SHADER);
      gl.shaderSource(vs, "attribute vec2 p;varying vec2 v;void main(){v=vec2(p.x*.5+.5,p.y*.5+.5);gl_Position=vec4(p,0.,1.);}");
      gl.compileShader(vs);
      const fs = gl.createShader(gl.FRAGMENT_SHADER);
      gl.shaderSource(fs, "precision mediump float;uniform sampler2D t;varying vec2 v;void main(){gl_FragColor=texture2D(t,v);}");
      gl.compileShader(fs);
      prog = gl.createProgram(); gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog); gl.useProgram(prog);
      const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      posLoc = gl.getAttribLocation(prog, "p"); gl.enableVertexAttribArray(posLoc); gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
      tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
    const cache = new Map();   // artId -> Promise<ImageBitmap|null>
    const queue = []; let active = 0; const MAX = 6;
    function pump() {
      while (active < MAX && queue.length) { const job = queue.shift(); active++; job().finally(() => { active--; pump(); }); }
    }
    async function decode(artId, w0) {
      const r = await fetch("art/" + artId + "?w=" + (w0 || 256));
      if (!r.ok) return null;
      const fmt = +r.headers.get("X-Tex-Format"), w = +r.headers.get("X-Tex-Width"), h = +r.headers.get("X-Tex-Height");
      const glFmt = FMT[fmt];
      if (!gl || !glFmt) return null;
      const data = new Uint8Array(await r.arrayBuffer());
      cv.width = w; cv.height = h;
      gl.viewport(0, 0, w, h);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.compressedTexImage2D(gl.TEXTURE_2D, 0, glFmt, w, h, 0, data);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      return await createImageBitmap(cv);
    }
    function get(artId, w) {
      if (!artId) return Promise.resolve(null);
      const key = artId + ":" + (w || 256);
      if (!cache.has(key)) {
        cache.set(key, new Promise((resolve) => { queue.push(() => decode(artId, w).then(resolve, () => resolve(null))); pump(); }));
      }
      return cache.get(key);
    }
    /** Alle <canvas data-art> unterhalb von root zeichnen (data-w = gewünschte Breite, Standard 256) */
    function bind(root) {
      if (typeof bindCardImages === "function") bindCardImages(root);
      for (const c of $$("canvas[data-art]", root)) {
        if (c.dataset.done) continue;
        c.dataset.done = "1";
        get(+c.dataset.art, +c.dataset.w || 256).then((bmp) => {
          if (!bmp) { c.closest(".c, .cc, .deck-tile, .deckbox, .deck-cell, .bar-row")?.classList.add("noimg"); return; }
          c.width = bmp.width; c.height = bmp.height;
          // Arena speichert das Artwork oft quadratisch gestaucht: quadratische Texturen werden gestreckt statt beschnitten
          c.classList.add(bmp.width === bmp.height ? "sq" : bmp.height > bmp.width ? "tall" : "wide");
          c.getContext("2d").drawImage(bmp, 0, 0);
        });
      }
    }
    return { get, bind, supported: !!(gl && s3tc) };
  })();
  const artCanvas = (artId, cls, w) => artId ? `<canvas class="${cls || ""}" data-art="${artId}"${w ? ` data-w="${w}"` : ""}></canvas>` : "";

  // ---- Karten -----------------------------------------------------------------------------
  // Eintrag: [Name, Set, Nr, Seltenheit, Token, ArtId, Farben, Typen, Rahmen-Flags, Stärke, Widerstandskraft, Regeltext, Typzeile, Manakosten]
  const COLOR_NAMES = { 1: "w", 2: "u", 3: "b", 4: "r", 5: "g" };
  const TYPE_NAMES = { 1: "Artefakt", 2: "Kreatur", 3: "Verzauberung", 4: "Spontanzauber", 5: "Land", 8: "Planeswalker", 10: "Hexerei", 11: "Stammes", 14: "Schlacht" };
  const RARITY_KEY = { Common: "c", Uncommon: "u", Rare: "r", Mythic: "m", Standardland: "c", Token: "t" };
  /**
   * Legendär steht in den Kartendaten, nicht im Bild: Kennung "L" (Supertyp aus der Kartendatenbank)
   * oder das Wort in der Typzeile, in den Sprachen, die das Spiel ausliefert.
   */
  const LEGEND_RE = /legend|légend|leggend|lendár|伝説/i;
  const legendaryOf = (flags, typeLine) => String(flags || "").includes("L") || LEGEND_RE.test(String(typeLine || ""));
  /** Zeile der Kartenliste (api/cards): [… , 14 = Kennungen, 18 = Typzeile] */
  const isLegendary = (c) => legendaryOf(c[14], c[18]);
  // Seiten mit eigenen Kartendaten (Bibliothek, Deckbau, Replay) geben ein dict mit; die Verweise merken
  // wir uns, damit auch später erzeugte Teile (z. B. Textkarten) die Karte noch finden
  const dicts = [];
  const merkeDict = (d) => { if (d && typeof d === "object" && !dicts.includes(d)) { dicts.unshift(d); if (dicts.length > 4) dicts.length = 4; } };
  function card(g, dict) {
    merkeDict(dict);
    const d = (dict && dict[g]) || (DATA && DATA.cards[g]) || dicts.reduce((x, o) => x || o[g], null);
    if (!d) return { name: tr("Karte") + " " + g, set: "", nr: "", rarity: "", token: false, art: 0, colors: [], types: [], frame: "c", isLand: false, creature: false, flags: "", style: "std", pt: "", typeText: "", typeLine: "", text: "", cost: "", rar: "c", legendary: false };
    const colors = String(d[6] || "").split(",").filter(Boolean).map((x) => COLOR_NAMES[x]).filter(Boolean);
    const types = String(d[7] || "").split(",").filter(Boolean).map(Number);
    const isLand = types.includes(5), isArtifact = types.includes(1);
    const frame = colors.length > 1 ? "m" : colors.length === 1 ? colors[0] : isLand ? "l" : isArtifact ? "a" : "c";
    const flags = String(d[8] || "");
    // Druck-Design: Retro (vor 8. Edition), Vollbild (Showcase/Standardland), Nyx-Verzauberung, Mystical Archive, Standard
    const style = flags.includes("R") ? "retro" : flags.includes("M") ? "archive" : flags.includes("F") ? "fullart" : flags.includes("N") ? "nyx" : "std";
    const pt = d[9] !== undefined && d[9] !== "" && d[10] !== "" ? `${d[9]}/${d[10]}` : "";
    const typeText = types.map((x) => TYPE_NAMES[x] ? tr(TYPE_NAMES[x]) : "").filter(Boolean).join(" ");
    return { name: d[0], set: d[1], nr: d[2], rarity: d[3], token: !!d[4], art: d[5] || 0, colors, types, frame, isLand, creature: types.includes(2), flags, style, legendary: legendaryOf(flags, d[12] || typeText), pt, typeText, typeLine: d[12] || typeText, text: d[11] || "", cost: d[13] || "", rar: RARITY_KEY[d[3]] || "c" };
  }
  const cardName = (g, dict) => card(g, dict).name;
  const artOf = (g, dict) => card(g, dict).art;
  /**
   * Echte Kartenbilder: der lokale Server liefert die gedruckte Karte (card-img/<GrpId>, einmalig
   * von Scryfall geholt und auf der Platte abgelegt). Schlägt das fehl, zeigt die Kachel als letzten
   * Ausweg das Artwork aus den Spieldaten mit dem Kartennamen. Es ist also immer ein Bild zu sehen.
   * opts: { dict, cls, qty, extra, w (Artwork-Fallbackbreite) }
   */
  function cardHtml(g, opts = {}) {
    merkeDict(opts.dict);
    const c = typeof g === "object" ? g : card(g, opts.dict);
    const gid = typeof g === "object" ? g.grpId || 0 : g;
    const cls = `c ${opts.cls || ""}`;
    const v = opts.size || (/\bbig\b/.test(opts.cls || "") ? "normal" : "small");
    return `<div class="${cls}" data-g="${gid}" title="${esc(c.name)}">
      <img class="cimg" src="card-img/${gid}?v=${v}" alt="${esc(c.name)}" loading="${opts.eager ? "eager" : "lazy"}" decoding="async" data-art="${c.art || 0}" data-w="${opts.w || 256}">
      <div class="fallback"><div class="fart"></div><div class="fname">${esc(c.name)}</div></div>
      ${opts.qty > 1 ? `<span class="q">${opts.qty}</span>` : ""}${opts.extra || ""}</div>`;
  }
  const cardTile = (g, opts = {}) => cardHtml(g, opts);
  /**
   * Textkarte: dieselbe Darstellung wie im Replay-Modus „Bilder aus“ – Name, Manakosten, Typzeile,
   * Regeltext und Kampfwerte aus den Spieldaten, ganz ohne Bild. Sie braucht weder Server noch Netz.
   */
  const TYPE_EMBLEM = (c) => c.isLand ? ["land", FI.land] : c.creature ? ["creature", FI.creature] : c.types.includes(8) ? ["pw", FI.planeswalker] : c.types.includes(4) ? ["instant", FI.instant] : c.types.includes(10) ? ["sorcery", FI.sorcery] : c.types.includes(3) ? ["ench", FI.enchantment] : c.types.includes(1) ? ["artifact", FI.artifact] : c.types.includes(14) ? ["battle", FI.battle] : ["other", FI.copies];
  function textCard(g, opts = {}) {
    const c = typeof g === "object" ? g : card(g, opts.dict);
    const [k, ic] = TYPE_EMBLEM(c);
    return `<div class="tcard f-${c.frame}"><div class="th"><span class="cp">${c.cost ? "" : c.colors.map((x) => manaSymbol(x)).join("")}</span><span class="n">${esc(c.name)}</span><span class="m">${manaHtml(c.cost)}</span></div>` +
      `<div class="tt"><span class="emb t-${k}">${ic}</span><span class="tl">${esc(c.typeLine || c.typeText)}</span></div>` +
      `<div class="tx">${c.text ? c.text.split("\n").map((l) => `<p>${ruleHtml(l)}</p>`).join("") : ""}</div>` +
      (c.pt ? `<div class="tpt">${esc(c.pt)}</div>` : "") + "</div>";
  }
  /**
   * Sind die Kartenbilder nicht erreichbar (Begleitprogramm aus, kein Netz), zeigen alle Kacheln die
   * Textkarte. Die Bilder werden im Hintergrund weiter versucht; sobald eines ankommt, sind sie zurück.
   */
  let ohneBilder = false, bildFehler = 0;
  function setOhneBilder(an) {
    if (ohneBilder === an) return;
    ohneBilder = an;
    document.body.classList.toggle("no-cardimg", an);
    if (an) textkartenEinsetzen(document);
    bildFehler = 0;
  }
  /** Textkarte in jede Kachel legen, die noch keine hat (Bild und Artwork blendet das CSS aus) */
  function textkartenEinsetzen(root) {
    for (const box of $$(".c[data-g], .cc[data-g]", root || document)) {
      const g = +box.dataset.g;
      if (!g || $(".tcard", box)) continue;
      (box.querySelector(".inner") || box).insertAdjacentHTML("beforeend", textCard(g));
    }
  }
  window.addEventListener("online", () => setOhneBilder(false));
  /** Schmaler Bildschirm (Handy): weniger auf einmal zeigen, Sekundäres einklappen */
  const isMobile = () => window.matchMedia("(max-width: 760px)").matches;
  /**
   * Abschnitt einklappbar machen: Klick auf die Überschrift klappt den Inhalt auf/zu, Zustand wird im Browser gemerkt.
   * open = Standard, wenn nichts gemerkt ist (auf dem Handy meist zu, am Desktop auf).
   */
  function foldable(head, body, key, open = true) {
    if (!head || !body) return;
    const k = "mtga-fold:" + key;
    let isOpen = open; try { const v = localStorage.getItem(k); if (v !== null) isOpen = v === "1"; } catch (e) { /* ohne Speicher */ }
    head.classList.add("fold-head");
    if (!$(".fold-chev", head)) head.insertAdjacentHTML("beforeend", '<span class="fold-chev">' + FI.chevron + "</span>");
    const paint = () => { head.classList.toggle("folded", !isOpen); body.classList.toggle("fold-hidden", !isOpen); };
    head.addEventListener("click", (ev) => { if (ev.target.closest("a, button, input, select")) return; isOpen = !isOpen; try { localStorage.setItem(k, isOpen ? "1" : "0"); } catch (e) { /* ignorieren */ } paint(); });
    paint();
  }
  /** Link zum Replay: groß mit Text oder als kleiner goldener Play-Knopf */
  const replayLink = (matchId, small) => small
    ? `<a class="btn-play" href="replay.html?id=${matchId}" title="${tr("Replay ▶")}" onclick="event.stopPropagation()">${FI.play}</a>`
    : `<a class="btn-replay" href="replay.html?id=${matchId}">${FI.play}<span>${tr("Replay")}</span></a>`;
  const bigCard = (c) => cardHtml(c, { w: 512, cls: "big" });
  /** Fehlgeschlagene Kartenbilder auf Artwork-Fallback umschalten (Bild aus den Spieldaten) */
  const loadedImgs = new Set(); // bereits geladene Kartenbilder: neue Kacheln damit blenden nicht erneut ein
  function bindCardImages(root) {
    if (ohneBilder) textkartenEinsetzen(root);
    for (const im of $$("img.cimg", root)) {
      if (im.dataset.bound) continue;
      im.dataset.bound = "1";
      let tries = 0;
      const fail = () => {
        const box = im.closest(".c, .cc");
        if (!box) return;
        if (!box.classList.contains("fb")) {
          box.classList.add("fb");
          const fa = $(".fart", box);
          if (fa && +im.dataset.art) { fa.innerHTML = artCanvas(+im.dataset.art, "", +im.dataset.w || 256); Art.bind(fa); }
        }
        // Kein Netz oder mehrere Bilder hintereinander fehlgeschlagen: auf Textkarten umstellen
        if (!ohneBilder && (!navigator.onLine || ++bildFehler >= 3)) setOhneBilder(true);
        // Scryfall kann kurzzeitig gesperrt sein: das echte Kartenbild nach einer Pause erneut anfordern
        // (bis zu 6 Versuche mit wachsendem Abstand: 20 s … 8 min, damit auch längere Sperren überbrückt werden)
        if (tries++ < 6 && im.isConnected) setTimeout(() => { if (im.isConnected) im.src = im.src.split("&r=")[0].split("?r=")[0] + (im.src.includes("?") ? "&" : "?") + "r=" + tries; }, Math.min(480000, 20000 * Math.pow(2, tries - 1)));
      };
      const done = () => { const box = im.closest(".c, .cc"); if (box && im.naturalWidth > 0) { box.classList.remove("fb"); box.classList.add("ld"); loadedImgs.add(im.getAttribute("src")); bildFehler = 0; setOhneBilder(false); } };
      im.addEventListener("load", done);
      if (im.complete && im.naturalWidth > 0) done();
      else if (im.complete && im.naturalWidth === 0 && im.src) fail();
      im.addEventListener("error", fail);
    }
  }
  // ---- Ladezustände: Skeleton-Platzhalter, Fortschrittsbalken, Entprellen --------------------------
  const skeleton = {
    cards: (n = 24, cls = "") => `<div class="cards sk-cards ${cls}">${Array.from({ length: n }, () => '<div class="c sk"></div>').join("")}</div>`,
    rows: (n = 5) => Array.from({ length: n }, (_, i) => `<div class="sk sk-row" style="width:${88 - (i * 13) % 40}%"></div>`).join(""),
    tiles: (n = 6) => `<div class="tiles">${Array.from({ length: n }, () => '<div class="tile"><div class="sk sk-row" style="width:50%;height:10px"></div><div class="sk sk-row" style="width:70%;height:28px;margin-top:10px"></div></div>').join("")}</div>`,
    chart: (h = 220) => `<div class="sk sk-chart" style="height:${h}px"></div>`,
    text: (w = "60%", h = 14) => `<span class="sk sk-row" style="display:inline-block;width:${w};height:${h}px;vertical-align:middle"></span>`
  };
  let busyEl, busyCount = 0;
  /** Dünner Fortschrittsbalken oben, solange etwas geladen wird */
  function busy(on) {
    if (!busyEl) { busyEl = document.createElement("div"); busyEl.className = "busy"; document.body.appendChild(busyEl); }
    busyCount = Math.max(0, busyCount + (on ? 1 : -1));
    busyEl.classList.toggle("on", busyCount > 0);
  }
  const debounce = (fn, ms = 150) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  /** fetch mit Zeitlimit und Fortschrittsanzeige */
  async function getJson(url, timeoutMs = 20000) {
    busy(true);
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { signal: ctl.signal });
      if (!r.ok) {
        // Der Server schreibt den Grund in das Feld "error"; ohne ihn bliebe nur eine nackte Zahl
        let grund = "";
        try { const j = await r.json(); grund = String((j && j.error) || ""); } catch (e) { /* kein JSON */ }
        throw new Error("HTTP " + r.status + (grund ? " – " + grund.slice(0, 300) : ""));
      }
      return await r.json();
    } finally { clearTimeout(t); busy(false); }
  }
  // ---- Filter-Bausteine: Dropdown mit Symbolen, ausklappbare Suche -------------------------------
  const FI = {
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
    set: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/></svg>',
    gem: (c) => `<svg viewBox="0 0 24 24"><path d="M12 3l7 7-7 11-7-11z" fill="${c}" stroke="rgba(0,0,0,.5)" stroke-width="1"/></svg>`,
    all: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="m5 12 5 5L20 7"/></svg>',
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17z"/><path d="M13.5 6.5l3 3"/></svg>',
    bolt: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M13 2 4 14h6l-1 8 9-12h-6z"/></svg>',
    act: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h12M13 6l6 6-6 6"/></svg>',
    creature: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="7" cy="8" r="2.2"/><circle cx="12" cy="5.5" r="2.2"/><circle cx="17" cy="8" r="2.2"/><path d="M12 10c-3.5 0-6 3-6 6.5C6 19 8 20 12 20s6-1 6-3.5C18 13 15.5 10 12 10z"/></svg>',
    instant: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M13 2 4 14h6l-1 8 9-12h-6z"/></svg>',
    sorcery: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 4h10a2 2 0 0 1 2 2v14H8a2 2 0 0 1-2-2z"/><path d="M6 4a2 2 0 0 0-2 2v2h4"/><path d="M10 9h5M10 13h5"/></svg>',
    enchantment: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.2 6.3L21 10l-5.5 4 2 6.8L12 17l-5.5 3.8 2-6.8L3 10l6.8-1.7z"/></svg>',
    artifact: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/></svg>',
    planeswalker: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2c2 5 4 7 9 8-5 1-7 3-9 8-2-5-4-7-9-8 5-1 7-3 9-8z"/></svg>',
    land: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 19l6-10 4 6 2-3 6 7z"/></svg>',
    battle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 21V4h11l-2 4 2 4H5"/></svg>',
    trophy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 4h8v5a4 4 0 0 1-8 0z"/><path d="M8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4"/><path d="M12 13v4M8 21h8M10 17h4"/></svg>',
    deck: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="3" width="12" height="16" rx="2"/><path d="M17 7h1a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2"/></svg>',
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
    az: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 18 8 6l4 12M5.5 14h5"/><path d="M14 6h6l-6 12h6"/></svg>',
    copies: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>',
    mana: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 7v10M8 12h8"/></svg>',
    download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 4v11M7 10l5 5 5-5M4 19h16"/></svg>',
    reset: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>',
    calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>',
    swords: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M4 20l7-7M13 11l7-7M14 4h6v6M4 14v6h6"/></svg>',
    gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><circle cx="12" cy="12" r="3.1"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
    chevron: '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="m6 9 6 6 6-6"/></svg>'
  };
  let ddOpen = null;
  document.addEventListener("click", (ev) => { if (ddOpen && !ddOpen.contains(ev.target)) { ddOpen.classList.remove("open"); ddOpen = null; } });
  /** Menü (.dd-menu) eines .dd-Elements öffnen oder schließen. Universell für alle Dropdowns und Menüs:
   *  nur eines offen; am rechten Rand rechtsbündig anschlagen, am unteren Rand nach oben aufklappen, nie über den linken Rand */
  function openMenu(el, open) {
    if (ddOpen && ddOpen !== el) ddOpen.classList.remove("open");
    el.classList.toggle("open", open); ddOpen = open ? el : null;
    const menu = $(".dd-menu", el); if (!open || !menu) return;
    menu.style.left = ""; menu.style.right = ""; menu.style.top = ""; menu.style.bottom = "";   // Breite regelt das CSS (max-width je Menüart)
    const dr = el.getBoundingClientRect(); let r = menu.getBoundingClientRect();
    if (r.right > window.innerWidth - 8) { menu.style.left = "auto"; menu.style.right = "0"; r = menu.getBoundingClientRect(); }
    if (r.left < 8) { menu.style.right = "auto"; menu.style.left = Math.round(8 - dr.left) + "px"; r = menu.getBoundingClientRect(); }
    if (r.bottom > window.innerHeight - 8 && dr.top - r.height - 6 > 8) { menu.style.top = "auto"; menu.style.bottom = "calc(100% + 6px)"; }
  }
  // Handy: die fixierte Suchleiste bekommt ihren Blur-Hintergrund erst, wenn sie beim Scrollen oben anliegt
  const stickyBars = () => {
    for (const b of document.querySelectorAll(".lib-bar")) {
      const sc = b.closest(".content"), se = document.scrollingElement;
      const scrolled = (sc && sc.scrollTop > 0) || window.scrollY > 0 || (se && se.scrollTop > 0);
      // Anschlag: Oberkante des scrollenden Bereichs, mindestens der Fensterrand (der Bereich selbst kann nach oben weggescrollt sein)
      const edge = Math.max(0, sc ? sc.getBoundingClientRect().top : 0);
      b.classList.toggle("stuck", !!scrolled && b.getBoundingClientRect().top <= edge + 1);
    }
  };
  document.addEventListener("scroll", stickyBars, { capture: true, passive: true });
  document.addEventListener("keydown", (ev) => { if (ev.key === "Escape" && ddOpen) { ddOpen.classList.remove("open"); ddOpen = null; } });
  /**
   * Dropdown mit Symbolen. items: [{ v, label, icon, short }], opts: { value, icon, title, onChange, defaultValue, searchable }
   * Rückgabe: { get value, set value }
   */
  function dropdown(el, opts) {
    const items = opts.items;
    let value = opts.value != null ? opts.value : items[0].v;
    el.classList.add("dd");
    if (opts.title) el.title = opts.title;
    const find = (v) => items.find((it) => String(it.v) === String(v)) || items[0];
    const paint = () => {
      const it = find(value);
      const isDefault = String(value) === String(opts.defaultValue != null ? opts.defaultValue : items[0].v);
      el.innerHTML = `<button type="button" class="dd-btn ${isDefault ? "" : "on"}">${it.icon || opts.icon || ""}<span class="lbl">${esc(it.short != null ? it.short : it.label)}</span>${FI.chevron}</button>
        <div class="dd-menu">${opts.searchable ? `<input type="search" class="dd-q" placeholder="${tr("Filtern …")}">` : ""}<div class="dd-list">${items.map((x) => `<button type="button" data-v="${esc(x.v)}" class="${String(x.v) === String(value) ? "on" : ""} ${x.cls || ""}"${x.title ? ` title="${esc(x.title)}"` : ""}${x.search ? ` data-q="${esc(x.search)}"` : ""}>${x.icon || ""}<span>${esc(x.label)}</span></button>`).join("")}</div></div>`;
      $(".dd-btn", el).addEventListener("click", () => {
        const open = !el.classList.contains("open");
        openMenu(el, open);
        // Suchfeld leeren; am PC gleich hineinspringen, auf dem Handy nicht (sonst klappt die Tastatur auf)
        if (open) { const q = $(".dd-q", el); if (q) { q.value = ""; if (!isMobile()) q.focus(); } const on = $(".dd-list .on", el); if (on) on.scrollIntoView({ block: "nearest" }); }
      });
      $$(".dd-list button", el).forEach((b) => b.addEventListener("click", (ev) => {
        const it = items.find((x) => String(x.v) === b.dataset.v);
        // Einträge mit keepOpen (z. B. "Precons einblenden") schalten nur etwas um und schließen das Menü nicht
        if (it && it.keepOpen) { ev.stopPropagation(); if (it.onClick) it.onClick(el, b); return; }
        value = b.dataset.v; el.classList.remove("open"); ddOpen = null; paint(); if (opts.onChange) opts.onChange(value);
      }));
      const q = $(".dd-q", el);
      if (q) q.addEventListener("input", () => { const t = q.value.trim().toLowerCase(); $$(".dd-list button", el).forEach((b) => { b.style.display = !t || (b.textContent + " " + (b.dataset.q || "")).toLowerCase().includes(t) ? "" : "none"; }); });
    };
    paint();
    return { get value() { return value; }, set value(v) { value = v; paint(); }, el };
  }
  /** Oder-Farbfilter (Bibliothek, Deckbau, Deckansicht) als vorbereitete Prüffunktion: jede gewählte Farbe zählt,
   *  "0"/"c" ergänzt farblose Karten (keine Länder), "m" verlangt mindestens zwei Farben. sel: Set, cc: Farben der Karte */
  /**
   * Farbauswahl: Farben sind oder-verknüpft; „Land“ schränkt zusätzlich auf Länder ein (Farben gelten
   * dann innerhalb der Länder), „Mehrfarbig“ verlangt mindestens zwei Farben.
   */
  function colorMatcher(sel) {
    if (!sel.size) return () => true;
    const pick = [...sel].filter((v) => v !== "0" && v !== "c" && v !== "m" && v !== "l");
    const wantC = sel.has("0") || sel.has("c"), wantM = sel.has("m"), wantLand = sel.has("l");
    return (cc, isLand) => {
      if (wantLand && !isLand) return false;
      // Länder gelten sonst nicht als farblos; ist „Land“ gewählt, zählt ein Land ohne Farben doch dazu
      const colorless = !cc.length && (!isLand || wantLand);
      let ok = !pick.length || pick.some((v) => cc.includes(v));
      if (wantC) ok = pick.length ? (ok || colorless) : colorless;
      return ok && !(wantM && cc.length < 2);
    };
  }
  const colorMatch = (sel, cc, isLand) => colorMatcher(sel)(cc, isLand);
  /**
   * Reihenfolge der Sortierpunkte – auf allen Seiten dieselbe. "indeck" erscheint nur, wo ein Deck
   * offen ist (Deckbau: deckSort). Ein neuer Punkt kommt hierhin und nach SORT_ITEMS, sonst nirgends.
   */
  const SORT_ORDER = ["color", "indeck", "name", "cmc", "rarity", "set", "owned", "wins", "played", "decks"];
  const SORT_ITEMS = {
    color: () => ({ v: "color", label: tr("Farbe"), short: tr("Farbe"), icon: FI.set }),
    indeck: () => ({ v: "indeck", label: tr("Im Deck"), short: tr("Im Deck"), icon: FI.deck }),
    name: () => ({ v: "name", label: tr("Name A–Z"), short: tr("Name"), icon: FI.az }), cmc: () => ({ v: "cmc", label: tr("Manawert"), short: tr("Mana"), icon: FI.mana }),
    wins: () => ({ v: "wins", label: tr("Meiste Siege"), short: tr("Siege"), icon: FI.trophy }), played: () => ({ v: "played", label: tr("Meist gespielt"), short: tr("Gespielt"), icon: FI.play }),
    decks: () => ({ v: "decks", label: tr("Meist in Decks"), short: tr("Decks"), icon: FI.deck }), owned: () => ({ v: "owned", label: tr("Meiste Exemplare"), short: tr("Exemplare"), icon: FI.copies }),
    rarity: () => ({ v: "rarity", label: tr("Seltenheit"), icon: FI.gem("#e0b654") }), set: () => ({ v: "set", label: tr("Set und Nummer"), short: tr("Set"), icon: FI.set })
  };
  /** Nutzung je Kartenname aus den lokalen Daten: Siege, gespielte Matches, Beschwörungen, Decks */
  function cardUsage(D) {
    D = D || DATA || {};
    const use = new Map();
    const u = (n) => { let x = use.get(n); if (!x) use.set(n, x = { w: 0, played: 0, casts: 0, decks: 0, m: new Set() }); return x; };
    for (const m of D.matches || []) for (const [g, n] of m.played || []) {
      const x = u(cardName(g));
      if (!x.m.has(m.matchId)) { x.m.add(m.matchId); x.played++; if (m.result === "Sieg") x.w++; }
      x.casts += n || 1;
    }
    for (const d of D.decks || []) { const namen = new Set(); for (const z of Object.values(d.zones || {})) for (const [g] of z) namen.add(cardName(g)); for (const n of namen) u(n).decks++; }
    const leer = { w: 0, played: 0, casts: 0, decks: 0 };
    return { map: use, of: (c) => use.get(typeof c === "string" ? c : c[1]) || leer };
  }
  /** Farbreihenfolge wie in Arena: Weiß, Blau, Schwarz, Rot, Grün, mehrfarbig, farblos, Länder */
  const colorKey = (c) => { if (String(c[6]).split(",").includes("5")) return 90; const cc = String(c[5] || "").split(",").filter(Boolean); return cc.length === 1 ? +cc[0] : cc.length > 1 ? 10 + cc.length : 80; };
  /**
   * Vergleich für eine Sortierung der Kartenliste (Zeilen wie in api/cards).
   * opt: { use: cardUsage(), extra: { schlüssel: vergleich } } – extra sind Vergleiche der Seite.
   */
  function cardSorter(key, opt = {}) {
    const byName = (a, b) => a[1].localeCompare(b[1], "en");
    if (opt.extra && opt.extra[key]) return opt.extra[key];
    const u = opt.use || cardUsage();
    const V = {
      color: (a, b) => (colorKey(a) - colorKey(b)) || String(a[5]).localeCompare(String(b[5])) || (a[8] - b[8]) || byName(a, b),
      name: byName,
      cmc: (a, b) => (a[8] - b[8]) || byName(a, b),
      rarity: (a, b) => (b[4] - a[4]) || byName(a, b),
      set: (a, b) => String(a[2]).localeCompare(String(b[2])) || String(a[3]).localeCompare(String(b[3]), undefined, { numeric: true }),
      owned: (a, b) => ((b[9] || 0) - (a[9] || 0)) || byName(a, b),
      wins: (a, b) => (u.of(b).w - u.of(a).w) || (u.of(b).played - u.of(a).played) || byName(a, b),
      played: (a, b) => (u.of(b).played - u.of(a).played) || (u.of(b).casts - u.of(a).casts) || byName(a, b),
      decks: (a, b) => (u.of(b).decks - u.of(a).decks) || (u.of(b).played - u.of(a).played) || byName(a, b)
    };
    return V[key] || byName;
  }
  /** Gemeinsame Filterleiste für Kartenlisten (Bibliothek, Deckbau). Füllt .topbar .right.filters (Set, Seltenheit, Typ,
   *  Manawert als Symbol, Farben, Besitz, Sortierung, Zurücksetzen) und .lib-bar (Suche, Zähler, Zoom-Menü mit Raster/Liste).
   *  Handy: Reihen Set/Besitz/Sortierung – Typ/Seltenheit – Manawert/Farben/Zurücksetzen.
   *  o: { key, grid, sets, deckSort (zeigt „Im Deck zuerst“), ownItems, ownValue, sortValue, searchPlaceholder, searchValue, textSearch,
   *       sizeKey, sizeMin, sizeMax, onChange }. Liefert Steuerelemente, matcher() für die gemeinsamen Filter, view(), count(text). */
  function cardFilterBar(o) {
    const bar = $(".topbar .right.filters"), lib = $(".lib-bar"), grid = o.grid, gem = FI.gem;
    const COLORS = [["1", "w", "Weiß"], ["2", "u", "Blau"], ["3", "b", "Schwarz"], ["4", "r", "Rot"], ["5", "g", "Grün"], ["m", "m", "Mehrfarbig"], ["0", "c", "Farblos"], ["l", "l", "Land"]];
    // Suche in der Titelzeile rechts; die Filter in einer eigenen Reihe darunter (auf dem Handy: Suche fixiert unter dem Titel, dann die Filter)
    const mobile = isMobile();
    const fbar = document.createElement("div"); fbar.className = "topbar filters-bar";
    fbar.innerHTML = `<div class="right filters"><div id="f-set"></div><div id="f-rar"></div><div id="f-type"></div><div id="f-cmc"></div>
      <div class="seg colors" id="f-colors" title="${tr("Farbe")}">${COLORS.map(([v, k, t]) => `<button type="button" data-v="${v}" class="c${k}" title="${tr(t)}">${k === "l" ? FI.land : filterIcon(k)}</button>`).join("")}</div>
      <div id="f-own"></div><div id="f-sort"></div><button type="button" class="reset" id="f-reset" title="${tr("Filter und Sortierung zurücksetzen")}">${FI.reset}</button></div>${mobile ? "" : `<div id="f-size"></div>`}`;
    if (mobile) { bar.innerHTML = ""; lib.innerHTML = `<div id="f-q"></div><span class="count" id="count"></span><div id="f-size"></div>`; lib.before(fbar); }   // Handy: Filter zuerst, die fixierte Suche zuletzt direkt über den Karten
    else { bar.innerHTML = `<span class="count" id="count"></span><div id="f-q"></div>`; bar.classList.add("search-col"); bar.closest(".topbar").after(fbar); lib.remove(); }   // Zähler, Suche, Zoom-Menü in der Titelzeile rechts
    const colors = new Set(), F = { colors };
    let view = "grid"; try { view = localStorage.getItem("mtga-view:" + o.key) || "grid"; } catch (e) { /* ohne Speicher */ }
    const active = () => !!(F.q.value || F.set.value || F.rar.value || F.type.value || F.cmc.value || colors.size || F.own.value !== "1" || F.sort.value !== (o.sortDefault || "name"));
    const paintReset = () => $("#f-reset").classList.toggle("show", active());
    const change = () => { paintReset(); o.onChange(); };
    F.q = searchBox($("#f-q"), { placeholder: o.searchPlaceholder || tr("Name suchen"), value: o.searchValue || "", onInput: debounce(change, 160) });
    F.set = dropdown($("#f-set"), { icon: FI.set, title: tr("Set"), searchable: true, onChange: change, items: [{ v: "", label: tr("Alle Sets"), short: tr("Set"), icon: FI.set }, ...o.sets.map((x) => ({ v: x, label: x, short: x, title: setName(x), search: setName(x), icon: setIcon(x) }))] });
    $("#f-set").classList.add("sets");
    F.rar = dropdown($("#f-rar"), { title: tr("Seltenheit"), onChange: change, items: [{ v: "", label: tr("Alle Seltenheiten"), short: tr("Seltenheit"), icon: gem("#8d95a8") }, { v: "2", label: "Common", icon: gem("#1f242e") }, { v: "3", label: "Uncommon", icon: gem("#b9c4cc") }, { v: "4", label: "Rare", icon: gem("#e0b654") }, { v: "5", label: "Mythic", icon: gem("#e8632a") }, { v: "1", label: tr("Standardland"), icon: gem("#6e5a3c") }] });
    F.type = dropdown($("#f-type"), { title: tr("Kartentyp"), onChange: change, items: [{ v: "", label: tr("Alle Typen"), short: tr("Typ"), icon: FI.all }, { v: "2", label: tr("Kreatur"), icon: FI.creature }, { v: "4", label: tr("Spontanzauber"), icon: FI.instant }, { v: "10", label: tr("Hexerei"), icon: FI.sorcery }, { v: "3", label: tr("Verzauberung"), icon: FI.enchantment }, { v: "1", label: tr("Artefakt"), icon: FI.artifact }, { v: "8", label: tr("Planeswalker"), icon: FI.planeswalker }, { v: "14", label: tr("Schlacht"), icon: FI.battle }, { v: "L", label: tr("Legendär"), icon: FI.trophy }] });
    F.cmc = dropdown($("#f-cmc"), { title: tr("Manawert"), onChange: change, items: [{ v: "", label: tr("Jeder Manawert"), short: "", icon: FI.mana }, ...[0, 1, 2, 3, 4, 5, 6].map((n) => ({ v: String(n), label: String(n), short: "", icon: manaSymbol(String(n)) })), { v: "7", label: "7+", short: "", icon: manaSymbol("7") }, { v: "x", label: "X", short: "", icon: manaSymbol("x") }] });
    $("#f-cmc").classList.add("icon-only", "cmc");
    F.own = dropdown($("#f-own"), { title: tr("Besitz"), value: o.ownValue || "1", defaultValue: "1", onChange: change, items: [{ v: "1", label: tr("Im Besitz"), icon: FI.check }, { v: "", label: tr("Alle Karten"), short: tr("Alle"), icon: FI.all }, { v: "0", label: tr("Fehlende"), icon: FI.x }, ...(o.ownItems || [])] });
    // Immer dieselben Punkte in derselben Reihenfolge; "Im Deck zuerst" nur mit offenem Deck
    const sortKeys = SORT_ORDER.filter((k) => k !== "indeck" || o.deckSort);
    F.sort = dropdown($("#f-sort"), { title: tr("Sortierung"), value: o.sortValue || o.sortDefault || "name", defaultValue: o.sortDefault || "name", onChange: change, items: sortKeys.map((k) => SORT_ITEMS[k]()) });
    $$("#f-colors button").forEach((b) => b.addEventListener("click", () => { const v = b.dataset.v; if (colors.has(v)) colors.delete(v); else colors.add(v); b.classList.toggle("on", colors.has(v)); change(); }));
    F.setColors = (vals) => { colors.clear(); for (const v of vals) colors.add(v); $$("#f-colors button").forEach((b) => b.classList.toggle("on", colors.has(b.dataset.v))); paintReset(); };
    $("#f-reset").addEventListener("click", () => { F.set.value = ""; F.rar.value = ""; F.type.value = ""; F.cmc.value = ""; F.own.value = "1"; F.sort.value = (o.sortDefault || "name"); F.setColors([]); F.q.value = ""; F.q.dispatchEvent(new Event("input")); });
    sizeSlider($("#f-size"), grid, o.sizeKey || "mtga-tile-w", o.sizeMin || 90, o.sizeMax || 220);
    grid.classList.toggle("listview", view === "list");
    zoomMenu(mobile ? lib : fbar, $("#f-size"), mobile ? $("#count") : null, { view, onView: (v) => { view = v; try { localStorage.setItem("mtga-view:" + o.key, v); } catch (e) { /* ignorieren */ } grid.classList.toggle("listview", v === "list"); o.onChange(); } });
    if (mobile) $(".right.filters", fbar).append($("#f-set"), $("#f-own"), $("#f-sort"), $("#f-type"), $("#f-rar"), $("#f-cmc"), $("#f-colors"), $("#f-reset"));
    F.view = () => view;
    F.count = (t) => { $("#count").textContent = t; };
    /** Vorbereitete Prüffunktion für die gemeinsamen Filter (Suche, Set, Seltenheit, Typ, Manawert, Farben); Karte im Bibliotheksformat */
    F.matcher = () => {
      const q = F.q.value.trim().toLowerCase(), set = F.set.value, rar = F.rar.value, t = F.type.value, m = F.cmc.value, col = colorMatcher(colors), text = !!o.textSearch;
      return (c) => {
        if (q && !c[1].toLowerCase().includes(q) && !(text && (String(c[17] || "").toLowerCase().includes(q) || String(c[18] || "").toLowerCase().includes(q)))) return false;
        if (set && c[2] !== set) return false;
        if (rar && String(c[4]) !== rar) return false;
        if (t === "L" ? !isLegendary(c) : (t && !String(c[6]).split(",").includes(t))) return false;
        if (m && (m === "x" ? !/x/i.test(String(c[10] || "")) : m === "7" ? c[8] < 7 : c[8] !== +m)) return false;
        return col(String(c[5]).split(",").filter(Boolean), String(c[6]).split(",").includes("5"));
      };
    };
    paintReset();
    return F;
  }
  /** Regeltext schnell erfassbar, rein typografisch: Schlüsselwörter als eigene fette Zeile (Erinnerungstext als Tooltip),
   *  je Fähigkeit ein Absatz; bei ausgelösten Fähigkeiten ist die Bedingung bis zum ersten Komma fett, Aktivierungskosten fett */
  function abilitiesHtml(text) {
    const lines = String(text || "").split("\n").map((l) => l.trim()).filter(Boolean);
    const out = []; let kws = [];
    const flush = () => { if (kws.length) { out.push(`<p class="ab kws">${kws.join('<span class="sep">, </span>')}</p>`); kws = []; } };
    const KW = /^[A-Z][a-z' \-]+(?:, [a-z][a-z' \-]+)*(?: (?:\{[^}]+\})+| \d+(?:—(?:\{[^}]+\})+)?)?$/;
    for (const l of lines) {
      const rem = (l.match(/\(([^()]{3,})\)\s*$/) || [])[1] || "";
      const core = l.replace(/\s*\([^()]*\)\s*$/, "").trim();
      if (KW.test(core)) {
        const parts = /\{|\d/.test(core) ? [core] : core.split(/,\s*/);
        for (const p of parts) kws.push(`<b class="kw"${rem ? ` title="${esc(rem)}"` : ""}>${manaHtml(esc(p.charAt(0).toUpperCase() + p.slice(1)))}</b>`);
        continue;
      }
      flush();
      let h = ruleHtml(l);
      if (/^(?:When|Whenever|At the beginning|At end|As long as)\b/.test(l)) h = h.replace(/^([^,]{1,90}?,)/, '<b class="trg">$1</b>');
      out.push(`<p class="ab">${h}</p>`);
    }
    flush();
    return out.join("");
  }
  /** Besitzanzeige wie in der Arena-Sammlung: vier Segmente, je Exemplar eines gefüllt (ab vier alle), daneben die Zahl */
  function ownHtml(n) {
    n = +n || 0;
    const pips = [1, 2, 3, 4].map((i) => `<i class="${n >= i ? "on" : ""}"></i>`).join("");
    return `<span class="own ${n ? "has" : ""}" title="${tr("{n}× im Besitz", { n })}"><span class="op">${pips}</span><b>${n}</b></span>`;
  }
  /** Zähler „− Anzahl +“ für den Deckbau (Kachel unten bzw. Listenzeile) im Stil des Arena-Deckbaus: Plus-Glyphe aus dem
   *  Spiel als Maske in Gold (Minus = ihr Querbalken), Mengen-Hintergrund der Kachel als weicher Schatten; ohne Spielgrafiken Textzeichen */
  function qtyHtml(g) {
    const plus = uiIcon("qPlus"), backer = uiIcon("qBacker");
    const glyph = (cls) => plus ? `<i class="g ${cls}" style="--qi:url('${esc(plus)}')"></i>` : `<i class="g t ${cls}">${cls === "plus" ? "+" : "−"}</i>`;
    return `<span class="qty" data-g="${g}">${backer ? `<img class="qb" src="${esc(backer)}" alt="">` : ""}<button type="button" class="q-m" title="${tr("Entfernen")}">${glyph("minus")}</button><b class="q-n">0</b><button type="button" class="q-p" title="${tr("Hinzufügen")}">${glyph("plus")}</button></span>`;
  }
  /** Schieberegler für die Kachelgröße eines Kartenrasters (gemerkt im Browser) */
  function sizeSlider(el, grid, key = "mtga-tile-w", min = 90, max = 220) {
    // Handy: Standard drei Karten nebeneinander, Bereich enger (zwei bis vier pro Reihe)
    const mobile = window.matchMedia("(max-width: 760px)").matches;
    if (mobile) { const w = Math.max(240, window.innerWidth - 24); min = Math.floor((w - 24) / 4); max = Math.floor((w - 8) / 2); }
    let v = mobile ? Math.floor((Math.max(240, window.innerWidth - 24) - 16) / 3) : 136;
    try { v = +localStorage.getItem(key + (mobile ? ":m" : "")) || v; } catch (e) { /* ohne Speicher */ }
    key = key + (mobile ? ":m" : "");
    v = Math.max(min, Math.min(max, v));
    el.classList.add("sizer");
    el.innerHTML = `<span class="sm" title="${tr("Kleiner")}">${FI.copies}</span><input type="range" min="${min}" max="${max}" step="2" value="${v}" title="${tr("Kartengröße")}"><span class="lg" title="${tr("Größer")}">${FI.copies}</span>`;
    const apply = (x) => { grid.style.setProperty("--tile-w", x + "px"); };
    apply(v);
    $("input", el).addEventListener("input", (ev) => { const x = +ev.target.value; apply(x); try { localStorage.setItem(key, String(x)); } catch (e) { /* ignorieren */ } });
  }
  /** Manawert einer Kostenangabe wie {2}{G}{W}; X zählt 0 */
  function cmcOf(cost) {
    let n = 0;
    for (const m of String(cost || "").matchAll(/\{([^}]+)\}/g)) { const p = m[1]; const num = parseInt(p, 10); if (!isNaN(num)) n += num; else if (p !== "X") n += 1; }
    return n;
  }
  /** Deck-Statistik: Manakurve, Farbanteile (Mana-Symbole), Anzahl je Typ, Ø Manawert */
  function deckStats(d) {
    const curve = [0, 0, 0, 0, 0, 0, 0, 0], colors = { w: 0, u: 0, b: 0, r: 0, g: 0 };
    let lands = 0, creatures = 0, spells = 0, others = 0, cmcSum = 0, nonLand = 0;
    const entries = [...(d.zones.CommandZone || []), ...(d.zones.MainDeck || [])];
    for (const [g, q] of entries) {
      const c = card(g);
      if (c.isLand) { lands += q; continue; }
      const cmc = cmcOf(c.cost);
      curve[Math.min(7, cmc)] += q; cmcSum += cmc * q; nonLand += q;
      for (const m of String(c.cost || "").matchAll(/\{([^}]+)\}/g)) for (const ch of m[1].toLowerCase()) if (colors[ch] != null) colors[ch] += q;
      if (c.creature) creatures += q; else if (c.types.includes(4) || c.types.includes(10)) spells += q; else others += q;
    }
    return { curve, colors, lands, creatures, spells, others, nonLand, avgCmc: nonLand ? cmcSum / nonLand : 0 };
  }
  /** Manaverteilung: farbige Leiste (Anteil der Mana-Symbole je Farbe) plus Symbol-Zähler – Deckansicht und Deckbau */
  function colorBarHtml(colors) {
    const total = Object.values(colors).reduce((x, y) => x + y, 0) || 1;
    const seg = Object.entries(colors).filter(([, n]) => n).map(([k, n]) => `<div class="seg c-${k}" style="flex:${n}" title="${tr("{n} {c}-Symbole ({p} %)", { n, c: k.toUpperCase(), p: Math.round(100 * n / total) })}"></div>`).join("");
    const pips = Object.entries(colors).filter(([, n]) => n).map(([k, n]) => `<span class="pip">${manaSymbol(k)}<b>${n}</b></span>`).join("");
    return `<div class="cbar">${seg || '<div class="seg c-c" style="flex:1"></div>'}</div><div class="pips">${pips || `<span class="muted small">${tr("farblos")}</span>`}</div>`;
  }
  /** Deck-Fakten: Kartenzähler als Kacheln (gleiche Optik wie die Match-Statistik), Manakurve, Farbanteile */
  function deckStatsHtml(st) {
    const max = Math.max(1, ...st.curve);
    const curve = st.curve.map((n, i) => `<div class="cb" title="${tr("{n} Karten mit Manawert {v}", { n, v: i === 7 ? "7+" : i })}"><div class="bar" style="height:${Math.round(100 * n / max)}%"></div><span class="v">${n || ""}</span><span class="l">${i === 7 ? "7+" : i}</span></div>`).join("");
    const tile = (l, v, icon) => `<div class="tile"><div class="label">${icon || ""}${l}</div><div class="value">${v}</div></div>`;
    return `<div class="deck-facts-head fold-head" data-fold="deck-facts">${tr("Statistik")}<span class="fold-chev">${FI.chevron}</span></div><div class="deck-facts">
      <div class="df-left">
        <div class="ds-block colors"><div class="ds-t">${tr("Farben")}</div>${colorBarHtml(st.colors)}</div>
        <div class="tiles stat-rows fact-tiles">${tile(tr("Kreaturen"), st.creatures, FI.creature)}${tile(tr("Zauber"), st.spells, FI.instant)}${tile(tr("Andere"), st.others, FI.artifact)}${tile(tr("Länder"), st.lands, FI.land)}${tile(tr("Nichtländer"), st.nonLand, FI.copies)}${tile(tr("Ø Manawert"), num(st.avgCmc, 1), FI.mana)}</div>
      </div>
      <div class="ds-block curve"><div class="ds-t">${tr("Manakurve")}</div><div class="curve">${curve}</div></div>
    </div>`;
  }
  /**
   * Macht aus einem gewöhnlichen <select> das Auswahlfeld des Dashboards: gleiches Aussehen, gleiche
   * Tastatur- und Randlogik (das Menü klappt am Bildschirmrand zur anderen Seite). Das <select>
   * bleibt unsichtbar bestehen, damit vorhandener Code weiter .value liest und auf "change" hört.
   */
  function selectToDropdown(sel) {
    if (!sel || sel.dataset.dd) return null;
    sel.dataset.dd = "1";
    const host = document.createElement("div");
    host.className = "dd from-select";
    if (sel.className) host.classList.add(...sel.className.split(/\s+/).filter(Boolean));
    sel.after(host);
    sel.classList.add("dd-hidden");
    // data-cls an einer Option färbt den Eintrag im Menü ein (z. B. Empfehlungen)
    const build = () => [...sel.options].map((o) => ({ v: o.value, label: o.textContent, title: o.title || "", cls: o.dataset.cls || "" }));
    let items = build();
    if (!items.length) items = [{ v: "", label: sel.getAttribute("placeholder") || "…" }];
    const dd = dropdown(host, {
      items, value: sel.value, defaultValue: sel.value, title: sel.title || "",
      searchable: items.length > 8,
      onChange: (v) => { sel.value = v; sel.dispatchEvent(new Event("change", { bubbles: true })); }
    });
    // Ändert fremder Code die Liste oder den Wert, zeichnet das Feld neu
    sel._ddSync = () => { const n = build(); if (n.length) { dd.el.dataset.n = n.length; } dropdownReplace(host, n, sel.value, sel); };
    new MutationObserver(() => sel._ddSync()).observe(sel, { childList: true });
    return dd;
  }
  /** Liste und Wert eines erzeugten Auswahlfelds austauschen */
  function dropdownReplace(host, items, value, sel) {
    host.innerHTML = "";
    host.classList.remove("open");
    dropdown(host, {
      items: items.length ? items : [{ v: "", label: "…" }], value, defaultValue: value, title: sel.title || "",
      searchable: items.length > 8,
      onChange: (v) => { sel.value = v; sel.dispatchEvent(new Event("change", { bubbles: true })); }
    });
  }
  /** Alle noch nicht umgewandelten <select> in einem Bereich übernehmen */
  function enhanceSelects(root2) { $$("select:not([data-dd])", root2 || document).forEach(selectToDropdown); }

  /**
   * Einstellungen in Reitern. Dieselbe Logik für das lokale Dashboard und die Website, damit die
   * Seite überall gleich aussieht und sich gleich verhält: ein Bereich nach dem anderen, die Wahl
   * steht in der Adresse und bleibt erhalten.
   */
  function settingsTabs(opts = {}) {
    const bar = $(opts.bar || "#set-tabs"), key = opts.key || "mtga-settings-tab";
    if (!bar) return { show: () => {} };
    const panes = () => $$("[data-pane]");
    const show = (name) => {
      const list = panes();
      if (!list.length) return;
      const known = list.some((p) => p.dataset.pane === name) ? name : list[0].dataset.pane;
      for (const p of list) p.classList.toggle("hidden", p.dataset.pane !== known);
      for (const b of $$(".set-tab", bar)) b.classList.toggle("on", b.dataset.tab === known);
      try { localStorage.setItem(key, known); } catch (e) { /* ohne Speicher */ }
      if (location.hash.slice(1) !== known) history.replaceState(null, "", "#" + known);
      if (opts.onShow) opts.onShow(known);
    };
    bar.addEventListener("click", (ev) => { const b = ev.target.closest(".set-tab"); if (b) show(b.dataset.tab); });
    window.addEventListener("hashchange", () => show(location.hash.slice(1)));
    let start = location.hash.slice(1);
    if (!start) { try { start = localStorage.getItem(key) || ""; } catch (e) { start = ""; } }
    show(start);
    return { show };
  }

  /** Ausklappbare Suche: Lupe, bei Klick öffnet sich das Feld; bleibt offen, solange etwas eingetippt ist */
  function searchBox(el, opts = {}) {
    el.classList.add("sbox");
    el.innerHTML = `<button type="button" class="dd-btn sb-btn" title="${esc(opts.title || tr("Suchen"))}">${FI.search}</button><input type="search" placeholder="${esc(opts.placeholder || tr("Suchen …"))}" value="${esc(opts.value || "")}">`;
    const input = $("input", el), btn = $(".sb-btn", el);
    el.classList.add("open"); // Suche bleibt immer sichtbar
    const sync = () => { btn.classList.toggle("on", !!input.value); };
    btn.addEventListener("click", () => { el.classList.add("open"); input.focus(); });
    input.addEventListener("focus", sync); input.addEventListener("blur", sync);
    input.addEventListener("input", () => { sync(); if (opts.onInput) opts.onInput(input.value); });
    sync();
    return input;
  }
  /** Farben eines Decks (Reihenfolge W U B R G) aus Commander und Hauptdeck */
  function deckColors(d) {
    const set = new Set();
    for (const z of ["CommandZone", "MainDeck"]) for (const [g] of d.zones && d.zones[z] || []) { const c = card(g); if (!c.isLand) c.colors.forEach((x) => set.add(x)); }
    return ["w", "u", "b", "r", "g"].filter((c) => set.has(c));
  }
  /** 3D-Deckbox im Querformat wie in Arena: Box mit Deckel, Artwork, Farb-Pips, Namensplakette */
  function deckBox(d, opts = {}) {
    const art = artOf(d.tile);
    // Ohne lokales Artwork (Website): Kartenbild der Titelkarte als Boxbild
    const artHtml = art ? artCanvas(art, "artbg") : (d.tile ? `<img class="artbg" src="card-img/${d.tile}?v=art" alt="" loading="lazy" onerror="this.remove()">` : "");
    const pips = (opts.colors || deckColors(d)).map((c) => `<span class="pip p-${c}">${manaSymbol(c)}</span>`).join("");
    // Commander-/Brawl-Decks: offizielles Commander-Symbol (Scryfall-Setsymbol "cmd") auf der Box
    const cmdr = (d.zones && d.zones.CommandZone && d.zones.CommandZone.length) ? `<img class="cmdr-ico" src="https://svgs.scryfall.io/sets/cmd.svg" alt="Commander" title="Commander" loading="lazy" onerror="this.remove()">` : "";
    return `<div class="deckbox ${opts.cls || ""}${d.archived ? " archived" : ""}" data-id="${esc(d.id || "")}" title="${esc(d.name)}">
      <div class="box"><div class="face top"><span class="brand">✦ ARENA</span></div><div class="face front"${d.archived ? ` data-archived="${esc(tr("Archiv"))}"` : ""}>${artHtml}${cmdr}<div class="pips">${pips}</div>${opts.badge || ""}</div><div class="face side"></div></div>
      <div class="plate"><span class="n">${esc(d.name)}</span>${opts.sub ? `<span class="s">${esc(opts.sub)}</span>` : ""}</div></div>`;
  }
  function deckCell(m) {
    return `<div class="deck-cell"><div class="art">${artOf(m.tile) ? artCanvas(artOf(m.tile)) : (m.tile ? `<img src="card-img/${m.tile}?v=art" alt="" loading="lazy" onerror="this.remove()">` : "")}</div><div><div class="n">${esc(m.myDeck || "?")}</div><div class="s">${esc(m.commander || m.format || "")}</div></div></div>`;
  }

  // ---- Formatierung ---------------------------------------------------------------------
  function fmtDate(ts) { const d = new Date(ts); return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`; }
  function fmtTime(ts) { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
  function fmtDur(sec) { return sec >= 3600 ? `${Math.floor(sec / 3600)} ${tr("h")} ${pad(Math.floor(sec % 3600 / 60))} ${tr("min")}` : `${Math.round(sec / 60)} ${tr("min")}`; }
  function relDate(ts) {
    const d = Math.floor((Date.now() - ts) / 86400000);
    return d === 0 ? tr("heute") : d === 1 ? tr("gestern") : d < 7 ? tr("vor {n} Tagen", { n: d }) : fmtDate(ts);
  }
  function deckLabel(m) { return m.commander ? `${m.myDeck} · ${m.commander}` : (m.myDeck || "?"); }
  function eventLabel(e) { return (e || "").replace(/^Play_/, "").replace(/_/g, " "); }
  function resultBadge(r) {
    const cls = r === "Sieg" ? "win" : r === "Niederlage" ? "loss" : "unk";
    return `<span class="badge ${cls}">${esc(tr(r || "?"))}</span>`;
  }

  // ---- Logo + Seitenleiste ----------------------------------------------------------------------
  // Logo: fünf Mana-Balken (W U B R G) auf dunkler Plakette, ihre Oberkanten zeichnen ein M – Statistik und Magic in einem
  let logoCache = null;
  function logoSvg() {
    if (logoCache) return logoCache;
    const cols = ["#f3e9c8", "#3d7fd6", "#9a8fb3", "#d8482f", "#3f9a4f"], hs = [34, 25, 17, 25, 34];
    const bars = cols.map((c, i) => `<rect x="${8.5 + i * 10}" y="${50 - hs[i]}" width="7" height="${hs[i]}" rx="3" fill="${c}"/>`).join("");
    logoCache = `<svg class="mark" viewBox="0 0 64 64" width="44" height="44" aria-hidden="true">
      <defs><linearGradient id="lg-bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2c2018"/><stop offset="1" stop-color="#100d0b"/></linearGradient></defs>
      <rect x="2" y="2" width="60" height="60" rx="15" fill="url(#lg-bg)" stroke="#f2b134" stroke-opacity=".55" stroke-width="1.6"/>
      ${bars}
    </svg>`;
    return logoCache;
  }
  const ICONS = {
    dash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="8" height="8" rx="2"/><rect x="13" y="3" width="8" height="5" rx="2"/><rect x="13" y="10" width="8" height="11" rx="2"/><rect x="3" y="13" width="8" height="8" rx="2"/></svg>',
    matches: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.5 3.5 20.5 9.5 9 21H3v-6z"/><path d="m12 6 6 6"/></svg>',
    decks: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="3" width="12" height="16" rx="2"/><path d="M9 7h4M9 11h4"/><path d="M17 7h1a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2"/></svg>',
    out: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 17l5-5-5-5M15 12H3M21 3v18"/></svg>',
    build: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 4 20 10 10 20H4v-6z"/><path d="M12 6l6 6"/><path d="M3 21h6"/></svg>',
    gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><circle cx="12" cy="12" r="3.1"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
    lib: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v14"/><path d="M4 19a2 2 0 0 0 2 2h14"/><path d="M8 7h8M8 11h6"/></svg>'
  };

  function shell(active, contentHtml) {
    // Auf der Website: freigegebene Decks zeigen nur die Deckseite, das eigene Dashboard bekommt Konto-Links
    const site = DATA && DATA.site;
    let pages = [["index.html", tr("Übersicht"), "dash", tr("Start")], ["matches.html", tr("Matches"), "matches"], ["decks.html", tr("Decks"), "decks"], ["library.html", tr("Bibliothek"), "lib", tr("Karten")], ["builder.html", tr("Deckbau"), "build", tr("Bauen")]];
    // Die Einstellungen stehen nicht zwischen den Seiten, sondern immer unten über dem Profil
    if (site && site.shared) pages = [["decks.html", tr("Geteiltes Deck"), "decks"]];
    if (isMobile()) pages = pages.filter((p) => p[0] !== "matches.html");   // Match-Tabelle ist nichts fürs Handy
    const globe = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>';
    const siteLinks = site && site.shared ? `<a class="nav" href="/p/${esc(site.handle)}">${ICONS.lib}<span>${tr("Profil von {h}", { h: esc(site.handle) })}</span></a>`
      : site ? `<a class="nav" href="/explore">${globe}<span>Explore</span></a>` : "";
    const player = (DATA && DATA.player) || tr("Spieler");
    const cur = pages.find((p) => p[0] === active); if (cur) document.title = "MTGA Stats · " + cur[1];
    const langSel = window.I18N ? `<label class="lang" title="${tr("Sprache")}"><select>${Object.entries(I18N.LANGS).map(([k, v]) => `<option value="${k}" ${k === I18N.lang ? "selected" : ""}>${v}</option>`).join("")}</select></label>` : "";
    const st = stats(DATA ? DATA.matches : []);
    // Immer an derselben Stelle: über dem Profil. Lokal die eigene Seite, angemeldet auf der Website /settings.
    const settingsHref = site ? (site.own ? "/settings" : "") : "settings.html";
    const settingsLink = settingsHref
      ? `<a class="nav nav-settings ${active === settingsHref || active === "settings.html" ? "active" : ""}" href="${settingsHref}">${ICONS.gear}<span data-short="${tr("Setup")}">${tr("Einstellungen")}</span></a>`
      : "";
    const nav = `<aside class="side-nav">
      ${site ? `<a class="brand" href="/?site=1" title="${tr("Zur Website")}">` : `<div class="brand">`}${logoSvg()}<div><div class="t1">MTGA Stats</div><div class="t2">${site ? tr("Website") : tr("Lokales Dashboard")}</div></div>${site ? "</a>" : "</div>"}
      ${pages.map(([h, t, ic, short]) => `<a class="nav ${active === h ? "active" : ""}" href="${h}">${ICONS[ic]}<span data-short="${esc(short || t)}">${t}</span></a>`).join("")}
      ${siteLinks ? `<div class="nav-sep"></div>${siteLinks}` : ""}
      <div class="spacer"></div>
      ${settingsLink}
      ${site && site.own
        ? `<div class="player link"><a class="who" href="/settings" title="${tr("Konto & Geräte")}"><div class="av">${esc(player.slice(0, 1).toUpperCase())}</div><div><div class="n">${esc(player)}</div><div class="s">${tr("{n} Matches", { n: st.n })} · ${Math.round(st.rate * 100)} % ${tr("Winrate")}</div></div></a>${site.csrf ? `<form method="post" action="/logout" class="inline"><input type="hidden" name="csrf" value="${esc(site.csrf)}"><button class="out" type="submit" title="${tr("Abmelden")}">${ICONS.out}</button></form>` : ""}</div>`
        : (true
          // Lokal führt das Profil auf dieselbe Einstellungsseite, kein Browserfenster
          ? `<div class="player link"><a class="who" href="settings.html#konto" title="${tr("Konto & Einstellungen")}"><div class="av">${esc(player.slice(0, 1).toUpperCase())}</div><div><div class="n">${esc(player)}</div><div class="s">${tr("{n} Matches", { n: st.n })} · ${Math.round(st.rate * 100)} % ${tr("Winrate")}</div></div></a></div>`
          : `<div class="player" title="${tr("Einstellungen: Tray-Menü (Rechtsklick auf das Symbol). Konto & Geräte: nach dem Verbinden mit der Website hier klicken.")}"><div class="av">${esc(player.slice(0, 1).toUpperCase())}</div><div><div class="n">${esc(player)}</div><div class="s">${tr("{n} Matches", { n: st.n })} · ${Math.round(st.rate * 100)} % ${tr("Winrate")}</div></div></div>`)}
      ${langSel}
      <div class="foot">${tr("Stand")} ${DATA && DATA.generatedAt ? fmtDate(DATA.generatedAt) + " " + fmtTime(DATA.generatedAt) : "?"}${Art.supported ? "" : " · " + tr("Bilder: WebGL S3TC nicht verfügbar")}</div>
    </aside>`;
    document.body.innerHTML = `<div class="shell">${nav}<main class="content">${contentHtml}</main></div>`;
    const ls = $(".side-nav .lang select"); if (ls) ls.addEventListener("change", () => I18N.set(ls.value));
    // Filterleiste: auf schmalen Bildschirmen hinter einem Knopf, aktive Filter als Zähler
    const filters = $(".topbar .right.filters");
    if (filters) {
      const btn = document.createElement("button");
      btn.className = "ghost f-toggle";
      btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 5h18M6 12h12M10 19h4"/></svg> ' + tr("Filter");
      btn.addEventListener("click", () => filters.classList.toggle("open"));
      filters.parentElement.insertBefore(btn, filters);
    }
    enhanceSelects(document.querySelector(".side-nav"));
    if (!document.querySelector("link[rel=icon]") && !document.querySelector("link[rel=manifest]")) {
      const l = document.createElement("link"); l.rel = "icon"; l.href = "data:image/svg+xml," + encodeURIComponent(logoSvg().replace('class="mark" ', "")); document.head.appendChild(l);
    }
    // Optionaler Zusatz: ist assistant.js mitgeliefert, hängt er sich hier in die Navigation.
    // Ob er erscheint, entscheidet er selbst: lokal immer, auf der Website nur im eigenen
    // Dashboard und nur wenn dort ein Modell hinterlegt ist.
    if (window.Assistant) { try { window.Assistant.mount(); } catch (e) { /* ohne Assistent */ } }
  }

  // ---- Statistik ----------------------------------------------------------------------------
  function stats(list) {
    const w = list.filter((m) => m.result === "Sieg").length;
    const l = list.filter((m) => m.result === "Niederlage").length;
    const n = list.length;
    const avgTurns = n ? list.reduce((s, m) => s + (m.turns || 0), 0) / n : 0;
    const avgDur = n ? list.reduce((s, m) => s + (m.durationSec || 0), 0) / n : 0;
    return { n, w, l, rate: w + l ? w / (w + l) : 0, avgTurns, avgDur };
  }
  function groupBy(list, keyFn) {
    const m = new Map();
    for (const x of list) { const k = keyFn(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); }
    return m;
  }

  // ---- Tooltip ----------------------------------------------------------------------------------
  let tip;
  function tooltip(show, html, ev) {
    if (!tip) {
      tip = document.createElement("div"); tip.className = "tooltip"; document.body.appendChild(tip);
      // Tooltip verschwindet bei Klick, Scrollen und Seitenwechsel (sonst bleibt er nach einem Klick stehen)
      const hide = () => { tip.style.display = "none"; };
      document.addEventListener("click", hide, true);
      document.addEventListener("scroll", hide, true);
      window.addEventListener("pagehide", hide);
      document.addEventListener("visibilitychange", hide);
    }
    if (!show) { tip.style.display = "none"; return; }
    tip.innerHTML = html;
    tip.style.display = "block";
    // Standard rechts unterhalb des Zeigers; stößt der Tooltip an den Rand, wechselt er auf die andere Seite
    const tw = tip.offsetWidth, th = tip.offsetHeight, gap = 16;
    let x = ev.clientX + gap, y = ev.clientY + gap;
    if (x + tw > window.innerWidth - 8) x = ev.clientX - tw - gap;
    if (y + th > window.innerHeight - 8) y = ev.clientY - th - gap;
    tip.style.left = Math.max(8, x) + "px";
    tip.style.top = Math.max(8, y) + "px";
  }

  // ---- Diagramme ---------------------------------------------------------------------------------
  /** Gestapelte Balken Sieg/Niederlage. rows: [{label, title, w, l, html}] (html = Tooltip-Inhalt) */
  function stackedBars(el, rows, opts = {}) {
    const W = opts.width || 720, H = opts.height || 220, padL = 30, padB = 26, padT = 8, padR = 8;
    const max = Math.max(1, ...rows.map((r) => r.w + r.l));
    const iw = W - padL - padR, ih = H - padT - padB;
    const step = iw / Math.max(1, rows.length);
    const bw = Math.max(4, Math.min(34, step - 4));
    const y = (v) => padT + ih - (v / max) * ih;
    let s = `<svg class="chart anim" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.label || "")}">`;
    const ticks = max <= 5 ? max : 4;
    for (let i = 0; i <= ticks; i++) {
      const v = Math.round((max / ticks) * i);
      s += `<line class="grid" x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}"/><text x="${padL - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
    }
    s += `<line class="axis" x1="${padL}" x2="${W - padR}" y1="${padT + ih}" y2="${padT + ih}"/>`;
    const every = Math.ceil(rows.length / 12);
    rows.forEach((r, i) => {
      const x = padL + i * step + (step - bw) / 2;
      const yw = y(r.w), yl = y(r.w + r.l);
      if (r.w) s += `<rect class="bar" x="${x}" y="${yw}" width="${bw}" height="${padT + ih - yw}" rx="3" fill="var(--win)"/>`;
      if (r.l) s += `<rect class="bar" x="${x}" y="${yl}" width="${bw}" height="${Math.max(0, yw - yl - 2)}" rx="3" fill="var(--loss)"/>`;
      if (r.w + r.l) s += `<text class="val" x="${x + bw / 2}" y="${yl - 4}" text-anchor="middle">${r.w + r.l}</text>`;
      if (i % every === 0) s += `<text x="${x + bw / 2}" y="${H - 8}" text-anchor="middle">${esc(r.label)}</text>`;
      s += `<rect class="hit" data-i="${i}" x="${padL + i * step}" y="${padT}" width="${step}" height="${ih}"/>`;
    });
    s += "</svg>";
    el.innerHTML = `<div class="legend"><span style="--c:var(--win)">${tr("Sieg")}</span><span style="--c:var(--loss)">${tr("Niederlage")}</span></div>` + s;
    $$("rect.hit", el).forEach((h) => {
      h.addEventListener("mousemove", (ev) => { const r = rows[+h.dataset.i]; tooltip(true, r.html || `<b>${esc(r.title || r.label)}</b><br>${tr("{w} Siege, {l} Niederlagen", { w: r.w, l: r.l })}`, ev); h.classList.add("on"); });
      h.addEventListener("mouseleave", () => { tooltip(false); h.classList.remove("on"); });
    });
  }

  /** Linienchart mit Fläche und Fadenkreuz. pts: [{y (0..1), html}] */
  function lineChart(el, pts, opts = {}) {
    const W = opts.width || 720, H = opts.height || 220, padL = 34, padB = 22, padT = 10, padR = 10;
    const iw = W - padL - padR, ih = H - padT - padB;
    const n = pts.length;
    const x = (i) => padL + (n > 1 ? (i / (n - 1)) * iw : iw / 2);
    const y = (v) => padT + ih - v * ih;
    let s = `<svg class="chart anim" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.label || "")}">`;
    for (const v of [0, .25, .5, .75, 1]) s += `<line class="grid ${v === .5 ? "mid" : ""}" x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}"/><text x="${padL - 6}" y="${y(v) + 4}" text-anchor="end">${Math.round(v * 100)}%</text>`;
    if (n) {
      const path = pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.y).toFixed(1)}`).join("");
      s += `<path class="area" d="${path}L${x(n - 1).toFixed(1)},${y(0)}L${x(0).toFixed(1)},${y(0)}Z"/><path class="line" pathLength="1" d="${path}"/>`;
      pts.forEach((p, i) => { if (p.mark) s += `<circle class="pt ${p.mark}" cx="${x(i)}" cy="${y(p.y)}" r="3.5"/>`; });
      const every = Math.ceil(n / 10);
      pts.forEach((p, i) => { if (p.label && i % every === 0) s += `<text x="${x(i)}" y="${H - 6}" text-anchor="middle">${esc(p.label)}</text>`; });
      s += `<line class="cross" x1="0" x2="0" y1="${padT}" y2="${padT + ih}" style="display:none"/><circle class="dot" r="5" style="display:none"/>`;
      s += `<rect class="hit" x="${padL}" y="${padT}" width="${iw}" height="${ih}"/>`;
    }
    s += "</svg>";
    el.innerHTML = s;
    const svg = $("svg", el), cross = $(".cross", el), dot = $(".dot", el), hit = $(".hit", el);
    if (!hit) return;
    hit.addEventListener("mousemove", (ev) => {
      const r = svg.getBoundingClientRect();
      const px = (ev.clientX - r.left) / r.width * W;
      const i = Math.max(0, Math.min(n - 1, Math.round(((px - padL) / iw) * (n - 1))));
      cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i)); cross.style.display = "";
      dot.setAttribute("cx", x(i)); dot.setAttribute("cy", y(pts[i].y)); dot.style.display = "";
      tooltip(true, pts[i].html || "", ev);
    });
    hit.addEventListener("mouseleave", () => { cross.style.display = "none"; dot.style.display = "none"; tooltip(false); });
  }

  function rateRows(el, rows, opts = {}) {
    const max = Math.max(1, ...rows.map((r) => r.w + r.l));
    el.innerHTML = rows.map((r) => {
      const n = r.w + r.l, pct = n ? Math.round(100 * r.w / n) : 0;
      const wp = (r.w / max) * 100, lp = (r.l / max) * 100;
      // Zweizeilig (Decks): Name, darunter Commander klein – statt einer abgeschnittenen Zeile
      const [t1, t2] = opts.twoLine ? String(r.label).split(" · ") : [r.label];
      const text = `<span class="t1">${esc(t1)}</span>${t2 ? `<span class="t2">${esc(t2)}</span>` : ""}`;
      const label = opts.link ? `<a href="${opts.link(r)}">${text}</a>` : text;
      const art = r.tile != null ? `<div class="art">${artOf(r.tile) ? artCanvas(artOf(r.tile)) : (r.tile ? `<img src="card-img/${r.tile}?v=art" alt="" loading="lazy" onerror="this.remove()">` : "")}</div>` : "";
      return `<div class="bar-row ${t2 ? "two" : ""}" data-tip="${esc(r.tipHtml || "")}"><div class="lbl">${art}<span class="t">${label}</span> <span class="muted small">(${n})</span></div><div class="bar-track"><div class="w" style="width:${wp}%"></div><div class="l" style="width:${lp}%"></div></div><div><b>${pct} %</b></div></div>`;
    }).join("") || `<div class="empty">${tr("Keine Daten")}</div>`;
    $$(".bar-row", el).forEach((row, i) => {
      const r = rows[i];
      row.addEventListener("mousemove", (ev) => tooltip(true, r.tipHtml || `<b>${esc(r.label)}</b><br>${tr("{w} Siege, {l} Niederlagen", { w: r.w, l: r.l })}`, ev));
      row.addEventListener("mouseleave", () => tooltip(false));
    });
    Art.bind(el);
  }

  function ring(pct, size = 118) {
    const r = 48, c = 2 * Math.PI * r, off = c * (1 - pct);
    return `<svg class="ring" viewBox="0 0 120 120" width="${size}" height="${size}"><circle cx="60" cy="60" r="${r}" fill="none" stroke="rgba(255,255,255,.08)" stroke-width="10"/><circle cx="60" cy="60" r="${r}" fill="none" stroke="var(--win)" stroke-width="10" stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${off}" transform="rotate(-90 60 60)"/><text x="60" y="66" text-anchor="middle" font-size="24">${Math.round(pct * 100)} %</text></svg>`;
  }

  // ---- Große Kartenvorschau beim Hover ---------------------------------------------------------
  let pv;
  function hoverPreview(root, dict) {
    if (!pv) { pv = document.createElement("div"); pv.className = "card-preview"; document.body.appendChild(pv); }
    const place = (ev, el) => {
      const w = pv.offsetWidth || 240, h = pv.offsetHeight || 340;
      let x = ev.clientX + 24, y = ev.clientY - h / 2;
      if (el && el.dataset.pvAnchor) {
        // neben dem Element verankert (Deckliste im Deckbau): links daneben, notfalls rechts
        const r = el.getBoundingClientRect();
        x = el.dataset.pvAnchor === "right" ? r.right + 12 : r.left - w - 12;
        if (x < 8) x = r.right + 12;
        if (x + w > window.innerWidth - 8) x = Math.max(8, window.innerWidth - w - 8);
        y = r.top + r.height / 2 - h / 2;
      } else if (x + w > window.innerWidth - 8) x = ev.clientX - w - 24;
      y = Math.max(8, Math.min(window.innerHeight - h - 8, y));
      pv.style.left = x + "px"; pv.style.top = y + "px";
    };
    for (const el of $$(".c[data-g], .cc[data-g], .c-row[data-g], [data-pv-anchor][data-g]", root)) {
      if (el.dataset.pv) continue;
      el.dataset.pv = "1";
      el.addEventListener("mouseenter", (ev) => {
        if (modal && !modal.classList.contains("hidden")) return;
        const c = card(+el.dataset.g, dict);
        pv.innerHTML = `${bigCard(Object.assign({}, c, { grpId: +el.dataset.g }))}<div class="meta">${esc(c.set)} ${esc(c.nr)}${c.rarity ? " · " + esc(c.rarity) : ""}${el.dataset.pt ? " · " + esc(el.dataset.pt) : ""}</div>`;
        $$(".c", pv).forEach((x) => x.removeAttribute("data-g"));
        pv.style.display = "block";
        Art.bind(pv);
        place(ev, el);
      });
      el.addEventListener("mousemove", (ev) => place(ev, el));
      el.addEventListener("mouseleave", () => { pv.style.display = "none"; });
      el.addEventListener("click", () => { pv.style.display = "none"; });
    }
  }

  // ---- Kartendetails (Modal) ----------------------------------------------------------------------
  const RARITY_NAME = { 0: "Token", 1: "Standardland", 2: "Common", 3: "Uncommon", 4: "Rare", 5: "Mythic" };
  // ---- Mana-Symbole als Grafik (Sonne, Tropfen, Schädel, Flamme, Baum, Diamant, Zahlen) ----
  const SYM = {
    w: '<circle cx="12" cy="12" r="11" fill="#f5efd6"/><circle cx="12" cy="12" r="3.2" fill="#3b2f0b"/><g stroke="#3b2f0b" stroke-width="1.8" stroke-linecap="round"><path d="M12 3.5v3M12 17.5v3M3.5 12h3M17.5 12h3M6 6l2.1 2.1M15.9 15.9 18 18M6 18l2.1-2.1M15.9 8.1 18 6"/></g>',
    u: '<circle cx="12" cy="12" r="11" fill="#2f74c4"/><path d="M12 4.5c3 4 5.5 7 5.5 10a5.5 5.5 0 0 1-11 0c0-3 2.5-6 5.5-10z" fill="#e8f2ff"/>',
    b: '<circle cx="12" cy="12" r="11" fill="#2a2430"/><path d="M12 5.5a5.5 5.5 0 0 0-5.5 5.5c0 2 1 3.2 2 4v2.5h7V15c1-.8 2-2 2-4A5.5 5.5 0 0 0 12 5.5z" fill="#c9c2d3"/><circle cx="9.7" cy="11.2" r="1.4" fill="#2a2430"/><circle cx="14.3" cy="11.2" r="1.4" fill="#2a2430"/><path d="M10.5 15h3" stroke="#2a2430" stroke-width="1"/>',
    r: '<circle cx="12" cy="12" r="11" fill="#c9462c"/><path d="M12 4c1 3 4 4.5 4 8.5a4 4 0 0 1-8 0c0-1.5.6-2.5 1.2-3.3.3 1.2 1 1.8 1.8 1.8C11 9 10.5 6 12 4z" fill="#ffe0b0"/>',
    g: '<circle cx="12" cy="12" r="11" fill="#3f8f4a"/><path d="M12 4l5 7h-2.5l3 4.5h-4v3h-3v-3h-4l3-4.5H7z" fill="#e6f7dc"/>',
    c: '<circle cx="12" cy="12" r="11" fill="#b9c4cc"/><path d="M12 5l6 7-6 7-6-7z" fill="#3a4450"/>',
    // mehrfarbig: goldener Kreis mit fünf Farbsegmenten
    m: '<circle cx="12" cy="12" r="11" fill="#d9b24a"/><path d="M12 12 L12 1.5 A10.5 10.5 0 0 1 22 8.8z" fill="#f3ead0"/><path d="M12 12 L22 8.8 A10.5 10.5 0 0 1 18.2 20.5z" fill="#2f74c4"/><path d="M12 12 L18.2 20.5 A10.5 10.5 0 0 1 5.8 20.5z" fill="#2a2430"/><path d="M12 12 L5.8 20.5 A10.5 10.5 0 0 1 2 8.8z" fill="#c9462c"/><path d="M12 12 L2 8.8 A10.5 10.5 0 0 1 12 1.5z" fill="#3f8f4a"/><circle cx="12" cy="12" r="4.5" fill="#d9b24a" stroke="#6b4e12" stroke-width="1"/>',
    t: '<circle cx="12" cy="12" r="11" fill="#c8c8c8"/><path d="M12 6a6 6 0 1 1-4.2 10.2" fill="none" stroke="#222" stroke-width="2.2"/><path d="M6.5 13.5 8 17.5l3.5-2.5z" fill="#222"/>'
  };
  /** Offizielles Symbol von Scryfall (nur verlinkt), darunter die eigene Zeichnung als Rückfall ohne Netz */
  const SYM_CDN = "https://svgs.scryfall.io/card-symbols/";
  function manaSymbol(s, cls) {
    const raw = String(s).trim();
    const k = raw.toLowerCase();
    const code = raw.toUpperCase().replace(/[{}\s]/g, "").replace(/\//g, "");
    const inner = SYM[k] || `<circle cx="12" cy="12" r="11" fill="#c9c9c9"/><text x="12" y="16.5" text-anchor="middle" font-size="13" font-weight="800" fill="#222" font-family="system-ui,sans-serif">${esc(raw.toUpperCase())}</text>`;
    return `<span class="ms ms-${esc(k.replace(/[^a-z0-9]/g, ""))} ${cls || ""}" aria-label="${esc(raw)}"><svg viewBox="0 0 24 24">${inner}</svg>${/^[A-Z0-9]{1,6}$/.test(code) ? `<img src="${SYM_CDN}${code}.svg" alt="" loading="lazy" onload="if(this.previousElementSibling)this.previousElementSibling.remove()" onerror="this.remove()">` : ""}</span>`;
  }
  /** Offizielles Set-Symbol (Scryfall); fehlt es, bleibt das Würfel-Symbol */
  /** Symbol aus dem Spiel (uiIcons des Kontos: lokal Route, Website Data-URL) oder null */
  const uiIcon = (key) => (DATA && DATA.account && DATA.account.uiIcons && DATA.account.uiIcons[key]) || null;
  /** Farbfilter-Knopf wie im Deckbau des Spiels: Filtersymbol (normal + leuchtend für "an"), sonst Mana-Symbol */
  function filterIcon(k) {
    const a = uiIcon("f_" + k), b = uiIcon("f_" + k + "_on");
    if (!a) return manaSymbol(k);
    return `<img class="fico off" src="${esc(a)}" alt="" loading="eager" onerror="this.parentElement.classList.add('noico')"><img class="fico on" src="${esc(b || a)}" alt="" loading="eager">`;
  }
  FI.grid = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>';
  FI.list = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6h16M4 12h16M4 18h16"/></svg>';
  FI.warn = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 3 2.5 20h19z"/><path d="M12 9v5M12 17h.01"/></svg>';
  /** Langes Drücken (Touch, 500 ms) auf Elemente unter root, die selector treffen: cb(el). Bewegung bricht ab. */
  function longPress(root, selector, cb) {
    let timer = null, target = null, x0 = 0, y0 = 0;
    const clear = () => { if (timer) clearTimeout(timer); timer = null; target = null; };
    root.addEventListener("touchstart", (ev) => { const el = ev.target.closest(selector); if (!el) return; target = el; x0 = ev.touches[0].clientX; y0 = ev.touches[0].clientY; timer = setTimeout(() => { const t = target; clear(); if (t) cb(t); }, 500); }, { passive: true });
    root.addEventListener("touchmove", (ev) => { if (!timer) return; const t = ev.touches[0]; if (Math.abs(t.clientX - x0) > 10 || Math.abs(t.clientY - y0) > 10) clear(); }, { passive: true });
    root.addEventListener("touchend", clear, { passive: true });
    root.addEventListener("touchcancel", clear, { passive: true });
  }
  /** Kartenzeile für die Listenansicht (ohne Bild): Kosten, Name, Typzeile, Set, Besitz. row = Bibliothekszeile */
  function cardRow(row, opts = {}) {
    return `<div class="c-row ${opts.cls || ""}" data-g="${row[0]}"><span class="cost">${manaHtml(row[10] || "")}</span><span class="nm">${esc(row[1])}</span><span class="tl">${esc(row[18] || "")}</span><span class="set">${esc(row[2] || "")}</span>${ownHtml(row[9])}${opts.extra || ""}</div>`;
  }
  /**
   * Handy: Ansicht-Menü neben der Suche – Raster/Liste umschalten und Kartengröße (Schieberegler) in einem Aufklappfeld.
   * opts: { view: "grid"|"list", onView(view) }
   */
  function zoomMenu(bar, sizer, count, opts = {}) {
    if (!bar || !sizer) return;
    let view = opts.view || "grid";
    const z = document.createElement("div"); z.className = "dd zoom";
    z.innerHTML = `<button type="button" class="dd-btn" title="${tr("Ansicht")}">${view === "list" ? FI.list : FI.grid}</button><div class="dd-menu">${opts.onView ? `<div class="seg view"><button type="button" data-v="grid" class="${view === "grid" ? "on" : ""}">${FI.grid} ${tr("Raster")}</button><button type="button" data-v="list" class="${view === "list" ? "on" : ""}">${FI.list} ${tr("Liste")}</button></div>` : ""}<div class="zs"></div></div>`;
    $(".zs", z).append(sizer);
    bar.append(z); if (count) bar.append(count);
    $(".dd-btn", z).addEventListener("click", () => openMenu(z, !z.classList.contains("open")));
    $$(".seg.view button", z).forEach((b) => b.addEventListener("click", () => { view = b.dataset.v; $$(".seg.view button", z).forEach((x) => x.classList.toggle("on", x === b)); $(".dd-btn", z).innerHTML = view === "list" ? FI.list : FI.grid; sizer.style.display = view === "list" ? "none" : ""; if (opts.onView) opts.onView(view); }));
    sizer.style.display = view === "list" ? "none" : "";
  }
  const setIcon = (code) => `<span class="seti"><img src="https://svgs.scryfall.io/sets/${esc(String(code || "").toLowerCase())}.svg" alt="" loading="lazy" onerror="this.parentElement.innerHTML=window.App.FI.set"></span>`;
  // "{2}{G}" oder MTGA-Notation "{o2oG}" -> Mana-Symbole
  const manaHtml = (cost) => String(cost || "").replace(/\{([^}]+)\}/g, (m, s) => {
    const parts = s.startsWith("o") ? s.split("o").filter(Boolean) : [s];
    return parts.map((p) => manaSymbol(p)).join("");
  });
  const ruleHtml = (t) => {
    // Erinnerungstext zuerst markieren (die Symbol-Bilder enthalten selbst Klammern), dann Symbole einsetzen
    let h = esc(t).replace(/\(([^()]{3,})\)/g, '<i class="rem">($1)</i>');
    h = manaHtml(h).replace(/\boT\b/g, manaSymbol("t"));
    if (/^[A-Z][a-z' \-]+(?:, [a-z][a-z' \-]+)*$/.test(t.trim())) return `<b class="kw">${h}</b>`;  // reine Schlüsselwortzeile
    h = h.replace(/^([A-Z][a-z]+(?: [a-z]+)?)(?= (?:<span class="ms|\d|from |&mdash;|—))/, '<b class="kw">$1</b>'); // Schlüsselwort mit Kosten/Parameter
    h = h.replace(/^([A-Z][A-Za-z' ]+) — /, '<b class="kw">$1</b> — ');                              // Fähigkeitswort
    const m = h.match(/^((?:<span class="ms[^]*?<\/span>|[^:<]){1,60}?): /);                       // Aktivierungskosten
    if (m && /<span class="ms|\{|\bPay\b|\bSacrifice\b|\bDiscard\b|\bTap\b|\bRemove\b|\bExile\b/.test(m[1])) h = `<span class="cost">${m[1]}</span>: ` + h.slice(m[0].length);
    return h;
  };
  const X_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  const xButton = (cls) => `<button class="x-btn ${cls || ""}" type="button" title="${tr("Schließen (Esc)")}" aria-label="${tr("Schließen")}">${X_ICON}</button>`;
  let modal;
  function closeModal() { if (modal) modal.classList.add("hidden"); if (pv) pv.style.display = "none"; }
  /** Statistik zu einer Karte aus den lokalen Daten: Decks, gespielte Matches, beim Gegner gesehen */
  function cardStats(grpId, dict) {
    const D = DATA || { matches: [], decks: [] };
    const name = card(grpId, dict).name;
    const sameName = (g) => g === grpId || card(g, dict).name === name; // alle Drucke zählen
    const decks = (D.decks || []).filter((d) => Object.values(d.zones || {}).some((z) => z.some(([g]) => sameName(g))));
    const played = (D.matches || []).filter((m) => (m.played || []).some(([g]) => sameName(g))).sort((a, b) => b.start - a.start);
    const casts = played.reduce((n, m) => n + (m.played || []).filter(([g]) => sameName(g)).reduce((x, [, c]) => x + c, 0), 0);
    const seen = (D.matches || []).filter((m) => (m.opponentCards || []).some((c) => sameName(c.grpId))).sort((a, b) => b.start - a.start);
    return { decks, played, casts, seen, sp: stats(played), ss: stats(seen) };
  }
  /** Kartendetails: links die Karte als Bild, rechts Text, Infos und Statistik; Drucke eingeklappt */
  async function showCard(grpId, dict) {
    if (!modal) {
      modal = document.createElement("div"); modal.className = "modal hidden";
      modal.addEventListener("click", (ev) => { if (ev.target === modal || ev.target.closest(".x-btn")) closeModal(); });
      document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") closeModal(); });
      document.body.appendChild(modal);
    }
    if (pv) pv.style.display = "none";
    const c = card(grpId, dict);
    const st = cardStats(grpId, dict);
    // Fremdes Profil oder geteiltes Deck: die eigene Statistik gibt es dort nicht, der Block bliebe leer
    const eigene = !(DATA && DATA.site) || !!(DATA.site && DATA.site.own);
    if (!SETS) loadSets().then(() => { const b = $(".m-meta .badge", modal); if (b) b.innerHTML = `${setIcon(c.set)}${esc(setName(c.set))} · ${esc(c.set)} ${esc(c.nr)}`; });
    const matchRow = (m, extra) => `<a class="m-match" href="replay.html?id=${m.matchId}"><span class="${m.result === "Sieg" ? "dotw" : "dotl"}"></span><span class="d">${relDate(m.start)}</span><span class="o">vs ${esc(m.opponent)}</span><span class="muted small">${esc(extra || m.myDeck || "")}</span></a>`;
    const pct = (x) => x.w + x.l ? Math.round(100 * x.w / (x.w + x.l)) + " %" : "–";
    // Statistik mit klaren Beschriftungen (Erklärung als Tooltip und Unterzeile)
    const statsHtml = !eigene ? "" : `<div class="m-sec">${tr("Deine Statistik mit dieser Karte")}</div><div class="m-stats">
        <div class="m-tile" title="${tr("In deinen Decks")}"><div class="k">${tr("In deinen Decks")}</div><div class="v">${st.decks.length}</div></div>
        <div class="m-tile" title="${tr("Matches, in denen du sie gespielt hast")}"><div class="k">${tr("Gespielt")}</div><div class="v">${st.played.length}</div><div class="s">${tr("{n}× gewirkt", { n: st.casts })}</div></div>
        <div class="m-tile ${st.sp.n ? (st.sp.rate >= .5 ? "win" : "loss") : ""}" title="${tr("Winrate, wenn du sie gespielt hast")}"><div class="k">${tr("Winrate")}</div><div class="v">${pct(st.sp)}</div><div class="s">${st.sp.n ? tr("{w} S · {l} N", { w: st.sp.w, l: st.sp.l }) : tr("keine Matches")}</div></div>
        <div class="m-tile" title="${tr("Matches, in denen der Gegner sie hatte")}"><div class="k">${tr("Beim Gegner")}</div><div class="v">${st.seen.length}</div><div class="s">${st.ss.n ? tr("dagegen {p}", { p: pct(st.ss) }) : tr("nie gesehen")}</div></div>
      </div>
      ${st.decks.length ? `<div class="m-sec">${tr("Decks")}</div><div class="m-chips">${st.decks.slice(0, 8).map((d) => `<a class="chip" href="decks.html?deck=${encodeURIComponent(d.name)}">${esc(d.name)}</a>`).join("")}${st.decks.length > 8 ? `<span class="chip muted">+${st.decks.length - 8}</span>` : ""}</div>` : ""}
      ${st.played.length ? `<div class="m-sec">${tr("Zuletzt gespielt")}</div><div class="m-matches">${st.played.slice(0, 4).map((m) => matchRow(m)).join("")}</div>` : ""}
      ${st.seen.length ? `<div class="m-sec">${tr("Beim Gegner gesehen")}</div><div class="m-matches">${st.seen.slice(0, 3).map((m) => matchRow(m, m.opponent && m.myDeck ? tr("mit {d}", { d: m.myDeck }) : "")).join("")}</div>` : ""}`;
    const RAR_NAME = ["Token", "Standardland", "Common", "Uncommon", "Rare", "Mythic"];
    const render = (d) => {
      const cc = Object.assign({}, c, { grpId });
      // Nicht jede Seite hat die Karte im lokalen Wörterbuch (Deckbau, Bibliothek, geteiltes Deck).
      // Dann kommen Name, Seltenheit, Farben und Artwork aus den nachgeladenen Details, damit die
      // Ansicht überall gleich aussieht.
      if (d) {
        if (d.name) cc.name = d.name;
        if (!cc.art && d.artId) cc.art = d.artId;
        if (!cc.rarity) cc.rarity = typeof d.rarity === "number" ? (RAR_NAME[d.rarity] || "") : (d.rarity || "");
        if (!cc.colors.length && (d.colors || []).length) cc.colors = d.colors.map((x) => ({ 1: "w", 2: "u", 3: "b", 4: "r", 5: "g" })[x]).filter(Boolean);
        if (!cc.typeLine && d.typeLine) cc.typeLine = d.typeLine;
        if (d.flags && !cc.flags) { cc.flags = d.flags; cc.legendary = legendaryOf(d.flags, d.typeLine || cc.typeLine); }
        const land = /(^|\s)(Land|Ländereien?)(\s|—|$)/i.test(d.typeLine || "");
        cc.isLand = cc.isLand || land;
        if (cc.frame === "c") cc.frame = cc.colors.length > 1 ? "m" : cc.colors.length === 1 ? cc.colors[0] : cc.isLand ? "l" : "c";
      }
      const text = d ? (d.text || []).join("\n") : c.text;
      const typeLine = d ? d.typeLine || c.typeLine : c.typeLine;
      const cost = d ? d.cost || c.cost : c.cost;
      const ptv = d ? (d.power !== "" && d.power != null ? d.power + "/" + d.toughness : "") : c.pt;
      const owned = d ? (d.owned ? `<span class="badge win">${tr("{n}× im Besitz", { n: d.owned })}</span>` : `<span class="badge unk">${tr("nicht im Besitz")}</span>`) : skeleton.text("90px", 20);
      const prints = d && d.printings.length > 1 ? `<button class="ghost small" id="m-prints-toggle">${tr("Drucke ({n})", { n: d.printings.length })} ▾</button><div class="m-prints hidden">${d.printings.map((p) => `<button class="ghost small ${p[0] === d.grpId ? "on" : ""}" data-g="${p[0]}">${esc(p[1])} ${esc(p[2])}${p[4] ? ` · ${p[4]}×` : ""}</button>`).join("")}</div>` : "";
      const rules = text ? abilitiesHtml(text) : (d ? `<p class="muted small">${tr("Kein Regeltext.")}</p>` : `<p>${skeleton.text("95%")}</p><p>${skeleton.text("70%")}</p>`);
      modal.innerHTML = `<div class="m-box wide">${xButton("m-close")}
        <div class="m-card">${bigCard(cc)}</div>
        <div class="m-info">
          <div class="m-title"><h2>${esc(cc.name)}</h2><span class="m-cost">${manaHtml(cost)}</span></div>
          <div class="m-type">${esc(typeLine || c.typeText)}${ptv ? ` <b class="m-pt">${esc(ptv)}</b>` : ""}</div>
          <div class="m-rules">${rules}${d && d.flavor ? `<p class="flavor">${esc(d.flavor)}</p>` : ""}</div>
          <div class="m-sec">${tr("Kartendaten")}</div>
          <div class="m-meta"><span class="badge unk set" title="${esc(setName(c.set))}">${setIcon(c.set)}${esc(setName(c.set))} · ${esc(c.set)} ${esc(c.nr)}</span>${cc.rarity ? `<span class="badge unk">${esc(tr(cc.rarity))}</span>` : ""}${owned}${d && d.isRebalanced ? `<span class="badge loss">${tr("Rebalanced")}</span>` : ""}${d && d.artist ? `<span class="muted small">${tr("Illustration")}: ${esc(d.artist)}</span>` : ""}</div>
          ${statsHtml}
          <div class="m-links">${prints}${eigene ? `<a href="library.html?q=${encodeURIComponent(cc.name)}">${tr("Bibliothek")}</a>` : ""}<a href="https://scryfall.com/search?q=${encodeURIComponent('!"' + c.name + '"')}" target="_blank" rel="noopener">Scryfall ↗</a><a href="https://gatherer.wizards.com/Pages/Search/Default.aspx?name=${encodeURIComponent(c.name)}" target="_blank" rel="noopener">Gatherer ↗</a></div>
        </div></div>`;
      Art.bind(modal);
      const t = $("#m-prints-toggle", modal);
      if (t) t.addEventListener("click", () => { const p = $(".m-prints", modal); p.classList.toggle("hidden"); t.textContent = `${tr("Drucke ({n})", { n: d.printings.length })} ${p.classList.contains("hidden") ? "▾" : "▴"}`; });
      $$(".m-prints button", modal).forEach((b) => b.addEventListener("click", () => showCard(+b.dataset.g, dict)));
    };
    render(null);
    modal.classList.remove("hidden");
    try { render(await getJson("api/card/" + grpId, 10000)); }
    catch (e) { render({ text: c.text ? c.text.split("\n") : [], typeLine: c.typeLine, cost: c.cost, power: "", printings: [], owned: 0 }); }
  }
  /** Klick auf Kartenkacheln öffnet die Details */
  function cardLinks(root, dict) {
    for (const el of $$(".c[data-g], .cc[data-g], .c-row[data-g]", root)) {
      if (el.dataset.lnk) continue;
      el.dataset.lnk = "1";
      el.style.cursor = "pointer";
      el.addEventListener("click", (ev) => { ev.stopPropagation(); showCard(+el.dataset.g, dict); });
    }
  }
  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) navigator.serviceWorker.register("sw.js").catch(() => {});

  function param(name) { return new URLSearchParams(location.search).get(name); }
  // Live-Aktualisierung: alle 20 s prüfen, ob der Watcher neue Daten geschrieben hat (ETag von data.json);
  // dann Hinweis zeigen und nach kurzer Zeit neu laden, außer der Nutzer ist gerade aktiv oder ein Dialog ist offen
  (function watchData() {
    if (!location.protocol.startsWith("http") || /replay\.html$/.test(location.pathname)) return;
    let tag = null, lastInput = 0, notified = false;
    for (const ev of ["pointerdown", "keydown", "input", "scroll"]) window.addEventListener(ev, () => { lastInput = Date.now(); }, { passive: true, capture: true });
    const check = async () => {
      try {
        const r = await fetch("data.json", { method: "HEAD", cache: "no-cache" });
        const t = r.headers.get("etag");
        if (!t) return;
        if (tag && t !== tag && !notified) {
          notified = true;
          const el = document.createElement("div"); el.className = "toast";
          el.innerHTML = `<span>${tr("Neue Daten vom Watcher")}</span><button type="button" class="primary small">${tr("Jetzt aktualisieren")}</button>`;
          $("button", el).addEventListener("click", () => location.reload());
          document.body.appendChild(el);
          const tryReload = () => { const busyUi = (modal && !modal.classList.contains("hidden")) || Date.now() - lastInput < 20000 || document.hidden; if (busyUi) setTimeout(tryReload, 5000); else location.reload(); };
          setTimeout(tryReload, 4000);
        }
        tag = tag || t;
      } catch (e) { /* Server weg: still bleiben */ }
    };
    setTimeout(check, 3000);
    setInterval(check, 20000);
  })();

  return { load, get DATA() { return DATA; }, $, $$, esc, num, card, cardName, artOf, artCanvas, cardTile, cardHtml, textCard, cardUsage, cardSorter, isLegendary, get ohneBilder() { return ohneBilder; }, replayLink, bigCard, bindCardImages, xButton, deckBox, deckCell, Art, closeModal, fmtDate, fmtTime, fmtDur, relDate, deckLabel, eventLabel, resultBadge, shell, stats, groupBy, tooltip, stackedBars, lineChart, rateRows, ring, param, hoverPreview, showCard, cardLinks, manaHtml, manaSymbol, filterIcon, uiIcon, zoomMenu, cardRow, longPress, openMenu, colorMatch, cardFilterBar, qtyHtml, ownHtml, ruleHtml, skeleton, busy, debounce, getJson, cardStats, dropdown, selectToDropdown, enhanceSelects, settingsTabs, searchBox, FI, loadSets, setName, setIcon, sizeSlider, deckStats, deckStatsHtml, colorBarHtml, cmcOf, loadedImgs, t: tr, isMobile, foldable, get LOGO() { return logoSvg(); } };
})();
