// SourceCheck: URL extraction, normalization and target validation.
//
// Plain script with no dependencies. It is loaded as a content script (before
// content.js), imported into the service worker with importScripts(), and
// required from the Node tests. It never touches the network.

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.SourceCheckLib = Object.assign(root.SourceCheckLib || {}, api);
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // Hosts of the chat applications themselves. Links to these are interface
  // chrome (share links, citation widgets, account pages), not cited sources.
  //   chatgpt.com, chat.openai.com : ChatGPT (both hosts are in the manifest matches)
  //   gemini.google.com            : Gemini
  //   claude.ai                    : Claude
  // Whole provider domains (openai.com, anthropic.com, google.com) are NOT
  // listed: they can be legitimate cited sources.
  const CHAT_HOSTS = new Set([
    "chatgpt.com",
    "chat.openai.com",
    "gemini.google.com",
    "claude.ai",
  ]);

  const ANCHOR_CONTEXT_CHARS = 400;
  const BARE_CONTEXT_RADIUS = 200;

  function isChatHost(hostname) {
    return CHAT_HOSTS.has(String(hostname || "").toLowerCase());
  }

  // Returns a URL object for http: and https: strings, otherwise null.
  function parseHttpUrl(s) {
    if (typeof s !== "string") return null;
    let u;
    try {
      u = new URL(s.trim());
    } catch {
      return null;
    }
    return u.protocol === "http:" || u.protocol === "https:" ? u : null;
  }

  // ---------- bare URLs inside a single text node ----------

  // Stops at whitespace, angle brackets, double quotes, backticks, the ellipsis
  // character and typographic quotes. Nothing else is guessed about the path.
  const BARE_URL_RE = /https?:\/\/[^\s<>"`…“”‘«»]+/gi;

  function count(s, ch) {
    let n = 0;
    for (const c of s) if (c === ch) n++;
    return n;
  }

  // Removes punctuation that belongs to the surrounding prose, not to the URL:
  // sentence punctuation, markdown emphasis markers, and closing brackets that
  // have no opening bracket inside the URL. Path characters, including digits
  // and capital letters, are never touched.
  function trimProse(s, prevChar) {
    let u = s;
    for (;;) {
      const before = u;
      u = u.replace(/[.,;:!?'’*~]+$/, "");
      if (prevChar === "_") u = u.replace(/_+$/, "");
      for (const [open, close] of [["(", ")"], ["[", "]"], ["{", "}"]]) {
        while (u.endsWith(close) && count(u, close) > count(u, open)) u = u.slice(0, -1);
      }
      if (u === before) return u;
    }
  }

  // Finds URLs in one string. Returns [{ url, index }] with valid http(s) URLs only.
  function extractBareUrls(text) {
    const out = [];
    const src = String(text || "");
    for (const m of src.matchAll(BARE_URL_RE)) {
      // Two URLs written back to back ("a,https://b") are separate URLs.
      const pieces = m[0].split(/(?=https?:\/\/)/i).filter(Boolean);
      let offset = 0;
      pieces.forEach((piece, i) => {
        const prevChar = i === 0 ? src[m.index - 1] || "" : "";
        const cleaned = trimProse(piece, prevChar);
        const u = cleaned ? parseHttpUrl(cleaned) : null;
        if (u) out.push({ url: u.href, index: m.index + offset });
        offset += piece.length;
      });
    }
    return out;
  }

  // ---------- dedupe ----------

  // Key used to decide whether two links are the same link. It removes only the
  // fragment (never sent to a server) and clearly tracking-oriented query
  // parameters: utm_*, fbclid, gclid. Everything else is kept, including
  // ref and source, scheme (http vs https), www, path and trailing slash.
  function normalizeKey(href) {
    try {
      const u = new URL(href);
      u.hash = "";
      const junk = [...u.searchParams.keys()].filter(
        (k) => /^utm_/i.test(k) || ["fbclid", "gclid"].includes(k.toLowerCase())
      );
      if (junk.length) junk.forEach((k) => u.searchParams.delete(k));
      return u.toString().replace(/\?$/, "");
    } catch {
      return String(href);
    }
  }

  // ---------- DOM walking (works on real DOM nodes and on plain test objects) ----------

  const BLOCK_TAGS = new Set(["P", "LI", "TD", "TH", "H1", "H2", "H3", "H4", "BLOCKQUOTE"]);
  const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "TEXTAREA"]);
  const UI_CLASSES = ["sourcecheck-btn", "sourcecheck-report", "sourcecheck-slot"];

  function tagOf(n) {
    return String(n.tagName || "").toUpperCase();
  }

  function classOf(n) {
    const c = n.className;
    if (typeof c === "string") return c;
    if (c && typeof c.baseVal === "string") return c.baseVal;
    return typeof n.getAttribute === "function" ? n.getAttribute("class") || "" : "";
  }

  function isSourceCheckUi(n) {
    const cls = " " + classOf(n).split(/\s+/).join(" ") + " ";
    return UI_CLASSES.some((c) => cls.includes(" " + c + " "));
  }

  function isSkipped(n) {
    return SKIP_TAGS.has(tagOf(n)) || isSourceCheckUi(n);
  }

  // Visible-ish text of a node. Element boundaries become spaces so that
  // neighbouring elements are never glued into one word, and SourceCheck's own
  // UI, scripts and styles are left out. Hidden text (CSS, aria-hidden) is not excluded.
  function textOf(node) {
    const parts = [];
    (function rec(n) {
      if (n.nodeType === 3) {
        parts.push(n.nodeValue || "");
      } else if (n.nodeType === 1 && !isSkipped(n)) {
        parts.push(" ");
        for (const c of n.childNodes || []) rec(c);
        parts.push(" ");
      }
    })(node);
    return parts.join("").replace(/\s+/g, " ").trim();
  }

  function windowAround(text, index, length) {
    const start = Math.max(0, index - BARE_CONTEXT_RADIUS);
    return text.slice(start, index + length + BARE_CONTEXT_RADIUS);
  }

  // Collects { url, context } for every checkable link inside an answer element:
  // <a href> links and bare URLs found one text node at a time. Text inside
  // anchors, SourceCheck's own button/report, scripts and styles is never scanned.
  // Items come in document order and are deduplicated with normalizeKey().
  function collectItems(root) {
    const found = new Map();

    function add(href, context) {
      const key = normalizeKey(href);
      if (!found.has(key)) found.set(key, { url: href, context });
    }

    function nearestBlock(ancestors) {
      for (let i = ancestors.length - 1; i >= 0; i--) {
        if (BLOCK_TAGS.has(tagOf(ancestors[i]))) return ancestors[i];
      }
      return ancestors[ancestors.length - 1];
    }

    function onAnchor(a, ancestors) {
      const u = parseHttpUrl(a.href);
      if (!u || isChatHost(u.hostname)) return;
      const block = nearestBlock(ancestors) || a;
      add(u.href, textOf(block).slice(0, ANCHOR_CONTEXT_CHARS));
    }

    function onText(node, ancestors) {
      const text = node.nodeValue || "";
      const hits = extractBareUrls(text);
      if (!hits.length) return;
      const block = nearestBlock(ancestors);
      const blockText = block ? textOf(block) : text;
      for (const hit of hits) {
        const u = parseHttpUrl(hit.url);
        if (!u || isChatHost(u.hostname)) continue;
        const at = blockText.indexOf(hit.url);
        add(
          u.href,
          at >= 0
            ? windowAround(blockText, at, hit.url.length)
            : windowAround(text, hit.index, hit.url.length)
        );
      }
    }

    const ancestors = [];
    (function visit(node) {
      if (node.nodeType === 3) return onText(node, ancestors);
      if (node.nodeType !== 1 || isSkipped(node)) return;
      if (tagOf(node) === "A") return onAnchor(node, ancestors);
      ancestors.push(node);
      for (const c of node.childNodes || []) visit(c);
      ancestors.pop();
    })(root);

    return [...found.values()];
  }

  // ---------- target validation ----------

  function parseIPv4(h) {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
    if (!m) return null;
    const parts = m.slice(1).map(Number);
    return parts.every((n) => n <= 255) ? parts : null;
  }

  function isBlockedIPv4([a, b]) {
    return (
      a === 0 || // 0.0.0.0/8
      a === 10 || // 10.0.0.0/8
      a === 127 || // loopback
      (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
      (a === 169 && b === 254) || // link-local
      (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
      (a === 192 && b === 168) || // 192.168.0.0/16
      a >= 224 // multicast and reserved
    );
  }

  // Parses a bracket-free IPv6 literal into 8 groups, or null if malformed.
  function parseIPv6(input) {
    let h = input;
    if (!/^[0-9a-f:.]+$/.test(h)) return null;
    if (h.includes(".")) {
      const i = h.lastIndexOf(":");
      const v4 = parseIPv4(h.slice(i + 1));
      if (!v4) return null;
      h = h.slice(0, i + 1) + ((v4[0] << 8) | v4[1]).toString(16) + ":" + ((v4[2] << 8) | v4[3]).toString(16);
    }
    const halves = h.split("::");
    if (halves.length > 2) return null;
    const left = halves[0] ? halves[0].split(":") : [];
    const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
    let groups;
    if (halves.length === 1) {
      groups = left;
    } else {
      const fill = 8 - left.length - right.length;
      if (fill < 1) return null;
      groups = [...left, ...Array(fill).fill("0"), ...right];
    }
    if (groups.length !== 8) return null;
    const nums = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
    return nums.some(Number.isNaN) ? null : nums;
  }

  function isBlockedIPv6(h) {
    const g = parseIPv6(h);
    if (!g) return true; // unparseable: refuse
    if (g.every((x) => x === 0)) return true; // ::
    if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true; // ::1
    if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7
    if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10
    const v4 = [g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255];
    if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return isBlockedIPv4(v4); // ::ffff:a.b.c.d
    if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return isBlockedIPv4(v4); // 64:ff9b::/96
    return false;
  }

  // True for hostnames that are obviously local or private. Hostnames that
  // merely resolve to a private address (DNS rebinding, split-horizon DNS) are
  // NOT detected: this is a literal-name and literal-IP check only.
  function isBlockedHost(hostname) {
    let h = String(hostname || "").toLowerCase();
    if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
    h = h.replace(/\.$/, "");
    if (!h) return true;
    if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
    if (h.includes(":")) return isBlockedIPv6(h);
    const v4 = parseIPv4(h);
    if (v4) return isBlockedIPv4(v4);
    return !h.includes("."); // single-label names such as "router" or "intranet"
  }

  // Decides whether the background worker may fetch this URL.
  function checkTarget(urlString) {
    const u = parseHttpUrl(urlString);
    if (!u) return { ok: false, reason: "Only http and https links can be checked." };
    if (isBlockedHost(u.hostname)) {
      return { ok: false, reason: "Skipped: this link points to a local or private network address." };
    }
    return { ok: true, url: u };
  }

  return {
    CHAT_HOSTS,
    isChatHost,
    parseHttpUrl,
    extractBareUrls,
    normalizeKey,
    textOf,
    tagOf,
    classOf,
    isSourceCheckUi,
    isSkipped,
    collectItems,
    isBlockedHost,
    checkTarget,
  };
});
