"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createChecker } = require("../sourcecheck/lib/check.js");
const { htmlResponse, emptyResponse, CHAT_SENDER } = require("./helpers.js");

const CONTEXT = "Sputnik 1 was launched in 1957 by the Soviet Union.";
const MATCHING = "<title>Sputnik</title><p>Sputnik 1 launched in 1957. The Soviet Union built it.</p>";
const UNRELATED = "<title>Pasta</title><p>Boil water, add salt and cook the spaghetti.</p>";
const URL_OK = "https://example.org/page";

const check = (fetch, url = URL_OK, context = CONTEXT, options = {}) =>
  createChecker({ fetch, ...options }).checkUrl({ url, context });

test("200 matching HTML is OK", async () => {
  const r = await check(async () => htmlResponse(MATCHING, { url: URL_OK }));
  assert.equal(r.status, "ok");
  assert.equal(r.httpStatus, 200);
  assert.equal(r.pageTitle, "Sputnik");
});

test("200 mismatching HTML is a mismatch", async () => {
  const r = await check(async () => htmlResponse(UNRELATED, { url: URL_OK }));
  assert.equal(r.status, "mismatch");
});

test("soft 404 that echoes the requested slug does not become OK", async () => {
  const slugUrl = "https://example.org/sputnik-1957-soviet-union";
  const r = await check(async () => htmlResponse("<title>404</title>not found", { url: slugUrl }), slugUrl);
  assert.notEqual(r.status, "ok");
});

test("404 and 410 are dead", async () => {
  for (const status of [404, 410]) {
    const r = await check(async () => emptyResponse(status, URL_OK));
    assert.equal(r.status, "dead", String(status));
  }
});

test("only 404 and 410 are dead: all other non-OK statuses are unverifiable", async () => {
  for (const status of [301, 304, 400, 401, 403, 405, 408, 429, 451, 500, 502, 503, 504]) {
    const r = await check(async () => emptyResponse(status, URL_OK));
    assert.equal(r.status, "unverifiable", String(status));
    assert.equal(r.httpStatus, status);
  }
});

test("network errors are unverifiable and do not claim the domain is missing", async () => {
  const r = await check(async () => {
    throw new TypeError("Failed to fetch");
  });
  assert.equal(r.status, "unverifiable");
  assert.doesNotMatch(r.note, /domain may not exist/i);
  assert.match(r.note, /not known/);
});

test("a timeout while waiting for headers is unverifiable", async () => {
  const r = await check(
    (url, init) =>
      new Promise((_, reject) => {
        init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
    URL_OK,
    CONTEXT,
    { timeoutMs: 30 }
  );
  assert.equal(r.status, "unverifiable");
  assert.match(r.note, /Timeout/);
});

test("a body that stalls after headers becomes unverifiable instead of hanging (stream respects abort)", async () => {
  const fetch = async (url, init) => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("<title>x</title>"));
        init.signal.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
      },
      pull: () => new Promise(() => {}),
    });
    const res = new Response(body, { status: 200, headers: { "content-type": "text/html" } });
    Object.defineProperty(res, "url", { value: url });
    return res;
  };
  const started = Date.now();
  const r = await check(fetch, URL_OK, CONTEXT, { timeoutMs: 50 });
  assert.equal(r.status, "unverifiable");
  assert.match(r.note, /Timeout while reading/);
  assert.ok(Date.now() - started < 2000);
});

test("a body read that ignores the abort signal still times out", async () => {
  const fetch = async (url) => ({
    status: 200,
    url,
    headers: { get: () => "text/html" },
    body: { getReader: () => ({ read: () => new Promise(() => {}), cancel: async () => {} }) },
  });
  const r = await check(fetch, URL_OK, CONTEXT, { timeoutMs: 50 });
  assert.equal(r.status, "unverifiable");
  assert.match(r.note, /Timeout while reading/);
});

test("a body that errors is unverifiable", async () => {
  const fetch = async (url) => {
    const body = new ReadableStream({
      start(controller) {
        controller.error(new TypeError("network error"));
      },
    });
    const res = new Response(body, { status: 200, headers: { "content-type": "text/html" } });
    Object.defineProperty(res, "url", { value: url });
    return res;
  };
  const r = await check(fetch);
  assert.equal(r.status, "unverifiable");
  assert.match(r.note, /could not be read/);
});

