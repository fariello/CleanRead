/**
 * CleanRead Background Service Worker (v1.0.2)
 * - For HTML, plain text, Markdown, JSON, XML, CSV, and similar text files:
 *   generates a clean *.md file (with URL & UTC Retrieved-Timestamp frontmatter)
 *   AND downloads the raw file.
 * - For all other files (PDFs, Office docs, archives, images, media, binaries):
 *   downloads the raw file directly with YYYYMMDD-<slug>.<ext> naming.
 */

const HTML_EXTENSIONS = new Set(["htm", "html", "xhtml", "shtml"]);
const MD_EXTENSIONS = new Set(["md", "markdown", "mdx"]);
const TEXT_EXTENSIONS = new Set([
  "txt", "text", "md", "markdown", "mdx", "rst", "adoc", "asciidoc",
  "htm", "html", "xhtml", "shtml",
  "csv", "tsv", "log", "json", "jsonl", "xml", "yaml", "yml",
  "ini", "conf", "cfg", "toml", "css", "js", "ts", "py", "sh", "sql",
  "svg"
]);

const KNOWN_BINARY_EXTENSIONS = new Set([
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp",
  "rtf", "epub", "mobi", "zip", "tar", "gz", "tgz", "bz2", "xz", "rar", "7z",
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "tif", "tiff",
  "mp3", "wav", "ogg", "flac", "aac", "m4a",
  "mp4", "webm", "mkv", "avi", "mov", "exe", "msi", "dmg", "iso", "bin"
]);

const MIME_TO_EXT = {
  "text/html": "html",
  "application/xhtml+xml": "xhtml",
  "text/plain": "txt",
  "text/markdown": "md",
  "text/x-markdown": "md",
  "text/csv": "csv",
  "text/tab-separated-values": "tsv",
  "application/json": "json",
  "text/json": "json",
  "application/xml": "xml",
  "text/xml": "xml",
  "application/yaml": "yaml",
  "text/yaml": "yaml",
  "image/svg+xml": "svg",
  "application/javascript": "js",
  "text/javascript": "js",
  "application/pdf": "pdf",
  "application/zip": "zip",
  "application/x-zip-compressed": "zip",
  "application/gzip": "gz",
  "application/x-tar": "tar",
  "application/x-7z-compressed": "7z",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/epub+zip": "epub",
  "application/rtf": "rtf",
  "text/rtf": "rtf",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/ogg": "ogg",
  "video/mp4": "mp4",
  "video/webm": "webm"
};

let jobState = {
  isRunning: false,
  cancelRequested: false,
  subfolder: "CleanRead",
  total: 0,
  completed: 0,
  failed: 0,
  currentUrl: "",
  logs: []
};

function addLog(message, type = "info") {
  const entry = {
    time: new Date().toISOString().slice(11, 19),
    message,
    type
  };
  jobState.logs.push(entry);
  if (jobState.logs.length > 100) {
    jobState.logs.shift();
  }
  broadcastState();
}

function broadcastState() {
  chrome.storage.local.set({ cleanReadJobState: jobState }).catch(() => {});
  chrome.runtime.sendMessage({ type: "STATE_UPDATE", state: jobState }).catch(() => {
    // Popup may be closed; ignore error
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForTabComplete(tabId, timeoutMs = 30000) {
  return new Promise((resolve) => {
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      clearTimeout(timer);
      resolve();
    };

    const onUpdated = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        finish();
      }
    };

    const onRemoved = (removedTabId) => {
      if (removedTabId === tabId) {
        finish();
      }
    };

    const timer = setTimeout(finish, timeoutMs);

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);

    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError || !tab) {
        finish();
      } else if (tab.status === "complete") {
        finish();
      }
    });
  });
}

