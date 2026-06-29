# Web Page Exporter

A zero-dependency Chrome (Manifest V3) extension that copies the current page's
HTML to your clipboard in one click — no more opening DevTools and hand-copying.

Built for the workflow of "grab the page so I can paste it into an AI for
context." You can copy the whole document, just the `<body>`, or only the
**main content** with the header, footer, navigation and sidebars stripped out.

## Three copy modes

| Mode | What you get | Shortcut |
| --- | --- | --- |
| **Full HTML** | The complete live document, including the `<!DOCTYPE>` and `<html>` — a faithful snapshot you can save as a standalone `.html` file. | `Alt+Shift+1` |
| **Body only** | The `<body>` element (with its tag and attributes). | `Alt+Shift+2` |
| **Main content** | The article/content container with header, footer, nav, asides, ads, scripts and styles removed. Best-effort, tuned for most blogs/news/docs/CMS sites. | `Alt+Shift+3` |
| **Markdown** | The main content converted to clean, minimal Markdown — headings, lists, links, images, code, blockquotes and tables — with a small context header (page **title**, **URL** and **description**). This is the most compact, readable way to hand a page's meaning to an AI. | _bind at_ `chrome://extensions/shortcuts` |

There are two ways to trigger a copy:

- **Floating hover buttons** — a small clipboard launcher sits in the
  bottom-right corner of every page. Hover it (or focus it with the keyboard)
  and the three copy buttons fade in. Toggle the launcher with `Alt+Shift+0`,
  or hide it with the **×** in the panel / the checkbox in the popup.
- **Toolbar popup** — click the extension icon for the same three buttons.
  This path always works even when a page is awkward, because the copy happens
  in the popup's own window.

## Install (unpacked)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked** and select this folder (the one containing
   `manifest.json`).
4. Pin the extension and you're ready. Reload any already-open tabs so the
   floating launcher appears on them.

## How "Main content" extraction works

A four-step priority cascade (all tunable in the `CONFIG` block at the top of
`src/extractor.js`):

1. **Semantic** — `<main>`, `[role="main"]`, then the largest `<article>`.
2. **Known CMS containers** — `.entry-content`, `.post-content`,
   `.markdown-body`, `#mw-content-text`, etc. (scored, best one wins).
3. **Density fallback** — a Readability-lite score (text length, comma count,
   paragraph count, positive/negative class-name hints, minus link density)
   with parent-hoisting, for pages with no semantic markup.
4. **Whole body** — last resort; the toast tells you when this happened.

Whatever is chosen is deep-cloned (the live page is never modified) and run
through a strip pass that removes `script`, `style`, `nav`, `header`, `footer`,
`aside`, `form`, hidden elements, and anything whose class/id looks like an ad,
share widget, comment block, newsletter, cookie banner, etc. Relative URLs are
rewritten to absolute so the copied markup keeps working when pasted elsewhere.

## Privacy

Everything happens **locally in your browser**. The extension makes no network
requests and sends nothing off your device. The page HTML only ever goes to
your clipboard. It requests the minimal permissions needed (`activeTab`,
`scripting`, `clipboardWrite`, `storage`) and reads the page only when you ask
it to copy.

## Known limitations

- **Full / Body** copy the *live, post-JavaScript DOM* (`outerHTML`), not the
  raw network response. Current DOM attribute state is included; canvas pixels
  and the internals of closed/encapsulated shadow roots are not serialized.
- **Cross-origin iframes** can't be read; their `<iframe>` placeholder remains.
- **Main content** detection is heuristic — on unusual layouts it may grab a
  little too much or too little. The toast warns when confidence is low, and
  the popup is always available as a clean fallback.
- Browser-protected pages (`chrome://`, the Web Store, `view-source:`, the New
  Tab page, `file://` without access) can't be exported — the popup says so and
  the floating launcher simply doesn't appear there.

## Files

```
manifest.json        MV3 manifest (permissions, content script, commands, icons)
src/extractor.js     Extraction core — getFullHTML / getBodyHTML / getMainHTML
src/clipboard.js     Clipboard helper (async API + execCommand fallback)
src/content.js       Floating Shadow-DOM launcher + message handling
src/popup.html/.css/.js   Toolbar popup (reliable fallback path)
src/background.js     Service worker — keyboard command routing
icons/               16 / 48 / 128 px icons
```

## Customising

Edit the `CONFIG` block at the top of `src/extractor.js` to add site-specific
content selectors, tweak the strip list, or adjust the positive/negative
keyword regexes. No build step — reload the extension from `chrome://extensions`
and the changes take effect.

Keyboard shortcuts can be remapped at `chrome://extensions/shortcuts`.
