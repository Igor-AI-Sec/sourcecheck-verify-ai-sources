"use strict";

// Loads the production lib files the way the browser does: as plain scripts in
// a shared global scope, with no require and no module. This is the path used by
// the MV3 service worker (importScripts) and by the content script (manifest order).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { htmlResponse } = require("./helpers.js");

const EXT = path.join(__dirname, "..", "sourcecheck");
const manifest = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));

function loadAsBrowser(files) {
  // Only platform globals a worker or content script has. No require, no module.
  const sandbox = { console, URL, TextDecoder, AbortController, setTimeout, clearTimeout };
  vm.createContext(sandbox);
  for (const f of files) vm.runInContext(fs.readFileSync(path.join(EXT, f), "utf8"), sandbox, { filename: f });
  return sandbox;
}

function importScriptsOrder() {
  const src = fs.readFileSync(path.join(EXT, manifest.background.service_worker), "utf8");
  return [...(/importScripts\(([^)]*)\)/.exec(src)[1]).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

test("service worker order (as in background.js) creates SourceCheckLib without require or module", () => {
  const order = importScriptsOrder();
  assert.deepEqual(order, ["lib/urls.js", "lib/score.js", "lib/check.js"]);
  const sb = loadAsBrowser(order);
  assert.equal(typeof sb.require, "undefined");
  assert.equal(typeof sb.module, "undefined");
  const lib = sb.SourceCheckLib;
  assert.ok(lib, "SourceCheckLib exists");
  for (const name of [
    "createChecker", "collectItems", "extractBareUrls", "normalizeKey", "parseHttpUrl", "checkTarget", "isChatHost",
    "assess", "keywordsFromContext", "htmlToText", "extractTitle", "decodeEntities",
  ]) {
    assert.equal(typeof lib[name], "function", name);
  }
});

test("the browser-global path runs a real check through the same code", async () => {
  const sb = loadAsBrowser(importScriptsOrder());
  const page = "<title>Sputnik</title><p>Sputnik 1 launched in 1957. The Soviet Union built it.</p>";
  const checker = sb.SourceCheckLib.createChecker({ fetch: async (url) => htmlResponse(page, { url }) });
  const ok = await checker.checkUrl({ url: "https://example.org/p", context: "Sputnik 1 was launched in 1957 by the Soviet Union." });
  assert.equal(ok.status, "ok");
  const blocked = await checker.checkUrl({ url: "http://127.0.0.1/", context: "x" });
  assert.equal(blocked.status, "unverifiable");
});

test("check.js without its dependencies cannot check anything, so the load order matters", async () => {
  const sb = loadAsBrowser(["lib/check.js"]);
  const r = await sb.SourceCheckLib.createChecker({ fetch: async () => {} }).checkUrl({ url: "https://a.example/", context: "" });
  assert.equal(r.status, "unverifiable");
  assert.match(r.note, /failed unexpectedly/);
});

test("content script order exposes everything content.js uses", () => {
  const files = manifest.content_scripts[0].js.filter((f) => f !== "content.js");
  assert.deepEqual(files, ["lib/urls.js", "lib/providers.js"]);
  const lib = loadAsBrowser(files).SourceCheckLib;
  const used = new Set([...fs.readFileSync(path.join(EXT, "content.js"), "utf8").matchAll(/\blib\.(\w+)/g)].map((m) => m[1]));
  assert.ok(used.size >= 2, [...used].join(","));
  for (const name of used) assert.equal(typeof lib[name], "function", `content.js uses lib.${name}`);
});

test("background.js uses only functions that the service worker order provides", () => {
  const lib = loadAsBrowser(importScriptsOrder()).SourceCheckLib;
  const src = fs.readFileSync(path.join(EXT, manifest.background.service_worker), "utf8");
  const used = new Set([...src.matchAll(/SourceCheckLib\.(\w+)/g)].map((m) => m[1]));
  assert.ok(used.has("createChecker"));
  for (const name of used) assert.equal(typeof lib[name], "function", name);
});