function sanitizeSubfolder(folder) {
  const cleaned = (folder || "CleanRead")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .map((part) => part.replace(/[<>:"|?*\x00-\x1F]/g, "").trim())
    .filter((part) => part && part !== "." && part !== "..")
    .join("/");
  return cleaned || "CleanRead";
}

function getLocalDateString() {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

function extractFilenameExt(filenameOrPath) {
  if (!filenameOrPath) return "";
  const base = filenameOrPath.split(/[\\/]/).pop() || "";
  const dotIdx = base.lastIndexOf(".");
  if (dotIdx <= 0 || dotIdx === base.length - 1) return "";
  const ext = base.slice(dotIdx + 1).toLowerCase();
  if (!/^[a-z0-9]{1,10}$/.test(ext)) return "";
  if (TEXT_EXTENSIONS.has(ext) || KNOWN_BINARY_EXTENSIONS.has(ext)) {
    return ext;
  }
  return "";
}

function getUrlExtension(url) {
  try {
    const parsed = new URL(url);
    return extractFilenameExt(parsed.pathname);
  } catch (_) {
    return "";
  }
}

function parseContentDispositionFilename(headerValue) {
  if (!headerValue) return "";
  const utf8Match = headerValue.match(/filename\*\s*=\s*(?:UTF-8|utf-8)''([^;\r\n]+)/i);
  if (utf8Match && utf8Match[1]) {
    try {
      return decodeURIComponent(utf8Match[1].trim().replace(/^["']|["']$/g, ""));
    } catch (_) {}
  }
  const plainMatch = headerValue.match(/filename\s*=\s*"([^"]+)"|filename\s*=\s*([^;\r\n]+)/i);
  const raw = (plainMatch && (plainMatch[1] || plainMatch[2])) || "";
  return raw.trim().replace(/^["']|["']$/g, "");
}

function stripKnownExtension(name) {
  if (!name) return "";
  const dotIdx = name.lastIndexOf(".");
  if (dotIdx > 0) {
    const ext = name.slice(dotIdx + 1).toLowerCase();
    if (TEXT_EXTENSIONS.has(ext) || KNOWN_BINARY_EXTENSIONS.has(ext)) {
      return name.slice(0, dotIdx);
    }
  }
  return name;
}

function buildBaseFilePath(subfolder, title, url, dispositionFilename = "") {
  const dateStr = getLocalDateString();

  let base = stripKnownExtension((title || "").trim());
  if (!base || base.toLowerCase() === "untitled") {
    base = stripKnownExtension((dispositionFilename || "").trim());
  }
  if (!base) {
    try {
      const parsed = new URL(url);
      const pathClean = stripKnownExtension(parsed.pathname.replace(/\/+$/, ""));
      base = parsed.hostname + pathClean;
    } catch (_) {
      base = "file";
    }
  }

  const slug =
    base
      .toLowerCase()
      .replace(/['’]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 70) || "file";

  const folder = sanitizeSubfolder(subfolder);
  return `${folder}/${dateStr}-${slug}`;
}

function classifyResource(url, contentType = "", dispositionFilename = "") {
  const mime = (contentType || "").split(";")[0].trim().toLowerCase();
  const dispExt = extractFilenameExt(dispositionFilename);
  const urlExt = getUrlExtension(url);
  const mimeExt = MIME_TO_EXT[mime] || "";

  // Determine effective extension
  let ext = dispExt || mimeExt || urlExt;

  // Classify HTML vs Text-like vs Binary
  const isHtmlMime = mime === "text/html" || mime === "application/xhtml+xml";
  const isTextMime =
    !isHtmlMime &&
    (mime.startsWith("text/") ||
      mime === "application/json" ||
      mime === "application/xml" ||
      mime === "application/yaml" ||
      mime === "application/javascript" ||
      mime === "application/ecmascript" ||
      mime === "image/svg+xml" ||
      mime.endsWith("+json") ||
      mime.endsWith("+xml"));

  if (isHtmlMime || (!mime && (HTML_EXTENSIONS.has(ext) || !ext))) {
    return { kind: "html", ext: ext === "htm" ? "htm" : "html", mime };
  }

  if (isTextMime || (!mime && TEXT_EXTENSIONS.has(ext))) {
    return { kind: "text", ext: ext || "txt", mime };
  }

  return { kind: "binary", ext: ext || "bin", mime };
}

function waitForDownloadFinish(downloadId, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      chrome.downloads.onChanged.removeListener(onChanged);
      clearTimeout(timer);
    };

    const finishOk = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(downloadId);
    };

    const finishErr = (msg) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(msg || "Download interrupted"));
    };

    const onChanged = (delta) => {
      if (delta.id !== downloadId) return;
      if (delta.state && delta.state.current === "complete") {
        finishOk();
      } else if (delta.state && delta.state.current === "interrupted") {
        finishErr((delta.error && delta.error.current) || "Download interrupted");
      }
    };

    const timer = setTimeout(finishOk, timeoutMs);
    chrome.downloads.onChanged.addListener(onChanged);

    chrome.downloads.search({ id: downloadId }, (items) => {
      if (items && items[0]) {
        if (items[0].state === "complete") finishOk();
        else if (items[0].state === "interrupted") {
          finishErr(items[0].error || "Download interrupted");
        }
      }
    });
  });
}

function downloadFromUrl(sourceUrl, filename) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      {
        url: sourceUrl,
        filename,
        conflictAction: "uniquify",
        saveAs: false
      },
      (downloadId) => {
        if (chrome.runtime.lastError || !downloadId) {
          reject(
            new Error(
              (chrome.runtime.lastError && chrome.runtime.lastError.message) ||
                "Download failed"
            )
          );
        } else {
          waitForDownloadFinish(downloadId).then(resolve, reject);
        }
      }
    );
  });
}

