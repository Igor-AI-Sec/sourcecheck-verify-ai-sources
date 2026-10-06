"use strict";

// Static checks on the extension package: syntax, manifest references,
// permissions, and a few "no backend / no telemetry" guards on the source.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const EXT = path.join(ROOT, "sourcecheck");
const manifest = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));

function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? jsFiles(path.join(dir, d.name)) : d.name.endsWith(".js") ? [path.join(dir, d.name)] : []
  );
}
const extensionSources = jsFiles(EXT);

test("every JavaScript file passes node --check", () => {
  for (const file of [...extensionSources, ...jsFiles(path.join(ROOT, "tests"))]) {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  }
});

test("manifest is Manifest V3 and every referenced file exists", () => {
  assert.equal(manifest.manifest_version, 3);
  const referenced = [
    manifest.background.service_worker,
    ...Object.values(manifest.icons),
    ...manifest.content_scripts.flatMap((c) => [...c.js, ...(c.css || [])]),
  ];
  for (const rel of referenced) assert.ok(fs.existsSync(path.join(EXT, rel)), rel);
});

test("the service worker imports only files that exist", () => {
  const src = fs.readFileSync(path.join(EXT, manifest.background.service_worker), "utf8");
  const m = /importScripts\(([^)]*)\)/.exec(src);
  assert.ok(m, "importScripts call");
  const files = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  assert.ok(files.length >= 3);
  for (const f of files) {
    assert.ok(fs.existsSync(path.join(EXT, f)), f);
    assert.ok(!/^[a-z]+:/i.test(f), "no remote script: " + f);
  }
});

test("content scripts load the shared library before content.js, only on the chat sites", () => {
  const [cs] = manifest.content_scripts;
  assert.deepEqual(cs.js, ["lib/urls.js", "content.js"]);
  assert.deepEqual(cs.matches.sort(), [
    "https://chat.openai.com/*",
    "https://chatgpt.com/*",
    "https://claude.ai/*",
    "https://gemini.google.com/*",
  ]);
});

test("no runtime permissions beyond host access for fetching link targets", () => {
  assert.deepEqual(manifest.permissions, []);
  assert.deepEqual(manifest.host_permissions, ["http://*/*", "https://*/*"]);
  for (const key of ["optional_permissions", "externally_connectable", "web_accessible_resources", "content_security_policy"]) {
    assert.equal(manifest[key], undefined, key);
  }
});

test("manifest description fits the store limit and does not claim nothing leaves the browser", () => {
  assert.ok(manifest.description.length <= 132, `${manifest.description.length} chars`);
  assert.doesNotMatch(manifest.description, /100% local|nothing ever leaves|never leaves/i);
});

test("source has no network path other than the single credentialless fetch", () => {
  const all = extensionSources.map((f) => [path.relative(ROOT, f), fs.readFileSync(f, "utf8")]);
  for (const [file, src] of all) {
    assert.doesNotMatch(src, /XMLHttpRequest|WebSocket|sendBeacon|EventSource|new Function\(|\beval\(/, file);
    assert.doesNotMatch(src, /import\(|<script|importScripts\(\s*["']https?:/, file);
  }
  const fetchCalls = all.filter(([, src]) => /\bfetchFn\(|\bfetch\(/.test(src)).map(([f]) => f.replace(/\\/g, "/"));
  assert.ok(fetchCalls.includes("sourcecheck/lib/check.js"));
  assert.doesNotMatch(fs.readFileSync(path.join(EXT, "lib", "check.js"), "utf8"), /credentials:\s*"include"|credentials:\s*"same-origin"/);
  assert.match(fs.readFileSync(path.join(EXT, "lib", "check.js"), "utf8"), /credentials:\s*"omit"/);
});

test("public text does not use the literal 'nothing leaves' claim or em dashes", () => {
  const files = [
    "README.md", "data/README.md", "sourcecheck/manifest.json",
    ...extensionSources.map((f) => path.relative(ROOT, f)),
    "sourcecheck/styles.css",
  ];
  for (const rel of files) {
    const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
    assert.ok(!src.includes(String.fromCharCode(0x2014)), `${rel} contains an em dash`);
    assert.doesNotMatch(src, /nothing ever leaves|nothing leaves your|Nothing is sent to any server/i, rel);
  }
});
