"use strict";

// Target discovery per provider, on simplified DOM objects that follow the
// structures seen in real ChatGPT and Gemini pages. The Claude fixtures follow
// the structure the original selectors matched (that provider worked and must
// not change). These tests call the same findAssistantTargets() the content
// script calls.

const test = require("node:test");
const assert = require("node:assert/strict");
const providers = require("../sourcecheck/lib/providers.js");
const urls = require("../sourcecheck/lib/urls.js");
const { text, elem, anchor } = require("./helpers.js");

const div = (children = [], props = {}) => elem("div", children, props);
const find = (root, host) => providers.findAssistantTargets(root, host);
const hrefsOf = (el) => urls.collectItems(el).map((i) => i.url);

const SOURCES = ["https://a.example/one", "https://b.example/two", "https://c.example/three"];
const sourceList = () => elem("ul", SOURCES.map((u) => elem("li", [text("Source: "), anchor(u)])));

// ---------- ChatGPT ----------

function chatgptAssistantTurn(n, answerChildren, { key = `fallback-turn-0:${n}:assistant` } = {}) {
  const markdown = div(answerChildren, { attrs: { "data-markdown-text-style": "assistant-message" } });
  const group = div([markdown], {
    className: "group flex min-w-0 flex-col",
    attrs: { "data-chatgpt-selection-conversation-id": "c", "data-chatgpt-selection-message-id": `m${n}` },
  });
  const unit = div([div([group])], {
    attrs: { "data-content-search-unit-key": key, "data-chatgpt-search-unit-key": key, "data-chatgpt-search-message-ids": `m${n}` },
  });
  return { unit, group, markdown };
}

function chatgptUserTurn(n) {
  const key = `fallback-turn-0:${n}:user`;
  return div([div([text("a question")], { attrs: { "data-markdown-text-style": "user-message" } })], {
    attrs: { "data-content-search-unit-key": key, "data-chatgpt-search-unit-key": key },
  });
}

test("ChatGPT: the current assistant markdown element is the one target, the user turn is excluded", () => {
  const turn = chatgptAssistantTurn(2, [elem("p", [text("Here are sources:")]), sourceList()]);
  const root = elem("main", [div([chatgptUserTurn(1), turn.unit])]);
  const targets = find(root, "chatgpt.com");
  assert.equal(targets.length, 1);
  assert.equal(targets[0].provider, "chatgpt");
  assert.equal(targets[0].extractionRoot, turn.markdown);
  assert.notEqual(targets[0].extractionRoot, turn.group, "not the turn group");
  assert.notEqual(targets[0].extractionRoot, turn.unit, "not the whole turn wrapper");
  assert.deepEqual(targets[0].insertion, { parent: turn.markdown, before: null });
  assert.deepEqual(hrefsOf(targets[0].extractionRoot), SOURCES, "three links, once each");
});

test("ChatGPT: an assistant-style element inside a user turn is not selected", () => {
  const sneaky = div([text("x")], { attrs: { "data-markdown-text-style": "assistant-message" } });
  const userTurn = div([sneaky], {
    attrs: { "data-content-search-unit-key": "fallback-turn-0:1:user", "data-chatgpt-search-unit-key": "fallback-turn-0:1:user" },
  });
  assert.equal(find(elem("main", [userTurn]), "chatgpt.com").length, 0);
});

test("ChatGPT: a turn key on either attribute is honoured, and no key at all is accepted", () => {
  const onlySearchUnit = div([div([text("x")], { attrs: { "data-markdown-text-style": "assistant-message" } })], {
    attrs: { "data-chatgpt-search-unit-key": "fallback-turn-0:1:user" },
  });
  assert.equal(find(elem("main", [onlySearchUnit]), "chatgpt.com").length, 0);
  const noKey = elem("main", [div([text("x")], { attrs: { "data-markdown-text-style": "assistant-message" } })]);
  assert.equal(find(noKey, "chatgpt.com").length, 1);
});

test("ChatGPT: the older data-message-author-role structure still works as a fallback", () => {
  const assistant = div([div([elem("p", [anchor(SOURCES[0])])], { className: "markdown" })], { attrs: { "data-message-author-role": "assistant" } });
  const user = div([text("q")], { attrs: { "data-message-author-role": "user" } });
  const targets = find(elem("main", [user, assistant]), "chat.openai.com");
  assert.equal(targets.length, 1);
  assert.equal(targets[0].extractionRoot, assistant);
  assert.deepEqual(targets[0].insertion, { parent: assistant, before: null });
});

