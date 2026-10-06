// SourceCheck: keyword-overlap heuristic.
//
// This is a lexical check, not semantic entailment. It asks how many of the
// distinctive words around a citation also appear in the fetched page. It
// cannot see negation, contradiction, paraphrase or meaning, and it compares
// words only (so a Polish or German paragraph is compared to an English page
// mostly through names and numbers).

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.SourceCheckLib = Object.assign(root.SourceCheckLib || {}, api);
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const MAX_KEYWORDS = 12; // keywords taken from the citation context
  const MAX_NUMBERS = 4; // of those, at most this many 3-4 digit numbers
  const MIN_KEYWORDS = 3; // fewer usable keywords: not enough to compare
  const MIN_MATCHES = 2; // absolute minimum number of matching keywords
  const MIN_RATIO = 0.3; // and at least this share of the keywords
  const MIN_PAGE_WORDS = 5; // pages with fewer words (empty or shell HTML) are not compared

  // Small stopword lists. They are deliberately short; this is not NLP.
  const STOPWORDS = new Set(
    (
      // English
      "the a an and or of to in on for with by from at as is are was were be been this that these those it its " +
      "i you he she we they what which who how when where not no yes can could will would should may might " +
      "more most other some such only also just than then so if but about into over under between " +
      "however additionally therefore moreover furthermore here there while many several " +
      // German (articles, conjunctions, common function words)
      "der die das den dem des ein eine einer einem einen eines und oder aber ist sind wird werden wurde wurden " +
      "hat haben hatte nicht kein keine mit von zu zum zur bei nach aus auf für über unter als auch wie dass " +
      "sich es sie er wir ihr im am an um vor bis durch gegen ohne dieser diese dieses nur noch schon sehr " +
      // Polish
      "jest są był była było były nie się na do od po za przez dla jak ale oraz lub czy to ten ta te tym tej " +
      "tego który która które także już tylko bardzo"
    ).split(" ")
  );

  const NAMED_ENTITIES = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
    ndash: "–", mdash: String.fromCharCode(0x2014), hellip: "…", bull: "•", middot: "·",
    lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", laquo: "«", raquo: "»",
    copy: "©", reg: "®", trade: "™",
    auml: "ä", Auml: "Ä", ouml: "ö", Ouml: "Ö", uuml: "ü", Uuml: "Ü", szlig: "ß",
    eacute: "é", egrave: "è", agrave: "à", aacute: "á", ccedil: "ç",
  };

  // Decodes numeric entities (&#252; and &#xFC;) and the limited named-entity
  // table above. Other named entities (for example &euro;) and entities written
  // without a closing semicolon are left as they are. This is not a full HTML
  // entity decoder, and numeric references in the legacy windows-1252 range
  // (128 to 159) are not remapped.
  function decodeEntities(s) {
    return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, body) => {
      if (body[0] === "#") {
        const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
        try {
          return String.fromCodePoint(code);
        } catch {
          return whole;
        }
      }
      return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body) ? NAMED_ENTITIES[body] : whole;
    });
  }

  // Plain-text view of an HTML document for keyword matching.
  function htmlToText(html) {
    const stripped = String(html)
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " ");
    return decodeEntities(stripped).replace(/\s+/g, " ").trim().toLowerCase();
  }

  function extractTitle(html) {
    const m = String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    return m ? decodeEntities(m[1]).replace(/\s+/g, " ").trim() : "";
  }

  // Words are compared in Unicode NFC, so composed and decomposed accents match.
  // There is no stemming or other linguistic normalization.
  function tokenize(s) {
    return String(s)
      .normalize("NFC")
      .replace(/’/g, "'")
      .split(/[^\p{L}\p{N}'-]+/u)
      .map((t) => t.replace(/^[-']+|[-']+$/g, ""))
      .filter(Boolean);
  }

  // Keywords from the text around a citation, strongest first:
  // years/numbers (3-4 digits), then capitalised names and acronyms, then
  // other words of 5+ letters. Capped at MAX_KEYWORDS. `excludeTokens` holds
  // lowercase tokens that must not count as evidence (the link's own host name).
  // Every keyword is a distinct lowercase word: a word seen both capitalised and
  // lowercase counts once, in its strongest category (number, then name, then
  // common word). Numeric ranges such as 1957-1969 are split into their numbers.
  function keywordsFromContext(context, excludeTokens = new Set()) {
    const raw = String(context || "").replace(/https?:\/\/\S+/gi, " ");
    const RANK = { number: 3, proper: 2, common: 1 };
    const kinds = new Map(); // lowercase word -> category, in first-seen order

    const tokens = tokenize(raw).flatMap((t) => (/^\d+(-\d+)+$/.test(t) ? t.split("-") : [t]));
    for (const t of tokens) {
      const lower = t.toLowerCase();
      if (STOPWORDS.has(lower) || excludeTokens.has(lower)) continue;
      const parts = lower.split("-").filter(Boolean);
      if (parts.length > 1 && parts.every((p) => excludeTokens.has(p))) continue;

      let kind = null;
      if (/^\d{3,4}$/.test(t)) kind = "number";
      else if (/^\p{Lu}/u.test(t) && (t.length >= 4 || (t.length >= 3 && t === t.toUpperCase()))) kind = "proper";
      else if (t.length >= 5) kind = "common";
      if (!kind) continue;

      const seen = kinds.get(lower);
      if (!seen || RANK[kind] > RANK[seen]) kinds.set(lower, kind);
    }

    const of = (kind) => [...kinds].filter(([, k]) => k === kind).map(([w]) => w);
    const numbers = of("number");
    const proper = of("proper");
    const common = of("common");

    const strong = [...numbers.slice(0, MAX_NUMBERS), ...proper];
    const keywords = strong.slice(0, MAX_KEYWORDS);
    const strongCount = keywords.length;
    for (const w of common) {
      if (keywords.length >= MAX_KEYWORDS) break;
      keywords.push(w);
    }
    return { keywords, strongCount };
  }

  // Whole-word view of a page: the set of its words and how many words it has.
  // Hyphenated tokens are also indexed by their parts.
  function pageWords(text) {
    const set = new Set();
    const tokens = tokenize(String(text).toLowerCase());
    for (const t of tokens) {
      set.add(t);
      if (t.includes("-")) t.split("-").filter(Boolean).forEach((p) => set.add(p));
    }
    return { set, count: tokens.length };
  }

  function requiredMatches(total) {
    return Math.max(MIN_MATCHES, Math.ceil(MIN_RATIO * total));
  }

  // Compares citation context with page text. Returns
  // { status: "ok" | "mismatch" | "unverifiable", matched, total, note }.
  //   ok            : enough keywords appear on the page
  //   mismatch      : a comparison was possible and too few appear
  //   unverifiable  : not enough usable context to compare
  function assess(context, pageText, excludeTokens) {
    const { keywords, strongCount } = keywordsFromContext(context, excludeTokens);
    const total = keywords.length;
    if (total < MIN_KEYWORDS) {
      return {
        status: "unverifiable",
        matched: [],
        total,
        note: "Page is reachable, but the surrounding text has too few distinctive words to compare, so the content was not checked.",
      };
    }

    const page = pageWords(pageText);
    if (page.count < MIN_PAGE_WORDS) {
      return {
        status: "unverifiable",
        matched: [],
        total,
        note: "Page was reachable, but there was not enough readable content to compare.",
      };
    }

    const matched = keywords.filter((k) => page.set.has(k));
    const needed = requiredMatches(total);
    const shown = (list) => list.slice(0, 5).join(", ") + (list.length > 5 ? ", ..." : "");

    if (matched.length >= needed) {
      return {
        status: "ok",
        matched,
        total,
        note: `Page is reachable and shares ${matched.length} of ${total} keywords with the surrounding text (${shown(matched)}).`,
      };
    }
    if (strongCount === 0) {
      return {
        status: "unverifiable",
        matched,
        total,
        note: "Page is reachable, but the surrounding text has no names or numbers, so a word comparison is not reliable (it may be written in another language than the page).",
      };
    }
    return {
      status: "mismatch",
      matched,
      total,
      note: `Page is reachable, but only ${matched.length} of ${total} keywords from the surrounding text appear on it (${needed} needed). This is a keyword-overlap heuristic, not a judgment of the claim. Checked: ${shown(keywords)}.`,
    };
  }

  return {
    MAX_KEYWORDS,
    MIN_KEYWORDS,
    MIN_MATCHES,
    MIN_RATIO,
    MIN_PAGE_WORDS,
    decodeEntities,
    htmlToText,
    extractTitle,
    keywordsFromContext,
    requiredMatches,
    assess,
  };
});
