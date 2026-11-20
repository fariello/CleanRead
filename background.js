/**
 * TidyTexty Background Service Worker (v1.0.7)
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

let currentBatchFullLogs = [];

let jobState = {
  isRunning: false,
  cancelRequested: false,
  subfolder: "TidyTexty",
  total: 0,
  completed: 0,
  failed: 0,
  currentUrl: "",
  logs: []
};

function addLog(message, type = "info") {
  const now = new Date();
  const entry = {
    time: now.toISOString().slice(11, 19),
    message,
    type
  };
  currentBatchFullLogs.push(
    `[${getLocalIsoTimestamp(now)}] [${String(type).toUpperCase()}] ${message}`
  );
  jobState.logs.push(entry);
  if (jobState.logs.length > 100) {
    jobState.logs.shift();
  }
  broadcastState();
}

function broadcastState() {
  chrome.storage.local.set({ tidyTextyJobState: jobState }).catch(() => {});
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
  const cleaned = (folder || "TidyTexty")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .map((part) => part.replace(/[<>:"|?*\x00-\x1F]/g, "").trim())
    .filter((part) => part && part !== "." && part !== "..")
    .join("/");
  return cleaned || "TidyTexty";
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

function getBasename(filePath) {
  if (!filePath) return "";
  return String(filePath).split(/[\\/]/).pop() || "";
}

function headersToObject(headers) {
  const obj = {};
  if (!headers || typeof headers.forEach !== "function") return obj;
  headers.forEach((value, key) => {
    obj[key] = value;
  });
  return obj;
}

function getDownloadItem(downloadId) {
  return new Promise((resolve) => {
    chrome.downloads.search({ id: downloadId }, (items) => {
      resolve(items && items[0] ? items[0] : null);
    });
  });
}

function waitForDownloadFinish(downloadId, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      chrome.downloads.onChanged.removeListener(onChanged);
      clearTimeout(timer);
    };

    const finishOk = async () => {
      if (settled) return;
      settled = true;
      cleanup();
      const item = await getDownloadItem(downloadId);
      resolve({
        downloadId,
        item,
        basename: item ? getBasename(item.filename) : "",
        mime: (item && item.mime) || "",
        fileSize:
          item && typeof item.fileSize === "number" && item.fileSize >= 0
            ? item.fileSize
            : item && typeof item.totalBytes === "number" && item.totalBytes >= 0
            ? item.totalBytes
            : null,
        finalUrl: (item && item.finalUrl) || ""
      });
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

    const headers = headersToObject(res.headers);
    const contentType = res.headers.get("content-type") || "";
    const disp = res.headers.get("content-disposition") || "";
    const dispositionFilename = parseContentDispositionFilename(disp);
    const isAttachment = /\battachment\b/i.test(disp);

    return {
      ok: res.ok,
      status: res.status,
      finalUrl: res.url || url,
      contentType,
      dispositionFilename,
      isAttachment,
      headers
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
    const text = await res.text();
    return {
      text,
      status: res.status,
      finalUrl: res.url || url,
      contentType: res.headers.get("content-type") || "",
      headers: headersToObject(res.headers)
    };
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
    // Strip existing top YAML frontmatter if present so TidyTexty frontmatter isn't duplicated
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
  // Avoid filename collision with the generated TidyTexty *.md file
  if (MD_EXTENSIONS.has(ext)) {
    return `raw.${ext}`;
  }
  return ext || "txt";
}

function buildUrlMetadataJson({
  requestedUrl,
  finalUrl,
  title,
  kind,
  ext,
  mimeType,
  characterSet,
  lastModified,
  referrer,
  httpStatus,
  httpProtocol,
  responseHeaders,
  headersSource,
  navigationPerf,
  fileSizeBytes,
  fetchedAt,
  durationMs,
  mdBasename,
  rawBasename,
  jsonBasename
}) {
  const manifest = chrome.runtime.getManifest ? chrome.runtime.getManifest() : {};
  let parsedUrl = {};
  try {
    const u = new URL(finalUrl || requestedUrl);
    parsedUrl = {
      protocol: u.protocol,
      hostname: u.hostname,
      pathname: u.pathname,
      search: u.search || ""
    };
  } catch (_) {}

  let description = "";
  if (kind === "html") {
    description =
      "Per-URL metadata record generated by TidyTexty. " +
      `The companion Markdown file (${mdBasename}) contains screen-reader-friendly text extracted from the webpage, ` +
      `the companion HTML file (${rawBasename}) preserves the raw rendered HTML DOM, ` +
      `and this JSON file (${jsonBasename}) records URL info, fetch timestamps, MIME type, HTTP response headers, saved filenames relative to this directory, and extension metadata.`;
  } else if (kind === "text") {
    description =
      "Per-URL metadata record generated by TidyTexty. " +
      `The companion Markdown file (${mdBasename}) contains the TidyTexty-formatted Markdown with frontmatter, ` +
      `the companion raw file (${rawBasename}) preserves the untouched source file as downloaded, ` +
      `and this JSON file (${jsonBasename}) records URL info, fetch timestamps, MIME type, HTTP response headers, saved filenames relative to this directory, and extension metadata.`;
  } else {
    description =
      "Per-URL metadata record generated by TidyTexty. " +
      `Because this resource is a non-text/binary file (${ext || "binary"}), no Markdown (.md) file was generated. ` +
      `The companion raw file (${rawBasename}) is the original downloaded file, ` +
      `and this JSON file (${jsonBasename}) records URL info, fetch timestamps, MIME type, HTTP response headers, saved filenames relative to this directory, and extension metadata.`;
  }

  const allSavedFiles = [mdBasename, rawBasename, jsonBasename].filter(Boolean);

  return {
    description,
    extension: {
      name: manifest.name || "TidyTexty",
      version: manifest.version || "",
      manifestVersion: manifest.manifest_version || 3,
      description: manifest.description || "",
      id: chrome.runtime.id || ""
    },
    fetchedAt: {
      utc: fetchedAt.toISOString(),
      local: getLocalIsoTimestamp(fetchedAt),
      unixEpochMs: fetchedAt.getTime(),
      processingDurationMs: durationMs ?? null
    },
    url: {
      requested: requestedUrl,
      final: finalUrl || requestedUrl,
      ...parsedUrl,
      referrer: referrer || null
    },
    resource: {
      kind,
      title: title || null,
      fileExtension: ext || null,
      mimeType: mimeType || null,
      characterSet: characterSet || null,
      lastModified: lastModified || null,
      fileSizeBytes: fileSizeBytes ?? null
    },
    http: {
      status: httpStatus ?? (navigationPerf && navigationPerf.responseStatus) ?? null,
      protocol: httpProtocol || (navigationPerf && navigationPerf.nextHopProtocol) || null,
      transferSizeBytes: navigationPerf ? navigationPerf.transferSize : null,
      encodedBodySizeBytes: navigationPerf ? navigationPerf.encodedBodySize : null,
      decodedBodySizeBytes: navigationPerf ? navigationPerf.decodedBodySize : null,
      headersSource:
        headersSource ||
        (responseHeaders && Object.keys(responseHeaders).length > 0 ? "http" : "unavailable"),
      responseHeaders: responseHeaders || {}
    },
    files: {
      markdown: mdBasename || null,
      raw: rawBasename || null,
      metadata: jsonBasename,
      allSavedFiles
    },
    environment: {
      userAgent: navigator.userAgent || "",
      platform: navigator.platform || "",
      language: navigator.language || ""
    }
  };
}

async function saveUrlMetadataJson(basePath, metadataArgs) {
  const jsonFilename = `${basePath}.json`;
  const jsonBasename = getBasename(jsonFilename);
  const metadataObj = buildUrlMetadataJson({
    ...metadataArgs,
    jsonBasename
  });
  const dl = await downloadFile(
    JSON.stringify(metadataObj, null, 2),
    jsonFilename,
    "application/json"
  );
  return {
    jsonFilename,
    jsonBasename: dl.basename || jsonBasename
  };
}

async function saveTextOrMarkdownFile({
  url,
  requestedUrl,
  title,
  rawText,
  ext,
  mime,
  subfolder,
  dispositionFilename = "",
  metaContext = {}
}) {
  const fetchedAt = new Date();
  const timestampUtc = fetchedAt.toISOString();
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

  const mdDl = await downloadFile(mdContent, mdFilename, "text/markdown");

  let rawDl;
  try {
    rawDl = await downloadFromUrl(url, rawFilename);
  } catch (_) {
    rawDl = await downloadFile(rawText, rawFilename, mime || "text/plain");
  }

  const mdBasename = mdDl.basename || getBasename(mdFilename);
  const rawBasename = rawDl.basename || getBasename(rawFilename);

  const { jsonFilename } = await saveUrlMetadataJson(basePath, {
    requestedUrl: requestedUrl || url,
    finalUrl: url,
    title: title || dispositionFilename || null,
    kind: "text",
    ext,
    mimeType: mime || rawDl.mime || "text/plain",
    characterSet: metaContext.characterSet || null,
    lastModified: metaContext.lastModified || null,
    referrer: metaContext.referrer || null,
    httpStatus: metaContext.httpStatus ?? null,
    httpProtocol: metaContext.httpProtocol || null,
    responseHeaders: metaContext.responseHeaders || {},
    headersSource: metaContext.headersSource || null,
    navigationPerf: metaContext.navigationPerf || null,
    fileSizeBytes: rawDl.fileSize ?? rawText.length,
    fetchedAt,
    durationMs: metaContext.startedMs ? Date.now() - metaContext.startedMs : null,
    mdBasename,
    rawBasename
  });

  return {
    title: title || dispositionFilename || url,
    savedSummary: `${mdFilename}, ${rawFilename} & ${jsonFilename}`,
    md: mdFilename,
    raw: rawFilename,
    json: jsonFilename
  };
}

async function saveBinaryRawFile({
  url,
  requestedUrl,
  title,
  ext,
  mime,
  subfolder,
  dispositionFilename = "",
  metaContext = {}
}) {
  const fetchedAt = new Date();
  const basePath = buildBaseFilePath(subfolder, title, url, dispositionFilename);
  const rawFilename = `${basePath}.${ext || "bin"}`;

  const rawDl = await downloadFromUrl(url, rawFilename);
  const rawBasename = rawDl.basename || getBasename(rawFilename);

  const { jsonFilename } = await saveUrlMetadataJson(basePath, {
    requestedUrl: requestedUrl || url,
    finalUrl: rawDl.finalUrl || url,
    title: title || dispositionFilename || null,
    kind: "binary",
    ext,
    mimeType: mime || rawDl.mime || null,
    characterSet: metaContext.characterSet || null,
    lastModified: metaContext.lastModified || null,
    referrer: metaContext.referrer || null,
    httpStatus: metaContext.httpStatus ?? null,
    httpProtocol: metaContext.httpProtocol || null,
    responseHeaders: metaContext.responseHeaders || {},
    headersSource: metaContext.headersSource || null,
    navigationPerf: metaContext.navigationPerf || null,
    fileSizeBytes: rawDl.fileSize ?? null,
    fetchedAt,
    durationMs: metaContext.startedMs ? Date.now() - metaContext.startedMs : null,
    mdBasename: null,
    rawBasename
  });

  return {
    title: title || dispositionFilename || url,
    savedSummary: `${rawFilename} & ${jsonFilename}`,
    raw: rawFilename,
    json: jsonFilename
  };
}

async function extractHtmlPageFromTab(
  tabId,
  url,
  subfolder,
  ext = "html",
  metaContext = {}
) {
  const fetchedAt = new Date();
  const timestampUtc = fetchedAt.toISOString();

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

  const mdDl = await downloadFile(finalMarkdown, mdFilename, "text/markdown");
  let rawDl = null;
  if (payload.rawHtml) {
    rawDl = await downloadFile(payload.rawHtml, rawFilename, "text/html");
  }

  const mdBasename = mdDl.basename || getBasename(mdFilename);
  const rawBasename = rawDl ? rawDl.basename || getBasename(rawFilename) : null;

  const { jsonFilename } = await saveUrlMetadataJson(basePath, {
    requestedUrl: metaContext.requestedUrl || url,
    finalUrl: url,
    title: payload.title || null,
    kind: "html",
    ext: ext === "htm" ? "htm" : "html",
    mimeType: metaContext.mimeType || "text/html",
    characterSet: metaContext.characterSet || null,
    lastModified: metaContext.lastModified || null,
    referrer: metaContext.referrer || null,
    httpStatus: metaContext.httpStatus ?? null,
    httpProtocol: metaContext.httpProtocol || null,
    responseHeaders: metaContext.responseHeaders || {},
    headersSource: metaContext.headersSource || null,
    navigationPerf: metaContext.navigationPerf || null,
    fileSizeBytes: rawDl ? rawDl.fileSize : null,
    fetchedAt,
    durationMs: metaContext.startedMs ? Date.now() - metaContext.startedMs : null,
    mdBasename,
    rawBasename
  });

  return {
    title: payload.title,
    savedSummary: `${mdFilename}, ${rawFilename} & ${jsonFilename}`,
    md: mdFilename,
    raw: rawFilename,
    json: jsonFilename
  };
}

async function probeLoadedTab(tabId) {
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const navEntry =
          performance && typeof performance.getEntriesByType === "function"
            ? performance.getEntriesByType("navigation")[0]
            : null;
        return {
          contentType: document.contentType || "",
          characterSet: document.characterSet || "",
          lastModified: document.lastModified || "",
          referrer: document.referrer || "",
          title: document.title || "",
          bodyText: document.body ? document.body.innerText : "",
          hasPdfEmbed: Boolean(document.querySelector('embed[type="application/pdf"]')),
          navigation: navEntry
            ? {
                responseStatus: navEntry.responseStatus || null,
                nextHopProtocol: navEntry.nextHopProtocol || "",
                transferSize: navEntry.transferSize ?? null,
                encodedBodySize: navEntry.encodedBodySize ?? null,
                decodedBodySize: navEntry.decodedBodySize ?? null
              }
            : null
        };
      }
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

function buildMetaContext({
  requestedUrl,
  startedMs,
  headInfo = null,
  fetchInfo = null,
  probed = null
}) {
  const responseHeaders =
    (fetchInfo &&
      fetchInfo.headers &&
      Object.keys(fetchInfo.headers).length > 0 &&
      fetchInfo.headers) ||
    (headInfo &&
      headInfo.headers &&
      Object.keys(headInfo.headers).length > 0 &&
      headInfo.headers) ||
    {};

  const headersSource =
    fetchInfo && fetchInfo.headers && Object.keys(fetchInfo.headers).length > 0
      ? "http-get"
      : headInfo && headInfo.headers && Object.keys(headInfo.headers).length > 0
      ? "http-head"
      : "unavailable";

  return {
    requestedUrl,
    startedMs,
    mimeType:
      (fetchInfo && fetchInfo.contentType) ||
      (probed && probed.contentType) ||
      (headInfo && headInfo.contentType) ||
      "",
    characterSet: (probed && probed.characterSet) || null,
    lastModified: (probed && probed.lastModified) || null,
    referrer: (probed && probed.referrer) || null,
    httpStatus:
      (fetchInfo && fetchInfo.status) ?? (headInfo && headInfo.status) ?? null,
    httpProtocol:
      probed && probed.navigation ? probed.navigation.nextHopProtocol : null,
    navigationPerf: (probed && probed.navigation) || null,
    responseHeaders,
    headersSource
  };
}

async function processSingleUrl(
  url,
  subfolder,
  isSingleWorker = false,
  minWait = 7,
  maxWait = 21
) {
  const startedMs = Date.now();

  // Fast pre-flight check via HEAD so direct binary downloads (PDFs, zips, images)
  // and plain text/md files save directly without fighting Chrome's viewer or attachment behavior.
  let headInfo = await probeRemoteHeaders(url);
  if (headInfo && headInfo.ok) {
    const info = classifyResource(
      headInfo.finalUrl || url,
      headInfo.contentType,
      headInfo.dispositionFilename
    );

    if (info.kind === "binary" || (headInfo.isAttachment && info.kind !== "text")) {
      const result = await saveBinaryRawFile({
        url: headInfo.finalUrl || url,
        requestedUrl: url,
        title: "",
        ext: info.ext,
        mime: info.mime,
        subfolder,
        dispositionFilename: headInfo.dispositionFilename,
        metaContext: buildMetaContext({ requestedUrl: url, startedMs, headInfo })
      });
      addLog(`Saved raw + JSON: ${result.savedSummary}`, "success");
      return { kind: "binary", ...result };
    }

    if (info.kind === "text") {
      try {
        const fetchInfo = await fetchRawText(headInfo.finalUrl || url);
        const result = await saveTextOrMarkdownFile({
          url: fetchInfo.finalUrl || headInfo.finalUrl || url,
          requestedUrl: url,
          title: "",
          rawText: fetchInfo.text,
          ext: info.ext,
          mime: info.mime,
          subfolder,
          dispositionFilename: headInfo.dispositionFilename,
          metaContext: buildMetaContext({
            requestedUrl: url,
            startedMs,
            headInfo,
            fetchInfo
          })
        });
        addLog(`Saved text, MD + JSON: ${result.savedSummary}`, "success");
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
    // If initial HEAD failed (e.g. Cloudflare cleared in tab or redirect), re-probe headers now
    if (!headInfo || !headInfo.ok || effectiveUrl !== url) {
      const postHead = await probeRemoteHeaders(effectiveUrl, 3000);
      if (postHead) headInfo = postHead;
    }

    let info = classifyResource(effectiveUrl, probed ? probed.contentType : "", "");
    if (probed && probed.hasPdfEmbed) {
      info = { kind: "binary", ext: "pdf", mime: "application/pdf" };
    }

    if (info.kind === "binary") {
      const result = await saveBinaryRawFile({
        url: effectiveUrl,
        requestedUrl: url,
        title: probed ? probed.title : "",
        ext: info.ext,
        mime: info.mime,
        subfolder,
        metaContext: buildMetaContext({
          requestedUrl: url,
          startedMs,
          headInfo,
          probed
        })
      });
      addLog(`Saved raw + JSON: ${result.savedSummary}`, "success");
      return { kind: "binary", ...result };
    }

    if (info.kind === "text") {
      let rawText = probed ? probed.bodyText : "";
      let fetchInfo = null;
      try {
        fetchInfo = await fetchRawText(effectiveUrl);
        rawText = fetchInfo.text;
      } catch (_) {}
      const result = await saveTextOrMarkdownFile({
        url: effectiveUrl,
        requestedUrl: url,
        title: probed ? probed.title : "",
        rawText,
        ext: info.ext,
        mime: info.mime,
        subfolder,
        metaContext: buildMetaContext({
          requestedUrl: url,
          startedMs,
          headInfo,
          fetchInfo,
          probed
        })
      });
      addLog(`Saved text, MD + JSON: ${result.savedSummary}`, "success");
      return { kind: "text", ...result };
    }

    const result = await extractHtmlPageFromTab(
      tabId,
      effectiveUrl,
      subfolder,
      info.ext,
      buildMetaContext({
        requestedUrl: url,
        startedMs,
        headInfo,
        probed
      })
    );
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

const readmeCreationPromises = new Map();

function folderAlreadyHasReadme(subfolder) {
  const normalizedFolder = sanitizeSubfolder(subfolder).toLowerCase();
  const targetSuffix = `/${normalizedFolder}/readme.md`;
  return new Promise((resolve) => {
    chrome.downloads.search({ exists: true }, (items) => {
      if (chrome.runtime.lastError || !Array.isArray(items)) {
        resolve(false);
        return;
      }
      const found = items.some((item) => {
        if (!item.filename || item.state !== "complete") return false;
        const normPath = item.filename.replace(/\\/g, "/").toLowerCase();
        return normPath.endsWith(targetSuffix);
      });
      resolve(found);
    });
  });
}

function buildDirectoryReadmeMarkdown(subfolder) {
  const manifest = chrome.runtime.getManifest ? chrome.runtime.getManifest() : {};
  const extName = manifest.name || "TidyTexty";
  const extVersion = manifest.version || "1.0.7";
  const cleanFolder = sanitizeSubfolder(subfolder);

  return `# ${extName} Output Directory (\`Downloads/${cleanFolder}/\`)

This directory contains web pages, text documents, raw files, metadata sidecars, and batch reports archived by **${extName} v${extVersion}** (a Chrome/Edge Manifest V3 browser extension).

## What ${extName} Does

- **Webpages & Text Resources** (\`.html\`, \`.htm\`, \`.txt\`, \`.md\`, \`.json\`, \`.xml\`, \`.csv\`, \`.yaml\`, \`.rst\`, \`.log\`):
  - Strips navigation bars, ads, sidebars, headers, footers, and pop-ups (using Mozilla \`Readability.js\` + semantic DOM normalization) to generate clean, screen-reader-friendly Markdown (\`YYYYMMDD-<slug>.md\`).
  - Downloads the untouched raw source (post-JS rendered \`.html\` for webpages, or the original raw file for text/data URLs).
- **Binary / Non-Text Files** (\`.pdf\`, \`.docx\`, \`.xlsx\`, \`.pptx\`, \`.zip\`, images, audio, video):
  - Downloads the original binary file directly (\`YYYYMMDD-<slug>.<ext>\`) without generating a \`.md\` file.
- **Metadata & Batch Audits**:
  - Writes a per-URL \`.json\` sidecar for every fetched URL, plus a timestamped Markdown report and complete execution log after each batch run.

---

## File Types in This Directory

All per-URL artifacts share the same local date prefix and slug: \`YYYYMMDD-<slug>\`.

1. **\`YYYYMMDD-<slug>.md\`** — Clean, readable Markdown extracted from HTML webpages or formatted from text/Markdown URLs. Always starts with YAML frontmatter:
   - \`URL\`: Original URL
   - \`Retrieved-Timestamp\`: UTC ISO-8601 retrieval timestamp

2. **\`YYYYMMDD-<slug>.json\`** — Structured metadata sidecar written for **every** fetched URL (webpages, text files, and binaries alike):
   - \`description\`: Explains what the JSON file and its companion files contain.
   - \`extension\`: Name, version, manifest version, description, and ID of the ${extName} extension build that created it.
   - \`fetchedAt\`: UTC timestamp, local ISO timestamp, Unix epoch ms, and processing duration.
   - \`url\`: \`requested\`, \`final\` (after redirects), parsed URL components, and \`referrer\`.
   - \`resource\`: \`kind\` (\`"html"\` | \`"text"\` | \`"binary"\`), \`title\`, \`fileExtension\`, \`mimeType\`, \`characterSet\`, \`lastModified\`, and \`fileSizeBytes\`.
   - \`http\`: HTTP status code, protocol, transfer/body byte sizes, and full \`responseHeaders\`.
   - \`files\`: Filenames **relative to this directory** (no full disk paths):
     - \`markdown\`: Companion \`.md\` filename (or \`null\` for binary files like PDFs)
     - \`raw\`: Companion raw filename (\`.html\`, \`.txt\`, \`.raw.md\`, \`.pdf\`, etc.)
     - \`metadata\`: This \`.json\` filename
     - \`allSavedFiles\`: Array of all filenames saved in this directory for that URL

3. **Raw Companion Files**
   - \`YYYYMMDD-<slug>.html\` / \`.htm\` — Post-JS rendered HTML DOM snapshot for webpages.
   - \`YYYYMMDD-<slug>.<ext>\` — Original raw text/data file (\`.txt\`, \`.json\`, \`.csv\`, \`.xml\`) or binary file (\`.pdf\`, \`.docx\`, \`.zip\`, \`.png\`, etc.).
   - \`YYYYMMDD-<slug>.raw.md\` — Original raw Markdown file when the fetched URL itself was already Markdown (distinguishing it from ${extName}'s frontmattered \`.md\`).

4. **\`YYYYMMDD-hhmmss-tidytexty-report.md\`** — Batch run summary report containing timestamps, settings, per-URL status/errors/saved files, and two plain URL lists at the bottom (\`## Successful URLS\` and \`## Unsuccessful URLs\`, one bare URL per line for copy-paste/retry).

5. **\`YYYYMMDD-hhmmss-tidytexty.log\`** — Full, untruncated timestamped execution log for a batch run.

---

## How an Agent Should Read & Use These Files

1. **Discover & Index**: Start by reading the latest \`*-tidytexty-report.md\` (for batch runs) or listing \`*.json\` sidecars. Each \`*.json\` file is self-describing and maps directly to its companion files via \`files.markdown\`, \`files.raw\`, and \`files.allSavedFiles\`.
2. **Read Clean Text**: Read \`YYYYMMDD-<slug>.md\` for clean article content without HTML boilerplate or ads. Inspect its top frontmatter for source \`URL\` and \`Retrieved-Timestamp\`.
3. **Inspect Raw Originals When Needed**: Open \`files.raw\` only when you need exact original HTML markup, structured data, or non-text binary files such as PDFs, Office documents, or images.
4. **Troubleshoot**: If a URL appears under \`## Unsuccessful URLs\` in a report, check the corresponding \`*-tidytexty.log\` for detailed worker timings and error messages.
`;
}

async function ensureDirectoryReadme(subfolder) {
  const cleanFolder = sanitizeSubfolder(subfolder);
  const key = cleanFolder.toLowerCase();
  if (readmeCreationPromises.has(key)) {
    return readmeCreationPromises.get(key);
  }

  const task = (async () => {
    try {
      const exists = await folderAlreadyHasReadme(cleanFolder);
      if (exists) return false;

      const readmeFilename = `${cleanFolder}/README.md`;
      const content = buildDirectoryReadmeMarkdown(cleanFolder);
      await downloadFile(content, readmeFilename, "text/markdown");
      addLog(`Created directory guide: ${readmeFilename}`, "info");
      return true;
    } catch (_) {
      return false;
    } finally {
      readmeCreationPromises.delete(key);
    }
  })();

  readmeCreationPromises.set(key, task);
  return task;
}

async function processCurrentTab(tabId, url, title, subfolder) {
  await ensureDirectoryReadme(subfolder);
  const startedMs = Date.now();
  const probed = await probeLoadedTab(tabId);
  const headerInfo = await probeRemoteHeaders(url, 3000);

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
      requestedUrl: url,
      title: effectiveTitle,
      ext: info.ext,
      mime: info.mime,
      subfolder,
      dispositionFilename: dispName,
      metaContext: buildMetaContext({
        requestedUrl: url,
        startedMs,
        headInfo: headerInfo,
        probed
      })
    });
    addLog(`Saved current file + JSON: ${result.savedSummary}`, "success");
    return {
      ok: true,
      title: result.title,
      filename: result.savedSummary,
      kind: "binary"
    };
  }

  if (info.kind === "text") {
    let rawText = (probed && probed.bodyText) || "";
    let fetchInfo = null;
    try {
      fetchInfo = await fetchRawText(url);
      rawText = fetchInfo.text;
    } catch (_) {}

    const result = await saveTextOrMarkdownFile({
      url,
      requestedUrl: url,
      title: effectiveTitle,
      rawText,
      ext: info.ext,
      mime: info.mime,
      subfolder,
      dispositionFilename: dispName,
      metaContext: buildMetaContext({
        requestedUrl: url,
        startedMs,
        headInfo: headerInfo,
        fetchInfo,
        probed
      })
    });
    addLog(`Saved current text, MD + JSON: ${result.savedSummary}`, "success");
    return {
      ok: true,
      title: result.title,
      filename: result.savedSummary,
      kind: "text"
    };
  }

  const result = await extractHtmlPageFromTab(
    tabId,
    url,
    subfolder,
    info.ext,
    buildMetaContext({
      requestedUrl: url,
      startedMs,
      headInfo: headerInfo,
      probed
    })
  );
  addLog(`Saved current page + JSON: ${result.savedSummary}`, "success");
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
    "# TidyTexty Batch Report",
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

  currentBatchFullLogs = [];
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
  await ensureDirectoryReadme(jobState.subfolder);

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
  const dateTimePrefix = getLocalDateTimePrefix(completedAt);
  const reportFilename = `${jobState.subfolder}/${dateTimePrefix}-tidytexty-report.md`;
  const logFilename = `${jobState.subfolder}/${dateTimePrefix}-tidytexty.log`;
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

  try {
    const logContent = currentBatchFullLogs.join("\n") + "\n";
    await downloadFile(logContent, logFilename, "text/plain");
    addLog(`Log saved: ${logFilename}`, "success");
  } catch (err) {
    addLog(
      `Failed to save log: ${err && err.message ? err.message : String(err)}`,
      "error"
    );
  }

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
    const subfolder = message.subfolder || "TidyTexty";

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
    const subfolder = message.subfolder || "TidyTexty";
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