test("ChatGPT: the fallback is used only when no current-style element exists", () => {
  const turn = chatgptAssistantTurn(2, [sourceList()]);
  // Both markers on one answer: only the current one is returned, so no duplicate.
  turn.markdown.getAttribute = ((orig) => (n) => (n === "data-message-author-role" ? "assistant" : orig(n)))(turn.markdown.getAttribute);
  const targets = find(elem("main", [turn.unit]), "chatgpt.com");
  assert.equal(targets.length, 1);
  assert.equal(targets[0].extractionRoot, turn.markdown);
});

test("ChatGPT: several answers give one target each and links never cross over", () => {
  const first = chatgptAssistantTurn(2, [elem("p", [anchor("https://first.example/a")])]);
  const second = chatgptAssistantTurn(4, [elem("p", [anchor("https://second.example/b")])]);
  const root = elem("main", [chatgptUserTurn(1), first.unit, chatgptUserTurn(3), second.unit]);
  const targets = find(root, "chatgpt.com");
  assert.equal(targets.length, 2);
  assert.deepEqual(targets.map((t) => t.extractionRoot), [first.markdown, second.markdown]);
  assert.deepEqual(hrefsOf(targets[0].extractionRoot), ["https://first.example/a"]);
  assert.deepEqual(hrefsOf(targets[1].extractionRoot), ["https://second.example/b"]);
});

test("ChatGPT: nested matching elements still give one target for one answer", () => {
  const inner = div([sourceList()], { attrs: { "data-markdown-text-style": "assistant-message" } });
  const outer = div([inner], { attrs: { "data-markdown-text-style": "assistant-message" } });
  const targets = find(elem("main", [outer]), "chatgpt.com");
  assert.equal(targets.length, 1);
  assert.equal(targets[0].extractionRoot, outer);
});

// ---------- Gemini ----------

// model-response > response-container > div.response-container > div.presented-response-container
//   > div.response-container-content > div.response-content > model-response-content
//   > structured-content-container.model-response-text > message-content > (content)
function geminiAnswer(contentChildren) {
  const messageContent = elem("message-content", contentChildren);
  const structured = elem("structured-content-container", [messageContent], { className: "model-response-text" });
  const modelResponseContent = elem("model-response-content", [structured]);
  const responseContent = div([modelResponseContent], { className: "response-content" });
  const responseContainerContent = div([responseContent], { className: "response-container-content" });
  const presented = div([responseContainerContent], { className: "presented-response-container" });
  const responseContainerDiv = div([presented], { className: "response-container" });
  const responseContainer = elem("response-container", [responseContainerDiv]);
  const modelResponse = elem("model-response", [responseContainer]);
  const wide = [structured, modelResponseContent, responseContent, responseContainerContent, presented, responseContainerDiv, responseContainer, modelResponse];
  return { modelResponse, messageContent, wide };
}

const geminiUserQuery = () => elem("user-query", [div([text("a question")], { className: "query-text" })]);

test("Gemini: one target; message-content is the extraction root and no wide wrapper is used for the UI", () => {
  const answer = geminiAnswer([elem("p", [text("Here:")]), sourceList(), elem("p", [text("Done.")])]);
  const root = elem("main", [geminiUserQuery(), answer.modelResponse]);
  const targets = find(root, "gemini.google.com");
  assert.equal(targets.length, 1);
  assert.equal(targets[0].provider, "gemini");
  assert.equal(targets[0].extractionRoot, answer.messageContent);
  for (const wrapper of answer.wide) {
    assert.notEqual(targets[0].extractionRoot, wrapper);
    assert.notEqual(targets[0].insertion.parent, wrapper, `UI parent must not be <${wrapper.tagName.toLowerCase()}>`);
  }
  assert.deepEqual(hrefsOf(targets[0].extractionRoot), SOURCES, "three links, once each");
});

test("Gemini: with blocks directly inside message-content, the UI follows the last block in that flow", () => {
  const answer = geminiAnswer([elem("p", [text("Here:")]), sourceList()]);
  const [t] = find(elem("main", [answer.modelResponse]), "gemini.google.com");
  assert.equal(t.insertion.parent, answer.messageContent);
  assert.equal(t.insertion.before, null);
  assert.equal(answer.messageContent.childNodes[answer.messageContent.childNodes.length - 1].tagName, "UL");
});

test("Gemini: with a wrapper around the blocks, the UI goes inside that wrapper, not message-content", () => {
  const blocks = div([elem("p", [text("Here:")]), sourceList()], { className: "markdown markdown-main-panel" });
  const answer = geminiAnswer([blocks]);
  const [t] = find(elem("main", [answer.modelResponse]), "gemini.google.com");
  assert.equal(t.extractionRoot, answer.messageContent);
  assert.equal(t.insertion.parent, blocks);
  assert.equal(t.insertion.before, null);
});

