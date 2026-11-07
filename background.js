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

function getLocalDateString() {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

function buildFilenames(subfolder, title, url) {
  const dateStr = getLocalDateString();

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
  const basePath = `${folder}/${dateStr}-${slug}`;
  return {
    md: `${basePath}.md`,
    html: `${basePath}.html`
  };
}

function downloadFile(content, filename, mimeType = "text/plain") {
  return new Promise((resolve, reject) => {
    const dataUrl =
      `data:${mimeType};charset=utf-8,` + encodeURIComponent(content);

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

      // Realistic human-like scrolling (downwards, occasionally slight back up)
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

async function processSingleUrl(url, subfolder, isSingleWorker = false) {
  let tabId = null;
  try {
    const tab = await chrome.tabs.create({ url, active: isSingleWorker });
    tabId = tab.id;

    // Wait for initial page complete
    await waitForTabComplete(tabId, 25000);

    // Random wait between 7.0 and 21.0 seconds with active mouse & scroll simulation
    const waitSeconds = (7 + Math.random() * 14).toFixed(1);
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
      `Retrieved-Timestamp: ${timestampUtc}`,
      "---",
      ""
    ].join("\n");

    const finalMarkdown = `${frontmatter}\n${payload.markdownBody.trim()}\n`;
    const filenames = buildFilenames(subfolder, payload.title, url);

    await downloadFile(finalMarkdown, filenames.md, "text/markdown");
    if (payload.rawHtml) {
      await downloadFile(payload.rawHtml, filenames.html, "text/html");
    }
    addLog(`Saved: ${filenames.md} & ${filenames.html}`, "success");
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

async function runBatchQueue(urls, subfolder, concurrency = 3) {
  const maxWorkers = Math.max(1, Math.min(Number(concurrency) || 3, 5));
  jobState = {
    isRunning: true,
    cancelRequested: false,
    subfolder: sanitizeSubfolder(subfolder),
    total: urls.length,
    completed: 0,
    failed: 0,
    currentUrl: "",
    concurrency: maxWorkers,
    logs: []
  };
  addLog(
    `Starting batch of ${urls.length} URL(s) with ${maxWorkers} tab worker(s) -> Downloads/${jobState.subfolder}/`
  );

  let nextIndex = 0;

  async function worker(workerId) {
    while (!jobState.cancelRequested) {
      if (nextIndex >= urls.length) break;
      const i = nextIndex++;
      const rawUrl = urls[i];

      jobState.currentUrl = rawUrl;
      addLog(`[Worker ${workerId}] Opening (${i + 1}/${urls.length}): ${rawUrl}`);
      broadcastState();

      try {
        await processSingleUrl(rawUrl, jobState.subfolder, maxWorkers === 1);
        jobState.completed++;
        addLog(`[Worker ${workerId}] Completed (${i + 1}/${urls.length})`, "success");
      } catch (err) {
        jobState.failed++;
        addLog(
          `[Worker ${workerId}] Error on ${rawUrl}: ${err && err.message ? err.message : String(err)}`,
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
    const concurrency = parseInt(message.concurrency, 10) || 3;
    runBatchQueue(urls, subfolder, concurrency);
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
