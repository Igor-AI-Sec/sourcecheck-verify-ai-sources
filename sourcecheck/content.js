// SourceCheck – content script (chatgpt.com)
// Zadania: (1) znaleźć odpowiedzi asystenta w DOM, (2) dodać przycisk "Verify sources",
// (3) zebrać URL-e + kontekst wokół nich, (4) wyświetlić raport z wynikami.

(() => {
  "use strict";

  // Każdy serwis ma inny DOM. Wykrywamy po hoście i dobieramy selektor odpowiedzi AI.
  // Priorytet: atrybuty semantyczne > klasy CSS (klasy zmieniają się przy redesignach).
  const HOST = location.hostname;

  let ASSISTANT_SELECTOR;
  if (HOST.includes("gemini.google.com")) {
    // Gemini renderuje odpowiedź w <message-content> / .model-response-text
    ASSISTANT_SELECTOR = "message-content, .model-response-text, [class*='response-container-content']";
  } else if (HOST.includes("claude.ai")) {
    // Claude oznacza wiadomości asystenta data-testid / klasą font-claude-*
    ASSISTANT_SELECTOR = "[data-testid='chat-message-content'], div[class*='font-claude']";
  } else {
    // ChatGPT (domyślnie)
    ASSISTANT_SELECTOR = '[data-message-author-role="assistant"]';
  }

  const BTN_CLASS = "sourcecheck-btn";
  const REPORT_CLASS = "sourcecheck-report";
  const PROCESSED_ATTR = "data-sourcecheck";

  let requestCounter = 0;
  const activeReports = new Map(); // requestId -> report DOM element

  // ---------- ekstrakcja URL-i z odpowiedzi ----------

  const URL_REGEX = /https?:\/\/[^\s<>"')\]]+[^\s<>"')\].,;:!?]/g;

  // FIX (Gemini): gdy <a href> sąsiaduje bez spacji z następnym słowem, textContent
  // skleja je: ".../auto" + "Uwaga" → ".../autoUwaga". Odcinamy doklejony ogon.
  function cleanUrl(url) {
    let u = url;
    // 1. Po rozszerzeniu pliku ucinamy doklejony ogon. Ogon MUSI zaczynać się wielką
    //    literą (sklejki to CamelCase/skróty: .htmlLG, .htmlHugging, .pdfE), więc czyste
    //    ".../linear_model.html" (małe l) NIE jest ruszane. Rozszerzenia bez opcjonalności.
    u = u.replace(/(\.(?:html|htm|pdf|php|aspx|asp|jsp|xml|json))[A-ZŁŚŻ][A-Za-zŁŚŻąćęłńóśźż]*$/, "$1");
    // 2. Doklejony wyraz z Wielką literą po ścieżce — ale NIE, gdy URL kończy się
    //    rozszerzeniem pliku (żeby nie uciąć ".../linear_model.html" → ".htm").
    if (!/\.(?:html?|pdf|php|aspx?|jsp|xml|json)$/i.test(u)) {
      const m = u.match(/^(.*?[a-z0-9\/])[A-ZŁŚŻ][a-ząćęłńóśźż]{2,}$/);
      if (m && m[1].length > 12) u = m[1];
    }
    return u;
  }

  // Domeny, których nie ma sensu sprawdzać (sam interfejs czatu, nie cytowane źródła)
  const IGNORED_HOSTS = new Set([
    "chatgpt.com", "chat.openai.com", "openai.com",
    "gemini.google.com", "google.com", "gstatic.com",
    "claude.ai", "anthropic.com",
  ]);

  function extractUrlsWithContext(messageEl) {
    const found = new Map(); // normalizedUrl -> { url, context }

    // Normalizacja do deduplikacji: usuwamy parametry trackujące (utm_*, ref, fbclid...)
    // i końcowy slash. Ten sam artykuł z ?utm_source=chatgpt.com i bez to jeden link.
    function normalize(url) {
      try {
        const u = new URL(url);
        const junk = [...u.searchParams.keys()].filter(
          k => /^utm_/i.test(k) || ["ref", "fbclid", "gclid", "source"].includes(k.toLowerCase())
        );
        junk.forEach(k => u.searchParams.delete(k));
        let s = u.toString().replace(/\?$/, "");
        return s.replace(/\/$/, "");
      } catch { return url; }
    }

    function add(url, context) {
      const key = normalize(url);
      if (!found.has(key)) found.set(key, { url, context });
    }

    // 1. Linki <a href> — kontekst = akapit/element, w którym link siedzi.
    messageEl.querySelectorAll("a[href^='http']").forEach(a => {
      const url = a.href;
      try {
        if (IGNORED_HOSTS.has(new URL(url).hostname.replace(/^www\./, ""))) return;
      } catch { return; }
      const container = a.closest("p, li, td, h1, h2, h3, blockquote") || a.parentElement;
      const context = (container?.textContent || a.textContent || "").slice(0, 400);
      add(url, context);
    });

    // 2. Gołe URL-e w tekście (AI często pisze linki bez <a>).
    const fullText = messageEl.textContent || "";
    let m;
    while ((m = URL_REGEX.exec(fullText)) !== null) {
      const url = cleanUrl(m[0]);   // usuń ewentualny doklejony ogon
      try {
        if (IGNORED_HOSTS.has(new URL(url).hostname.replace(/^www\./, ""))) continue;
      } catch { continue; }
      // Kontekst = 200 znaków przed i po URL-u.
      const start = Math.max(0, m.index - 200);
      const context = fullText.slice(start, m.index + url.length + 200);
      add(url, context);
    }

    return [...found.values()].map(({ url, context }) => ({ url, context }));
  }

  // ---------- UI: przycisk ----------

  function addButtonTo(messageEl) {
    if (messageEl.hasAttribute(PROCESSED_ATTR)) return;
    messageEl.setAttribute(PROCESSED_ATTR, "1");

    const btn = document.createElement("button");
    btn.className = BTN_CLASS;
    btn.type = "button";
    btn.textContent = "⛨ Verify sources";
    btn.title = "Check whether the links in this answer actually exist (runs 100% locally)";

    btn.addEventListener("click", () => onVerifyClick(messageEl, btn));
    messageEl.appendChild(btn);
  }

  function onVerifyClick(messageEl, btn) {
    const items = extractUrlsWithContext(messageEl);

    // Usuń poprzedni raport dla tej wiadomości, jeśli był.
    messageEl.querySelectorAll("." + REPORT_CLASS).forEach(el => el.remove());

    const report = document.createElement("div");
    report.className = REPORT_CLASS;
    messageEl.appendChild(report);

    if (items.length === 0) {
      report.innerHTML = `<div class="sc-empty">No links found in this answer. SourceCheck verifies URLs — answers without links can't be checked automatically.</div>`;
      return;
    }

    const requestId = "req-" + (++requestCounter);
    activeReports.set(requestId, report);

    report.innerHTML = `
      <div class="sc-header">
        <span class="sc-title">Checking ${items.length} source${items.length > 1 ? "s" : ""}…</span>
        <span class="sc-progress">0/${items.length}</span>
      </div>
      <ul class="sc-list"></ul>
      <div class="sc-summary" hidden></div>
      <div class="sc-footer">All checks run locally in your browser. Nothing is sent to any server.</div>
    `;

    btn.disabled = true;
    btn.textContent = "Checking…";

    chrome.runtime.sendMessage(
      { type: "SOURCECHECK_VERIFY", requestId, items },
      () => {
        // Po zakończeniu (SOURCECHECK_DONE) przycisk odblokuje handler poniżej —
        // tu tylko zabezpieczenie na wypadek błędu wysyłki.
        if (chrome.runtime.lastError) {
          btn.disabled = false;
          btn.textContent = "⛨ Verify sources";
          report.innerHTML = `<div class="sc-empty">Extension error: ${chrome.runtime.lastError.message}. Try reloading the page.</div>`;
        }
      }
    );

    // Odblokowanie przycisku po zakończeniu obsługuje listener SOURCECHECK_DONE;
    // zapamiętujemy przycisk na raporcie.
    report._btn = btn;
  }

  // ---------- UI: wyniki ----------

  const STATUS_META = {
    ok:       { icon: "✅", label: "OK" },
    mismatch: { icon: "⚠️", label: "Content mismatch" },
    dead:     { icon: "❌", label: "Dead link" },
    blocked:  { icon: "🔒", label: "Can't verify" },
    unknown:  { icon: "❔", label: "Unknown" },
  };

  function renderResult(report, result) {
    const list = report.querySelector(".sc-list");
    if (!list) return;
    const meta = STATUS_META[result.status] || STATUS_META.unknown;

    const li = document.createElement("li");
    li.className = "sc-item sc-" + result.status;
    li.innerHTML = `
      <span class="sc-icon">${meta.icon}</span>
      <div class="sc-body">
        <a class="sc-url" href="${escapeHtml(result.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(shortenUrl(result.url))}</a>
        ${result.pageTitle ? `<div class="sc-pagetitle">${escapeHtml(result.pageTitle)}</div>` : ""}
        <div class="sc-note">${escapeHtml(result.note)}</div>
      </div>
    `;
    list.appendChild(li);
  }

  function renderSummary(report, results) {
    const counts = { ok: 0, mismatch: 0, dead: 0, blocked: 0, unknown: 0 };
    results.forEach(r => { counts[r.status] = (counts[r.status] || 0) + 1; });

    const header = report.querySelector(".sc-title");
    if (header) header.textContent = "Source check complete";
    const progress = report.querySelector(".sc-progress");
    if (progress) progress.remove();

    const summary = report.querySelector(".sc-summary");
    if (summary) {
      summary.hidden = false;
      const parts = [];
      if (counts.ok) parts.push(`✅ ${counts.ok} verified`);
      if (counts.mismatch) parts.push(`⚠️ ${counts.mismatch} mismatch`);
      if (counts.dead) parts.push(`❌ ${counts.dead} dead`);
      if (counts.blocked) parts.push(`🔒 ${counts.blocked} unverifiable`);
      summary.textContent = parts.join("  ·  ");
    }

    if (report._btn) {
      report._btn.disabled = false;
      report._btn.textContent = "⛨ Verify sources";
    }
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "SOURCECHECK_PROGRESS") {
      const report = activeReports.get(message.requestId);
      if (!report || !report.isConnected) return;
      renderResult(report, message.result);
      const progress = report.querySelector(".sc-progress");
      if (progress) progress.textContent = `${message.done}/${message.total}`;
    }
    if (message?.type === "SOURCECHECK_DONE") {
      const report = activeReports.get(message.requestId);
      if (!report || !report.isConnected) return;
      renderSummary(report, message.results);
      activeReports.delete(message.requestId);
    }
  });

  // ---------- pomocnicze ----------

  function shortenUrl(url) {
    return url.length > 80 ? url.slice(0, 77) + "…" : url;
  }

  function escapeHtml(s) {
    const div = document.createElement("div");
    div.textContent = s ?? "";
    return div.innerHTML;
  }

  // ---------- obserwacja DOM (nowe odpowiedzi pojawiają się dynamicznie) ----------

  function scan() {
    const all = [...document.querySelectorAll(ASSISTANT_SELECTOR)];
    // Gemini/Claude zagnieżdżają pasujące elementy jeden w drugim → ten sam
    // dymek trafiałby wielokrotnie. Bierzemy tylko NAJBARDZIEJ ZEWNĘTRZNY:
    // pomijamy element, jeśli któryś inny trafiony element go zawiera.
    const outermost = all.filter(el => !all.some(other => other !== el && other.contains(el)));
    outermost.forEach(addButtonTo);
  }

  const observer = new MutationObserver(() => {
    // Debounce: ChatGPT streamuje tokeny, mutacje lecą setkami — skanujemy max co 800ms.
    if (observer._t) return;
    observer._t = setTimeout(() => {
      observer._t = null;
      scan();
    }, 800);
  });

  observer.observe(document.body, { childList: true, subtree: true });
  scan();
})();