test("Gemini: the UI is placed after the last element of the flow and before anything that follows it", () => {
  const trailing = elem("script", [text("x")]);
  const blocks = div([elem("p", [text("a")]), sourceList(), trailing]);
  const answer = geminiAnswer([blocks]);
  const [t] = find(elem("main", [answer.modelResponse]), "gemini.google.com");
  assert.equal(t.insertion.parent, blocks);
  assert.equal(t.insertion.before, trailing);
});

test("Gemini: the result is the same when SourceCheck's own button and report are already in place", () => {
  const blocks = div([elem("p", [text("Here:")]), sourceList()]);
  const answer = geminiAnswer([blocks]);
  const before = find(elem("main", [answer.modelResponse]), "gemini.google.com")[0];
  const btn = elem("button", [text("Verify")], { className: "sourcecheck-btn" });
  const report = div([text("report https://x.example/from-report")], { className: "sourcecheck-report" });
  blocks.childNodes.push(btn, report);
  btn.parentElement = report.parentElement = blocks;
  const after = find(elem("main", [answer.modelResponse]), "gemini.google.com")[0];
  assert.equal(after.insertion.parent, before.insertion.parent);
  assert.equal(after.insertion.before, before.insertion.before);
  assert.deepEqual(hrefsOf(after.extractionRoot), SOURCES, "report text is not extraction input");
});

test("Gemini: with no rendered block found it falls back to a slot appended to message-content", () => {
  const answer = geminiAnswer([div([text("just text")])]);
  const [t] = find(elem("main", [answer.modelResponse]), "gemini.google.com");
  assert.equal(t.insertion.parent, answer.messageContent);
  assert.equal(t.insertion.before, null);
  assert.equal(t.insertion.slot, true);
  assert.equal(t.insertion.anchor, null);
});

// Regression: in the live page the button was laid out in a different grid column
// from the report (button in the left gutter, report in the answer column) because
// they were two separate items of the content flow. Both must be one slot item, and
// that slot must belong to the inner content flow and follow the last content block.
test("Gemini: button and report share one slot that belongs to the inner content flow", () => {
  const sourceListEl = sourceList();
  const blocks = div([elem("p", [text("Here:")]), sourceListEl], { className: "markdown" });
  const answer = geminiAnswer([blocks]);
  const [t] = find(elem("main", [answer.modelResponse]), "gemini.google.com");
  assert.equal(t.insertion.slot, true, "one wrapper holds both the button and the report");
  assert.equal(t.insertion.parent, blocks, "the slot is a child of the inner content flow");
  assert.equal(t.insertion.anchor, sourceListEl, "and it follows the last content block");
  for (const outer of [answer.messageContent, ...answer.wide]) {
    assert.notEqual(t.insertion.parent, outer, `the slot is not a child of <${outer.tagName.toLowerCase()}>`);
  }
});

test("Gemini: with blocks directly in message-content the slot anchors on the last block there", () => {
  const list = sourceList();
  const answer = geminiAnswer([elem("p", [text("Here:")]), list]);
  const [t] = find(elem("main", [answer.modelResponse]), "gemini.google.com");
  assert.equal(t.insertion.slot, true);
  assert.equal(t.insertion.parent, answer.messageContent);
  assert.equal(t.insertion.anchor, list);
});

test("ChatGPT and Claude do not use a slot", () => {
  const turn = chatgptAssistantTurn(2, [sourceList()]);
  assert.equal("slot" in find(elem("main", [turn.unit]), "chatgpt.com")[0].insertion, false);
  const claude = div([elem("p", [text("x")])], { className: "font-claude-response" });
  assert.equal("slot" in find(elem("main", [claude]), "claude.ai")[0].insertion, false);
});

test("slotGridColumn: in a grid the slot copies the content block's own column", () => {
  assert.deepEqual(providers.slotGridColumn("grid", { gridColumnStart: "2", gridColumnEnd: "auto" }), { start: "2", end: "auto" });
  assert.deepEqual(providers.slotGridColumn("inline-grid", { gridColumnStart: "3", gridColumnEnd: "span 2" }), { start: "3", end: "span 2" });
  assert.deepEqual(providers.slotGridColumn("grid", { gridColumnStart: "auto", gridColumnEnd: "auto" }), { start: "auto", end: "auto" });
  assert.deepEqual(providers.slotGridColumn("grid", {}), { start: "auto", end: "auto" });
});

