# CleanRead (v1.0.3)

A lightweight MS Edge / Google Chrome extension (Manifest V3) that converts web pages, plain text, and Markdown files into screen-reader-friendly Markdown (`*.md`) and saves the raw file (`*.html`, `*.txt`, `*.pdf`, `*.docx`, images, archives, etc.) into your Downloads folder.

## New in v1.0.3

- **Batch Summary Report (`YYYYMMDD-hhmmss-cleanread-report.md`)**: Every batch run writes a timestamped report directly into `Downloads/<Subfolder>/` detailing run timestamps, settings, counts, per-URL status/files/errors, and two clean copy-pasteable sections at the end (`## Successful URLS` and `## Unsuccessful URLs`, one bare URL per line).

## v1.0.2 Features

- **Smart Multi-Format Handling (Markdown + Raw Files)**:
  - **Webpages & Text Files** (`html`, `htm`, `txt`, `md`, `csv`, `json`, `xml`, `yaml`, `rst`, `log`, etc.): Generates a clean `YYYYMMDD-<slug>.md` file with `URL` and UTC `Retrieved-Timestamp` frontmatter **and** downloads the raw original file alongside it (`YYYYMMDD-<slug>.html`, `.txt`, `-raw.md`, `.json`, etc.).
  - **PDFs & All Other Binary Files** (`.pdf`, `.docx`, `.xlsx`, `.zip`, `.png`, `.jpg`, `.mp3`, `.mp4`, etc.): Downloads the raw file directly (`YYYYMMDD-<slug>.<ext>`) using the browser's download manager—both from bulk URL queues and from the 1-click active tab button.

## Features

- **⚡ 1-Click Active Tab Conversion**: Convert your currently open webpage or save your currently open PDF/file immediately without closing the tab or waiting through batch delays.
- **Concurrent Tab Processing**: Choose from 1, 3, 5, 7, or 11 parallel tab workers (default 3) to process lists of URLs up to 11x faster.
- **Configurable Settle Range**: Custom Min Wait and Max Wait seconds (default 7–21s) with active mouse/pointer simulation and smooth scrolling to clear Cloudflare challenges and let dynamic JS finish rendering.
- **30s Network Safety Guard**: Automatically proceeds after 30s if third-party trackers or ads stall the page's `onload` event.
- **Background Tabs**: Multi-tab batches run quietly in the background without stealing your focus or bouncing between windows.
- **Dynamic Version Indicator**: Displays the active version (`v1.0.2`) directly in the header to confirm the latest extension build is loaded.

## Output Format

Each URL or active tab is saved to `Downloads/<Subfolder>/` (default `Downloads/CleanRead/`) using your computer's local `YYYYMMDD` date:
- **HTML / Webpage**: `YYYYMMDD-<slug>.md` + rendered `YYYYMMDD-<slug>.html`
- **Plain Text / Structured Text**: `YYYYMMDD-<slug>.md` + raw `YYYYMMDD-<slug>.txt` (or `.json`, `.csv`, `.xml`, etc.)
- **Markdown**: `YYYYMMDD-<slug>.md` (with CleanRead frontmatter) + raw `YYYYMMDD-<slug>-raw.md`
- **PDF & Other Binaries**: raw `YYYYMMDD-<slug>.pdf` (or `.docx`, `.zip`, `.png`, etc.)

```markdown
---
URL: https://example.com/article
Retrieved-Timestamp: 2026-11-16T21:50:00.000Z
---

# Article Title

Clean, structured Markdown text without images, raw inline URLs, navbars, or footers.
```

## Installation & Update (MS Edge / Google Chrome)

1. Open `edge://extensions` (in Edge) or `chrome://extensions` (in Chrome).
2. Enable **Developer mode**.
3. If previously loaded, click the **Reload** (circular arrow) icon on the **CleanRead** card.
   - If loading for the first time, click **Load unpacked** and select the `CleanRead` folder.
4. Open the popup to verify **`v1.0.3`** in the header.
5. *(Recommended)* In browser download settings (`edge://settings/downloads` or `chrome://settings/downloads`), turn **off** *"Ask where to save each file before downloading"* so downloads save automatically without prompting for each file.