function downloadFile(content, filename, mimeType = "text/plain") {
  const dataUrl = `data:${mimeType};charset=utf-8,` + encodeURIComponent(content);
  return downloadFromUrl(dataUrl, filename);
}

async function probeRemoteHeaders(url, timeoutMs = 4500) {
  if (!/^https?:\/\//i.test(url)) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      credentials: "include",
      signal: controller.signal
    });
    clearTimeout(timer);

    if (!res.ok) {
      return { ok: false, status: res.status };
    }

    const contentType = res.headers.get("content-type") || "";
    const disp = res.headers.get("content-disposition") || "";
    const dispositionFilename = parseContentDispositionFilename(disp);
    const isAttachment = /\battachment\b/i.test(disp);

    return {
      ok: true,
      status: res.status,
      finalUrl: res.url || url,
      contentType,
      dispositionFilename,
      isAttachment
    };
  } catch (_) {
    return null;
  }
}

async function fetchRawText(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      credentials: "include",
      signal: controller.signal
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function formatTextAsMarkdown({ url, title, rawText, ext, mime, timestampUtc }) {
  const frontmatter = [
    "---",
    `URL: ${url}`,
    `Retrieved-Timestamp: ${timestampUtc}`,
    "---",
    ""
  ].join("\n");

  let body = (rawText || "").replace(/\r\n/g, "\n").trim();

  if (
    MD_EXTENSIONS.has(ext) ||
    mime === "text/markdown" ||
    mime === "text/x-markdown"
  ) {
    // Strip existing top YAML frontmatter if present so CleanRead frontmatter isn't duplicated
    if (body.startsWith("---\n")) {
      const endIdx = body.indexOf("\n---\n", 4);
      if (endIdx !== -1) {
        body = body.slice(endIdx + 5).trim();
      }
    }
    return `${frontmatter}\n${body}\n`;
  }

  const codeLangMap = {
    json: "json",
    jsonl: "json",
    xml: "xml",
    svg: "xml",
    yaml: "yaml",
    yml: "yaml",
    csv: "csv",
    tsv: "tsv",
    css: "css",
    js: "javascript",
    ts: "typescript",
    py: "python",
    sh: "bash",
    sql: "sql",
    toml: "toml",
    ini: "ini"
  };

  const heading = title ? `# ${title}\n\n` : "";
  const lang = codeLangMap[ext];
  if (lang) {
    return `${frontmatter}\n${heading}\`\`\`${lang}\n${body}\n\`\`\`\n`;
  }

  return `${frontmatter}\n${heading}${body}\n`;
}

function getRawTextExtension(ext) {
  // Avoid filename collision with the generated CleanRead *.md file
  if (MD_EXTENSIONS.has(ext)) {
    return `raw.${ext}`;
  }
  return ext || "txt";
}

async function saveTextOrMarkdownFile({
  url,
  title,
  rawText,
  ext,
  mime,
  subfolder,
  dispositionFilename = ""
}) {
  const timestampUtc = new Date().toISOString();
  const basePath = buildBaseFilePath(subfolder, title, url, dispositionFilename);
  const mdFilename = `${basePath}.md`;
  const rawExt = getRawTextExtension(ext);
  const rawFilename = `${basePath}.${rawExt}`;

  const mdContent = formatTextAsMarkdown({
    url,
    title: stripKnownExtension(title || dispositionFilename),
    rawText,
    ext,
    mime,
    timestampUtc
  });

  await downloadFile(mdContent, mdFilename, "text/markdown");

  try {
    await downloadFromUrl(url, rawFilename);
  } catch (_) {
    await downloadFile(rawText, rawFilename, mime || "text/plain");
  }

  return {
    title: title || dispositionFilename || url,
    savedSummary: `${mdFilename} & ${rawFilename}`,
    md: mdFilename,
    raw: rawFilename
  };
}

async function saveBinaryRawFile({
  url,
  title,
  ext,
  subfolder,
  dispositionFilename = ""
}) {
  const basePath = buildBaseFilePath(subfolder, title, url, dispositionFilename);
  const rawFilename = `${basePath}.${ext || "bin"}`;

  await downloadFromUrl(url, rawFilename);

  return {
    title: title || dispositionFilename || url,
    savedSummary: rawFilename,
    raw: rawFilename
  };
}

async function extractHtmlPageFromTab(tabId, url, subfolder, ext = "html") {
  const timestampUtc = new Date().toISOString();

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["Readability.js"]
  });

  const injectionResults = await chrome.scripting.executeScript({
    target: { tabId },
    files: ["extractor.js"]
  });

  const payload =
    injectionResults && injectionResults[0] && injectionResults[0].result
      ? injectionResults[0].result
      : null;

  if (!payload || !payload.markdownBody) {
    throw new Error(
      (payload && payload.error) || "No readable text found on page"
    );
  }

  const frontmatter = [
    "---",
    `URL: ${url}`,
    `Retrieved-Timestamp: ${timestampUtc}`,
    "---",
    ""
  ].join("\n");

  const finalMarkdown = `${frontmatter}\n${payload.markdownBody.trim()}\n`;
  const basePath = buildBaseFilePath(subfolder, payload.title, url);
  const mdFilename = `${basePath}.md`;
  const rawFilename = `${basePath}.${ext === "htm" ? "htm" : "html"}`;

  await downloadFile(finalMarkdown, mdFilename, "text/markdown");
  if (payload.rawHtml) {
    await downloadFile(payload.rawHtml, rawFilename, "text/html");
  }

  return {
    title: payload.title,
    savedSummary: `${mdFilename} & ${rawFilename}`,
    md: mdFilename,
    raw: rawFilename
  };
}

