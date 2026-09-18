// Gemeinsame Hilfsfunktionen. Datenquelle: window.MTGA_DATA (data.js), alternativ data.json vom Server.
// Kartenbilder: der lokale Server liefert die komprimierte Textur direkt aus den MTGA-Spieldaten
// (/art/<ArtId>), der Browser dekodiert sie per WebGL auf der Grafikkarte. Nichts wird umgewandelt oder gespeichert.
window.App = (function () {
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => [...(root || document).querySelectorAll(sel)];
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const pad = (n) => String(n).padStart(2, "0");
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

  async function load() {
    if (!DATA) { const r = await fetch("data.json"); DATA = await r.json(); }
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
  function card(g, dict) {
    const d = (dict && dict[g]) || (DATA && DATA.cards[g]);
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
    return { name: d[0], set: d[1], nr: d[2], rarity: d[3], token: !!d[4], art: d[5] || 0, colors, types, frame, isLand, creature: types.includes(2), flags, style, legendary: flags.includes("L"), pt, typeText, typeLine: d[12] || typeText, text: d[11] || "", cost: d[13] || "", rar: RARITY_KEY[d[3]] || "c" };
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
        // Scryfall kann kurzzeitig gesperrt sein: das echte Kartenbild nach einer Pause erneut anfordern
        // (bis zu 6 Versuche mit wachsendem Abstand: 20 s … 8 min, damit auch längere Sperren überbrückt werden)
        if (tries++ < 6 && im.isConnected) setTimeout(() => { if (im.isConnected) im.src = im.src.split("&r=")[0].split("?r=")[0] + (im.src.includes("?") ? "&" : "?") + "r=" + tries; }, Math.min(480000, 20000 * Math.pow(2, tries - 1)));
      };
      const done = () => { const box = im.closest(".c, .cc"); if (box && im.naturalWidth > 0) { box.classList.remove("fb"); box.classList.add("ld"); loadedImgs.add(im.getAttribute("src")); } };
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
      if (!r.ok) throw new Error("HTTP " + r.status);
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
    reset: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M4 12a8 8 0 1 1 2.6 5.9"/><path d="M4 18v-6h6"/></svg>',
    calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>',
    swords: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M4 20l7-7M13 11l7-7M14 4h6v6M4 14v6h6"/></svg>',
    chevron: '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="m6 9 6 6 6-6"/></svg>'
  };
  let ddOpen = null;
  document.addEventListener("click", (ev) => { if (ddOpen && !ddOpen.contains(ev.target)) { ddOpen.classList.remove("open"); ddOpen = null; } });
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
        <div class="dd-menu">${opts.searchable ? `<input type="search" class="dd-q" placeholder="${tr("Filtern …")}">` : ""}<div class="dd-list">${items.map((x) => `<button type="button" data-v="${esc(x.v)}" class="${String(x.v) === String(value) ? "on" : ""}"${x.title ? ` title="${esc(x.title)}"` : ""}${x.search ? ` data-q="${esc(x.search)}"` : ""}>${x.icon || ""}<span>${esc(x.label)}</span></button>`).join("")}</div></div>`;
      $(".dd-btn", el).addEventListener("click", () => {
        const open = !el.classList.contains("open");
        if (ddOpen && ddOpen !== el) ddOpen.classList.remove("open");
        el.classList.toggle("open", open); ddOpen = open ? el : null;
        if (open) {
          // Menü im Sichtbereich halten: links am Knopf ausrichten, bei Platzmangel nach links rücken, nie über einen Rand
          // (per left-Wert statt transform, damit die Einblend-Animation nichts überschreibt)
          const menu = $(".dd-menu", el); menu.style.left = ""; menu.style.right = ""; menu.style.maxWidth = Math.min(280, window.innerWidth - 16) + "px";
          const dr = el.getBoundingClientRect(), mw = menu.getBoundingClientRect().width;
          let left = dr.left; if (left + mw > window.innerWidth - 8) left = window.innerWidth - 8 - mw; if (left < 8) left = 8;
          menu.style.left = Math.round(left - dr.left) + "px"; menu.style.right = "auto";
          const q = $(".dd-q", el); if (q) { q.value = ""; q.focus(); } const on = $(".dd-list .on", el); if (on) on.scrollIntoView({ block: "center" });
        }
      });
      $$(".dd-list button", el).forEach((b) => b.addEventListener("click", () => { value = b.dataset.v; el.classList.remove("open"); ddOpen = null; paint(); if (opts.onChange) opts.onChange(value); }));
      const q = $(".dd-q", el);
      if (q) q.addEventListener("input", () => { const t = q.value.trim().toLowerCase(); $$(".dd-list button", el).forEach((b) => { b.style.display = !t || (b.textContent + " " + (b.dataset.q || "")).toLowerCase().includes(t) ? "" : "none"; }); });
    };
    paint();
    return { get value() { return value; }, set value(v) { value = v; paint(); }, el };
  }
  /** Schieberegler für die Kachelgröße eines Kartenrasters (gemerkt im Browser) */
  function sizeSlider(el, grid, key = "mtga-tile-w", min = 90, max = 220) {
    let v = 136;
    try { v = +localStorage.getItem(key) || v; } catch (e) { /* ohne Speicher */ }
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
  /** Deck-Fakten: Kartenzähler als Kacheln (gleiche Optik wie die Match-Statistik), Manakurve, Farbanteile */
  function deckStatsHtml(st) {
    const max = Math.max(1, ...st.curve);
    const curve = st.curve.map((n, i) => `<div class="cb" title="${tr("{n} Karten mit Manawert {v}", { n, v: i === 7 ? "7+" : i })}"><div class="bar" style="height:${Math.round(100 * n / max)}%"></div><span class="v">${n || ""}</span><span class="l">${i === 7 ? "7+" : i}</span></div>`).join("");
    const total = Object.values(st.colors).reduce((x, y) => x + y, 0) || 1;
    const seg = Object.entries(st.colors).filter(([, n]) => n).map(([k, n]) => `<div class="seg c-${k}" style="flex:${n}" title="${tr("{n} {c}-Symbole ({p} %)", { n, c: k.toUpperCase(), p: Math.round(100 * n / total) })}"></div>`).join("");
    const pips = Object.entries(st.colors).filter(([, n]) => n).map(([k, n]) => `<span class="pip">${manaSymbol(k)}<b>${n}</b></span>`).join("");
    const tile = (l, v, icon) => `<div class="tile"><div class="label">${icon || ""}${l}</div><div class="value">${v}</div></div>`;
    return `<div class="deck-facts-head fold-head" data-fold="deck-facts">${tr("Statistik")}<span class="fold-chev">${FI.chevron}</span></div><div class="deck-facts">
      <div class="df-left">
        <div class="ds-block colors"><div class="ds-t">${tr("Farben")}</div><div class="cbar">${seg || '<div class="seg c-c" style="flex:1"></div>'}</div><div class="pips">${pips || `<span class="muted small">${tr("farblos")}</span>`}</div></div>
        <div class="tiles stat-rows fact-tiles">${tile(tr("Kreaturen"), st.creatures, FI.creature)}${tile(tr("Zauber"), st.spells, FI.instant)}${tile(tr("Andere"), st.others, FI.artifact)}${tile(tr("Länder"), st.lands, FI.land)}${tile(tr("Nichtländer"), st.nonLand, FI.copies)}${tile(tr("Ø Manawert"), st.avgCmc.toFixed(1), FI.mana)}</div>
      </div>
      <div class="ds-block curve"><div class="ds-t">${tr("Manakurve")}</div><div class="curve">${curve}</div></div>
    </div>`;
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
    lib: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v14"/><path d="M4 19a2 2 0 0 0 2 2h14"/><path d="M8 7h8M8 11h6"/></svg>'
  };

  function shell(active, contentHtml) {
    // Auf der Website: freigegebene Decks zeigen nur die Deckseite, das eigene Dashboard bekommt Konto-Links
    const site = DATA && DATA.site;
    let pages = [["index.html", tr("Übersicht"), "dash"], ["matches.html", tr("Matches"), "matches"], ["decks.html", tr("Decks"), "decks"], ["library.html", tr("Bibliothek"), "lib"], ["builder.html", tr("Deckbau"), "build"]];
    if (site && site.shared) pages = [["decks.html", tr("Geteiltes Deck"), "decks"]];
    if (isMobile()) pages = pages.filter((p) => p[0] !== "matches.html");   // Match-Tabelle ist nichts fürs Handy
    const siteLinks = site && site.shared ? `<a class="nav" href="/p/${esc(site.handle)}">${ICONS.lib}<span>${tr("Profil von {h}", { h: esc(site.handle) })}</span></a>` : "";
    const player = (DATA && DATA.player) || tr("Spieler");
    const cur = pages.find((p) => p[0] === active); if (cur) document.title = "MTGA Stats · " + cur[1];
    const langSel = window.I18N ? `<label class="lang" title="${tr("Sprache")}"><select>${Object.entries(I18N.LANGS).map(([k, v]) => `<option value="${k}" ${k === I18N.lang ? "selected" : ""}>${v}</option>`).join("")}</select></label>` : "";
    const st = stats(DATA ? DATA.matches : []);
    const nav = `<aside class="side-nav">
      ${site ? `<a class="brand" href="/?site=1" title="${tr("Zur Website")}">` : `<div class="brand">`}${logoSvg()}<div><div class="t1">MTGA Stats</div><div class="t2">${site ? tr("Website") : tr("Lokales Dashboard")}</div></div>${site ? "</a>" : "</div>"}
      ${pages.map(([h, t, ic]) => `<a class="nav ${active === h ? "active" : ""}" href="${h}">${ICONS[ic]}<span>${t}</span></a>`).join("")}
      ${siteLinks ? `<div class="nav-sep"></div>${siteLinks}` : ""}
      <div class="spacer"></div>
      ${site && site.own
        ? `<div class="player link"><a class="who" href="/settings" title="${tr("Konto & Geräte")}"><div class="av">${esc(player.slice(0, 1).toUpperCase())}</div><div><div class="n">${esc(player)}</div><div class="s">${tr("{n} Matches", { n: st.n })} · ${Math.round(st.rate * 100)} % ${tr("Winrate")}</div></div></a>${site.csrf ? `<form method="post" action="/logout" class="inline"><input type="hidden" name="csrf" value="${esc(site.csrf)}"><button class="out" type="submit" title="${tr("Abmelden")}">${ICONS.out}</button></form>` : ""}</div>`
        : (DATA && DATA.syncUrl
          // lokales Dashboard mit verbundener Website: Klick öffnet Konto & Geräte dort
          ? `<div class="player link"><a class="who" href="${esc(DATA.syncUrl)}/settings" target="_blank" rel="noopener" title="${tr("Konto & Geräte auf der Website")}"><div class="av">${esc(player.slice(0, 1).toUpperCase())}</div><div><div class="n">${esc(player)}</div><div class="s">${tr("{n} Matches", { n: st.n })} · ${Math.round(st.rate * 100)} % ${tr("Winrate")}</div></div></a></div>`
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
    if (!document.querySelector("link[rel=icon]") && !document.querySelector("link[rel=manifest]")) {
      const l = document.createElement("link"); l.rel = "icon"; l.href = "data:image/svg+xml," + encodeURIComponent(logoSvg().replace('class="mark" ', "")); document.head.appendChild(l);
    }
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
    tip.style.left = Math.min(ev.clientX + 16, window.innerWidth - tip.offsetWidth - 8) + "px";
    tip.style.top = Math.min(ev.clientY + 16, window.innerHeight - tip.offsetHeight - 8) + "px";
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
      const label = opts.link ? `<a href="${opts.link(r)}">${esc(r.label)}</a>` : esc(r.label);
      const art = r.tile != null ? `<div class="art">${artCanvas(artOf(r.tile))}</div>` : "";
      return `<div class="bar-row" data-tip="${esc(r.tipHtml || "")}"><div class="lbl">${art}<span class="t">${label}</span> <span class="muted small">(${n})</span></div><div class="bar-track"><div class="w" style="width:${wp}%"></div><div class="l" style="width:${lp}%"></div></div><div><b>${pct} %</b></div></div>`;
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
    for (const el of $$(".c[data-g], .cc[data-g], [data-pv-anchor][data-g]", root)) {
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
    if (!SETS) loadSets().then(() => { const b = $(".m-meta .badge", modal); if (b) b.innerHTML = `${setIcon(c.set)}${esc(setName(c.set))} · ${esc(c.set)} ${esc(c.nr)}`; });
    const matchRow = (m, extra) => `<a class="m-match" href="replay.html?id=${m.matchId}"><span class="${m.result === "Sieg" ? "dotw" : "dotl"}"></span><span class="d">${relDate(m.start)}</span><span class="o">vs ${esc(m.opponent)}</span><span class="muted small">${esc(extra || m.myDeck || "")}</span></a>`;
    const pct = (x) => x.w + x.l ? Math.round(100 * x.w / (x.w + x.l)) + " %" : "–";
    const statsHtml = `<div class="m-stats">
        <div class="m-tile"><div class="k">${tr("In Decks")}</div><div class="v">${st.decks.length}</div></div>
        <div class="m-tile"><div class="k">${tr("Gespielt")}</div><div class="v">${st.played.length}</div><div class="s">${tr("{n}× gewirkt", { n: st.casts })}</div></div>
        <div class="m-tile ${st.sp.n ? (st.sp.rate >= .5 ? "win" : "loss") : ""}"><div class="k">${tr("Winrate")}</div><div class="v">${pct(st.sp)}</div><div class="s">${tr("{w} S · {l} N", { w: st.sp.w, l: st.sp.l })}</div></div>
        <div class="m-tile"><div class="k">${tr("Beim Gegner")}</div><div class="v">${st.seen.length}</div><div class="s">${st.ss.n ? tr("dagegen {p}", { p: pct(st.ss) }) : tr("nie gesehen")}</div></div>
      </div>
      ${st.decks.length ? `<div class="m-sec">${tr("Decks")}</div><div class="m-chips">${st.decks.slice(0, 8).map((d) => `<a class="chip" href="decks.html?deck=${encodeURIComponent(d.name)}">${esc(d.name)}</a>`).join("")}${st.decks.length > 8 ? `<span class="chip muted">+${st.decks.length - 8}</span>` : ""}</div>` : ""}
      ${st.played.length ? `<div class="m-sec">${tr("Zuletzt gespielt")}</div><div class="m-matches">${st.played.slice(0, 4).map((m) => matchRow(m)).join("")}</div>` : ""}
      ${st.seen.length ? `<div class="m-sec">${tr("Beim Gegner gesehen")}</div><div class="m-matches">${st.seen.slice(0, 3).map((m) => matchRow(m, m.opponent && m.myDeck ? tr("mit {d}", { d: m.myDeck }) : "")).join("")}</div>` : ""}`;
    const render = (d) => {
      const cc = Object.assign({}, c, { grpId });
      const text = d ? (d.text || []).join("\n") : c.text;
      const typeLine = d ? d.typeLine || c.typeLine : c.typeLine;
      const cost = d ? d.cost || c.cost : c.cost;
      const ptv = d ? (d.power !== "" && d.power != null ? d.power + "/" + d.toughness : "") : c.pt;
      const owned = d ? (d.owned ? `<span class="badge win">${tr("{n}× im Besitz", { n: d.owned })}</span>` : `<span class="badge unk">${tr("nicht im Besitz")}</span>`) : skeleton.text("90px", 20);
      const prints = d && d.printings.length > 1 ? `<button class="ghost small" id="m-prints-toggle">${tr("Drucke ({n})", { n: d.printings.length })} ▾</button><div class="m-prints hidden">${d.printings.map((p) => `<button class="ghost small ${p[0] === d.grpId ? "on" : ""}" data-g="${p[0]}">${esc(p[1])} ${esc(p[2])}${p[4] ? ` · ${p[4]}×` : ""}</button>`).join("")}</div>` : "";
      const rules = text ? text.split("\n").filter((l) => l.trim()).map((l) => `<p class="ab">${ruleHtml(l)}</p>`).join("") : (d ? `<p class="muted small">${tr("Kein Regeltext.")}</p>` : `<p>${skeleton.text("95%")}</p><p>${skeleton.text("70%")}</p>`);
      modal.innerHTML = `<div class="m-box wide">${xButton("m-close")}
        <div class="m-card">${bigCard(cc)}</div>
        <div class="m-info">
          <div class="m-title"><h2>${esc(c.name)}</h2><span class="m-cost">${manaHtml(cost)}</span></div>
          <div class="m-type">${esc(typeLine || c.typeText)}${ptv ? ` <b class="m-pt">${esc(ptv)}</b>` : ""}</div>
          <div class="m-rules">${rules}${d && d.flavor ? `<p class="flavor">${esc(d.flavor)}</p>` : ""}</div>
          <div class="m-meta"><span class="badge unk set" title="${esc(setName(c.set))}">${setIcon(c.set)}${esc(setName(c.set))} · ${esc(c.set)} ${esc(c.nr)}</span><span class="badge unk">${esc(tr(c.rarity))}</span>${owned}${d && d.isRebalanced ? `<span class="badge loss">${tr("Rebalanced")}</span>` : ""}${d && d.artist ? `<span class="muted small">${tr("Illustration")}: ${esc(d.artist)}</span>` : ""}</div>
          ${statsHtml}
          <div class="m-links">${prints}<a href="library.html?q=${encodeURIComponent(c.name)}">${tr("Bibliothek")}</a><a href="https://scryfall.com/search?q=${encodeURIComponent('!"' + c.name + '"')}" target="_blank" rel="noopener">Scryfall ↗</a><a href="https://gatherer.wizards.com/Pages/Search/Default.aspx?name=${encodeURIComponent(c.name)}" target="_blank" rel="noopener">Gatherer ↗</a></div>
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
    for (const el of $$(".c[data-g], .cc[data-g]", root)) {
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

  return { load, get DATA() { return DATA; }, $, $$, esc, card, cardName, artOf, artCanvas, cardTile, cardHtml, replayLink, bigCard, bindCardImages, xButton, deckBox, deckCell, Art, closeModal, fmtDate, fmtTime, fmtDur, relDate, deckLabel, eventLabel, resultBadge, shell, stats, groupBy, tooltip, stackedBars, lineChart, rateRows, ring, param, hoverPreview, showCard, cardLinks, manaHtml, manaSymbol, ruleHtml, skeleton, busy, debounce, getJson, cardStats, dropdown, searchBox, FI, loadSets, setName, setIcon, sizeSlider, deckStats, deckStatsHtml, cmcOf, loadedImgs, t: tr, isMobile, foldable, get LOGO() { return logoSvg(); } };
})();
