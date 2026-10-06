"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const score = require("../sourcecheck/lib/score.js");

const verdict = (context, page, exclude) => score.assess(context, score.htmlToText(page), exclude);

test("keywords prefer numbers and names, then longer common words, capped at 12", () => {
  const { keywords, strongCount } = score.keywordsFromContext(
    "Sputnik 1 was launched in 1957 by the Soviet Union, a satellite experiment."
  );
  assert.deepEqual(keywords.slice(0, strongCount).sort(), ["1957", "soviet", "sputnik", "union"]);
  assert.ok(keywords.includes("launched"));
  const many = score.keywordsFromContext(
    "Alpha Bravo Charlie Delta Echo Foxtrot Golf Hotel India Juliet Kilo Lima Mike in 1957"
  );
  assert.equal(many.keywords.length, 12);
  assert.ok(many.keywords.includes("1957"), "a year is not crowded out by names");
});

test("host name words are not evidence", () => {
  const { keywords } = score.keywordsFromContext("Osjournal published Osjournal results", new Set(["osjournal"]));
  assert.ok(!keywords.includes("osjournal"));
});

test("clear support is OK", () => {
  const v = verdict(
    "Sputnik 1 was launched in 1957 by the Soviet Union.",
    "<title>Sputnik</title><p>Sputnik 1 launched in 1957. The Soviet Union built it.</p>"
  );
  assert.equal(v.status, "ok");
});

test("an unrelated page is a mismatch", () => {
  const v = verdict(
    "Sputnik 1 was launched in 1957 by the Soviet Union.",
    "<title>Pasta</title><p>Boil water, add salt and cook the spaghetti for ten minutes.</p>"
  );
  assert.equal(v.status, "mismatch");
  assert.match(v.note, /heuristic/);
});

test("one weak keyword hit is not automatically OK", () => {
  const v = verdict(
    "NASA launched Sputnik in 1957 using Soviet rockets from Baikonur.",
    "<p>This cooking blog mentions NASA once in an unrelated joke.</p>"
  );
  assert.equal(v.matched.length, 1);
  assert.notEqual(v.status, "ok");
  assert.equal(v.status, "mismatch");
});

test("the URL slug cannot make a page OK: only fetched page text counts", () => {
  // A soft 404 that echoes the requested path has no keyword in its own text.
  const page = "<title>404</title><p>Sorry, we could not find that page.</p>";
  const v = score.assess("Sputnik 1957 NASA launch history", score.htmlToText(page), new Set(["example"]));
  assert.notEqual(v.status, "ok");
  assert.deepEqual(v.matched, []);
});

test("too little context is unverifiable, not OK", () => {
  assert.equal(verdict("", "<p>anything</p>").status, "unverifiable");
  assert.equal(verdict("Sputnik", "<p>Sputnik</p>").status, "unverifiable");
});

test("context without names or numbers and no overlap is unverifiable, not a mismatch", () => {
  const v = verdict("the first artificial satellite went into orbit during autumn", "<p>Sputnik orbited Earth.</p>");
  assert.equal(v.status, "unverifiable");
});

test("matching is by whole word, so short fragments do not match inside other words", () => {
  const v = verdict("Act Regarding Zebra Migration Patterns Ahead", "<p>contact exact react under order</p>");
  assert.notEqual(v.status, "ok");
  assert.deepEqual(v.matched, []);
});

test("a keyword that is only a fragment of longer page words does not match", () => {
  const v = verdict(
    "Sputnik Soviet Union 1957 satellite",
    "<p>Sputniks, Sovietization, Unionised workers and satellites in 19570.</p>"
  );
  assert.deepEqual(v.matched, []);
  assert.notEqual(v.status, "ok");
});

test("German context does not trivially pass an unrelated English page", () => {
  const page = "<p>This page sells garden furniture and under-floor heating for every order.</p>";
  for (const ctx of [
    "Der Bundesgerichtshof entschied über Datenschutz und Einwilligung bei Cookies.",
    "Das Urteil betrifft die Haftung der Plattformbetreiber.",
    "Die Entscheidung wurde in Karlsruhe verkündet.",
  ]) {
    assert.notEqual(verdict(ctx, page).status, "ok", ctx);
  }
});

test("German context matches a German page", () => {
  const v = verdict(
    "Der Bundesgerichtshof entschied über Datenschutz und Einwilligung bei Cookies.",
    "<p>Der Bundesgerichtshof hat zu Datenschutz und Einwilligung bei Cookies entschieden.</p>"
  );
  assert.equal(v.status, "ok");
});

test("HTML entities and umlauts in the page are decoded before matching", () => {
  const v = verdict(
    "Fürsorgepflicht Überprüfung Größe Maßnahmen",
    "<p>F&uuml;rsorgepflicht, &Uuml;berpr&uuml;fung, Gr&ouml;&szlig;e und Ma&#223;nahmen</p>"
  );
  assert.equal(v.status, "ok");
  assert.equal(score.extractTitle("<title>Python API &mdash; xgboost&hellip;</title>"), "Python API " + String.fromCharCode(0x2014) + " xgboost" + String.fromCharCode(0x2026));
});

