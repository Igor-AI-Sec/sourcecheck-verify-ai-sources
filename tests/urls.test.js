"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const urls = require("../sourcecheck/lib/urls.js");
const { text, elem, anchor } = require("./helpers.js");

const urlsOf = (items) => items.map((i) => i.url);

test("glued adjacent DOM text does not create classes.html2", () => {
  const A = "https://scikit-learn.org/stable/modules/classes.html";
  // <p>Docs: <a>URL</a><sup>2</sup></p>: the anchor text and the citation digit
  // are separate nodes, so one concatenated string would read "...classes.html2".
  const root = elem("div", [elem("p", [text("Docs: "), anchor(A), elem("sup", [text("2")])])]);
  assert.deepEqual(urlsOf(urls.collectItems(root)), [A]);
});

test("a URL typed as plain text next to an icon node is not extended by the icon", () => {
  const A = "https://scikit-learn.org/stable/modules/classes.html";
  const root = elem("div", [
    elem("p", [text("See "), elem("span", [text(A)]), elem("span", [text("⛨")])]),
  ]);
  assert.deepEqual(urlsOf(urls.collectItems(root)), [A]);
});

test("SourceCheck button and report text are ignored", () => {
  const LONG = "https://example.com/" + "a".repeat(90);
  const shortened = LONG.slice(0, 77) + "…";
  const root = elem("div", [
    elem("p", [anchor(LONG)]),
    elem("button", [text("⛨ Verify sources https://example.com/from-button")], { className: "sourcecheck-btn" }),
    elem("div", [
      elem("ul", [elem("li", [anchor(LONG, shortened), text(" " + shortened + " https://example.com/in-report")])]),
    ], { className: "sourcecheck-report" }),
  ]);
  assert.deepEqual(urlsOf(urls.collectItems(root)), [LONG]);
});

test("second verification does not discover the shortened report URL ending in an ellipsis", () => {
  const LONG = "https://example.com/docs/" + "x".repeat(80);
  const shortened = LONG.slice(0, 77) + "…";
  const answer = elem("p", [text("Source: " + LONG)]);
  const report = elem("div", [text(shortened)], { className: "sourcecheck-report" });
  const first = urls.collectItems(elem("div", [answer]));
  const second = urls.collectItems(elem("div", [answer, report]));
  assert.deepEqual(urlsOf(second), urlsOf(first));
  assert.ok(!urlsOf(second).some((u) => u.includes("…")));
});

test("text inside script, style and anchor nodes is not scanned for bare URLs", () => {
  const root = elem("div", [
    elem("script", [text("var u = 'https://evil.example/script'")]),
    elem("style", [text("/* https://evil.example/style */")]),
    elem("p", [text("plain https://ok.example/page")]),
  ]);
  assert.deepEqual(urlsOf(urls.collectItems(root)), ["https://ok.example/page"]);
});

test("valid capitalised path segments are preserved", () => {
  for (const u of [
    "https://en.wikipedia.org/wiki/Sputnik",
    "https://github.com/some-user/Repo",
    "https://example.com/Introduction",
    "https://example.com/docs/Guide",
  ]) {
    assert.deepEqual(urlsOf(urls.collectItems(elem("p", [text("Read " + u + " today")]))), [u]);
  }
});

test("valid trailing digits are preserved", () => {
  for (const u of ["https://example.com/page2", "https://arxiv.org/abs/2005.14165", "https://example.com/v1"]) {
    assert.deepEqual(urlsOf(urls.collectItems(elem("p", [text(u)]))), [u]);
  }
});

test("surrounding prose punctuation is stripped but balanced brackets stay", () => {
  const f = (s) => urls.extractBareUrls(s).map((h) => h.url);
  assert.deepEqual(f("see https://x.example/a."), ["https://x.example/a"]);
  assert.deepEqual(f("(https://x.example/a)"), ["https://x.example/a"]);
  assert.deepEqual(f("**https://x.example/a**"), ["https://x.example/a"]);
  assert.deepEqual(f("_https://x.example/a_"), ["https://x.example/a"]);
  assert.deepEqual(f("https://en.wikipedia.org/wiki/Python_(programming_language)."), [
    "https://en.wikipedia.org/wiki/Python_(programming_language)",
  ]);
  assert.deepEqual(f("https://x.example/a,https://y.example/b"), ["https://x.example/a", "https://y.example/b"]);
  assert.deepEqual(f("https://x.example/a…"), ["https://x.example/a"]);
});

test("only valid http(s) URLs are extracted", () => {
  assert.deepEqual(urls.extractBareUrls("https:// and http://"), []);
  assert.equal(urls.parseHttpUrl("javascript:alert(1)"), null);
  assert.equal(urls.parseHttpUrl("ftp://x.example/"), null);
  assert.equal(urls.parseHttpUrl("data:text/html,hi"), null);
  assert.equal(urls.parseHttpUrl(42), null);
});

