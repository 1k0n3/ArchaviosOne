// Serverseitig gerenderte Seiten der Website (Einstellungen): Übersetzung mit dem Wörterbuch der App (i18n.js),
// Sprachwahl in der Seitenleiste und einklappbare Bereiche. Kartennamen bleiben Englisch.
(function () {
  const I = window.I18N;
  if (I) {
    // Textknoten und Titel-Attribute übersetzen: der getrimmte deutsche Text ist der Wörterbuchschlüssel
    const tr = (s) => { const k = s.trim(); if (!k) return s; const v = I.t(k); return v === k ? s : s.replace(k, v); };
    const walk = (node) => {
      if (node.nodeType === 3) { if (node.parentNode && !/^(SCRIPT|STYLE)$/.test(node.parentNode.nodeName)) node.nodeValue = tr(node.nodeValue); return; }
      if (node.nodeType !== 1) return;
      for (const a of ["title", "placeholder", "aria-label"]) if (node.hasAttribute(a)) node.setAttribute(a, tr(node.getAttribute(a)));
      for (const c of Array.from(node.childNodes)) walk(c);
    };
    if (I.lang !== "de") { walk(document.body); document.title = document.title.replace(/^[^·]+/, (m) => tr(m)); }
    const sel = document.getElementById("lang-sel");
    if (sel) {
      sel.innerHTML = Object.entries(I.LANGS).map(([k, v]) => `<option value="${k}" ${k === I.lang ? "selected" : ""}>${v}</option>`).join("");
      sel.addEventListener("change", () => I.set(sel.value));
    }
  }
  // Decksuche in den Einstellungen: Zeilen nach Name/Format filtern
  const dq = document.querySelector(".deck-q");
  if (dq) {
    const rows = Array.from(dq.parentElement.querySelectorAll("tr"));
    const none = dq.parentElement.querySelector(".deck-q-none");
    dq.addEventListener("input", () => {
      const t = dq.value.trim().toLowerCase();
      let n = 0;
      for (const r of rows) { const hit = !t || r.textContent.toLowerCase().includes(t); r.style.display = hit ? "" : "none"; if (hit) n++; }
      if (none) none.hidden = n > 0;
    });
  }
  // Einklappbare Bereiche: Überschrift mit data-fold, der folgende Block ist der Inhalt; Zustand bleibt im Browser
  document.querySelectorAll(".fold-head[data-fold]").forEach((head) => {
    const body = head.nextElementSibling;
    if (!body) return;
    const key = "mtga-fold:" + head.dataset.fold;
    let open = !(window.matchMedia && window.matchMedia("(max-width: 760px)").matches);
    try { const v = localStorage.getItem(key); if (v !== null) open = v === "1"; } catch (e) { /* ohne Speicher */ }
    const paint = () => { head.classList.toggle("folded", !open); body.classList.toggle("fold-hidden", !open); };
    head.addEventListener("click", (ev) => {
      if (ev.target.closest("a, button, input, select")) return;
      open = !open;
      try { localStorage.setItem(key, open ? "1" : "0"); } catch (e) { /* ignorieren */ }
      paint();
    });
    paint();
  });
})();