test("reading stops after maxBodyBytes", async () => {
  let pulled = 0;
  const fetch = async (url) => {
    const body = new ReadableStream({
      pull(controller) {
        pulled += 1000;
        controller.enqueue(new TextEncoder().encode("a".repeat(1000)));
        if (pulled > 1_000_000) controller.close();
      },
    });
    const res = new Response(body, { status: 200, headers: { "content-type": "text/html" } });
    Object.defineProperty(res, "url", { value: url });
    return res;
  };
  await check(fetch, URL_OK, CONTEXT, { maxBodyBytes: 5000 });
  assert.ok(pulled < 100_000, `pulled ${pulled} bytes`);
});

test("non-HTML content is unverifiable because it is not compared", async () => {
  for (const type of ["application/pdf", "text/plain", "image/png", ""]) {
    const r = await check(async () => htmlResponse("%PDF-1.7", { url: URL_OK, contentType: type }));
    assert.equal(r.status, "unverifiable", type);
    assert.match(r.note, /not checked/);
  }
});

test("a page with too little context is unverifiable", async () => {
  const r = await check(async () => htmlResponse(MATCHING, { url: URL_OK }), URL_OK, "");
  assert.equal(r.status, "unverifiable");
});

test("bot-protection pages are unverifiable, but a reCAPTCHA script in the head is not a bot wall", async () => {
  const wall = await check(async () => htmlResponse("<title>Just a moment...</title><p>Checking your browser</p>", { url: URL_OK }));
  assert.equal(wall.status, "unverifiable");
  assert.match(wall.note, /bot-protection/);
  const page = `<head><script src="https://www.google.com/recaptcha/api.js"></script><title>Sputnik</title></head>${MATCHING}`;
  const normal = await check(async () => htmlResponse(page, { url: URL_OK }));
  assert.equal(normal.status, "ok");
});

test("a non-UTF-8 page is decoded with its declared charset", async () => {
  const bytes = new Uint8Array([...Buffer.from("<title>t</title><p>Die ", "latin1"), 0xdc, ...Buffer.from("berpr", "latin1"), 0xfc, ...Buffer.from("fung der Gr", "latin1"), 0xf6, 0xdf, ...Buffer.from("e und F", "latin1"), 0xfc, ...Buffer.from("rsorgepflicht wird jetzt gepr", "latin1"), 0xfc, ...Buffer.from("ft</p>", "latin1")]);
  const fetch = async (url) => {
    const res = new Response(bytes, { status: 200, headers: { "content-type": "text/html; charset=iso-8859-1" } });
    Object.defineProperty(res, "url", { value: url });
    return res;
  };
  const r = await check(fetch, URL_OK, "Überprüfung Größe Fürsorgepflicht");
  assert.equal(r.status, "ok");
});

test("malformed percent encoding in the URL cannot abort the check", async () => {
  const url = "https://example.com/50%-off";
  const r = await check(async () => htmlResponse(MATCHING, { url }), url);
  assert.equal(r.status, "ok");
});

test("every fetch is credentialless, follows redirects and uses no referrer", async () => {
  let init;
  await check(async (url, i) => {
    init = i;
    return htmlResponse(MATCHING, { url });
  });
  assert.equal(init.credentials, "omit");
  assert.equal(init.redirect, "follow");
  assert.equal(init.method, "GET");
  assert.equal(init.referrerPolicy, "no-referrer");
});

test("initial local, private and non-http targets are not fetched", async () => {
  let calls = 0;
  const fetch = async () => {
    calls++;
    return htmlResponse(MATCHING);
  };
  for (const u of ["http://localhost:3000/", "http://127.0.0.1/", "http://10.1.2.3/", "http://192.168.0.1/", "http://169.254.169.254/", "http://[::1]/", "file:///etc/passwd", "javascript:alert(1)"]) {
    const r = await check(fetch, u);
    assert.equal(r.status, "unverifiable", u);
    assert.match(r.note, /local or private|http and https/, u);
  }
  assert.equal(calls, 0);
});

test("a normal public target is fetched", async () => {
  let calls = 0;
  await check(async (url) => {
    calls++;
    return htmlResponse(MATCHING, { url });
  });
  assert.equal(calls, 1);
});

// The browser follows redirects itself, so the request to the private address has
// already been sent by the time the final URL is visible. This test only covers
// what happens afterwards: the response is discarded and classified unverifiable.
test("a redirect that lands on a private address is classified unverifiable and its content is discarded", async () => {
  const r = await check(async () => htmlResponse("<title>Router admin</title>" + MATCHING, { url: "http://192.168.0.1/login" }));
  assert.equal(r.status, "unverifiable");
  assert.equal(r.pageTitle, "");
  assert.equal(r.finalUrl, null);
  assert.deepEqual(r.matchedKeywords, []);
  assert.match(r.note, /redirected to a local or private/);
  assert.match(r.note, /discarded/);
});

