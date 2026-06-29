/*
 * Web Page Exporter — content script (the on-page UI + brain).
 *
 * Mounts a Shadow-DOM-isolated floating launcher that expands on hover into
 * three copy buttons. Wires them to __WPE_EXTRACTOR + __WPE_COPY and shows a
 * toast. Also answers messages from the popup / service worker (copy / toggle).
 */
(function () {
  "use strict";
  if (window.__wpeInjected) return; // guard against double-injection
  window.__wpeInjected = true;

  var HOST_ID = "wpe-host";
  var enabled = true;     // user pref (chrome.storage.local)
  var dismissed = false;  // per-page-load dismiss via the "×"
  var corner = "bottom-right";

  var host, shadow, root, panel, launcher;
  var toastHost, toastShadow, toastEl, toastTimer, closeTimer, observer;

  /* ----------------------------- styles ----------------------------- */
  var CSS = "" +
    ":host{all:initial;}" +
    "*{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;}" +
    ".root{position:fixed;display:flex;flex-direction:column-reverse;align-items:flex-end;gap:8px;z-index:2147483647;pointer-events:none;}" +
    ".root.bottom-right{right:16px;bottom:16px;}" +
    ".root.bottom-left{left:16px;bottom:16px;align-items:flex-start;}" +
    ".root.top-right{right:16px;top:16px;flex-direction:column;}" +
    ".root.top-left{left:16px;top:16px;flex-direction:column;align-items:flex-start;}" +
    ".launcher{pointer-events:auto;width:40px;height:40px;border:none;border-radius:50%;cursor:pointer;" +
      "display:flex;align-items:center;justify-content:center;background:#2b6cb0;color:#fff;" +
      "box-shadow:0 2px 8px rgba(0,0,0,.28);opacity:.5;transition:opacity .15s ease,transform .15s ease;padding:0;}" +
    ".launcher:hover,.launcher:focus-visible{opacity:1;outline:none;}" +
    ".launcher svg{width:20px;height:20px;display:block;}" +
    ".panel{pointer-events:none;display:flex;flex-direction:column;gap:6px;min-width:168px;padding:8px;" +
      "background:#ffffff;color:#1a202c;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.22);" +
      "opacity:0;transform:translateY(8px);transition:opacity .15s ease,transform .15s ease;}" +
    ".root.open .panel{pointer-events:auto;opacity:1;transform:translateY(0);}" +
    ".root.open .launcher{opacity:1;}" +
    ".phead{display:flex;align-items:center;justify-content:space-between;font-size:11px;font-weight:600;" +
      "letter-spacing:.04em;text-transform:uppercase;color:#718096;padding:0 2px 2px;}" +
    ".dismiss{pointer-events:auto;border:none;background:transparent;color:#a0aec0;cursor:pointer;font-size:15px;" +
      "line-height:1;padding:2px 4px;border-radius:4px;}" +
    ".dismiss:hover{color:#e53e3e;background:rgba(0,0,0,.05);}" +
    ".btn{pointer-events:auto;display:flex;flex-direction:column;align-items:flex-start;gap:1px;text-align:left;" +
      "border:1px solid #e2e8f0;background:#f7fafc;color:#1a202c;border-radius:7px;padding:7px 10px;cursor:pointer;" +
      "font-size:13px;font-weight:600;transition:background .12s ease,border-color .12s ease;}" +
    ".btn small{font-weight:400;font-size:11px;color:#718096;}" +
    ".btn:hover{background:#ebf4ff;border-color:#90cdf4;}" +
    ".btn:active{background:#bee3f8;}" +
    ".btn:focus-visible{outline:2px solid #2b6cb0;outline-offset:1px;}" +
    ".toast{position:fixed;pointer-events:none;background:#1a202c;color:#fff;font-size:12.5px;font-weight:500;" +
      "padding:8px 12px;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.3);opacity:0;transform:translateY(6px);" +
      "transition:opacity .18s ease,transform .18s ease;max-width:300px;}" +
    ".toast.show{opacity:1;transform:translateY(0);}" +
    ".toast.err{background:#c53030;}" +
    ".toast.bottom-right,.toast.top-right{right:16px;}" +
    ".toast.bottom-left,.toast.top-left{left:16px;}" +
    ".toast.bottom-right,.toast.bottom-left{bottom:66px;}" +
    ".toast.top-right,.toast.top-left{top:66px;}" +
    "@media (prefers-color-scheme:dark){" +
      ".panel{background:#2d3748;color:#f7fafc;}" +
      ".btn{background:#1a202c;border-color:#4a5568;color:#f7fafc;}" +
      ".btn small{color:#a0aec0;}" +
      ".btn:hover{background:#2c5282;border-color:#4299e1;}" +
      ".btn:active{background:#2b6cb0;}" +
      ".toast{background:#000;}" +
    "}" +
    "@media (prefers-reduced-motion:reduce){.launcher,.panel,.toast{transition:none;}}";

  var CLIP_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="9" y="9" width="11" height="11" rx="2"></rect>' +
    '<path d="M5 15V5a2 2 0 0 1 2-2h10"></path></svg>';

  var MODES = [
    { mode: "full", label: "Full HTML", desc: "complete document" },
    { mode: "body", label: "Body", desc: "the <body> element" },
    { mode: "main", label: "Main content", desc: "no header / footer / nav" },
    { mode: "md", label: "Markdown", desc: "clean text for AI context" }
  ];

  /* ----------------------------- build UI ----------------------------- */
  function buildUI() {
    host = document.createElement("div");
    host.id = HOST_ID;
    host.style.cssText = "all:initial;position:fixed;z-index:2147483647;";
    shadow = host.attachShadow({ mode: "open" });

    var style = document.createElement("style");
    style.textContent = CSS;
    shadow.appendChild(style);

    root = document.createElement("div");
    root.className = "root " + corner;

    launcher = document.createElement("button");
    launcher.type = "button";
    launcher.className = "launcher";
    launcher.setAttribute("aria-label", "Web Page Exporter — copy page HTML");
    launcher.setAttribute("aria-haspopup", "menu");
    launcher.innerHTML = CLIP_SVG;
    launcher.addEventListener("click", function (e) { e.stopPropagation(); toggleOpen(); });

    panel = document.createElement("div");
    panel.className = "panel";
    panel.setAttribute("role", "menu");

    var phead = document.createElement("div");
    phead.className = "phead";
    var title = document.createElement("span");
    title.textContent = "Copy HTML";
    var dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "dismiss";
    dismiss.textContent = "×";
    dismiss.setAttribute("aria-label", "Hide the floating buttons for now");
    dismiss.addEventListener("click", function (e) { e.stopPropagation(); dismissed = true; applyVisibility(); });
    phead.appendChild(title);
    phead.appendChild(dismiss);
    panel.appendChild(phead);

    MODES.forEach(function (m) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "btn";
      b.setAttribute("role", "menuitem");
      b.setAttribute("aria-label", "Copy " + m.label);
      b.innerHTML = "";
      var strong = document.createElement("span");
      strong.textContent = m.label;
      var small = document.createElement("small");
      small.textContent = m.desc;
      b.appendChild(strong);
      b.appendChild(small);
      b.addEventListener("click", function (e) { e.stopPropagation(); doCopy(m.mode); });
      panel.appendChild(b);
    });

    root.appendChild(panel);
    root.appendChild(launcher);
    shadow.appendChild(root);

    // The toast lives in its OWN host so it stays visible even when the launcher
    // is disabled/dismissed — e.g. to give feedback for keyboard-shortcut copies.
    toastHost = document.createElement("div");
    toastHost.id = "wpe-toast-host";
    toastHost.style.cssText = "all:initial;";
    toastShadow = toastHost.attachShadow({ mode: "open" });
    var tstyle = document.createElement("style");
    tstyle.textContent = CSS;
    toastShadow.appendChild(tstyle);
    toastEl = document.createElement("div");
    toastEl.className = "toast " + corner;
    toastEl.setAttribute("role", "status");
    toastEl.setAttribute("aria-live", "polite");
    toastShadow.appendChild(toastEl);

    // Hover reveal: mouseenter/leave on root treat descendants as one region,
    // so moving from launcher to the (absolutely-offset) panel won't close it.
    root.addEventListener("mouseenter", openMenu);
    root.addEventListener("mouseleave", scheduleClose);
    root.addEventListener("focusin", openMenu);
    root.addEventListener("focusout", scheduleClose);
    root.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { closeMenu(); launcher.blur(); }
    });
    // When opened via hover, focus is still on the page, so the shadow-level
    // handler never sees the keydown — listen on document too (passive: it only
    // acts when our menu is open, never preventDefaults or stops propagation).
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && root.classList.contains("open")) {
        closeMenu();
        try { launcher.blur(); } catch (_) {}
      }
    }, true);
  }

  function openMenu() { clearTimeout(closeTimer); root.classList.add("open"); }
  function closeMenu() { root.classList.remove("open"); }
  function scheduleClose() { clearTimeout(closeTimer); closeTimer = setTimeout(closeMenu, 250); }
  function toggleOpen() { root.classList.contains("open") ? closeMenu() : openMenu(); }

  /* ----------------------------- behaviour ----------------------------- */
  function fmtBytes(n) {
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
    return (n / 1048576).toFixed(2) + " MB";
  }

  function showToast(msg, isErr) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.className = "toast " + corner + (isErr ? " err" : "");
    // force reflow so the transition restarts on rapid repeats
    void toastEl.offsetWidth;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove("show"); }, 2000);
  }

  function doCopy(mode) {
    var out;
    try {
      out = globalThis.__WPE_EXTRACTOR.get(mode);
    } catch (e) {
      showToast("Couldn't read the page.", true);
      return Promise.resolve({ ok: false });
    }
    if (!out || !out.ok || !out.html) {
      showToast(mode === "main" ? "No content found to copy." : "Nothing to copy here.", true);
      return Promise.resolve({ ok: false });
    }
    // Mount the execCommand fallback's textarea in the always-visible toast
    // shadow (the launcher's host may be display:none when disabled/dismissed).
    return globalThis.__WPE_COPY(out.html, toastShadow).then(function (r) {
      if (r.ok) {
        var note = ((mode === "main" || mode === "md") && out.confidence === "low")
          ? " (whole page — no main content found)" : "";
        showToast("Copied " + fmtBytes(r.bytes) + note + ".", false);
      } else {
        showToast("Copy failed — try the toolbar button.", true);
      }
      return { ok: r.ok, bytes: r.bytes, confidence: out.confidence };
    });
  }

  /* ------------------------- mount / visibility ------------------------- */
  function ensureMounted() {
    if (!host) buildUI();
    if (document.documentElement) {
      if (!host.isConnected) document.documentElement.appendChild(host);
      if (toastHost && !toastHost.isConnected) document.documentElement.appendChild(toastHost);
    }
  }

  function applyVisibility() {
    if (!host) return;
    host.style.display = (enabled && !dismissed) ? "" : "none";
  }

  // Re-append our host if an SPA / framework wipes documentElement's children.
  function watchDom() {
    if (observer || !document.documentElement) return;
    var pending = false;
    observer = new MutationObserver(function () {
      if (pending) return;
      pending = true;
      setTimeout(function () {
        pending = false;
        if ((host && !host.isConnected) || (toastHost && !toastHost.isConnected)) ensureMounted();
      }, 300);
    });
    observer.observe(document.documentElement, { childList: true });
  }

  /* ----------------------------- messaging ----------------------------- */
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || !msg.type) return;
    if (msg.type === "WPE_PING") { sendResponse({ pong: true }); return; }
    if (msg.type === "WPE_COPY") {
      doCopy(msg.mode).then(sendResponse);
      return true; // async response
    }
    if (msg.type === "WPE_TOGGLE") {
      dismissed = !dismissed;
      if (!dismissed) enabled = true;
      applyVisibility();
      if (!dismissed && enabled) { ensureMounted(); openMenu(); scheduleClose(); }
      sendResponse({ visible: enabled && !dismissed });
      return;
    }
    if (msg.type === "WPE_SET_ENABLED") {
      enabled = !!msg.enabled;
      if (enabled) dismissed = false;
      ensureMounted();
      applyVisibility();
      sendResponse({ ok: true });
      return;
    }
  });

  /* ------------------------------- init ------------------------------- */
  function init() {
    try {
      chrome.storage.local.get(["wpe_launcher_enabled", "wpe_corner"], function (cfg) {
        if (cfg && cfg.wpe_launcher_enabled === false) enabled = false;
        if (cfg && cfg.wpe_corner) corner = cfg.wpe_corner;
        ensureMounted();
        applyVisibility();
        watchDom();
      });
    } catch (e) {
      ensureMounted();
      applyVisibility();
      watchDom();
    }
    window.addEventListener("pageshow", function () { if (enabled && !dismissed) ensureMounted(); });
  }

  init();
})();
