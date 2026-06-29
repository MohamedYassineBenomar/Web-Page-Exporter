/*
 * Web Page Exporter — extraction core (the single source of truth).
 *
 * Exposes globalThis.__WPE_EXTRACTOR with:
 *   .get(mode)        -> {ok, html, confidence}  mode = "full" | "body" | "main"
 *   .getFullHTML()    -> faithful snapshot of the whole document (incl. doctype)
 *   .getBodyHTML()    -> the <body> element (outerHTML)
 *   .getMainHTML()    -> cleaned main/article content (header/footer/nav stripped)
 *
 * Runs in the content-script isolated world. Also injected on demand by the
 * popup / service worker via chrome.scripting.executeScript({files:[...]}).
 * It never mutates the live page — extraction always works on a deep clone.
 */
(function () {
  "use strict";
  if (globalThis.__WPE_EXTRACTOR) return; // idempotent: safe to inject twice

  /* =====================  CONFIG (edit me)  ===================== *
   * Tune the main-content heuristics here. Everything below uses
   * these lists/thresholds so behaviour is easy to adjust per-site. */
  var SEMANTIC_SELECTORS = ["main", '[role="main"]', "article"];

  var CMS_SELECTORS = [
    "#content", "#main", "#main-content", "#primary", "#bodyContent",
    "#mw-content-text", ".main-content", ".post-content", ".entry-content",
    ".article-content", ".article-body", ".post-body", ".story-body",
    ".content__article-body", ".blog-post", ".markdown-body", ".prose",
    ".rich-text", ".td-post-content", '[itemprop="articleBody"]',
    "#bodyContent .mw-parser-output"
  ];

  var STRIP_SELECTORS = [
    "script", "style", "noscript", "template", "iframe", "object", "embed",
    "link", "meta", "header", "footer", "nav", "aside", "form",
    '[role="banner"]', '[role="navigation"]', '[role="complementary"]',
    '[role="contentinfo"]', '[role="search"]', '[aria-hidden="true"]', "[hidden]"
  ];

  var POSITIVE_RE = /(article|content|entry|main|post|story|text|blog|body[-_]?text)/i;
  var NEGATIVE_RE = /(comment|sidebar|footer|header|menu|nav|share|social|promo|ad[-_]|advert|widget|related|recirc|breadcrumb|pagination|byline|caption|cookie|banner|popup|modal|sticky|newsletter|subscribe|skip[-_]?link)/i;

  var MIN_TEXT = 200;          // a candidate must have this much text to count
  var FALLBACK_MIN_TEXT = 250; // density-fallback winner must clear this
  var FALLBACK_MIN_SCORE = 20; // ...and this score
  /* ===================  end CONFIG  =================== */

  function txtLen(el) { return el && el.textContent ? el.textContent.trim().length : 0; }
  function text(el) { return el && el.textContent ? el.textContent.trim() : ""; }
  function idClass(el) {
    // getAttribute keeps this a string even for SVG (where .className is an object)
    return ((el.getAttribute && el.getAttribute("class")) || "") + " " + (el.id || "");
  }

  var STRIP_TAGS = { nav: 1, header: 1, footer: 1, aside: 1 };
  function isStructuralChrome(el) {
    return !!STRIP_TAGS[el.tagName ? el.tagName.toLowerCase() : ""];
  }

  function hasLayoutBox(el) {
    if (el === document.body) return true;
    if (el.getClientRects && el.getClientRects().length > 0) return true;
    return el.offsetParent !== null;
  }

  function isSubstantial(el) {
    if (!el || isStructuralChrome(el)) return false;
    if (!hasLayoutBox(el)) return false;
    return txtLen(el) >= MIN_TEXT;
  }

  // Readability-lite score for a single element.
  function scoreNode(el) {
    if (!el) return 0;
    var t = text(el);
    var len = t.length;
    if (len === 0) return 0;
    var commas = (t.match(/,/g) || []).length;
    var score = commas + Math.min(Math.floor(len / 100), 3);

    var tag = el.tagName.toLowerCase();
    if (tag === "article" || tag === "section" || tag === "main") score += 5;
    score += Math.min(el.getElementsByTagName("p").length, 10);

    var ic = idClass(el);
    if (POSITIVE_RE.test(ic)) score += 25;
    if (NEGATIVE_RE.test(ic)) score -= 25;

    // Link density: punish nav/link-heavy blocks.
    var links = el.getElementsByTagName("a");
    var linkLen = 0;
    for (var i = 0; i < links.length; i++) linkLen += text(links[i]).length;
    var density = Math.min(linkLen / len, 1);
    return score * (1 - density);
  }

  // STEP 3 — density / Readability-lite fallback.
  function densityPick() {
    if (!document.body) return null;
    var candidates = document.body.querySelectorAll("p, div, section, article, td, main");
    var scores = new Map();
    for (var i = 0; i < candidates.length; i++) {
      var el = candidates[i];
      if (txtLen(el) < 25) continue;
      var s = scoreNode(el);
      scores.set(el, (scores.get(el) || 0) + s);
      var parent = el.parentElement;
      if (parent) scores.set(parent, (scores.get(parent) || 0) + s * 0.25);
    }
    var best = null, bestScore = -Infinity;
    scores.forEach(function (s, el) { if (s > bestScore) { bestScore = s; best = el; } });
    if (!best) return null;

    // Hoist to parent when it aggregates ~as much, to avoid clipping siblings.
    var parent = best.parentElement;
    if (parent && parent !== document.body) {
      var ps = scores.get(parent) || 0;
      if (ps >= bestScore * 0.85) best = parent;
    }
    if (txtLen(best) > FALLBACK_MIN_TEXT && bestScore > FALLBACK_MIN_SCORE) return best;
    return null;
  }

  // The priority cascade: semantic -> CMS -> density -> body.
  function pickMainElement() {
    // STEP 1 — semantic, author intent. Largest match wins (avoids one card).
    for (var i = 0; i < SEMANTIC_SELECTORS.length; i++) {
      var nodes = document.querySelectorAll(SEMANTIC_SELECTORS[i]);
      var best = null, bestLen = 0;
      for (var j = 0; j < nodes.length; j++) {
        if (isSubstantial(nodes[j])) {
          var l = txtLen(nodes[j]);
          if (l > bestLen) { bestLen = l; best = nodes[j]; }
        }
      }
      if (best) return { element: best, confidence: "high" };
    }

    // STEP 2 — known CMS containers, best score wins.
    var cmsBest = null, cmsScore = -Infinity;
    for (var k = 0; k < CMS_SELECTORS.length; k++) {
      var cn = document.querySelectorAll(CMS_SELECTORS[k]);
      for (var m = 0; m < cn.length; m++) {
        if (isSubstantial(cn[m])) {
          var sc = scoreNode(cn[m]);
          if (sc > cmsScore) { cmsScore = sc; cmsBest = cn[m]; }
        }
      }
    }
    if (cmsBest) return { element: cmsBest, confidence: "high" };

    // STEP 3 — density fallback.
    var dens = densityPick();
    if (dens) return { element: dens, confidence: "medium" };

    // STEP 4 — last resort: whole body.
    if (document.body) return { element: document.body, confidence: "low" };
    return { element: null, confidence: "none" };
  }

  // Remove, from the CLONE, any element that is display:none / visibility:hidden
  // in the LIVE tree. Both trees share identical structure (clone made just now),
  // so we walk them in lockstep. getComputedStyle is read off the live node only.
  function removeHiddenSynced(liveEl, cloneEl) {
    var live = liveEl.children, clone = cloneEl.children;
    for (var i = live.length - 1; i >= 0; i--) {
      var lk = live[i], ck = clone[i];
      if (!ck) continue;
      var cs;
      try { cs = getComputedStyle(lk); } catch (e) { cs = null; }
      if (cs && (cs.display === "none" || cs.visibility === "hidden")) { ck.remove(); continue; }
      removeHiddenSynced(lk, ck);
    }
  }

  // Strip chrome/ads/scripts and neutralise inline handlers on a detached clone.
  function stripJunk(root) {
    STRIP_SELECTORS.forEach(function (sel) {
      var nodes;
      try { nodes = root.querySelectorAll(sel); } catch (e) { return; }
      for (var i = nodes.length - 1; i >= 0; i--) nodes[i].remove();
    });

    var all = root.querySelectorAll("*");
    for (var j = all.length - 1; j >= 0; j--) {
      var el = all[j];
      if (!root.contains(el)) continue; // ancestor already removed (clone is detached)
      var ic = idClass(el).trim();
      if (ic && NEGATIVE_RE.test(ic)) { el.remove(); continue; }
    }

    var rest = root.querySelectorAll("*");
    for (var k = 0; k < rest.length; k++) {
      var e = rest[k];
      var style = e.getAttribute("style");
      if (style && /display\s*:\s*none|visibility\s*:\s*hidden/i.test(style)) { e.remove(); continue; }
      var attrs = e.attributes;
      for (var a = attrs.length - 1; a >= 0; a--) {
        if (/^on/i.test(attrs[a].name)) e.removeAttribute(attrs[a].name);
      }
      var href = e.getAttribute("href");
      if (href && /^\s*javascript:/i.test(href)) e.removeAttribute("href");
      var src = e.getAttribute("src");
      if (src && /^\s*javascript:/i.test(src)) e.removeAttribute("src");
    }
  }

  // Rewrite relative URLs to absolute so copied content keeps working.
  function absolutize(root) {
    var base = document.baseURI;
    var nodes = root.querySelectorAll("[src], [href], [data-src]");
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var ds = el.getAttribute("data-src");
      if (ds && !el.getAttribute("src")) {
        try { el.setAttribute("src", new URL(ds, base).href); } catch (e) {}
      }
      ["src", "href"].forEach(function (attr) {
        var v = el.getAttribute(attr);
        if (v && !/^(#|data:|mailto:|tel:|javascript:|blob:)/i.test(v)) {
          try { el.setAttribute(attr, new URL(v, base).href); } catch (e) {}
        }
      });
    }
  }

  function getFullHTML() {
    var dt = "";
    if (document.doctype) {
      try { dt = new XMLSerializer().serializeToString(document.doctype); } catch (e) { dt = ""; }
    }
    var root = document.documentElement;
    var html = root ? root.outerHTML : "";
    return { ok: !!html, html: dt ? dt + "\n" + html : html, confidence: "high" };
  }

  function getBodyHTML() {
    var el = document.body || document.documentElement;
    if (!el) return { ok: false, html: "", confidence: "none" };
    return { ok: true, html: el.outerHTML, confidence: "high" };
  }

  function getMainHTML() {
    var pick = pickMainElement();
    if (!pick.element) return { ok: false, html: "", confidence: "none" };
    var clone = pick.element.cloneNode(true);
    try { removeHiddenSynced(pick.element, clone); } catch (e) {}
    stripJunk(clone);
    absolutize(clone);
    var html = clone.outerHTML;
    if (!html || !html.trim()) return { ok: false, html: "", confidence: pick.confidence };
    return { ok: true, html: html, confidence: pick.confidence };
  }

  globalThis.__WPE_EXTRACTOR = {
    get: function (mode) {
      if (mode === "full") return getFullHTML();
      if (mode === "body") return getBodyHTML();
      if (mode === "main") return getMainHTML();
      return { ok: false, html: "", confidence: "none" };
    },
    getFullHTML: getFullHTML,
    getBodyHTML: getBodyHTML,
    getMainHTML: getMainHTML
  };
})();