test("tracking parameters and fragments dedupe; other parameters do not", () => {
  const dedupe = (hrefs) => urlsOf(urls.collectItems(elem("div", hrefs.map((h) => elem("p", [anchor(h)])))));
  assert.equal(dedupe(["https://x.example/a?utm_source=chatgpt.com", "https://x.example/a"]).length, 1);
  assert.equal(dedupe(["https://x.example/a?fbclid=1", "https://x.example/a?gclid=2", "https://x.example/a"]).length, 1);
  assert.equal(dedupe(["https://x.example/a#one", "https://x.example/a#two"]).length, 1);
  assert.equal(dedupe(["https://x.example/a?ref=1", "https://x.example/a"]).length, 2);
  assert.equal(dedupe(["https://x.example/a?source=1", "https://x.example/a"]).length, 2);
  assert.equal(dedupe(["https://x.example/a?id=5&utm_medium=x", "https://x.example/a?id=5"]).length, 1);
  assert.equal(dedupe(["https://x.example/a?id=5", "https://x.example/a?id=6"]).length, 2);
});

test("ref and source parameters are kept in the returned URL", () => {
  const out = urls.collectItems(elem("p", [anchor("https://x.example/a?ref=1&source=2&utm_source=z")]));
  assert.equal(out[0].url, "https://x.example/a?ref=1&source=2&utm_source=z");
});

test("http vs https and www vs bare host are not merged", () => {
  const out = urls.collectItems(
    elem("div", ["https://x.example/a", "http://x.example/a", "https://www.x.example/a"].map((h) => elem("p", [anchor(h)])))
  );
  assert.equal(out.length, 3);
});

test("only chat application hosts are ignored; provider domains are legitimate sources", () => {
  const hrefs = [
    "https://chatgpt.com/share/1", "https://chat.openai.com/c/1", "https://gemini.google.com/app", "https://claude.ai/chat/1",
    "https://openai.com/index/gpt", "https://www.anthropic.com/news/x", "https://google.com/search?q=a", "https://docs.google.com/d/1",
  ];
  const out = urlsOf(urls.collectItems(elem("div", hrefs.map((h) => elem("p", [anchor(h)])))));
  assert.deepEqual(out, hrefs.slice(4));
});

test("items come in document order and carry context from their own paragraph", () => {
  const root = elem("div", [
    elem("p", [text("First claim about Sputnik: "), anchor("https://a.example/1")]),
    elem("p", [text("Second claim about Apollo "), text("https://b.example/2")]),
  ]);
  const out = urls.collectItems(root);
  assert.deepEqual(urlsOf(out), ["https://a.example/1", "https://b.example/2"]);
  assert.match(out[0].context, /Sputnik/);
  assert.doesNotMatch(out[0].context, /Apollo/);
  assert.match(out[1].context, /Apollo/);
  assert.doesNotMatch(out[1].context, /Sputnik/);
});

test("neighbouring elements in a context are separated, not glued into one word", () => {
  const p = elem("p", [elem("b", [text("end")]), elem("i", [text("Next")])]);
  assert.equal(urls.textOf(p), "end Next");
});

// ---------- target validation ----------

test("local and private literal targets are rejected", () => {
  for (const u of [
    "http://localhost/", "http://localhost:8080/admin", "http://app.localhost/", "http://127.0.0.1/", "http://127.9.9.9:3000/",
    "http://10.0.0.5/", "http://172.16.0.1/", "http://172.31.255.255/", "http://192.168.1.1/", "http://169.254.169.254/latest/meta-data",
    "http://[::1]/", "http://[::]/", "http://[fc00::1]/", "http://[fd12:3456::1]/", "http://[fe80::1]/", "http://[febf::1]/",
    "http://[::ffff:127.0.0.1]/", "http://[::ffff:192.168.0.1]/", "http://2130706433/", "http://0x7f.1/", "http://router/", "http://printer.local/",
    "http://0.0.0.0/", "http://100.64.0.1/", "http://localhost./",
  ]) {
    const r = urls.checkTarget(u);
    assert.equal(r.ok, false, u);
    assert.match(r.reason, /local or private/, u);
  }
});

test("normal public http and https targets are accepted", () => {
  for (const u of [
    "https://example.com/", "http://example.org/page?q=1", "https://sub.example.co.uk/a/b", "http://8.8.8.8/", "http://172.15.0.1/",
    "http://172.32.0.1/", "https://[2001:db8::1]/", "http://[2606:4700::1111]/",
  ]) {
    assert.equal(urls.checkTarget(u).ok, true, u);
  }
});

test("non-http schemes and malformed URLs are rejected", () => {
  for (const u of ["file:///etc/passwd", "ftp://example.com/", "javascript:alert(1)", "data:text/plain,hi", "chrome://settings", "not a url", ""]) {
    const r = urls.checkTarget(u);
    assert.equal(r.ok, false, u);
    assert.match(r.reason, /http and https/, u);
  }
});
