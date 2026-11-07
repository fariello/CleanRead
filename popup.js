const subfolderInput = document.getElementById("subfolderInput");
const folderPreview = document.getElementById("folderPreview");
const urlsInput = document.getElementById("urlsInput");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const openFolderBtn = document.getElementById("openFolderBtn");
const statusText = document.getElementById("statusText");
const counterText = document.getElementById("counterText");
const progressFill = document.getElementById("progressFill");
const logsContainer = document.getElementById("logsContainer");

function parseUrls(rawText) {
  const lines = (rawText || "")
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    .filter(Boolean);

  const validUrls = [];
  for (const line of lines) {
    // Extract http/https URL if line has surrounding text, or treat whole line as URL
    const match = line.match(/https?:\/\/[^\s"'<>]+/i);
    let candidate = match ? match[0] : line;
    if (!/^https?:\/\//i.test(candidate) && /^[a-z0-9.-]+\.[a-z]{2,}\b/i.test(candidate)) {
      candidate = "https://" + candidate;
    }
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        validUrls.push(parsed.href);
      }
    } catch (_) {
      // Ignore invalid lines
    }
  }
  return validUrls;
}

function renderState(state) {
  if (!state) return;

  const doneCount = (state.completed || 0) + (state.failed || 0);
  const total = state.total || 0;
  counterText.textContent = `${doneCount} / ${total}`;

  const pct = total > 0 ? Math.min(100, Math.round((doneCount / total) * 100)) : 0;
  progressFill.style.width = `${pct}%`;

  if (state.isRunning) {
    statusText.textContent = state.cancelRequested
      ? "Stopping..."
      : "Opening & saving one at a time...";
    startBtn.disabled = true;
    stopBtn.style.display = "inline-block";
    stopBtn.disabled = Boolean(state.cancelRequested);
  } else {
    statusText.textContent =
      total > 0 ? `Done (${state.completed} saved, ${state.failed} failed)` : "Idle";
    startBtn.disabled = false;
    stopBtn.style.display = "none";
  }

  logsContainer.innerHTML = "";
  const logs = Array.isArray(state.logs) ? state.logs : [];
  for (const item of logs) {
    const div = document.createElement("div");
    div.className = `log-item ${item.type || "info"}`;
    div.textContent = `[${item.time}] ${item.message}`;
    logsContainer.appendChild(div);
  }
  logsContainer.scrollTop = logsContainer.scrollHeight;
}

// Load saved drafts and live state on popup open
chrome.storage.local.get(
  ["cleanReadSubfolder", "cleanReadUrlsDraft", "cleanReadJobState"],
  (res) => {
    if (res.cleanReadSubfolder) {
      subfolderInput.value = res.cleanReadSubfolder;
      folderPreview.textContent = res.cleanReadSubfolder;
    }
    if (res.cleanReadUrlsDraft) {
      urlsInput.value = res.cleanReadUrlsDraft;
    }
    if (res.cleanReadJobState) {
      renderState(res.cleanReadJobState);
    }
  }
);

chrome.runtime.sendMessage({ type: "GET_STATE" }, (res) => {
  if (res && res.state) {
    renderState(res.state);
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "STATE_UPDATE" && msg.state) {
    renderState(msg.state);
  }
});

subfolderInput.addEventListener("input", () => {
  const val = subfolderInput.value.trim() || "CleanRead";
  folderPreview.textContent = val;
  chrome.storage.local.set({ cleanReadSubfolder: val });
});

urlsInput.addEventListener("input", () => {
  chrome.storage.local.set({ cleanReadUrlsDraft: urlsInput.value });
});

startBtn.addEventListener("click", () => {
  const urls = parseUrls(urlsInput.value);
  if (urls.length === 0) {
    statusText.textContent = "Please paste at least one valid URL.";
    return;
  }

  const subfolder = subfolderInput.value.trim() || "CleanRead";
  chrome.storage.local.set({ cleanReadSubfolder: subfolder });

  chrome.runtime.sendMessage(
    {
      type: "START_BATCH",
      urls,
      subfolder
    },
    (res) => {
      if (res && res.state) {
        renderState(res.state);
      }
    }
  );
});

stopBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "STOP_BATCH" }, (res) => {
    if (res && res.state) {
      renderState(res.state);
    }
  });
});

openFolderBtn.addEventListener("click", () => {
  chrome.downloads.showDefaultFolder();
});