test("one item that throws cannot abort the other items", async () => {
  const checker = createChecker({
    fetch: async (url) => {
      if (url.includes("bad")) {
        return { status: 200, url, headers: { get: () => { throw new Error("boom"); } }, body: null };
      }
      return htmlResponse(MATCHING, { url });
    },
  });
  const { results } = await checker.checkAll([
    { url: "https://a.example/ok1", context: CONTEXT },
    { url: "https://b.example/bad", context: CONTEXT },
    { url: "https://c.example/ok2", context: CONTEXT },
  ]);
  assert.deepEqual(results.map((r) => r.status), ["ok", "unverifiable", "ok"]);
});

test("a throwing progress callback cannot abort the batch", async () => {
  const checker = createChecker({ fetch: async (url) => htmlResponse(MATCHING, { url }) });
  const { results } = await checker.checkAll(
    [{ url: "https://a.example/1", context: CONTEXT }, { url: "https://b.example/2", context: CONTEXT }],
    () => {
      throw new Error("ui gone");
    }
  );
  assert.equal(results.length, 2);
});

// ---------- batch and messages ----------

test("more than maxUrls links reports checked and skipped honestly", async () => {
  const checker = createChecker({ fetch: async (url) => htmlResponse(MATCHING, { url }) });
  const items = Array.from({ length: 20 }, (_, i) => ({ url: `https://h${i}.example/p`, context: CONTEXT }));
  const { results, skipped } = await checker.checkAll(items);
  assert.equal(results.length, 15);
  assert.equal(skipped.length, 5);
  assert.deepEqual(skipped, items.slice(15).map((i) => i.url));
});

test("handleVerify answers with checked vs total and always ends with one DONE message", async () => {
  const sent = [];
  const checker = createChecker({ fetch: async (url) => htmlResponse(MATCHING, { url }) });
  const items = Array.from({ length: 20 }, (_, i) => ({ url: `https://h${i}.example/p`, context: CONTEXT }));
  const reply = checker.handleVerify({ type: "SOURCECHECK_VERIFY", requestId: "req-1", items }, CHAT_SENDER, (tabId, msg) => {
    sent.push([tabId, msg]);
  });
  assert.deepEqual(reply, { accepted: true, checked: 15, total: 20, cap: 15 });
  await new Promise((r) => setTimeout(r, 200));
  const done = sent.filter(([, m]) => m.type === "SOURCECHECK_DONE");
  assert.equal(done.length, 1);
  assert.equal(done[0][0], 7);
  assert.equal(done[0][1].results.length, 15);
  assert.equal(done[0][1].total, 20);
  assert.equal(done[0][1].skipped.length, 5);
  assert.equal(sent.filter(([, m]) => m.type === "SOURCECHECK_PROGRESS").length, 15);
});

test("DONE is still sent, with an unverifiable result, when fetch throws synchronously", async () => {
  const sent = [];
  const broken = createChecker({
    fetch: () => {
      throw new Error("sync failure");
    },
  });
  broken.handleVerify(
    { type: "SOURCECHECK_VERIFY", requestId: "req-2", items: [{ url: URL_OK, context: CONTEXT }] },
    CHAT_SENDER,
    (tabId, msg) => sent.push(msg)
  );
  await new Promise((r) => setTimeout(r, 100));
  const done = sent.find((m) => m.type === "SOURCECHECK_DONE");
  assert.ok(done);
  assert.equal(done.results[0].status, "unverifiable");
});

test("malformed messages are rejected cleanly", () => {
  const checker = createChecker({ fetch: async () => htmlResponse(MATCHING) });
  const ok = { url: URL_OK, context: CONTEXT };
  const bad = [
    [{ type: "SOURCECHECK_VERIFY" }, "missing id and items"],
    [{ type: "SOURCECHECK_VERIFY", requestId: "req-1" }, "missing items"],
    [{ type: "SOURCECHECK_VERIFY", requestId: "req-1", items: "abc" }, "items not an array"],
    [{ type: "SOURCECHECK_VERIFY", requestId: 5, items: [ok] }, "numeric id"],
    [{ type: "SOURCECHECK_VERIFY", requestId: "x".repeat(100), items: [ok] }, "long id"],
    [{ type: "SOURCECHECK_VERIFY", requestId: "a b<c>", items: [ok] }, "odd id"],
    [{ type: "SOURCECHECK_VERIFY", requestId: "req-1", items: [{ url: 5, context: "" }] }, "url not a string"],
    [{ type: "SOURCECHECK_VERIFY", requestId: "req-1", items: [{ url: URL_OK }] }, "context missing"],
    [{ type: "SOURCECHECK_VERIFY", requestId: "req-1", items: [null] }, "null item"],
    [{ type: "SOURCECHECK_VERIFY", requestId: "req-1", items: Array(501).fill(ok) }, "too many items"],
  ];
  for (const [msg, label] of bad) {
    const reply = checker.handleVerify(msg, CHAT_SENDER, () => {});
    assert.equal(reply.accepted, false, label);
    assert.equal(typeof reply.error, "string", label);
  }
});