async function probeLoadedTab(tabId) {
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({
        contentType: document.contentType || "",
        title: document.title || "",
        bodyText: document.body ? document.body.innerText : "",
        hasPdfEmbed: Boolean(document.querySelector('embed[type="application/pdf"]'))
      })
    });
    return res && res[0] && res[0].result ? res[0].result : null;
  } catch (_) {
    return null;
  }
}

/**
 * Injected into the target tab to simulate realistic human browsing:
 * smooth mouse movements, pointer events, and natural scrolling
 * while waiting out Cloudflare challenges and dynamic JS rendering.
 */
function simulateHumanActivity(durationMs) {
  return new Promise((resolve) => {
    const endTime = Date.now() + durationMs;

    let curX = Math.floor(window.innerWidth * 0.3 + Math.random() * window.innerWidth * 0.4);
    let curY = Math.floor(window.innerHeight * 0.3 + Math.random() * window.innerHeight * 0.4);

    function dispatchPoint(x, y) {
      const eventInit = {
        clientX: x,
        clientY: y,
        screenX: x + (window.screenX || 0),
        screenY: y + (window.screenY || 0),
        bubbles: true,
        cancelable: true,
        view: window
      };
      const el = document.elementFromPoint(x, y) || document.body || document.documentElement;
      if (el) {
        try {
          if (window.PointerEvent) {
            el.dispatchEvent(new PointerEvent("pointermove", eventInit));
          }
          el.dispatchEvent(new MouseEvent("mousemove", eventInit));
        } catch (_) {}
      }
    }

    function step() {
      const now = Date.now();
      if (now >= endTime) {
        resolve();
        return;
      }

      const maxW = Math.max(300, window.innerWidth - 40);
      const maxH = Math.max(300, window.innerHeight - 40);
      const targetX = Math.max(20, Math.min(maxW, curX + (Math.random() - 0.5) * 350));
      const targetY = Math.max(20, Math.min(maxH, curY + (Math.random() - 0.5) * 250));

      const steps = 6 + Math.floor(Math.random() * 6);
      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        const intermediateX = Math.round(
          curX + (targetX - curX) * t + Math.sin(t * Math.PI) * ((Math.random() - 0.5) * 15)
        );
        const intermediateY = Math.round(
          curY + (targetY - curY) * t + Math.sin(t * Math.PI) * ((Math.random() - 0.5) * 15)
        );
        dispatchPoint(intermediateX, intermediateY);
      }
      curX = targetX;
      curY = targetY;

      if (Math.random() < 0.4) {
        const scrollDelta = (Math.random() < 0.7 ? 1 : -1) * Math.floor(80 + Math.random() * 160);
        window.scrollBy({ top: scrollDelta, behavior: "smooth" });
      }

      const nextInterval = 200 + Math.floor(Math.random() * 400);
      setTimeout(step, Math.min(nextInterval, Math.max(50, endTime - Date.now())));
    }

    step();
  });
}

