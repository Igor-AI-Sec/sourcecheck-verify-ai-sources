// SourceCheck – background service worker
// Zadanie: dostaje listę URL-i z content scriptu, sprawdza każdy i odsyła wyniki.
// Wszystko dzieje się lokalnie w przeglądarce użytkownika. Zero serwera, zero telemetrii.

const TIMEOUT_MS = 8000;      // max czas na jeden link
const MAX_CONCURRENT = 4;     // ile linków sprawdzamy równolegle
const MAX_URLS = 15;          // twardy limit na jedno kliknięcie "Verify"
const MAX_BODY_CHARS = 200000; // ile znaków HTML czytamy do dopasowania treści

// ---------- pomocnicze ----------

function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  return fetch(url, {
    ...options,
    signal: controller.signal,
    redirect: "follow",
    // credentials: 'omit' — nie wysyłamy ciasteczek użytkownika na sprawdzane strony
    credentials: "omit",
  }).finally(() => clearTimeout(timer));
}

// Bardzo prosty ekstraktor tekstu z HTML (bez DOM w service workerze).
function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

function extractTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeEntities(m[1]).replace(/\s+/g, " ").trim() : "";
}

// Słowa kluczowe z kontekstu, w jakim AI zacytowało link (tekst wokół linku).
// Odsiewamy krótkie słowa i typowe wypełniacze — zostają rzeczowniki/nazwy.
const STOPWORDS = new Set(
  ("the a an and or of to in on for with by from at as is are was were be been this that these those it its " +
   "i you he she we they what which who how when where not no yes can could will would should may might " +
   "more most other some such only also just than then so if but about into over under between").split(" ")
);

// KLUCZOWA POPRAWKA (test z 04.07): użytkownik pyta po polsku, strona jest po
// angielsku → zwykłe słowa nigdy się nie pokryją i prawdziwe linki dostają ⚠️.
// Rozwiązanie: nazwy własne (Sputnik, NASA, Apollo) i liczby (1957) wyglądają
// tak samo w każdym języku. Priorytet: nazwy własne + liczby; zwykłe słowa
// tylko jako uzupełnienie, gdy nazw własnych jest za mało.
function keywordsFromContext(context) {
  const raw = (context || "").replace(/https?:\/\/\S+/g, " ");
  const tokens = raw.split(/[^\p{L}\p{N}''-]+/u).filter(Boolean);

  const proper = new Set();
  const numbers = new Set();
  const common = new Set();

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const lower = t.toLowerCase();
    if (STOPWORDS.has(lower)) continue;

    if (/^\d{3,4}$/.test(t)) {                 // lata i liczby: 1957, 1969
      numbers.add(t);
    } else if (/^\p{Lu}/u.test(t) && t.length >= 3) {
      // Słowo z wielkiej litery. Początek zdania odsiewamy tylko częściowo:
      // jeśli poprzedni token kończył zdanie, i tak bierzemy — lepszy
      // fałszywy kandydat niż zgubiona nazwa własna. Akronimy (NASA) łapią się same.
      proper.add(lower);
    } else if (t.length >= 5) {
      common.add(lower);
    }
  }

  // Nazwy własne i liczby najpierw; zwykłe słowa dopełniają do max 12.
  const primary = [...proper, ...numbers];
  const keywords = primary.slice(0, 12);
  for (const w of common) {
    if (keywords.length >= 12) break;
    keywords.push(w);
  }
  // Ile z listy to "mocne" słowa (językowo-niezależne) — potrzebne do progu oceny.
  return { keywords, strongCount: Math.min(primary.length, 12) };
}

// ---------- sprawdzenie pojedynczego URL ----------

