// SourceCheck: where the answers are, per chat provider.
//
// Pure DOM logic with no chrome.* calls and no network. For each assistant
// answer it returns two things, which are deliberately separate:
//
//   extractionRoot : the element whose links are verified (one answer)
//   insertion      : { parent, before } where the button and report go
//
// The rules differ per provider because their DOM differs, so there is no
// global "outermost" or "innermost" choice. Provider markup changes without
// notice; these rules follow the structures seen in real pages when they were
// written and are not guaranteed to match the current production sites.
//
// It works on real DOM nodes and on plain test objects (nodeType, tagName,
// className, childNodes, parentElement, getAttribute).

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.SourceCheckLib = Object.assign(root.SourceCheckLib || {}, api);
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const urls =
    typeof require === "function" && typeof module === "object" ? require("./urls.js") : globalThis.SourceCheckLib;
  const { tagOf, classOf, isSourceCheckUi, isSkipped } = urls;

  // Rendered block elements of an answer. Used to find the content flow in Gemini.
  const BLOCK_TAGS = new Set(["P", "UL", "OL", "PRE", "TABLE", "BLOCKQUOTE", "H1", "H2", "H3", "H4", "H5", "H6", "HR"]);
  const MAX_FLOW_DEPTH = 12;

  function attr(el, name) {
    return typeof el.getAttribute === "function" ? el.getAttribute(name) : null;
  }

  function hasClass(el, name) {
    return (" " + classOf(el).split(/\s+/).join(" ") + " ").includes(" " + name + " ");
  }

  function elementChildren(el) {
    return [...(el.childNodes || [])].filter((n) => n.nodeType === 1);
  }

  function isInside(el, ancestor) {
    for (let p = el.parentElement; p; p = p.parentElement) if (p === ancestor) return true;
    return false;
  }

  function hasAncestor(el, test) {
    for (let p = el.parentElement; p; p = p.parentElement) if (test(p)) return true;
    return false;
  }

  // Keeps only elements that do not sit inside another element of the list.
  function outermost(list) {
    return list.filter((el) => !list.some((other) => other !== el && isInside(el, other)));
  }

  // Elements below `root` that satisfy spec.test. In a browser the candidates
  // come from a native querySelectorAll(spec.css) prefilter (css must match at
  // least everything test accepts). Objects without querySelectorAll, as used in
  // the Node tests, are walked instead. The decision is always spec.test.
  function queryAll(rootEl, spec) {
    let all;
    if (typeof rootEl.querySelectorAll === "function") {
      all = [...rootEl.querySelectorAll(spec.css)];
    } else {
      all = [];
      (function walk(n) {
        for (const c of n.childNodes || []) {
          if (c.nodeType !== 1 || isSourceCheckUi(c)) continue;
          all.push(c);
          walk(c);
        }
      })(rootEl);
    }
    return all.filter((el) => !isSourceCheckUi(el) && spec.test(el));
  }

  function appendTo(el) {
    return { parent: el, before: null };
  }

  // ---------- ChatGPT ----------
  // Current DOM: the answer text is a [data-markdown-text-style="assistant-message"]
  // element inside a turn wrapper whose data-content-search-unit-key (or
  // data-chatgpt-search-unit-key) ends in ":assistant". The older
  // [data-message-author-role="assistant"] attribute is only a fallback for
  // when no current-style element exists on the page.

  const CHATGPT_PRIMARY = {
    css: "[data-markdown-text-style]",
    test: (el) => attr(el, "data-markdown-text-style") === "assistant-message",
  };
  const CHATGPT_FALLBACK = {
    css: "[data-message-author-role]",
    test: (el) => attr(el, "data-message-author-role") === "assistant",
  };

  function chatgptTurnKey(el) {
    for (let p = el; p; p = p.parentElement) {
      const key = attr(p, "data-content-search-unit-key") || attr(p, "data-chatgpt-search-unit-key");
      if (key) return key;
    }
    return null;
  }

  // When a turn key is visible it must say "assistant". No key at all is accepted:
  // the element's own attribute already names it an assistant message.
  function inAssistantTurn(el) {
    const key = chatgptTurnKey(el);
    return key === null || /:assistant$/.test(key);
  }

  function chatgptTargets(rootEl) {
    let found = outermost(queryAll(rootEl, CHATGPT_PRIMARY).filter(inAssistantTurn));
    if (found.length === 0) found = outermost(queryAll(rootEl, CHATGPT_FALLBACK).filter(inAssistantTurn));
    return found.map((el) => ({ extractionRoot: el, insertion: appendTo(el) }));
  }

  // ---------- Gemini ----------
  // One <message-content> is one model answer. It is the right place to read
  // links from but not the right place to put UI: it and its wrappers are
  // full-width layout boxes. The UI goes into the content flow inside it: the
  // shallowest descendant that has rendered blocks (p, ul, ol, ...) as direct
  // children, right after the last element of that flow.

  const inUserQuery = (el) => hasAncestor(el, (p) => tagOf(p) === "USER-QUERY");
  const GEMINI_PRIMARY = {
    css: "message-content",
    test: (el) => tagOf(el) === "MESSAGE-CONTENT" && !inUserQuery(el),
  };
  const GEMINI_FALLBACK = {
    css: ".model-response-text",
    test: (el) => hasClass(el, "model-response-text") && !inUserQuery(el),
  };

  function geminiFlow(rootEl) {
    let level = [rootEl];
    for (let depth = 0; level.length && depth < MAX_FLOW_DEPTH; depth++) {
      const next = [];
      for (const node of level) {
        const kids = elementChildren(node).filter((c) => !isSkipped(c));
        if (kids.some((k) => BLOCK_TAGS.has(tagOf(k)))) return { parent: node, kids };
        next.push(...kids);
      }
      level = next;
    }
    return null;
  }

  // Gemini gets a slot: one wrapper element that holds both the button and the
  // report, so they are a single item in the content flow. Without it, a flow that
  // is a grid or flex container would lay the button and the report out as
  // separate items, in different columns. `anchor` is the last content element of
  // the flow; the slot takes the same grid column as that block (see slotGridColumn).
  function geminiInsertion(rootEl) {
    const flow = geminiFlow(rootEl);
    if (!flow) return { parent: rootEl, before: null, anchor: null, slot: true }; // no rendered blocks found: conservative fallback
    const last = flow.kids[flow.kids.length - 1];
    const siblings = elementChildren(flow.parent);
    let before = null;
    for (let i = siblings.indexOf(last) + 1; i < siblings.length; i++) {
      if (!isSourceCheckUi(siblings[i])) {
        before = siblings[i];
        break;
      }
    }
    return { parent: flow.parent, before, anchor: last, slot: true };
  }

  // In a grid, an element with no explicit column goes into the first free cell,
  // which is usually the gutter. The slot must instead sit in the column the
  // content blocks use, so it copies the anchor block's own computed placement.
  // Returns { start, end } for a grid parent, or null when there is nothing to copy
  // (not a grid, or no anchor). Nothing here is a fixed offset or width.
  function slotGridColumn(parentDisplay, anchorStyle) {
    if (!anchorStyle || (parentDisplay !== "grid" && parentDisplay !== "inline-grid")) return null;
    return { start: anchorStyle.gridColumnStart || "auto", end: anchorStyle.gridColumnEnd || "auto" };
  }

  function geminiTargets(rootEl) {
    let found = outermost(queryAll(rootEl, GEMINI_PRIMARY));
    if (found.length === 0) found = outermost(queryAll(rootEl, GEMINI_FALLBACK));
    return found.map((el) => ({ extractionRoot: el, insertion: geminiInsertion(el) }));
  }

  // ---------- Claude ----------
  // Unchanged from the version that works: the outermost matching element is
  // both the extraction root and the place the UI is appended.

  const CLAUDE = {
    css: "[data-testid='chat-message-content'], div[class*='font-claude']",
    test: (el) =>
      attr(el, "data-testid") === "chat-message-content" || (tagOf(el) === "DIV" && classOf(el).includes("font-claude")),
  };

  function claudeTargets(rootEl) {
    return outermost(queryAll(rootEl, CLAUDE)).map((el) => ({ extractionRoot: el, insertion: appendTo(el) }));
  }

  // ---------- public ----------

  function providerForHost(hostname) {
    const h = String(hostname || "").toLowerCase();
    if (h.includes("gemini.google.com")) return "gemini";
    if (h.includes("claude.ai")) return "claude";
    return "chatgpt";
  }

  // Returns [{ provider, extractionRoot, insertion }], one per assistant answer
  // found below `rootEl`, in document order. insertion is { parent, before }, plus
  // { slot: true, anchor } for Gemini. `before` is the element the UI must sit
  // directly in front of, or null to append to `parent`.
  // SourceCheck's own button and report are ignored when computing it, so the
  // result is the same with or without them in place.
  function findAssistantTargets(rootEl, hostname) {
    const provider = providerForHost(hostname);
    const finder = { chatgpt: chatgptTargets, gemini: geminiTargets, claude: claudeTargets }[provider];
    return finder(rootEl).map((t) => ({ provider, ...t }));
  }

  return { findAssistantTargets, providerForHost, slotGridColumn, BLOCK_TAGS };
});
