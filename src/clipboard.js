/*
 * Web Page Exporter — clipboard helper (shared by the content script and popup).
 *
 * globalThis.__WPE_COPY(text, container?) -> Promise<{ok, bytes}>
 *   Tries the async Clipboard API first (works in secure contexts inside a user
 *   gesture), then falls back synchronously to a hidden <textarea> + execCommand
 *   for http pages, focus-loss, or very large payloads. `container` lets the
 *   content script mount the temp textarea inside its Shadow root.
 */
(function () {
  "use strict";
  if (globalThis.__WPE_COPY) return;

  function byteSize(text) {
    try { return new Blob([text]).size; } catch (e) { return text.length; }
  }

  function fallbackCopy(text, container) {
    try {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.top = "-9999px";
      ta.style.left = "-9999px";
      ta.style.width = "1px";
      ta.style.height = "1px";
      ta.style.opacity = "0";
      var host = container || document.body || document.documentElement;
      host.appendChild(ta);
      var prev = document.activeElement;
      ta.focus();
      ta.select();
      try { ta.setSelectionRange(0, text.length); } catch (e) {}
      var ok = false;
      try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
      ta.remove();
      try { if (prev && prev.focus) prev.focus(); } catch (e) {}
      return ok;
    } catch (e) {
      return false;
    }
  }

  globalThis.__WPE_COPY = async function copy(text, container) {
    var bytes = byteSize(text);
    if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        return { ok: true, bytes: bytes };
      } catch (e) {
        // permissions/focus issue — fall through to execCommand
      }
    }
    return { ok: fallbackCopy(text, container), bytes: bytes };
  };
})();
