# CleanRead

A lightweight MS Edge / Google Chrome extension (Manifest V3) that takes a pasted list of URLs, processes them across concurrent background tabs (1 to 5 tabs at once), strips out navigation bars, headers, footers, sidebars, pop-ups, and media, and saves screen-reader-friendly, text-only Markdown files with `URL` and UTC `Retrieved-Timestamp` frontmatter.

## Features

- **Concurrent Tab Processing**: Choose from 1 to 5 parallel tab workers (default 3) to process lists of URLs 3x–5x faster.
- **Background Tabs**: Multi-tab batches run quietly in the background without stealing your focus or bouncing between windows.
- **Human Simulation**: Performs natural, curved mouse/pointer movements and subtle scrolls during a randomized 7–21s wait to clear Cloudflare challenges and let dynamic JS finish rendering.
- **Dual Output**: Saves both clean `.md` and rendered `.html` under `YYYYMMDD-<slug>` using your computer's local date.

## Output Format

Each page is saved to `Downloads/<Subfolder>/` (default `Downloads/CleanRead/`) as a pair of files named with the local date:
- `YYYYMMDD-<slug>.md` — Clean, text-only Markdown with frontmatter for screen readers.
- `YYYYMMDD-<slug>.html` — The full rendered page HTML after dynamic scripts and Cloudflare checks complete.

```markdown
---
URL: https://example.com/article
Retrieved-Timestamp: 2026-11-07T05:44:30.774Z
---

# Article Title

Clean, structured Markdown text without images, raw inline URLs, navbars, or footers.
```

## Installation (MS Edge / Google Chrome)

1. Open `edge://extensions` (in Edge) or `chrome://extensions` (in Chrome).
2. Enable **Developer mode**.
3. Click **Load unpacked** and select the `CleanRead` folder.
4. *(Recommended)* In browser download settings (`edge://settings/downloads` or `chrome://settings/downloads`), turn **off** *"Ask where to save each file before downloading"* so bulk runs save automatically without prompting for each URL.