test("script, style and comment text are not page content", () => {
  const text = score.htmlToText("<script>var sputnik=1</script><style>.nasa{}</style><!-- apollo --><p>Hello</p>");
  assert.equal(text, "hello");
});

// Documented limitation: this is word overlap, not meaning.
test("limitation: negation and contradiction pass because the same words appear", () => {
  const v = verdict(
    "NASA did not land Apollo 11 on the Moon in 1969.",
    "<p>NASA landed Apollo 11 on the Moon in 1969.</p>"
  );
  assert.equal(v.status, "ok");
});

test("limitation: a paraphrase with no shared words is a mismatch when names are present", () => {
  const v = verdict(
    "Hubble discovered the expansion of the universe in 1929.",
    "<p>Edwin observed galaxies receding, showing the cosmos grows.</p>"
  );
  assert.equal(v.status, "mismatch");
});

test("keywords are distinct: a word seen capitalised and lowercase counts once", () => {
  assert.deepEqual(score.keywordsFromContext("Union union Quokka").keywords, ["union", "quokka"]);
  // Same word, one lexical item: it must not buy two matches or inflate the denominator.
  const v = verdict("Union union Quokka Narwhal", "<p>the union of workers meets again today</p>");
  assert.equal(v.total, 3);
  assert.deepEqual(v.matched, ["union"]);
  assert.notEqual(v.status, "ok");
});

test("the literal case from the review: 'Union union Quokka' against 'union' is not OK", () => {
  assert.notEqual(verdict("Union union Quokka", "<p>union</p>").status, "ok");
});

test("a repeated name gets no extra credit from a page that has it once", () => {
  const context = "Apollo launches continued. The Apollo programme ended later, apollo fans remain.";
  const { keywords } = score.keywordsFromContext(context);
  assert.equal(new Set(keywords).size, keywords.length, "no duplicates");
  const v = verdict(context, "<p>the apollo era is remembered by many people today</p>");
  assert.deepEqual(v.matched, ["apollo"]);
  assert.notEqual(v.status, "ok");
  assert.equal(v.total, keywords.length);
});

test("a word seen in both forms keeps its strongest category", () => {
  const { keywords, strongCount } = score.keywordsFromContext("later apollo and Apollo");
  assert.deepEqual(keywords, ["apollo", "later"]);
  assert.equal(strongCount, 1);
});

test("MIN_KEYWORDS boundary: 0, 1 and 2 usable keywords are unverifiable, 3 may be compared", () => {
  const page = "<p>Sputnik launched in 1957 by the Soviet Union and orbited the Earth.</p>";
  const cases = [
    ["", 0, "unverifiable"],
    ["Sputnik", 1, "unverifiable"],
    ["Sputnik 1957", 2, "unverifiable"],
    ["Sputnik 1957 Soviet", 3, "ok"],
  ];
  for (const [context, total, status] of cases) {
    const v = verdict(context, page);
    assert.equal(v.total, total, context);
    assert.equal(v.status, status, context);
  }
  assert.equal(score.MIN_KEYWORDS, 3);
  // Three keywords that do not appear on the page is a real comparison and a mismatch.
  assert.equal(verdict("Zebra Quokka Narwhal", page).status, "mismatch");
});

test("composed and decomposed accents match (NFC)", () => {
  const composed = "Fürsorgepflicht Überprüfung Größe";
  const decomposed = composed.normalize("NFD");
  assert.notEqual(composed, decomposed);
  assert.deepEqual(score.keywordsFromContext(decomposed).keywords, score.keywordsFromContext(composed).keywords);
  const pageComposed = "<p>Die Fürsorgepflicht und die Überprüfung der Größe werden jetzt geprüft</p>";
  assert.equal(verdict(decomposed, pageComposed).status, "ok");
  assert.equal(verdict(composed, pageComposed.normalize("NFD")).status, "ok");
  assert.equal(verdict("Łódź Świnoujście Kraków".normalize("NFD"), "<p>Łódź, Świnoujście i Kraków są miastami w Polsce</p>").status, "ok");
});

test("numeric ranges give both years", () => {
  const { keywords } = score.keywordsFromContext("The 1957-1969 period Moonshot");
  assert.ok(keywords.includes("1957") && keywords.includes("1969"), keywords.join(","));
});

test("thin pages are not compared: empty, whitespace and shell HTML are unverifiable", () => {
  for (const html of ["", "   \n ", "<title>App</title><div id=root></div><script>x()</script>"]) {
    const v = verdict("Sputnik 1957 Soviet Union", html);
    assert.equal(v.status, "unverifiable", JSON.stringify(html));
    assert.match(v.note, /not enough readable content/);
  }
  assert.equal(score.MIN_PAGE_WORDS, 5);
  // The same keywords against a real page without them stay a mismatch.
  assert.equal(verdict("Sputnik 1957 Soviet Union", "<p>Boil water, add salt and cook the spaghetti.</p>").status, "mismatch");
});

test("required matches scale with the number of keywords", () => {
  assert.equal(score.requiredMatches(3), 2);
  assert.equal(score.requiredMatches(5), 2);
  assert.equal(score.requiredMatches(7), 3);
  assert.equal(score.requiredMatches(12), 4);
});
