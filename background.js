/**
 * CleanRead Background Service Worker
 * Orchestrates opening URLs one at a time, running Readability + text-only Markdown extraction,
 * saving each file with URL + UTC Timestamp frontmatter, and closing the tab.
 */

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

/**
 * Waits until a tab reaches status === "complete" or times out after timeoutMs.
 * Even on timeout (e.g. a stalled 3rd-party tracker), we still proceed to extract the DOM.
 */
function waitForTabComplete(tabId, timeoutMs = 25000) {
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

    // Check immediately in case it already completed
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

function buildFilename(subfolder, index, total, title, url) {
  const padWidth = Math.max(2, String(total).length);
  const prefix = String(index).padStart(padWidth, "0");

  let base = (title || "").trim();
  if (!base || base.toLowerCase() === "untitled") {
    try {
      const parsed = new URL(url);
      base = (parsed.hostname + parsed.pathname).replace(/\/+$/, "");
    } catch (_) {
      base = "page";
    }
  }

  const slug = base
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 70) || "article";

  const folder = sanitizeSubfolder(subfolder);
  return `${folder}/${prefix}-${slug}.md`;
}

function downloadMarkdownFile(markdownText, filename) {
  return new Promise((resolve, reject) => {
    const dataUrl =
      "data:text/markdown;charset=utf-8," + encodeURIComponent(markdownText);

    chrome.downloads.download(
      {
        url: dataUrl,
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
          resolve(downloadId);
        }
      }
    );
  });
}

async function processSingleUrl(url, index, total, subfolder) {
  let tabId = null;
  try {
    const tab = await chrome.tabs.create({ url, active: true });
    tabId = tab.id;

    // Wait for page load + brief settle delay for dynamic JS content
    await waitForTabComplete(tabId, 25000);
    await sleep(1500);

    const timestampUtc = new Date().toISOString();

    // Inject Mozilla Readability.js first
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["Readability.js"]
    });

    // Inject our CleanRead extractor and capture its return value
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
      `Timestamp: ${timestampUtc}`,
      "---",
      ""
    ].join("\n");

    const finalMarkdown = `${frontmatter}\n${payload.markdownBody.trim()}\n`;
    const filename = buildFilename(subfolder, index, total, payload.title, url);

    await downloadMarkdownFile(finalMarkdown, filename);
    addLog(`Saved: ${filename}`, "success");
    return true;
  } finally {
    if (tabId !== null) {
      try {
        await chrome.tabs.remove(tabId);
      } catch (_) {
        // Tab may already have been closed by user
      }
    }
  }
}

async function runBatchQueue(urls, subfolder) {
  jobState = {
    isRunning: true,
    cancelRequested: false,
    subfolder: sanitizeSubfolder(subfolder),
    total: urls.length,
    completed: 0,
    failed: 0,
    currentUrl: "",
    logs: []
  };
  addLog(`Starting batch of ${urls.length} URL(s) -> Downloads/${jobState.subfolder}/`);

  for (let i = 0; i < urls.length; i++) {
    if (jobState.cancelRequested) {
      addLog("Batch stopped by user.", "warn");
      break;
    }

    const rawUrl = urls[i];
    jobState.currentUrl = rawUrl;
    broadcastState();
    addLog(`[${i + 1}/${urls.length}] Opening ${rawUrl}`);

    try {
      await processSingleUrl(rawUrl, i + 1, urls.length, jobState.subfolder);
      jobState.completed++;
    } catch (err) {
      jobState.failed++;
      addLog(
        `Error on ${rawUrl}: ${err && err.message ? err.message : String(err)}`,
        "error"
      );
    }

    broadcastState();
    // Brief pause between tabs
    if (i < urls.length - 1 && !jobState.cancelRequested) {
      await sleep(500);
    }
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

  if (message.type === "START_BATCH") {
    if (jobState.isRunning) {
      sendResponse({ ok: false, error: "A batch is already running." });
      return true;
    }
    const urls = Array.isArray(message.urls) ? message.urls : [];
    const subfolder = message.subfolder || "CleanRead";
    runBatchQueue(urls, subfolder);
    sendResponse({ ok: true, state: jobState });
    return true;
  }

  if (message.type === "STOP_BATCH") {
    if (jobState.isRunning) {
      jobState.cancelRequested = true;
      addLog("Stopping after current URL finishes...", "warn");
    }
    sendResponse({ ok: true, state: jobState });
    return true;
  }
});
