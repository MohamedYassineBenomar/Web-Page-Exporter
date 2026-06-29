/*
 * Web Page Exporter — popup controller (the reliable fallback).
 *
 * On click: inject the extractor into the active tab, get the HTML string back,
 * and copy it here in the popup's own focused document (sidesteps page-focus
 * clipboard issues entirely). Detects browser-protected pages up front.
 */
"use strict";

// Pages where content scripts / executeScript are not allowed.
var PROTECTED = /^(chrome|edge|brave|opera|vivaldi|about|chrome-extension|moz-extension|view-source|devtools|data):|^https?:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com)/i;

function setStatus(msg, kind) {
  var el = document.getElementById("status");
  el.textContent = msg;
  el.className = "status" + (kind ? " " + kind : "");
}

function fmtBytes(n) {
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
  return (n / 1048576).toFixed(2) + " MB";
}

async function activeTab() {
  var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs && tabs[0];
}

async function getHtmlFromTab(tabId, mode) {
  // Make sure the extractor is present (idempotent), then run it and read back.
  await chrome.scripting.executeScript({ target: { tabId: tabId }, files: ["src/extractor.js"] });
  var res = await chrome.scripting.executeScript({
    target: { tabId: tabId },
    func: function (m) { return globalThis.__WPE_EXTRACTOR.get(m); },
    args: [mode]
  });
  return res && res[0] ? res[0].result : null;
}

async function doCopy(mode) {
  var tab = await activeTab();
  if (!tab || !tab.id) { setStatus("No active tab.", "err"); return; }
  if (tab.url && PROTECTED.test(tab.url)) {
    setStatus("This page can't be exported (browser-protected page).", "err");
    return;
  }
  setStatus("Copying…");
  var out;
  try {
    out = await getHtmlFromTab(tab.id, mode);
  } catch (e) {
    setStatus("Can't access this page. Reload it and try again.", "err");
    return;
  }
  if (!out || !out.ok || !out.html) {
    setStatus(mode === "main" ? "No content found on this page." : "Nothing to copy here.", "err");
    return;
  }
  var r = await window.__WPE_COPY(out.html);
  if (r.ok) {
    var note = (mode === "main" && out.confidence === "low")
      ? " (whole page — no main content found)" : "";
    setStatus("Copied " + fmtBytes(r.bytes) + note + ".", "ok");
  } else {
    setStatus("Copy failed.", "err");
  }
}

document.getElementById("full").addEventListener("click", function () { doCopy("full"); });
document.getElementById("body").addEventListener("click", function () { doCopy("body"); });
document.getElementById("main").addEventListener("click", function () { doCopy("main"); });

// Floating-launcher on/off preference, synced live to the active tab.
(async function () {
  var cb = document.getElementById("launcher-toggle");
  try {
    var cfg = await chrome.storage.local.get("wpe_launcher_enabled");
    cb.checked = cfg.wpe_launcher_enabled !== false;
  } catch (e) {}
  cb.addEventListener("change", async function () {
    try { await chrome.storage.local.set({ wpe_launcher_enabled: cb.checked }); } catch (e) {}
    var tab = await activeTab();
    if (tab && tab.id && !(tab.url && PROTECTED.test(tab.url))) {
      try {
        await chrome.tabs.sendMessage(tab.id, { type: "WPE_SET_ENABLED", enabled: cb.checked });
      } catch (e) { /* content script may not be loaded on this page; that's fine */ }
    }
  });
})();