async function checkUrl(item) {
  const { url, context } = item;
  const result = {
    url,
    status: "unknown",   // ok | mismatch | dead | blocked | unknown
    httpStatus: null,
    finalUrl: null,
    pageTitle: "",
    matchedKeywords: [],
    totalKeywords: 0,
    note: "",
  };

  let response;
  try {
    // Od razu GET (HEAD bywa blokowany częściej niż GET i i tak potrzebujemy treści).
    response = await fetchWithTimeout(url, { method: "GET" });
  } catch (err) {
    if (err.name === "AbortError") {
      result.status = "blocked";
      result.note = "Timeout — site did not respond in time. Cannot verify automatically.";
    } else {
      // Błąd sieci: DNS nie istnieje, połączenie odrzucone itp. → najpewniej zmyślony URL.
      result.status = "dead";
      result.note = "Network error — domain may not exist.";
    }
    return result;
  }

  result.httpStatus = response.status;
  result.finalUrl = response.url;

  if (response.status === 404 || response.status === 410) {
    result.status = "dead";
    result.note = `Page not found (HTTP ${response.status}).`;
    return result;
  }

  if (response.status === 403 || response.status === 401 || response.status === 429 || response.status === 503) {
    // Strona istnieje, ale blokuje boty / wymaga logowania. Uczciwie: "nie da się zweryfikować".
    result.status = "blocked";
    result.note = `Site blocked automated access (HTTP ${response.status}). Link exists but content can't be verified.`;
    return result;
  }

  if (!response.ok) {
    result.status = "dead";
    result.note = `HTTP ${response.status}.`;
    return result;
  }

  // Link żyje. Teraz: czy treść pasuje do kontekstu cytowania?
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("html")) {
    // PDF, obrazek itd. — istnieje, ale nie czytamy treści. To wystarczy na "ok".
    result.status = "ok";
    result.note = `Link works (${contentType.split(";")[0] || "non-HTML content"}).`;
    return result;
  }

  let html = "";
  try {
    html = (await response.text()).slice(0, MAX_BODY_CHARS);
  } catch {
    result.status = "ok";
    result.note = "Link works, but page content could not be read.";
    return result;
  }

  result.pageTitle = extractTitle(html);

  // FIX (test użytkownika 04.07): strony antybotowe zwracają HTTP 200 z treścią
  // "udowodnij, że jesteś człowiekiem" (Cloudflare, reCAPTCHA, "checking your browser").
  // Bez tego traktujemy je jak prawdziwą stronę i porównujemy słowa z challenge'm.
  // Wykrywamy po sygnaturach w tytule/treści i oznaczamy uczciwie jako 🔒.
  const titleLc = result.pageTitle.toLowerCase();
  const bodySample = html.slice(0, 5000).toLowerCase();
  const BOT_WALL_SIGNS = [
    "just a moment", "checking your browser", "verify you are human",
    "are you a robot", "captcha", "cf-browser-verification", "cf_chl",
    "enable javascript and cookies", "ddos protection by", "attention required",
    "sprawdzam przeglądarkę", "sprawdzamy, czy nie jesteś botem", "nie jesteś botem",
  ];
  if (BOT_WALL_SIGNS.some(s => titleLc.includes(s) || bodySample.includes(s))) {
    result.status = "blocked";
    result.note = "Site returned a bot-protection / CAPTCHA page. Link exists but content can't be verified.";
    return result;
  }

  // Szukamy słów kluczowych w: treści strony + tytule + samym URL-u
  // (slug typu /dawn-of-the-space-age/ często zawiera nazwy własne).
  const haystack =
    htmlToText(html) + " " +
    titleLc + " " +
    decodeURIComponent(result.finalUrl || url).toLowerCase().replace(/[-_/.]/g, " ");

  // FIX (test 3 użytkownika): "osjournal" z plakietki domeny potwierdziło link
  // do osjournal.org — domena nie może być dowodem na samą siebie.
  // Wykluczamy tokeny nazwy hosta ze słów kluczowych przed dopasowaniem.
  let hostTokens = new Set();
  try {
    hostTokens = new Set(
      new URL(result.finalUrl || url).hostname.toLowerCase()
        .split(/[^a-z0-9]+/).filter(t => t.length >= 3)
    );
  } catch { /* zostaje pusty set */ }

  const extracted = keywordsFromContext(context);
  const keywords = extracted.keywords.filter(k => !hostTokens.has(k.toLowerCase()));
  const removedAsSelfRef = extracted.keywords.length - keywords.length;
  // Jeśli po odsianiu domeny nie zostały żadne "mocne" słowa, traktujemy jak brak nazw.
  const strongCount = Math.max(0, extracted.strongCount - removedAsSelfRef);

  result.totalKeywords = keywords.length;
  result.matchedKeywords = keywords.filter(k => haystack.includes(k.toLowerCase()));

  if (keywords.length === 0) {
    result.status = "ok";
    result.note = removedAsSelfRef > 0
      ? "Link works. Context only mentioned the site's own name, so content match was skipped — check the page title above yourself."
      : "Link works. No context to compare against.";
  } else {
    const matches = result.matchedKeywords.length;
    const ratio = matches / keywords.length;
    // Progi: 2+ trafienia albo 30% listy = OK. Przy różnicy języków czat/strona
    // zwykłe słowa i tak nie trafią, ale nazwy własne (strongCount) powinny.
    if (matches >= 2 || ratio >= 0.3) {
      result.status = "ok";
      result.note = `Link works and content matches context (found: ${result.matchedKeywords.slice(0, 4).join(", ")}${matches > 4 ? "…" : ""}).`;
    } else if (matches === 1) {
      result.status = "ok";
      result.note = `Link works; weak content match (only "${result.matchedKeywords[0]}" found). Worth a quick look.`;
    } else if (strongCount === 0) {
      // Kontekst nie zawierał żadnych nazw własnych ani liczb — nie mamy jak
      // porównać między językami. Uczciwie: nie oceniamy zamiast straszyć ⚠️.
      result.status = "ok";
      result.note = "Link works. Context had no names or numbers to compare, so content match was skipped.";
    } else {
      result.status = "mismatch";
      result.note = `Link works, but none of the key names/terms from the AI's claim appear on the page (checked: ${keywords.slice(0, 5).join(", ")}${keywords.length > 5 ? "…" : ""}).`;
    }
  }
  return result;
}

// ---------- kolejka z limitem równoległości ----------

async function checkAll(items, onProgress) {
  const queue = items.slice(0, MAX_URLS);
  const results = [];
  let index = 0;

  async function worker() {
    while (index < queue.length) {
      const i = index++;
      const res = await checkUrl(queue[i]);
      results[i] = res;
      onProgress(res, results.filter(Boolean).length, queue.length);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(MAX_CONCURRENT, queue.length) }, worker)
  );
  return results;
}

// ---------- komunikacja z content scriptem ----------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "SOURCECHECK_VERIFY") return;

  const tabId = sender.tab?.id;
  const { requestId, items } = message;

  checkAll(items, (result, done, total) => {
    if (tabId != null) {
      chrome.tabs.sendMessage(tabId, {
        type: "SOURCECHECK_PROGRESS",
        requestId, result, done, total,
      }).catch(() => {});
    }
  }).then(results => {
    if (tabId != null) {
      chrome.tabs.sendMessage(tabId, {
        type: "SOURCECHECK_DONE",
        requestId, results,
      }).catch(() => {});
    }
  });

  sendResponse({ accepted: true, count: Math.min(items.length, MAX_URLS) });
  return true;
});
