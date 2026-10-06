// SourceCheck: link checking and message handling for the background service worker.
//
// createChecker() takes its dependencies (fetch, limits) as options so the
// logic can be tested in Node with a mocked fetch. In the extension,
// background.js wires it to the real fetch and chrome.* APIs.
//
// Statuses
//   ok            reachable HTML page with enough keyword overlap
//   mismatch      reachable HTML page, comparison possible, too little overlap
//   dead          HTTP 404 or 410 only
//   unverifiable  everything else: timeouts, network failures, 401/403/429/451,
//                 5xx and other non-OK responses, bot/challenge pages,
//                 non-HTML content, unreadable body, too little context,
//                 pages with too little readable content, skipped (non-http,
//                 overlong, local or private) targets
//
// Local and private targets: the INITIAL URL is screened before fetching.
// Redirects are followed automatically by the browser, and a service worker
// cannot read a redirect target without following it (redirect: "manual" gives
// an opaque response). A public URL can therefore redirect to a local or
// private address and cause that request to be sent before the final URL is
// visible here. The final URL is screened afterwards and, if it is local or
// private, the response is discarded and nothing from it is read or shown.
// Host names that resolve to private addresses (DNS rebinding) are not detected.

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.SourceCheckLib = Object.assign(root.SourceCheckLib || {}, api);
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const lib =
    typeof require === "function" && typeof module === "object"
      ? Object.assign({}, require("./urls.js"), require("./score.js"))
      : globalThis.SourceCheckLib;

  const DEFAULTS = {
    timeoutMs: 8000, // one budget per link, covering headers AND body
    maxConcurrent: 4, // links checked in parallel
    maxUrls: 15, // links checked per Verify click
    maxBodyBytes: 500000, // stop reading a page after this many bytes
    maxItemsAccepted: 500, // largest batch the worker will accept at all
    maxContextChars: 1000, // context text kept per link
    maxUrlChars: 2048,
  };

  const BOT_WALL_TEXT = [
    "just a moment", "checking your browser", "verify you are human",
    "are you a robot", "captcha", "enable javascript and cookies",
    "ddos protection by", "attention required",
    "sprawdzam przeglądarkę", "sprawdzamy, czy nie jesteś botem", "nie jesteś botem",
  ];
  const BOT_WALL_RAW = ["cf-browser-verification", "cf_chl_opt", "cf_chl"];

  function createChecker(options = {}) {
    const cfg = { ...DEFAULTS, ...options };
    const fetchFn = options.fetch || ((...args) => globalThis.fetch(...args));

    function emptyResult(url) {
      return {
        url,
        linkable: true, // false when `url` is only a truncated label, not a real link
        status: "unverifiable",
        httpStatus: null,
        finalUrl: null,
        pageTitle: "",
        matchedKeywords: [],
        totalKeywords: 0,
        note: "",
      };
    }

    function abortError() {
      const e = new Error("aborted");
      e.name = "AbortError";
      return e;
    }

    // Reads at most maxBodyBytes of the response body and decodes it with the
    // declared (or sniffed) charset. Rejects as soon as the signal aborts, even
    // if the underlying stream never settles.
    async function readBody(response, signal, contentType) {
      const aborted = new Promise((_, reject) => {
        if (signal.aborted) reject(abortError());
        signal.addEventListener("abort", () => reject(abortError()), { once: true });
      });

      const work = (async () => {
        const chunks = [];
        let total = 0;
        if (response.body && typeof response.body.getReader === "function") {
          const reader = response.body.getReader();
          try {
            while (total < cfg.maxBodyBytes) {
              const { done, value } = await reader.read();
              if (done) break;
              chunks.push(value);
              total += value.length;
            }
          } finally {
            try {
              await reader.cancel();
            } catch {
              /* nothing to cancel */
            }
          }
        } else {
          const buf = new Uint8Array(await response.arrayBuffer());
          chunks.push(buf.subarray(0, cfg.maxBodyBytes));
        }
        const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
        let at = 0;
        for (const c of chunks) {
          bytes.set(c, at);
          at += c.length;
        }
        return decodeBytes(bytes.subarray(0, cfg.maxBodyBytes), contentType);
      })();
      work.catch(() => {});
      return Promise.race([work, aborted]);
    }

    function decodeBytes(bytes, contentType) {
      let label = (/charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType) || [])[1];
      if (!label) {
        const head = new TextDecoder("latin1").decode(bytes.subarray(0, 2048));
        label = (/<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(head) || [])[1];
      }
      try {
        return new TextDecoder(label || "utf-8").decode(bytes);
      } catch {
        return new TextDecoder("utf-8").decode(bytes);
      }
    }

    function discardBody(response) {
      try {
        const p = response.body && response.body.cancel && response.body.cancel();
        if (p && p.catch) p.catch(() => {});
      } catch {
        /* best effort */
      }
    }

    function looksLikeBotWall(html, title) {
      const rawHead = html.slice(0, 5000).toLowerCase();
      if (BOT_WALL_RAW.some((s) => rawHead.includes(s))) return true;
      const sample = (title.toLowerCase() + " " + lib.htmlToText(html.slice(0, 40000))).slice(0, 5000);
      return BOT_WALL_TEXT.some((s) => sample.includes(s));
    }

    async function checkOne(item, result) {
      if (item.skipReason) {
        result.linkable = item.linkable !== false;
        result.note = item.skipReason;
        return result;
      }
      const target = lib.checkTarget(item.url);
      if (!target.ok) {
        result.note = target.reason;
        return result;
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
      try {
        let response;
        try {
          response = await fetchFn(item.url, {
            method: "GET",
            signal: controller.signal,
            redirect: "follow",
            credentials: "omit",
            referrerPolicy: "no-referrer",
          });
        } catch (err) {
          if (controller.signal.aborted || (err && err.name === "AbortError")) {
            result.note = "Timeout: the site did not respond in time. Cannot verify automatically.";
          } else {
            result.note =
              "The request failed (DNS, TLS, connection reset, offline or blocked; the cause is not known). Cannot verify automatically.";
          }
          return result;
        }

        result.httpStatus = response.status;
        result.finalUrl = response.url || null;

        // The browser has already followed any redirect, so if the final URL is
        // local or private the request to it was already sent. This only keeps
        // that response from being read or shown; it does not prevent the request.
        if (response.url && !lib.checkTarget(response.url).ok) {
          discardBody(response);
          result.finalUrl = null;
          result.note = "The link redirected to a local or private network address. The response was discarded and its content was not read.";
          return result;
        }

        const s = response.status;
        if (s === 404 || s === 410) {
          discardBody(response);
          result.status = "dead";
          result.note = `Page not found (HTTP ${s}).`;
          return result;
        }
        if (!(s >= 200 && s < 300)) {
          discardBody(response);
          result.note =
            s === 401 || s === 403 || s === 429 || s === 451
              ? `The site refused automated access (HTTP ${s}). The link may exist; content cannot be verified.`
              : s >= 500
                ? `The server returned an error (HTTP ${s}). This may be temporary. Cannot verify.`
                : `Unexpected response (HTTP ${s}). Cannot verify.`;
          return result;
        }

        const contentType = response.headers.get("content-type") || "";
        if (!/html/i.test(contentType)) {
          discardBody(response);
          result.note = `The URL responded (${contentType.split(";")[0] || "no content type"}), but only HTML pages are compared, so the content was not checked.`;
          return result;
        }

        let html;
        try {
          html = await readBody(response, controller.signal, contentType);
        } catch (err) {
          result.note = controller.signal.aborted
            ? "Timeout while reading the page. Cannot verify automatically."
            : "The page content could not be read. Cannot verify automatically.";
          return result;
        }

        result.pageTitle = lib.extractTitle(html);
        if (looksLikeBotWall(html, result.pageTitle)) {
          result.note = "The site returned a bot-protection or CAPTCHA page. Content cannot be verified.";
          return result;
        }

        // Host name words are not evidence about the page itself. The URL path is
        // never used as evidence either: only fetched page text counts.
        let hostTokens = new Set();
        try {
          hostTokens = new Set(
            new URL(result.finalUrl || item.url).hostname.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3)
          );
        } catch {
          /* keep the empty set */
        }

        const verdict = lib.assess(item.context, lib.htmlToText(html), hostTokens);
        result.status = verdict.status;
        result.matchedKeywords = verdict.matched;
        result.totalKeywords = verdict.total;
        result.note = verdict.note;
        return result;
      } finally {
        clearTimeout(timer);
      }
    }

    // Never throws: any unexpected failure becomes an unverifiable result.
    async function checkUrl(item) {
      const url = item && typeof item.url === "string" ? item.url : "";
      const result = emptyResult(url);
      try {
        return await checkOne(
          {
            url,
            context: item && typeof item.context === "string" ? item.context : "",
            skipReason: item && item.skipReason,
            linkable: item && item.linkable,
          },
          result
        );
      } catch {
        result.status = "unverifiable";
        result.note = "The check failed unexpectedly. Cannot verify automatically.";
        return result;
      }
    }

    // Checks the first maxUrls items with limited concurrency. Items beyond the
    // limit are returned in `skipped` so the caller can report them.
    async function checkAll(items, onProgress = () => {}) {
      const queue = items.slice(0, cfg.maxUrls);
      const skipped = items.slice(cfg.maxUrls).map((i) => i.url);
      const results = new Array(queue.length);
      let next = 0;
      let done = 0;

      async function worker() {
        while (next < queue.length) {
          const i = next++;
          let res;
          try {
            res = await checkUrl(queue[i]);
          } catch {
            res = emptyResult(queue[i] && queue[i].url);
            res.note = "The check failed unexpectedly. Cannot verify automatically.";
          }
          results[i] = res;
          done++;
          try {
            onProgress(res, done, queue.length);
          } catch {
            /* a broken progress callback must not stop the run */
          }
        }
      }

      await Promise.all(Array.from({ length: Math.min(cfg.maxConcurrent, queue.length) }, worker));
      return { results, skipped };
    }

    // ---------- message handling ----------

    function validateSender(sender) {
      if (!sender || !sender.tab || typeof sender.tab.id !== "number") return false;
      const u = lib.parseHttpUrl(sender.origin || sender.url || "");
      return !!u && lib.isChatHost(u.hostname);
    }

    function validateVerifyMessage(message, sender) {
      if (!validateSender(sender)) return { ok: false, error: "Message did not come from a supported chat page." };
      if (!message || typeof message.requestId !== "string" || !/^[\w.-]{1,64}$/.test(message.requestId)) {
        return { ok: false, error: "Invalid request id." };
      }
      if (!Array.isArray(message.items)) return { ok: false, error: "Invalid item list." };
      if (message.items.length > cfg.maxItemsAccepted) {
        return { ok: false, error: `Too many links in one request (limit ${cfg.maxItemsAccepted}).` };
      }
      // The envelope above is all-or-nothing. Individual links are not: an entry
      // of the wrong shape means the message itself is malformed, but an empty,
      // overlong, unparseable or unsupported URL only fails that one link.
      const items = [];
      for (const it of message.items) {
        if (!it || typeof it !== "object" || typeof it.url !== "string" || typeof it.context !== "string") {
          return { ok: false, error: "Invalid link entry." };
        }
        const context = it.context.slice(0, cfg.maxContextChars);
        if (it.url.length === 0) {
          items.push({ url: "", context: "", linkable: false, skipReason: "Empty link." });
        } else if (it.url.length > cfg.maxUrlChars) {
          items.push({
            url: it.url.slice(0, 200) + "...",
            context: "",
            linkable: false,
            skipReason: `The link is longer than ${cfg.maxUrlChars} characters and was not checked.`,
          });
        } else {
          items.push({ url: it.url, context });
        }
      }
      return { ok: true, requestId: message.requestId, items };
    }

    function safeSend(send, tabId, msg) {
      try {
        const p = send(tabId, msg);
        if (p && typeof p.catch === "function") p.catch(() => {});
      } catch {
        /* the tab may be gone */
      }
    }

    // Always finishes with exactly one SOURCECHECK_DONE message.
    async function run(requestId, tabId, items, send) {
      let outcome = { results: [], skipped: [] };
      let error = null;
      try {
        outcome = await checkAll(items, (result, done, total) =>
          safeSend(send, tabId, { type: "SOURCECHECK_PROGRESS", requestId, result, done, total })
        );
      } catch {
        error = "The check stopped unexpectedly.";
      }
      safeSend(send, tabId, {
        type: "SOURCECHECK_DONE",
        requestId,
        results: outcome.results.filter(Boolean),
        total: items.length,
        skipped: outcome.skipped,
        error,
      });
    }

    // Returns the immediate reply for sendResponse and starts the async run.
    function handleVerify(message, sender, send) {
      const v = validateVerifyMessage(message, sender);
      if (!v.ok) return { accepted: false, error: v.error };
      run(v.requestId, sender.tab.id, v.items, send).catch(() => {});
      return { accepted: true, checked: Math.min(v.items.length, cfg.maxUrls), total: v.items.length, cap: cfg.maxUrls };
    }

    return { config: cfg, checkUrl, checkAll, validateVerifyMessage, handleVerify };
  }

  return { createChecker, CHECK_DEFAULTS: DEFAULTS };
});
