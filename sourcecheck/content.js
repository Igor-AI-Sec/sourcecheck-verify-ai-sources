// SourceCheck: content script (ChatGPT, Claude, Gemini).
// Finds assistant answers in the page, adds a "Verify sources" button, collects
// the links and the text around them, and draws the report. Link extraction
// lives in lib/urls.js (loaded first).

(() => {
  "use strict";

  const lib = globalThis.SourceCheckLib;
  if (!lib || !lib.collectItems) return;

  // Each chat site has its own DOM. The assistant-message selector is picked by
  // host. Semantic attributes are preferred over CSS class names, but provider
  // markup changes without notice, so these selectors are not guaranteed to
  // match the current production pages.
  const HOST = location.hostname;

  let ASSISTANT_SELECTOR;
  if (HOST.includes("gemini.google.com")) {
    ASSISTANT_SELECTOR = "message-content, .model-response-text, [class*='response-container-content']";
  } else if (HOST.includes("claude.ai")) {
    ASSISTANT_SELECTOR = "[data-testid='chat-message-content'], div[class*='font-claude']";
  } else {
    ASSISTANT_SELECTOR = '[data-message-author-role="assistant"]';
  }

  const BTN_CLASS = "sourcecheck-btn";
  const REPORT_CLASS = "sourcecheck-report";
  const WATCHDOG_MS = 90000; // re-enable the button if the worker never answers

  let requestCounter = 0;
  const activeReports = new Map(); // requestId -> report element

  // Forgets a request and stops its watchdog. Returns the report if the request
  // was still active. Always called first on DONE, error and timeout, whether or
  // not the page has removed the report element in the meantime.
  function closeRequest(requestId) {
    const report = activeReports.get(requestId);
    activeReports.delete(requestId);
    if (report) clearTimeout(report._watchdog);
    return report;
  }

  function el(tag, className, text) {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text != null) e.textContent = text;
    return e;
  }

  // ---------- button ----------

  function addButtonTo(messageEl) {
    // The button itself is the marker. If the page re-renders the answer and the
    // button disappears, the next scan adds a new one.
    if (messageEl.querySelector("." + BTN_CLASS)) return;

    const btn = el("button", BTN_CLASS, "⛨ Verify sources");
    btn.type = "button";
    btn.title = "Check whether the links in this answer respond. Requests go directly from your browser to each site.";
    btn.addEventListener("click", () => onVerifyClick(messageEl, btn));
    messageEl.appendChild(btn);
  }

  function onVerifyClick(messageEl, btn) {
    // Drop any earlier report first. collectItems() also ignores SourceCheck's
    // own button and report, so they can never become input to a new run.
    messageEl.querySelectorAll("." + REPORT_CLASS).forEach((n) => n.remove());
    const items = lib.collectItems(messageEl);

    const report = el("div", REPORT_CLASS);
    messageEl.appendChild(report);

    if (items.length === 0) {
      report.appendChild(
        el("div", "sc-empty", "No links found in this answer. SourceCheck checks URLs, so answers without links cannot be checked automatically.")
      );
      return;
    }

    const requestId = "req-" + ++requestCounter;
    activeReports.set(requestId, report);

    const header = el("div", "sc-header");
    header.appendChild(el("span", "sc-title", `Checking ${items.length} source${items.length > 1 ? "s" : ""}…`));
    header.appendChild(el("span", "sc-progress", `0/${items.length}`));
    report.appendChild(header);
    report.appendChild(el("ul", "sc-list"));
    const summary = el("div", "sc-summary");
    summary.hidden = true;
    report.appendChild(summary);
    report.appendChild(
      el("div", "sc-footer", "SourceCheck has no server and sends no telemetry. Checking a link sends a direct request from your browser to that site.")
    );

    btn.disabled = true;
    btn.textContent = "Checking…";
    report._btn = btn;
    report._watchdog = setTimeout(() => {
      if (!closeRequest(requestId)) return;
      finish(report, "The extension did not answer in time. Try again or reload the page.");
    }, WATCHDOG_MS);

    chrome.runtime.sendMessage({ type: "SOURCECHECK_VERIFY", requestId, items }, (reply) => {
      if (chrome.runtime.lastError) {
        closeRequest(requestId);
        finish(report, `Extension error: ${chrome.runtime.lastError.message}. Try reloading the page.`);
      } else if (!reply || reply.accepted !== true) {
        closeRequest(requestId);
        finish(report, `The request was rejected${reply && reply.error ? ": " + reply.error : "."}`);
      } else {
        const title = report.querySelector(".sc-title");
        if (title && reply.checked < reply.total) {
          title.textContent = `Checking ${reply.checked} of ${reply.total} sources…`;
        }
        const progress = report.querySelector(".sc-progress");
        if (progress) progress.textContent = `0/${reply.checked}`;
      }
    });
  }

  // Ends a run: stops the watchdog, re-enables the button, shows an optional message.
  function finish(report, message) {
    clearTimeout(report._watchdog);
    const title = report.querySelector(".sc-title");
    if (title) title.textContent = message ? "Source check stopped" : "Source check complete";
    const progress = report.querySelector(".sc-progress");
    if (progress) progress.remove();
    if (message) report.appendChild(el("div", "sc-empty", message));
    if (report._btn) {
      report._btn.disabled = false;
      report._btn.textContent = "⛨ Verify sources";
    }
  }

  // ---------- results ----------

  const STATUS_META = {
    ok:           { icon: "✅", label: "OK" },
    mismatch:     { icon: "⚠️", label: "Low keyword overlap" },
    dead:         { icon: "❌", label: "Not found" },
    unverifiable: { icon: "🔒", label: "Can't verify" },
  };

  function shortenUrl(url) {
    return url.length > 80 ? url.slice(0, 77) + "…" : url;
  }

  function renderResult(report, result) {
    const list = report.querySelector(".sc-list");
    if (!list) return;
    const status = STATUS_META[result.status] ? result.status : "unverifiable";

    const li = el("li", "sc-item sc-" + status);
    li.appendChild(el("span", "sc-icon", STATUS_META[status].icon));
    const body = el("div", "sc-body");
    const link = el("a", "sc-url", shortenUrl(String(result.url)));
    if (result.linkable !== false && lib.parseHttpUrl(result.url)) {
      link.href = result.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    }
    body.appendChild(link);
    if (result.pageTitle) body.appendChild(el("div", "sc-pagetitle", result.pageTitle));
    body.appendChild(el("div", "sc-note", result.note));
    li.appendChild(body);
    list.appendChild(li);
  }

  function renderSummary(report, data) {
    const counts = { ok: 0, mismatch: 0, dead: 0, unverifiable: 0 };
    data.results.forEach((r) => {
      counts[STATUS_META[r.status] ? r.status : "unverifiable"]++;
    });

    const parts = [];
    if (counts.ok) parts.push(`✅ ${counts.ok} ok`);
    if (counts.mismatch) parts.push(`⚠️ ${counts.mismatch} low overlap`);
    if (counts.dead) parts.push(`❌ ${counts.dead} not found`);
    if (counts.unverifiable) parts.push(`🔒 ${counts.unverifiable} unverifiable`);

    const summary = report.querySelector(".sc-summary");
    if (summary) {
      summary.hidden = false;
      summary.textContent = parts.join("  ·  ");
    }

    const skipped = data.skipped || [];
    if (skipped.length) {
      const box = el(
        "div",
        "sc-skipped",
        `${skipped.length} of ${data.total} links were not checked because of the per-run limit of ${data.results.length} links:`
      );
      const ul = el("ul", "sc-skipped-list");
      skipped.forEach((u) => ul.appendChild(el("li", null, shortenUrl(String(u)))));
      box.appendChild(ul);
      report.insertBefore(box, report.querySelector(".sc-footer"));
    }

    finish(report, data.error || null);
    if (!data.error) {
      const title = report.querySelector(".sc-title");
      if (title) title.textContent = skipped.length ? "Source check complete (partial)" : "Source check complete";
    }
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (!message) return;
    if (message.type === "SOURCECHECK_PROGRESS") {
      const report = activeReports.get(message.requestId);
      if (!report || !report.isConnected) return;
      renderResult(report, message.result);
      const progress = report.querySelector(".sc-progress");
      if (progress) progress.textContent = `${message.done}/${message.total}`;
    } else if (message.type === "SOURCECHECK_DONE") {
      // Cleanup comes first and does not depend on the report still being in the
      // page: rendering into a detached element is harmless and re-enables the button.
      const report = closeRequest(message.requestId);
      if (!report) return;
      renderSummary(report, message);
    }
  });

  // ---------- watching the page for new answers ----------

  function scan() {
    const all = [...document.querySelectorAll(ASSISTANT_SELECTOR)];
    // Providers nest matching elements, which would add several buttons to one
    // answer. Only the outermost match is used.
    all.filter((n) => !all.some((other) => other !== n && other.contains(n))).forEach(addButtonTo);
  }

  const observer = new MutationObserver(() => {
    // Streaming answers mutate the DOM constantly; scan at most every 800 ms.
    if (observer._t) return;
    observer._t = setTimeout(() => {
      observer._t = null;
      scan();
    }, 800);
  });

  observer.observe(document.body, { childList: true, subtree: true });
  scan();
})();
