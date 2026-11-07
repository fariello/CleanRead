# CleanRead

A lightweight MS Edge / Google Chrome extension (Manifest V3) that takes a pasted list of URLs, opens them one at a time, strips out navigation bars, headers, footers, sidebars, pop-ups, and media, and saves screen-reader-friendly, text-only Markdown files with `URL` and UTC `Timestamp` frontmatter.

## Output Format

Each page is saved to `Downloads/<Subfolder>/` (default `Downloads/CleanRead/`) as a pair of numbered files:
- `<prefix>-<title>.md` — Clean, text-only Markdown with frontmatter for screen readers.
- `<prefix>-<title>.html` — The full rendered page HTML after dynamic scripts and Cloudflare checks complete.

```markdown
---
URL: https://example.com/article
Timestamp: 2026-11-07T05:44:30.774Z
---

# Article Title

Clean, structured Markdown text without images, raw inline URLs, navbars, or footers.
```

## Installation (MS Edge / Google Chrome)

1. Open `edge://extensions` (in Edge) or `chrome://extensions` (in Chrome).
2. Enable **Developer mode**.
3. Click **Load unpacked** and select the `CleanRead` folder.
4. *(Recommended)* In browser download settings (`edge://settings/downloads` or `chrome://settings/downloads`), turn **off** *"Ask where to save each file before downloading"* so bulk runs save automatically without prompting for each URL.
