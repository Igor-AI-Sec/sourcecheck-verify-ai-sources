// SourceCheck: content script (ChatGPT, Claude, Gemini).
// Finds assistant answers in the page, adds a "Verify sources" button, collects
// the links and the text around them, and draws the report. Link extraction
// lives in lib/urls.js (loaded first).

(() => {
  "use strict";

  const lib = globalThis.SourceCheckLib;
  if (!lib || !lib.collectItems || !lib.findAssistantTargets || !lib.slotGridColumn) return;

  // Which element is an assistant answer, and where the UI goes, is decided per
  // provider in lib/providers.js (loaded before this file). Provider markup
  // changes without notice, so that logic is not guaranteed to match the
  // current production pages.
  const HOST = location.hostname;

  const BTN_CLASS = "sourcecheck-btn";
  const REPORT_CLASS = "sourcecheck-report";
  const SLOT_CLASS = "sourcecheck-slot";
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

  // Makes sure one answer has exactly one button in the right place. `target` is
  // { extractionRoot, insertion: { parent, before } } from findAssistantTargets().
  // The button itself is the marker: if the page re-renders the answer and the
  // button disappears, the next scan adds a new one. If streaming content pushes
  // the button away from its place, the next scan moves it (and its report) back.
  function ensureUi(target) {
    const root = target.extractionRoot;
    const { parent, before } = target.insertion;

    let btn = root.querySelector("." + BTN_CLASS);
    if (!btn) {
      btn = el("button", BTN_CLASS, "⛨ Verify sources");
      btn.type = "button";
      btn.title = "Check whether the links in this answer respond. Requests go directly from your browser to each site.";
      btn.addEventListener("click", () => onVerifyClick(root, btn));
    }
    const report = root.querySelector("." + REPORT_CLASS);

    if (target.insertion.slot) {
      placeInSlot(target, btn, report);
      return;
    }

    const last = report || btn;
    const inPlace =
      btn.parentElement === parent && last.nextElementSibling === before && (!report || btn.nextElementSibling === report);
    if (inPlace) return;
    parent.insertBefore(btn, before);
    if (report) parent.insertBefore(report, before);
  }

  // Slot mode (Gemini): the button and the report live together in one wrapper
  // element, so they are a single item in the page's content flow and always share
  // its column. The wrapper takes the same grid column as the last content block.
  function placeInSlot(target, btn, report) {
    const { parent, before, anchor } = target.insertion;
    let slot = target.extractionRoot.querySelector("." + SLOT_CLASS);
    if (!slot) slot = el("div", SLOT_CLASS);

    if (btn.parentElement !== slot) slot.insertBefore(btn, slot.firstChild);
    if (report && (report.parentElement !== slot || btn.nextElementSibling !== report)) slot.insertBefore(report, btn.nextSibling);

    const column = anchor ? lib.slotGridColumn(getComputedStyle(parent).display, getComputedStyle(anchor)) : null;
    if (column) {
      slot.style.gridColumnStart = column.start;
      slot.style.gridColumnEnd = column.end;
    } else {
      slot.style.removeProperty("grid-column-start");
      slot.style.removeProperty("grid-column-end");
    }

    if (slot.parentElement !== parent || slot.nextElementSibling !== before) parent.insertBefore(slot, before);
  }

  // `root` is the answer's extraction root: links are read only from inside it.
  function onVerifyClick(root, btn) {
    // Drop any earlier report first. collectItems() also ignores SourceCheck's
    // own button and report, so they can never become input to a new run.
    root.querySelectorAll("." + REPORT_CLASS).forEach((n) => n.remove());
    const items = lib.collectItems(root);

    const report = el("div", REPORT_CLASS);
    btn.after(report);

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
    lib.findAssistantTargets(document.body, HOST).forEach(ensureUi);
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