test("slotGridColumn: nothing is copied for non-grid parents or when there is no anchor", () => {
  for (const display of ["block", "flex", "inline-block", "contents", "", undefined]) {
    assert.equal(providers.slotGridColumn(display, { gridColumnStart: "2", gridColumnEnd: "auto" }), null, String(display));
  }
  assert.equal(providers.slotGridColumn("grid", null), null);
});

test("Gemini: a message-content inside the user's query is not an answer", () => {
  const userQuery = elem("user-query", [elem("message-content", [elem("p", [text("q")])])]);
  assert.equal(find(elem("main", [userQuery]), "gemini.google.com").length, 0);
});

test("Gemini: .model-response-text is only a fallback when no message-content exists", () => {
  const structured = elem("structured-content-container", [elem("p", [text("x")])], { className: "model-response-text" });
  const wrapper = elem("model-response", [div([structured], { className: "response-container-content" })]);
  const [t] = find(elem("main", [wrapper]), "gemini.google.com");
  assert.equal(t.extractionRoot, structured);
  assert.equal(find(elem("main", [geminiAnswer([elem("p", [text("x")])]).modelResponse]), "gemini.google.com").length, 1, "one target when both exist");
});

test("Gemini: several answers give one target each and links never cross over", () => {
  const a = geminiAnswer([elem("p", [anchor("https://first.example/a")])]);
  const b = geminiAnswer([elem("ul", [elem("li", [anchor("https://second.example/b")])])]);
  const targets = find(elem("main", [geminiUserQuery(), a.modelResponse, geminiUserQuery(), b.modelResponse]), "gemini.google.com");
  assert.equal(targets.length, 2);
  assert.deepEqual(targets.map((t) => t.extractionRoot), [a.messageContent, b.messageContent]);
  assert.deepEqual(hrefsOf(targets[0].extractionRoot), ["https://first.example/a"]);
  assert.deepEqual(hrefsOf(targets[1].extractionRoot), ["https://second.example/b"]);
});

// ---------- Claude ----------

test("Claude: the nested structure the old selectors matched gives exactly one target, UI appended to it", () => {
  const body = div([elem("p", [anchor(SOURCES[0])])], { className: "font-claude-response-body grid-cols-1" });
  const response = div([body], { className: "font-claude-response relative" });
  const user = div([text("q")], { className: "font-user-message" });
  const targets = find(elem("main", [user, response]), "claude.ai");
  assert.equal(targets.length, 1);
  assert.equal(targets[0].provider, "claude");
  assert.equal(targets[0].extractionRoot, response, "the outermost match, as before");
  assert.deepEqual(targets[0].insertion, { parent: response, before: null });
});

test("Claude: data-testid chat-message-content matches on any tag", () => {
  const msg = elem("section", [elem("p", [text("x")])], { attrs: { "data-testid": "chat-message-content" } });
  const targets = find(elem("main", [msg]), "claude.ai");
  assert.equal(targets.length, 1);
  assert.equal(targets[0].extractionRoot, msg);
});

test("Claude: class font-claude only matches on a div, and user messages are excluded", () => {
  const span = elem("span", [text("x")], { className: "font-claude-response" });
  const user = div([text("q")], { className: "font-user-message" });
  assert.equal(find(elem("main", [span, user]), "claude.ai").length, 0);
});

test("Claude: several answers give one target each", () => {
  const r1 = div([elem("p", [anchor("https://one.example/")])], { className: "font-claude-response" });
  const r2 = div([elem("p", [anchor("https://two.example/")])], { className: "font-claude-response" });
  const targets = find(elem("main", [r1, div([text("q")], { className: "font-user-message" }), r2]), "claude.ai");
  assert.deepEqual(targets.map((t) => t.extractionRoot), [r1, r2]);
  assert.deepEqual(hrefsOf(targets[0].extractionRoot), ["https://one.example/"]);
});

// ---------- shared ----------

test("provider is chosen by host", () => {
  assert.equal(providers.providerForHost("gemini.google.com"), "gemini");
  assert.equal(providers.providerForHost("claude.ai"), "claude");
  assert.equal(providers.providerForHost("chatgpt.com"), "chatgpt");
  assert.equal(providers.providerForHost("chat.openai.com"), "chatgpt");
});

test("nothing is returned for a page without answers, and SourceCheck's own UI is never an answer", () => {
  assert.deepEqual(find(elem("main", [div([text("hello")])]), "chatgpt.com"), []);
  const ui = div([div([text("x")], { attrs: { "data-markdown-text-style": "assistant-message" } })], { className: "sourcecheck-report" });
  assert.deepEqual(find(elem("main", [ui]), "chatgpt.com"), []);
});