async function processSingleUrl(
  url,
  subfolder,
  isSingleWorker = false,
  minWait = 7,
  maxWait = 21
) {
  // Fast pre-flight check via HEAD so direct binary downloads (PDFs, zips, images)
  // and plain text/md files save directly without fighting Chrome's viewer or attachment behavior.
  const headInfo = await probeRemoteHeaders(url);
  if (headInfo && headInfo.ok) {
    const info = classifyResource(
      headInfo.finalUrl || url,
      headInfo.contentType,
      headInfo.dispositionFilename
    );

    if (info.kind === "binary" || (headInfo.isAttachment && info.kind !== "text")) {
      const result = await saveBinaryRawFile({
        url: headInfo.finalUrl || url,
        title: "",
        ext: info.ext,
        subfolder,
        dispositionFilename: headInfo.dispositionFilename
      });
      addLog(`Saved raw file: ${result.savedSummary}`, "success");
      return { kind: "binary", ...result };
    }

    if (info.kind === "text") {
      try {
        const rawText = await fetchRawText(headInfo.finalUrl || url);
        const result = await saveTextOrMarkdownFile({
          url: headInfo.finalUrl || url,
          title: "",
          rawText,
          ext: info.ext,
          mime: info.mime,
          subfolder,
          dispositionFilename: headInfo.dispositionFilename
        });
        addLog(`Saved text + MD: ${result.savedSummary}`, "success");
        return { kind: "text", ...result };
      } catch (_) {
        // Fall through to tab-based handling if fetch failed
      }
    }
  }

  let tabId = null;
  try {
    const tab = await chrome.tabs.create({ url, active: isSingleWorker });
    tabId = tab.id;

    // Wait for initial page complete (30s timeout guard)
    await waitForTabComplete(tabId, 30000);

    // Random wait between minWait and maxWait with active mouse & scroll simulation
    const low = Math.max(0, Number(minWait) || 7);
    const high = Math.max(low, Number(maxWait) || 21);
    const waitSeconds = (low + Math.random() * (high - low)).toFixed(1);
    const waitMs = Math.round(waitSeconds * 1000);
    addLog(`Waiting ${waitSeconds}s (simulating human mouse moves & scroll)...`);

    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: simulateHumanActivity,
        args: [waitMs]
      });
    } catch (_) {
      await sleep(waitMs);
    }

    let currentTab = null;
    try {
      currentTab = await chrome.tabs.get(tabId);
    } catch (_) {}
    const effectiveUrl = (currentTab && currentTab.url) || url;

    const probed = await probeLoadedTab(tabId);
    let info = classifyResource(effectiveUrl, probed ? probed.contentType : "", "");
    if (probed && probed.hasPdfEmbed) {
      info = { kind: "binary", ext: "pdf", mime: "application/pdf" };
    }

    if (info.kind === "binary") {
      const result = await saveBinaryRawFile({
        url: effectiveUrl,
        title: probed ? probed.title : "",
        ext: info.ext,
        subfolder
      });
      addLog(`Saved raw file: ${result.savedSummary}`, "success");
      return { kind: "binary", ...result };
    }

    if (info.kind === "text") {
      let rawText = probed ? probed.bodyText : "";
      try {
        rawText = await fetchRawText(effectiveUrl);
      } catch (_) {}
      const result = await saveTextOrMarkdownFile({
        url: effectiveUrl,
        title: probed ? probed.title : "",
        rawText,
        ext: info.ext,
        mime: info.mime,
        subfolder
      });
      addLog(`Saved text + MD: ${result.savedSummary}`, "success");
      return { kind: "text", ...result };
    }

    const result = await extractHtmlPageFromTab(tabId, effectiveUrl, subfolder, info.ext);
    addLog(`Saved: ${result.savedSummary}`, "success");
    return { kind: "html", ...result };
  } finally {
    if (tabId !== null) {
      try {
        await chrome.tabs.remove(tabId);
      } catch (_) {}
    }
  }
}