test("messages from outside the supported chat pages are rejected", () => {
  const checker = createChecker({ fetch: async () => htmlResponse(MATCHING) });
  const msg = { type: "SOURCECHECK_VERIFY", requestId: "req-1", items: [{ url: URL_OK, context: CONTEXT }] };
  for (const sender of [
    undefined, {}, { tab: { id: 1 }, url: "https://evil.example/" }, { tab: { id: 1 }, origin: "https://chatgpt.com.evil.example" },
    { url: "https://chatgpt.com/" }, { tab: {}, url: "https://chatgpt.com/" }, { tab: { id: 1 }, url: "chrome-extension://abc/page.html" },
  ]) {
    assert.equal(checker.handleVerify(msg, sender, () => {}).accepted, false, JSON.stringify(sender));
  }
  for (const origin of ["https://chatgpt.com", "https://chat.openai.com", "https://gemini.google.com", "https://claude.ai"]) {
    assert.equal(checker.handleVerify(msg, { tab: { id: 1 }, origin }, () => {}).accepted, true, origin);
  }
});

test("one overlong URL between two normal URLs fails only itself", async () => {
  const sent = [];
  const fetched = [];
  const checker = createChecker({
    fetch: async (url) => {
      fetched.push(url);
      return htmlResponse(MATCHING, { url });
    },
  });
  const longUrl = "https://example.org/" + "x".repeat(3000);
  const items = [
    { url: "https://a.example/one", context: CONTEXT },
    { url: longUrl, context: CONTEXT },
    { url: "https://b.example/two", context: CONTEXT },
  ];
  const reply = checker.handleVerify({ type: "SOURCECHECK_VERIFY", requestId: "req-3", items }, CHAT_SENDER, (tabId, msg) => sent.push(msg));
  assert.deepEqual(reply, { accepted: true, checked: 3, total: 3, cap: 15 });
  await new Promise((r) => setTimeout(r, 150));
  const done = sent.filter((m) => m.type === "SOURCECHECK_DONE");
  assert.equal(done.length, 1);
  assert.deepEqual(done[0].results.map((r) => r.status), ["ok", "unverifiable", "ok"]);
  assert.equal(done[0].results[1].linkable, false);
  assert.match(done[0].results[1].note, /longer than 2048/);
  assert.ok(done[0].results[1].url.length < 300, "the label is truncated");
  assert.deepEqual(fetched.sort(), ["https://a.example/one", "https://b.example/two"]);
});

test("malformed and unsupported URLs fail only themselves; valid siblings are still checked", async () => {
  const checker = createChecker({ fetch: async (url) => htmlResponse(MATCHING, { url }) });
  const v = checker.validateVerifyMessage(
    {
      type: "SOURCECHECK_VERIFY",
      requestId: "req-4",
      items: [
        { url: "not a url", context: CONTEXT },
        { url: "ftp://files.example/x", context: CONTEXT },
        { url: "", context: CONTEXT },
        { url: "https://ok.example/page", context: CONTEXT },
      ],
    },
    CHAT_SENDER
  );
  assert.equal(v.ok, true);
  const { results } = await checker.checkAll(v.items);
  assert.deepEqual(results.map((r) => r.status), ["unverifiable", "unverifiable", "unverifiable", "ok"]);
});

test("the request envelope is still bounded: item count, request id and context size", () => {
  const checker = createChecker({ fetch: async () => htmlResponse(MATCHING) });
  const item = { url: URL_OK, context: CONTEXT };
  assert.equal(checker.validateVerifyMessage({ requestId: "req-1", items: Array(501).fill(item) }, CHAT_SENDER).ok, false);
  assert.equal(checker.validateVerifyMessage({ requestId: "r".repeat(65), items: [item] }, CHAT_SENDER).ok, false);
  assert.equal(checker.validateVerifyMessage({ requestId: "req-1", items: [{ url: URL_OK, context: "x".repeat(9999) }] }, CHAT_SENDER).items[0].context.length, 1000);
});

