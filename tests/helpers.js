"use strict";

// Minimal DOM-like nodes for testing lib/urls.js without a browser or jsdom.

function text(value) {
  return { nodeType: 3, nodeValue: value };
}

function elem(tagName, children = [], props = {}) {
  return { nodeType: 1, tagName: tagName.toUpperCase(), className: "", childNodes: children, ...props };
}

function anchor(href, label) {
  return elem("a", [text(label === undefined ? href : label)], { href });
}

// A Response with a real stream body and a settable url, as fetch() would return.
function htmlResponse(body, { status = 200, url = "", contentType = "text/html; charset=utf-8" } = {}) {
  const res = new Response(body, { status, headers: { "content-type": contentType } });
  Object.defineProperty(res, "url", { value: url });
  return res;
}

// A Response with the given status and no body (statuses such as 204 cannot carry one).
function emptyResponse(status, url = "", contentType = "text/html") {
  const res = new Response(null, { status, headers: { "content-type": contentType } });
  Object.defineProperty(res, "url", { value: url });
  return res;
}

const CHAT_SENDER = {
  tab: { id: 7 },
  url: "https://chatgpt.com/c/abc",
  origin: "https://chatgpt.com",
};

module.exports = { text, elem, anchor, htmlResponse, emptyResponse, CHAT_SENDER };