async function processCurrentTab(tabId, url, title, subfolder) {
  const probed = await probeLoadedTab(tabId);
  let headerInfo = null;

  // If executeScript couldn't read the tab (e.g. restricted PDF viewer) or contentType was empty,
  // check HTTP headers as well.
  if (!probed || !probed.contentType) {
    headerInfo = await probeRemoteHeaders(url);
  }

  const effectiveContentType =
    (probed && probed.contentType) ||
    (headerInfo && headerInfo.contentType) ||
    "";
  const dispName = (headerInfo && headerInfo.dispositionFilename) || "";
  const effectiveTitle = (probed && probed.title) || title || "";

  let info = classifyResource(url, effectiveContentType, dispName);
  if (probed && probed.hasPdfEmbed) {
    info = { kind: "binary", ext: "pdf", mime: "application/pdf" };
  }

  if (info.kind === "binary") {
    const result = await saveBinaryRawFile({
      url,
      title: effectiveTitle,
      ext: info.ext,
      subfolder,
      dispositionFilename: dispName
    });
    addLog(`Saved current file: ${result.savedSummary}`, "success");
    return {
      ok: true,
      title: result.title,
      filename: result.savedSummary,
      kind: "binary"
    };
  }

  if (info.kind === "text") {
    let rawText = (probed && probed.bodyText) || "";
    try {
      rawText = await fetchRawText(url);
    } catch (_) {}

    const result = await saveTextOrMarkdownFile({
      url,
      title: effectiveTitle,
      rawText,
      ext: info.ext,
      mime: info.mime,
      subfolder,
      dispositionFilename: dispName
    });
    addLog(`Saved current text + MD: ${result.savedSummary}`, "success");
    return {
      ok: true,
      title: result.title,
      filename: result.savedSummary,
      kind: "text"
    };
  }

  const result = await extractHtmlPageFromTab(tabId, url, subfolder, info.ext);
  addLog(`Saved current page: ${result.savedSummary}`, "success");
  return {
    ok: true,
    title: result.title,
    filename: result.savedSummary,
    kind: "html"
  };
}

function getLocalDateTimePrefix(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const yyyy = date.getFullYear();
  const mm = pad(date.getMonth() + 1);
  const dd = pad(date.getDate());
  const hh = pad(date.getHours());
  const min = pad(date.getMinutes());
  const ss = pad(date.getSeconds());
  return `${yyyy}${mm}${dd}-${hh}${min}${ss}`;
}

function getLocalIsoTimestamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const yyyy = date.getFullYear();
  const mm = pad(date.getMonth() + 1);
  const dd = pad(date.getDate());
  const hh = pad(date.getHours());
  const min = pad(date.getMinutes());
  const ss = pad(date.getSeconds());
  const tzOffset = -date.getTimezoneOffset();
  const sign = tzOffset >= 0 ? "+" : "-";
  const tzh = pad(Math.floor(Math.abs(tzOffset) / 60));
  const tzm = pad(Math.abs(tzOffset) % 60);
  return `${yyyy}-${mm}-${dd}T${hh}:${min}:${ss}${sign}${tzh}:${tzm}`;
}

function buildBatchReportMarkdown({
  subfolder,
  startedAt,
  completedAt,
  concurrency,
  minWait,
  maxWait,
  stoppedEarly,
  outcomes
}) {
  const durationSec = ((completedAt.getTime() - startedAt.getTime()) / 1000).toFixed(1);
  const successful = outcomes.filter((o) => o.status === "success");
  const unsuccessful = outcomes.filter((o) => o.status !== "success");

  const lines = [
    "# CleanRead Batch Report",
    "",
    `- **Started (Local):** ${getLocalIsoTimestamp(startedAt)}`,
    `- **Completed (Local):** ${getLocalIsoTimestamp(completedAt)}`,
    `- **Started (UTC):** ${startedAt.toISOString()}`,
    `- **Completed (UTC):** ${completedAt.toISOString()}`,
    `- **Duration:** ${durationSec}s`,
    `- **Directory:** Downloads/${subfolder}/`,
    `- **Settings:** ${concurrency} tab worker(s), ${minWait}-${maxWait}s wait`,
    `- **Status:** ${stoppedEarly ? "Stopped early by user" : "Completed"}`,
    `- **Total URLs:** ${outcomes.length}`,
    `- **Successful:** ${successful.length}`,
    `- **Unsuccessful:** ${unsuccessful.length}`,
    "",
    "## Activity Log",
    ""
  ];

  for (const item of outcomes) {
    const num = item.index + 1;
    if (item.status === "success") {
      const kind = item.kind ? ` [${item.kind}]` : "";
      lines.push(
        `${num}. **SUCCESS**${kind} (${item.durationSec}s) — \`${item.url}\` -> \`${item.savedSummary || "Saved"}\``
      );
    } else if (item.status === "cancelled") {
      lines.push(
        `${num}. **CANCELLED** — \`${item.url}\` (Stopped before processing)`
      );
    } else {
      lines.push(
        `${num}. **FAILED** (${item.durationSec}s) — \`${item.url}\` — Error: ${item.error || "Unknown error"}`
      );
    }
  }

  lines.push("");
  lines.push("## Successful URLS");
  lines.push("");
  for (const item of successful) {
    lines.push(item.url);
  }

  lines.push("");
  lines.push("## Unsuccessful URLs");
  lines.push("");
  for (const item of unsuccessful) {
    lines.push(item.url);
  }
  lines.push("");

  return lines.join("\n");
}

