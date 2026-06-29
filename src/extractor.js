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

  // URL schemes that must never survive into cleaned output / be promoted.
  var SCRIPT_URL_RE = /^\s*(javascript|vbscript):/i;
  var SKIP_ABS_RE = /^(#|data:|mailto:|tel:|javascript:|vbscript:|blob:|about:)/i;
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
    if (el.offsetParent !== null) return true;
    // display:contents elements generate no box of their own but are visible —
    // common for unstyled semantic grouping wrappers (e.g. a <main>/.content div).
    try {
      var cs = getComputedStyle(el);
      if (cs && cs.display === "contents") return txtLen(el) > 0;
    } catch (e) {}
    return false;
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
  // Iterative (explicit stack) so pathologically deep DOMs can't overflow it.
  function removeHiddenSynced(liveRoot, cloneRoot) {
    var stack = [[liveRoot, cloneRoot]];
    while (stack.length) {
      var pair = stack.pop();
      var live = pair[0].children, clone = pair[1].children;
      for (var i = live.length - 1; i >= 0; i--) {
        var lk = live[i], ck = clone[i];
        if (!ck) continue;
        var cs;
        try { cs = getComputedStyle(lk); } catch (e) { cs = null; }
        if (cs && (cs.display === "none" || cs.visibility === "hidden")) { ck.remove(); continue; }
        stack.push([lk, ck]);
      }
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
      // Strip inline event handlers and ANY attribute carrying a script URL —
      // covers href, src, xlink:href, formaction, action, etc.
      var attrs = e.attributes;
      for (var a = attrs.length - 1; a >= 0; a--) {
        var an = attrs[a].name, av = attrs[a].value;
        if (/^on/i.test(an) || (av && SCRIPT_URL_RE.test(av))) e.removeAttribute(an);
      }
    }
  }

  // Rewrite relative URLs to absolute so copied content keeps working.
  function absolutize(root) {
    var base = document.baseURI;
    function abs(v) { try { return new URL(v, base).href; } catch (e) { return null; } }
    function absSrcset(val) {
      return val.split(",").map(function (part) {
        var s = part.trim();
        if (!s) return "";
        var sp = s.split(/\s+/);
        if (sp[0] && !SKIP_ABS_RE.test(sp[0])) { var a = abs(sp[0]); if (a) sp[0] = a; }
        return sp.join(" ");
      }).filter(Boolean).join(", ");
    }
    var nodes = root.querySelectorAll("[src], [href], [data-src], [srcset]");
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var ds = el.getAttribute("data-src");
      // promote lazy-load data-src -> src, but never a script: URL
      if (ds && !el.getAttribute("src") && !SKIP_ABS_RE.test(ds)) {
        var a1 = abs(ds); if (a1) el.setAttribute("src", a1);
      }
      ["src", "href"].forEach(function (attr) {
        var v = el.getAttribute(attr);
        if (v && !SKIP_ABS_RE.test(v)) { var a2 = abs(v); if (a2) el.setAttribute(attr, a2); }
      });
      var ss = el.getAttribute("srcset");
      if (ss) el.setAttribute("srcset", absSrcset(ss));
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

  /* ----------------  Markdown conversion  ----------------
   * Turns the cleaned main content into minimal, structure-preserving
   * Markdown — headings, lists, links, images, code, quotes, tables — so an
   * AI gets the page's meaning and context without the HTML noise. */
  var INLINE_TAGS = {
    a: 1, strong: 1, b: 1, em: 1, i: 1, code: 1, span: 1, img: 1, small: 1,
    sup: 1, sub: 1, u: 1, mark: 1, abbr: 1, time: 1, cite: 1, q: 1, label: 1,
    s: 1, del: 1, ins: 1, kbd: 1, var: 1, samp: 1, bdi: 1, bdo: 1, wbr: 1
  };

  function collapseWs(s) { return s.replace(/\s+/g, " "); }

  function inlineMd(node) {
    var out = "";
    var kids = node.childNodes;
    for (var i = 0; i < kids.length; i++) {
      var c = kids[i];
      if (c.nodeType === 3) { out += collapseWs(c.nodeValue); continue; }
      if (c.nodeType !== 1) continue;
      var tag = c.tagName.toLowerCase();
      if (tag === "br") { out += "  \n"; continue; }
      if (tag === "strong" || tag === "b") { var st = inlineMd(c).trim(); out += st ? "**" + st + "**" : ""; }
      else if (tag === "em" || tag === "i") { var et = inlineMd(c).trim(); out += et ? "*" + et + "*" : ""; }
      else if (tag === "s" || tag === "del") { var dt = inlineMd(c).trim(); out += dt ? "~~" + dt + "~~" : ""; }
      else if (tag === "code") { out += "`" + collapseWs(c.textContent) + "`"; }
      else if (tag === "a") {
        var href = c.getAttribute("href") || "";
        var t = inlineMd(c).trim() || href;
        out += href ? "[" + t + "](" + href + ")" : t;
      } else if (tag === "img") {
        var alt = collapseWs(c.getAttribute("alt") || "").trim();
        var src = c.getAttribute("src") || "";
        if (src) out += "![" + alt + "](" + src + ")";
      } else {
        out += inlineMd(c);
      }
    }
    return out;
  }

  function liContentMd(li) {
    var buf = "", extras = [];
    var kids = li.childNodes;
    for (var i = 0; i < kids.length; i++) {
      var c = kids[i];
      if (c.nodeType === 3) { buf += collapseWs(c.nodeValue); continue; }
      if (c.nodeType !== 1) continue;
      var tag = c.tagName.toLowerCase();
      if (tag === "ul" || tag === "ol") extras.push(listMd(c, tag === "ol"));
      else if (tag === "p" || tag === "div") buf += (buf ? " " : "") + inlineMd(c);
      else buf += inlineMd(c);
    }
    var first = collapseWs(buf).trim();
    var sub = extras.join("\n");
    return sub ? first + "\n" + sub : first;
  }

  function listMd(listEl, ordered) {
    var items = [], n = 1;
    for (var i = 0; i < listEl.children.length; i++) {
      var li = listEl.children[i];
      if (li.tagName.toLowerCase() !== "li") continue;
      var content = liContentMd(li);
      if (!content) continue;
      var marker = ordered ? (n++ + ". ") : "- ";
      var ls = content.split("\n");
      var first = marker + (ls.shift() || "");
      var rest = ls.map(function (l) { return l ? "  " + l : l; }).join("\n");
      items.push(rest ? first + "\n" + rest : first);
    }
    return items.join("\n");
  }

  function tableMd(table) {
    var rows = table.querySelectorAll("tr");
    if (!rows.length) return "";
    var grid = [];
    for (var r = 0; r < rows.length; r++) {
      var cells = rows[r].querySelectorAll("th, td");
      var row = [];
      for (var ci = 0; ci < cells.length; ci++) {
        row.push(inlineMd(cells[ci]).replace(/\n/g, " ").replace(/\|/g, "\\|").trim());
      }
      if (row.length) grid.push(row);
    }
    if (!grid.length) return "";
    var cols = 0;
    grid.forEach(function (g) { if (g.length > cols) cols = g.length; });
    function pad(a) { a = a.slice(); while (a.length < cols) a.push(""); return a; }
    var lines = [];
    lines.push("| " + pad(grid[0]).join(" | ") + " |");
    lines.push("| " + pad(grid[0]).map(function () { return "---"; }).join(" | ") + " |");
    for (var g = 1; g < grid.length; g++) lines.push("| " + pad(grid[g]).join(" | ") + " |");
    return lines.join("\n");
  }

  function blockMd(node) {
    var out = [], buf = "";
    function flush() { var t = collapseWs(buf).trim(); if (t) out.push(t); buf = ""; }
    var kids = node.childNodes;
    for (var i = 0; i < kids.length; i++) {
      var c = kids[i];
      if (c.nodeType === 3) { buf += collapseWs(c.nodeValue); continue; }
      if (c.nodeType !== 1) continue;
      var tag = c.tagName.toLowerCase();
      if (tag === "br") { buf += "  \n"; continue; }
      if (INLINE_TAGS[tag]) { buf += inlineMd(c); continue; }
      if (/^h[1-6]$/.test(tag)) { flush(); out.push(new Array(+tag[1] + 1).join("#") + " " + inlineMd(c).trim()); }
      else if (tag === "p") { flush(); var p = inlineMd(c).trim(); if (p) out.push(p); }
      else if (tag === "hr") { flush(); out.push("---"); }
      else if (tag === "ul" || tag === "ol") { flush(); var l = listMd(c, tag === "ol"); if (l) out.push(l); }
      else if (tag === "blockquote") {
        flush();
        var q = blockMd(c).trim();
        if (q) out.push(q.split("\n").map(function (x) { return x ? "> " + x : ">"; }).join("\n"));
      } else if (tag === "pre") {
        flush();
        out.push("```\n" + c.textContent.replace(/\n+$/, "") + "\n```");
      } else if (tag === "table") { flush(); var tm = tableMd(c); if (tm) out.push(tm); }
      else { var inner = blockMd(c).trim(); if (inner) { flush(); out.push(inner); } }
    }
    flush();
    return out.join("\n\n");
  }

  function pageMeta() {
    var title = (document.title || "").trim();
    var desc = "";
    var m = document.querySelector('meta[name="description"], meta[property="og:description"]');
    if (m) desc = collapseWs(m.getAttribute("content") || "").trim();
    var url = "";
    try { url = (document.location && document.location.href) || document.baseURI || ""; } catch (e) { url = document.baseURI || ""; }
    return { title: title, desc: desc, url: url };
  }

  function getMarkdown() {
    var pick = pickMainElement();
    var meta = pageMeta();
    var parts = [];
    if (meta.title) parts.push("# " + meta.title);
    var ctx = [];
    if (meta.url) ctx.push("**URL:** " + meta.url);
    if (meta.desc) ctx.push("**Description:** " + meta.desc);
    if (ctx.length) parts.push(ctx.join("  \n"));

    var body = "";
    if (pick.element) {
      var clone = pick.element.cloneNode(true);
      try { removeHiddenSynced(pick.element, clone); } catch (e) {}
      stripJunk(clone);
      absolutize(clone);
      body = blockMd(clone).trim();
    }
    if (body) parts.push(body);

    var out = parts.join("\n\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
    if (!out.trim()) return { ok: false, html: "", confidence: "none" };
    return { ok: true, html: out, confidence: pick.confidence };
  }

  globalThis.__WPE_EXTRACTOR = {
    get: function (mode) {
      if (mode === "full") return getFullHTML();
      if (mode === "body") return getBodyHTML();
      if (mode === "main") return getMainHTML();
      if (mode === "md") return getMarkdown();
      return { ok: false, html: "", confidence: "none" };
    },
    getFullHTML: getFullHTML,
    getBodyHTML: getBodyHTML,
    getMainHTML: getMainHTML,
    getMarkdown: getMarkdown
  };
})();
