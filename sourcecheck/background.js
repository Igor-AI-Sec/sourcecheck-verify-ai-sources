// SourceCheck: background service worker.
//
// Receives a list of URLs plus surrounding text from the content script, checks
// them with direct requests from this browser to the target sites, and sends the
// results back. There is no SourceCheck server and no telemetry. The checking
// logic lives in lib/check.js; this file only wires it to the browser.

importScripts("lib/urls.js", "lib/score.js", "lib/check.js");

const checker = SourceCheckLib.createChecker();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "SOURCECHECK_VERIFY") return;
  const reply = checker.handleVerify(message, sender, (tabId, msg) => chrome.tabs.sendMessage(tabId, msg));
  sendResponse(reply);
});