test("the target host name cannot confirm itself", async () => {
  const page = "<title>t</title><p>Welcome to Osjournal. Our zebra exhibit opens today for everyone.</p>";
  const r = await check(async (url) => htmlResponse(page, { url }), "https://osjournal.org/paper", "Osjournal Zebra Narwhal Quokka");
  // Without host-name exclusion, "osjournal" and "zebra" would give 2 of 4 matches and pass.
  assert.equal(r.status, "mismatch");
  assert.equal(r.totalKeywords, 3);
  assert.deepEqual(r.matchedKeywords, ["zebra"]);
});

test("a visible bot-wall message is unverifiable", async () => {
  const page = "<title>Security check</title><p>Please verify you are human by completing the action below to continue to the site.</p>";
  const r = await check(async (url) => htmlResponse(page, { url }));
  assert.equal(r.status, "unverifiable");
  assert.match(r.note, /bot-protection/);
});

test("a challenge marker in the page source is unverifiable even when the visible text would match", async () => {
  const page = `<head><script>window._cf_chl_opt={cvId:"3"};</script><title>Sputnik</title></head>${MATCHING}`;
  const r = await check(async (url) => htmlResponse(page, { url }));
  assert.equal(r.status, "unverifiable");
  assert.match(r.note, /bot-protection/);
});

test("empty, whitespace-only and shell HTML are unverifiable, not a mismatch", async () => {
  const bodies = [
    "",
    "   \n\t  ",
    "<html><head><title>App</title></head><body><div id=\"root\"></div><script>window.__DATA__={};</script></body></html>",
  ];
  for (const body of bodies) {
    const r = await check(async (url) => htmlResponse(body, { url }));
    assert.equal(r.status, "unverifiable", JSON.stringify(body));
    assert.match(r.note, /not enough readable content/);
  }
});

test("a real page that simply lacks the keywords is still a mismatch", async () => {
  const r = await check(async (url) => htmlResponse(UNRELATED, { url }));
  assert.equal(r.status, "mismatch");
});

// Windows-1250 bytes for "Swiat Lodz" with S-acute, L-stroke, o-acute, z-acute.
const CP1250_BODY = (head) =>
  Uint8Array.from([
    ...Buffer.from(head + "<p>", "latin1"),
    0x8c, ...Buffer.from("wiat ", "latin1"),
    0xa3, 0xf3, ...Buffer.from("d", "latin1"), 0x9f,
    ...Buffer.from(" Zebra Quokka Narwhal live here today</p>", "latin1"),
  ]);
const POLISH_CONTEXT = "Świat Łódź Zebra Quokka Narwhal";

test("charset is sniffed from <meta> when the HTTP header has none", async () => {
  const fetch = async (url) => {
    const res = new Response(CP1250_BODY('<meta charset="windows-1250">'), { status: 200, headers: { "content-type": "text/html" } });
    Object.defineProperty(res, "url", { value: url });
    return res;
  };
  const r = await check(fetch, URL_OK, POLISH_CONTEXT);
  assert.ok(r.matchedKeywords.includes("świat"), String(r.matchedKeywords));
  assert.ok(r.matchedKeywords.includes("łódź"), String(r.matchedKeywords));
});

test("charset from the HTTP header is used, and an undeclared one falls back to UTF-8", async () => {
  const make = (head, type) => async (url) => {
    const res = new Response(CP1250_BODY(head), { status: 200, headers: { "content-type": type } });
    Object.defineProperty(res, "url", { value: url });
    return res;
  };
  const viaHeader = await check(make("", "text/html; charset=windows-1250"), URL_OK, POLISH_CONTEXT);
  assert.ok(viaHeader.matchedKeywords.includes("świat"));
  const undeclared = await check(make("", "text/html"), URL_OK, POLISH_CONTEXT);
  assert.ok(!undeclared.matchedKeywords.includes("świat"), "no declaration means UTF-8, so the cp1250 bytes do not decode");
});

test("an unknown charset label falls back to UTF-8 instead of failing", async () => {
  const r = await check(async (url) => htmlResponse(MATCHING, { url, contentType: "text/html; charset=x-no-such-charset" }));
  assert.equal(r.status, "ok");
});

test("context is bounded", () => {
  const checker = createChecker({ fetch: async () => htmlResponse(MATCHING) });
  const v = checker.validateVerifyMessage(
    { type: "SOURCECHECK_VERIFY", requestId: "req-1", items: [{ url: URL_OK, context: "x".repeat(5000) }] },
    CHAT_SENDER
  );
  assert.equal(v.ok, true);
  assert.equal(v.items[0].context.length, 1000);
});