async function runBatchQueue(
  urls,
  subfolder,
  concurrency = 3,
  minWait = 7,
  maxWait = 21
) {
  const maxWorkers = Math.max(1, Math.min(Number(concurrency) || 3, 11));
  const low = Math.max(0, Number(minWait) || 7);
  const high = Math.max(low, Number(maxWait) || 21);
  const startedAt = new Date();

  jobState = {
    isRunning: true,
    cancelRequested: false,
    subfolder: sanitizeSubfolder(subfolder),
    total: urls.length,
    completed: 0,
    failed: 0,
    currentUrl: "",
    concurrency: maxWorkers,
    minWait: low,
    maxWait: high,
    logs: []
  };
  addLog(
    `Starting batch of ${urls.length} URL(s) with ${maxWorkers} tab worker(s), ${low}-${high}s wait -> Downloads/${jobState.subfolder}/`
  );

  let nextIndex = 0;
  const outcomes = new Array(urls.length);

  async function worker(workerId) {
    while (!jobState.cancelRequested) {
      if (nextIndex >= urls.length) break;
      const i = nextIndex++;
      const rawUrl = urls[i];
      const itemStart = Date.now();

      jobState.currentUrl = rawUrl;
      addLog(`[Worker ${workerId}] Processing (${i + 1}/${urls.length}): ${rawUrl}`);
      broadcastState();

      try {
        const res = await processSingleUrl(
          rawUrl,
          jobState.subfolder,
          maxWorkers === 1,
          low,
          high
        );
        const durationSec = ((Date.now() - itemStart) / 1000).toFixed(1);
        outcomes[i] = {
          index: i,
          url: rawUrl,
          status: "success",
          kind: res && res.kind ? res.kind : "",
          savedSummary: res && res.savedSummary ? res.savedSummary : "",
          durationSec
        };
        jobState.completed++;
        addLog(`[Worker ${workerId}] Completed (${i + 1}/${urls.length})`, "success");
      } catch (err) {
        const durationSec = ((Date.now() - itemStart) / 1000).toFixed(1);
        const errorMsg = err && err.message ? err.message : String(err);
        outcomes[i] = {
          index: i,
          url: rawUrl,
          status: "failed",
          error: errorMsg,
          durationSec
        };
        jobState.failed++;
        addLog(
          `[Worker ${workerId}] Error on ${rawUrl}: ${errorMsg}`,
          "error"
        );
      }
      broadcastState();
      await sleep(300);
    }
  }

  const workerPromises = [];
  const actualWorkers = Math.min(maxWorkers, urls.length);
  for (let w = 1; w <= actualWorkers; w++) {
    workerPromises.push(worker(w));
  }
  await Promise.all(workerPromises);

  // Fill any unprocessed URLs if stopped early
  for (let i = 0; i < urls.length; i++) {
    if (!outcomes[i]) {
      outcomes[i] = {
        index: i,
        url: urls[i],
        status: "cancelled",
        error: "Stopped before processing",
        durationSec: "0.0"
      };
    }
  }

  const completedAt = new Date();
  const reportFilename = `${jobState.subfolder}/${getLocalDateTimePrefix(completedAt)}-cleanread-report.md`;
  const reportMarkdown = buildBatchReportMarkdown({
    subfolder: jobState.subfolder,
    startedAt,
    completedAt,
    concurrency: maxWorkers,
    minWait: low,
    maxWait: high,
    stoppedEarly: Boolean(jobState.cancelRequested),
    outcomes
  });

  try {
    await downloadFile(reportMarkdown, reportFilename, "text/markdown");
    addLog(`Report saved: ${reportFilename}`, "success");
  } catch (err) {
    addLog(
      `Failed to save report: ${err && err.message ? err.message : String(err)}`,
      "error"
    );
  }

  jobState.isRunning = false;
  jobState.currentUrl = "";
  addLog(
    `Finished! ${jobState.completed} saved, ${jobState.failed} failed.`,
    "info"
  );
  broadcastState();
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || !message.type) return;

  if (message.type === "GET_STATE") {
    sendResponse({ state: jobState });
    return true;
  }

  if (message.type === "SAVE_CURRENT_TAB") {
    const tabId = message.tabId;
    const url = message.url;
    const title = message.title || "";
    const subfolder = message.subfolder || "CleanRead";

    if (!tabId || !url) {
      sendResponse({ ok: false, error: "No active tab specified." });
      return true;
    }

    processCurrentTab(tabId, url, title, subfolder)
      .then((res) => sendResponse(res))
      .catch((err) =>
        sendResponse({
          ok: false,
          error: (err && err.message) || String(err)
        })
      );
    return true;
  }

  if (message.type === "START_BATCH") {
    if (jobState.isRunning) {
      sendResponse({ ok: false, error: "A batch is already running." });
      return true;
    }
    const urls = Array.isArray(message.urls) ? message.urls : [];
    const subfolder = message.subfolder || "CleanRead";
    const concurrency = parseInt(message.concurrency, 10) || 3;
    const minWait = parseFloat(message.minWait) || 7;
    const maxWait = parseFloat(message.maxWait) || 21;
    runBatchQueue(urls, subfolder, concurrency, minWait, maxWait);
    sendResponse({ ok: true, state: jobState });
    return true;
  }

  if (message.type === "STOP_BATCH") {
    if (jobState.isRunning) {
      jobState.cancelRequested = true;
      addLog("Stopping after current URLs finish...", "warn");
    }
    sendResponse({ ok: true, state: jobState });
    return true;
  }
});
