/*
 * Web Page Exporter — service worker.
 * Owns the keyboard commands; routes them to the active tab's content script,
 * injecting the scripts on demand if the content script isn't present yet.
 */
"use strict";

var MODE_BY_COMMAND = { "copy-full": "full", "copy-body": "body", "copy-main": "main", "copy-md": "md" };

var PROTECTED = /^(chrome|edge|brave|opera|vivaldi|about|chrome-extension|moz-extension|view-source|devtools|data):|^https?:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com)/i;

chrome.runtime.onInstalled.addListener(function () {
  chrome.storage.local.get("wpe_launcher_enabled").then(function (o) {
    if (o.wpe_launcher_enabled === undefined) {
      chrome.storage.local.set({ wpe_launcher_enabled: true });
    }
  }).catch(function () {});
});

async function ensureScripts(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId: tabId },
    files: ["src/extractor.js", "src/clipboard.js", "src/content.js"]
  });
}

async function sendOrInject(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (e) {
    // No receiver yet — inject the content scripts, then retry once.
    await ensureScripts(tabId);
    return await chrome.tabs.sendMessage(tabId, message);
  }
}

chrome.commands.onCommand.addListener(async function (command) {
  var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  var tab = tabs && tabs[0];
  if (!tab || !tab.id) return;
  if (tab.url && PROTECTED.test(tab.url)) return; // can't act on protected pages

  if (command === "toggle-launcher") {
    try { await sendOrInject(tab.id, { type: "WPE_TOGGLE" }); } catch (e) {}
    return;
  }

  var mode = MODE_BY_COMMAND[command];
  if (!mode) return;
  // The page is focused during a keyboard shortcut, so the content script can
  // write to the clipboard. It also shows the success/error toast.
  try { await sendOrInject(tab.id, { type: "WPE_COPY", mode: mode }); } catch (e) {}
});
