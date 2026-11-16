# CleanRead (v1.0.1)

A lightweight MS Edge / Google Chrome extension (Manifest V3) that converts web pages and lists of URLs into screen-reader-friendly, text-only Markdown files with `URL` and UTC `Retrieved-Timestamp` frontmatter. Strips navigation bars, headers, footers, sidebars, pop-ups, and media.

## New in v1.0.1

- **⚡ 1-Click Active Page Conversion**: Added a dedicated **"Save Current Page (1-Click)"** button at the top of the popup. When viewing any article or doc in your browser, open CleanRead and click one button to instantly save the clean Markdown and raw HTML without closing your active tab or waiting through batch delay queues!
- **Dynamic Version Indicator**: Displays the active version (`v1.0.1`) directly in the header to confirm the latest extension build is loaded.

## Core Features

- **1-Click Current Page Extraction**: Instant conversion of your currently active browser tab.
- **Concurrent Tab Processing**: Choose from 1, 3, 5, 7, or 11 parallel tab workers (default 3) to process lists of URLs up to 11x faster.
- **Configurable Settle Range**: Custom Min Wait and Max Wait seconds (default 7–21s) with active mouse/pointer simulation and smooth scrolling to clear Cloudflare challenges and let dynamic JS finish rendering.
- **30s Network Safety Guard**: Automatically proceeds after 30s if third-party trackers or ads stall the page's `onload` event.
- **Background Tabs**: Multi-tab batches run quietly in the background without stealing your focus or bouncing between windows.
- **Dual Output**: Saves both clean `.md` and rendered `.html` under `YYYYMMDD-<slug>` using your computer's local date.

## Output Format

Each page is saved to `Downloads/<Subfolder>/` (default `Downloads/CleanRead/`) as a pair of files named with the local date:
- `YYYYMMDD-<slug>.md` — Clean, text-only Markdown with frontmatter for screen readers.
- `YYYYMMDD-<slug>.html` — The full rendered page HTML after dynamic scripts and Cloudflare checks complete.

```markdown
---
URL: https://example.com/article
Retrieved-Timestamp: 2026-11-16T21:05:00.000Z
---

# Article Title

Clean, structured Markdown text without images, raw inline URLs, navbars, or footers.
```

## Installation & Update (MS Edge / Google Chrome)

1. Open `edge://extensions` (in Edge) or `chrome://extensions` (in Chrome).
2. Enable **Developer mode**.
3. If previously loaded, click the **Reload** (circular arrow) icon on the **CleanRead** card.
   - If loading for the first time, click **Load unpacked** and select the `CleanRead` folder.
4. Open the popup to verify **`v1.0.1`** in the header.
5. *(Recommended)* In browser download settings (`edge://settings/downloads` or `chrome://settings/downloads`), turn **off** *"Ask where to save each file before downloading"* so downloads save automatically without prompting for each file.
