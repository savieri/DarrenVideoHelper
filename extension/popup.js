let currentTabId = null;
let currentState = null;
const jobCache = new Map();
let sessionRefreshTimer = 0;
let activePreview = null;
const PREVIEW_HOVER_DELAY_MS = 240;
const PREVIEW_MAX_PLAY_MS = 8000;

const pageTitleEl = document.getElementById("pageTitle");
const noticeEl = document.getElementById("notice");
const streamsEl = document.getElementById("streams");
const refreshButton = document.getElementById("refreshButton");
const optionsButton = document.getElementById("optionsButton");
const pauseQueueButton = document.getElementById("pauseQueueButton");
const resumeQueueButton = document.getElementById("resumeQueueButton");
const importFileEl = document.getElementById("importFile");
const jobsEl = document.getElementById("jobs");
const jobListEl = document.getElementById("jobList");
const queueStateEl = document.getElementById("queueState");

document.addEventListener("DOMContentLoaded", init);
refreshButton.addEventListener("click", loadStreams);
optionsButton.addEventListener("click", () => chrome.runtime.openOptionsPage());
pauseQueueButton.addEventListener("click", async () => {
  await sendMessage({ type: "pauseQueue" });
  await refreshJobs();
});
resumeQueueButton.addEventListener("click", async () => {
  await sendMessage({ type: "resumeQueue" });
  await refreshJobs();
});
importFileEl.addEventListener("change", importUrlFile);
window.addEventListener("blur", stopActivePreview);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopActivePreview();
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.source === "darren-video-helper-page-preview") {
    if (!activePreview || message.token !== activePreview.token) return;
    if (message.type === "pagePreviewFrame") activePreview.showFrame(message.frame);
    if (message.type === "pagePreviewUnavailable") activePreview.unavailable();
    return;
  }
  if (message?.tabId === currentTabId && message.type === "videoSessionInvalidated") {
    currentState = { ...(currentState || {}), navigating: true, streams: [], recommended: null };
    pageTitleEl.textContent = "正在切换视频…";
    renderStreams([]);
    showNotice("页面正在切换，上一视频已失效。正在检测新视频…", "warning");
    return;
  }
  if (message?.tabId === currentTabId && message.type === "videoSessionChanged") {
    window.clearTimeout(sessionRefreshTimer);
    sessionRefreshTimer = window.setTimeout(loadStreams, 120);
    return;
  }
  if (!message || message.type !== "jobUpdate" || !message.job) return;
  jobCache.set(message.job.id, message.job);
  if (currentState) currentState.queuePaused = Boolean(message.queuePaused);
  renderJobs();
});

async function init() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTabId = tabs?.[0]?.id || null;
  await loadStreams();
  window.setInterval(refreshJobs, 1800);
}

async function loadStreams() {
  showNotice("正在检测...", "muted");
  streamsEl.innerHTML = "";

  try {
    currentState = await sendMessage({ type: "getStreams", tabId: currentTabId });
    if (!currentState.ok) throw new Error(currentState.error || "Could not read streams.");

    pageTitleEl.textContent = currentState.pageTitle || currentState.pageUrl || "Current tab";

    for (const job of currentState.jobs || []) jobCache.set(job.id, job);
    renderStreams(currentState.streams || []);
    renderJobs();

    if (currentState.warning) {
      showNotice(currentState.warning, "warning");
    } else if (!currentState.streams?.length) {
      showNotice("没检测到视频，请先播放 3-5 秒后刷新 popup。", "warning");
    } else if (!currentState.detectedStreamCount) {
      showNotice("未捕获到 m3u8/MP4；PAGE 不会作为真实媒体自动下载。", "warning");
    } else {
      hideNotice();
    }
  } catch (error) {
    showNotice(error.message || String(error), "error");
  }
}

function renderStreams(streams) {
  stopActivePreview();
  streamsEl.innerHTML = "";

  if (!streams.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = currentState?.navigating ? "正在切换视频…" : "没检测到视频";
    streamsEl.appendChild(empty);
    return;
  }

  for (const stream of streams) {
    const card = document.createElement("article");
    card.className = [
      "stream-card",
      stream.recommended ? "recommended" : "",
      stream.canDownloadWholeVideo ? "" : "segment"
    ].filter(Boolean).join(" ");
    card.dataset.streamId = stream.id;

    const preview = document.createElement("div");
    preview.className = "media-preview";
    preview.dataset.previewMode = "poster";
    if (stream.thumbnailUrl) {
      const img = document.createElement("img");
      img.src = stream.thumbnailUrl;
      img.alt = "";
      img.loading = "lazy";
      preview.appendChild(img);
    } else {
      const placeholder = document.createElement("span");
      placeholder.className = "preview-placeholder";
      placeholder.textContent = "▶";
      preview.appendChild(placeholder);
    }
    if (stream.previewStrategy !== "poster" && (stream.previewStrategy || stream.previewUrl)) {
      setupHoverPreview(preview, stream);
    }
    const previewOverlay = document.createElement("div");
    previewOverlay.className = "preview-overlay";
    const formatPill = document.createElement("span");
    formatPill.className = "preview-format";
    formatPill.textContent = stream.formatLabel || "MP4";
    previewOverlay.appendChild(formatPill);
    const duration = document.createElement("span");
    duration.className = "preview-duration";
    duration.textContent = stream.durationLabel || "--:--";
    previewOverlay.appendChild(duration);
    preview.appendChild(previewOverlay);
    card.appendChild(preview);

    const body = document.createElement("div");
    body.className = "stream-body";

    const titleRow = document.createElement("div");
    titleRow.className = "stream-title-row";
    const title = document.createElement("h2");
    title.textContent = stream.sourceTitle || stream.host || "Detected video";
    titleRow.appendChild(title);
    body.appendChild(titleRow);

    const source = document.createElement("p");
    source.className = "source";
    source.textContent = [
      stream.providerLabel || stream.host || "网页视频",
      stream.pipelineLabel || stream.formatLabel,
      stream.sizeLabel || "大小未知"
    ].filter(Boolean).join(" · ");
    body.appendChild(source);

    const actions = document.createElement("div");
    actions.className = "actions";

    const formatBadge = makeBadge(stream.formatLabel || "MP4", "format");
    actions.appendChild(formatBadge);

    const qualitySelect = document.createElement("select");
    qualitySelect.className = "quality-select";
    qualitySelect.setAttribute("aria-label", "选择清晰度");
    for (const quality of stream.qualityOptions || [{ value: "best", label: "最佳可用" }]) {
      const option = document.createElement("option");
      option.value = quality.value;
      option.textContent = quality.label;
      option.selected = quality.value === (stream.defaultQuality || "best");
      qualitySelect.appendChild(option);
    }
    actions.appendChild(qualitySelect);

    const downloadButton = document.createElement("button");
    downloadButton.type = "button";
    downloadButton.className = "primary download-button";
    downloadButton.textContent = "下载";
    downloadButton.disabled = !stream.canDownloadWholeVideo;
    downloadButton.addEventListener("click", () => downloadStream(stream, downloadButton, qualitySelect.value));
    actions.appendChild(downloadButton);

    body.appendChild(actions);
    if (stream.advancedSources?.length) {
      const details = document.createElement("details");
      details.className = "source-details";
      const summary = document.createElement("summary");
      summary.textContent = `内部来源 ${stream.evidenceCount || stream.advancedSources.length}`;
      details.appendChild(summary);
      const list = document.createElement("ul");
      for (const sourceItem of stream.advancedSources) {
        const item = document.createElement("li");
        item.textContent = [sourceItem.typeTag, sourceItem.qualityLabel, sourceItem.label]
          .filter(Boolean)
          .join(" · ");
        list.appendChild(item);
      }
      details.appendChild(list);
      const previewDiagnostic = document.createElement("p");
      previewDiagnostic.className = "preview-diagnostic";
      previewDiagnostic.hidden = true;
      details.appendChild(previewDiagnostic);
      body.appendChild(details);
    }
    card.appendChild(body);
    streamsEl.appendChild(card);
  }
}

function setupHoverPreview(preview, stream) {
  const video = document.createElement("video");
  video.className = "preview-video";
  video.muted = true;
  video.defaultMuted = true;
  video.playsInline = true;
  video.preload = "none";
  video.disablePictureInPicture = true;
  video.setAttribute("muted", "");
  video.setAttribute("playsinline", "");
  video.setAttribute("preload", "none");
  video.setAttribute("aria-hidden", "true");
  const frame = document.createElement("img");
  frame.className = "preview-frame";
  frame.alt = "";
  frame.setAttribute("aria-hidden", "true");
  preview.classList.add("can-preview");
  preview.title = "悬停静音预览";
  preview.appendChild(video);
  preview.appendChild(frame);

  let hoverTimer = 0;
  let stopTimer = 0;
  let previewToken = "";
  let pageFallbackStarted = false;

  const clearTimers = () => {
    window.clearTimeout(hoverTimer);
    window.clearTimeout(stopTimer);
    hoverTimer = 0;
    stopTimer = 0;
  };

  const stop = () => {
    clearTimers();
    const token = previewToken;
    previewToken = "";
    pageFallbackStarted = false;
    video.pause();
    video.removeAttribute("src");
    video.load();
    frame.removeAttribute("src");
    preview.classList.remove("preview-loading", "preview-playing");
    preview.dataset.previewMode = "poster";
    if (activePreview?.preview === preview) activePreview = null;
    if (token && currentTabId && chrome.tabs?.sendMessage) {
      chrome.tabs.sendMessage(currentTabId, { type: "stopPagePreview", token }, () => {
        void chrome.runtime.lastError;
      });
    }
  };

  const unavailable = () => {
    const details = preview.closest(".stream-card")?.querySelector(".preview-diagnostic");
    if (details) {
      details.textContent = "预览不可用：页面播放器未提供可读取画面，已无感保留海报。";
      details.hidden = false;
    }
    const current = activePreview;
    if (current?.preview === preview) activePreview = null;
    clearTimers();
    video.pause();
    video.removeAttribute("src");
    video.load();
    frame.removeAttribute("src");
    preview.classList.remove("preview-loading", "preview-playing");
    preview.dataset.previewMode = "poster-fallback";
  };

  const showFrame = (dataUrl) => {
    if (!dataUrl || activePreview?.preview !== preview) return;
    frame.src = dataUrl;
    preview.classList.remove("preview-loading");
    preview.classList.add("preview-playing");
    preview.dataset.previewMode = "page-player";
  };

  const startPagePlayerPreview = () => {
    if (pageFallbackStarted || activePreview?.preview !== preview) return;
    pageFallbackStarted = true;
    video.pause();
    video.removeAttribute("src");
    video.load();
    previewToken = `preview:${Date.now()}:${Math.random().toString(16).slice(2)}`;
    activePreview.token = previewToken;
    activePreview.showFrame = showFrame;
    activePreview.unavailable = unavailable;
    if (!currentTabId || !chrome.tabs?.sendMessage) {
      unavailable();
      return;
    }
    chrome.tabs.sendMessage(currentTabId, {
      type: "startPagePreview",
      token: previewToken,
      maxDurationMs: PREVIEW_MAX_PLAY_MS
    }, (response) => {
      const error = chrome.runtime.lastError;
      if (activePreview?.preview !== preview) return;
      if (error || !response?.ok) unavailable();
    });
  };

  const start = () => {
    hoverTimer = 0;
    if (!preview.matches(":hover")) return;
    stopActivePreview(preview);
    activePreview = { preview, stop, token: "", showFrame, unavailable };
    preview.classList.add("preview-loading");
    preview.dataset.previewMode = "loading";
    if (stream.previewStrategy === "popup_video" && stream.previewUrl) {
      video.src = stream.previewUrl;
      video.load();
      const playAttempt = video.play();
      if (playAttempt?.catch) {
        playAttempt.catch(() => {
          if (activePreview?.preview === preview) startPagePlayerPreview();
        });
      }
    } else {
      startPagePlayerPreview();
    }
    stopTimer = window.setTimeout(stop, PREVIEW_MAX_PLAY_MS);
  };

  preview.addEventListener("mouseenter", () => {
    if (hoverTimer || activePreview?.preview === preview) return;
    hoverTimer = window.setTimeout(start, PREVIEW_HOVER_DELAY_MS);
  });
  preview.addEventListener("mouseleave", stop);
  video.addEventListener("loadeddata", () => {
    if (activePreview?.preview !== preview) return;
    preview.classList.remove("preview-loading");
    preview.classList.add("preview-playing");
    preview.dataset.previewMode = "video";
  });
  video.addEventListener("ended", stop);
  video.addEventListener("error", () => {
    if (activePreview?.preview === preview || preview.classList.contains("preview-loading")) {
      startPagePlayerPreview();
    }
  });
}

function stopActivePreview(exceptPreview = null) {
  if (!activePreview || activePreview.preview === exceptPreview) return;
  const current = activePreview;
  activePreview = null;
  current.stop();
}

async function downloadStream(stream, button, qualityPreference = "best") {
  button.disabled = true;
  button.textContent = "已加入";
  try {
    let response = await requestDownload("download", stream, false, qualityPreference);
    if (response.duplicate && window.confirm(`${response.error}\n\n是否强制重新下载？`)) {
      response = await requestDownload("download", stream, true, qualityPreference);
    }
    if (!response.ok) throw new Error(response.error || "Download failed to start.");
    await refreshJobs();
    if (response.activeDuplicate) {
      button.textContent = "下载中";
      showNotice(response.message || "这个视频已在下载中。", "muted");
      focusJob(response.jobId);
    }
  } catch (error) {
    showNotice(error.message || String(error), "error");
    button.disabled = false;
    button.textContent = "下载";
  }
}

function requestDownload(type, stream, forceRedownload, qualityPreference = "best") {
  return sendMessage({
    type,
    tabId: currentTabId,
    forceRedownload,
    selection: {
      sessionId: stream.sessionId,
      resourceId: stream.resourceId || stream.id,
      resourceUrl: stream.resourceUrl || stream.lastUrl || stream.url,
      pageUrl: stream.pageUrl || currentState?.pageUrl || "",
      fingerprint: stream.fingerprint,
      qualityPreference
    }
  });
}

async function importUrlFile(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  try {
    const text = await file.text();
    const urls = parseUrls(text);
    const response = await sendMessage({ type: "importUrls", urls });
    if (!response.ok) throw new Error(response.error || "导入失败。");
    showNotice(`已加入 ${response.jobIds?.length || 0} 个任务`, "muted");
    await refreshJobs();
  } catch (error) {
    showNotice(error.message || String(error), "error");
  }
}

async function refreshJobs() {
  try {
    const response = await sendMessage({ type: "getJobs" });
    if (!response.ok) return;
    for (const job of response.jobs || []) jobCache.set(job.id, job);
    if (!currentState) currentState = {};
    currentState.queuePaused = Boolean(response.queuePaused);
    renderJobs();
  } catch {
    // The popup may close while a request is in flight.
  }
}

function renderJobs() {
  const jobs = Array.from(jobCache.values()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  jobsEl.hidden = jobs.length === 0;
  queueStateEl.textContent = currentState?.queuePaused ? "Paused" : "";
  jobListEl.innerHTML = "";

  for (const job of jobs) {
    const item = document.createElement("div");
    item.className = `job ${job.status || "running"}`;
    item.dataset.jobId = job.id;
    item.tabIndex = -1;

    const top = document.createElement("div");
    top.className = "job-top";
    const status = document.createElement("strong");
    status.textContent = jobStatus(job);
    top.appendChild(status);
    const title = document.createElement("span");
    title.textContent = job.title || "";
    top.appendChild(title);
    item.appendChild(top);

    const progress = document.createElement("div");
    progress.className = "progress";
    const fill = document.createElement("div");
    fill.style.width = `${Math.max(0, Math.min(100, Number(job.percent || 0)))}%`;
    progress.appendChild(fill);
    item.appendChild(progress);

    const message = document.createElement("p");
    message.textContent = jobLine(job);
    item.appendChild(message);

    if (job.outputPath) {
      const output = document.createElement("code");
      const size = job.fileSize ? ` (${formatBytes(job.fileSize)})` : "";
      output.textContent = `${job.outputPath}${size}`;
      item.appendChild(output);
    }

    const controls = document.createElement("div");
    controls.className = "job-controls";
    if (["queued", "paused", "downloading", "merging"].includes(job.status)) {
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "small";
      cancel.textContent = "Cancel";
      cancel.addEventListener("click", () => sendMessage({ type: "cancelJob", jobId: job.id }));
      controls.appendChild(cancel);
    }
    if (job.status === "failed" && (job.details || job.logs?.length)) {
      const details = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = "错误详情";
      details.appendChild(summary);
      const pre = document.createElement("pre");
      pre.textContent = [job.details, ...(job.logs || [])].filter(Boolean).join("\n");
      details.appendChild(pre);
      controls.appendChild(details);
    }
    if (controls.childNodes.length) item.appendChild(controls);

    jobListEl.appendChild(item);
  }
}

function focusJob(jobId) {
  const item = Array.from(jobListEl.querySelectorAll(".job"))
    .find((candidate) => candidate.dataset.jobId === jobId);
  if (!item) return;
  item.scrollIntoView({ block: "nearest", behavior: "smooth" });
  item.focus({ preventScroll: true });
}

function makeMeta(value, label) {
  const item = document.createElement("span");
  item.className = "meta";
  item.textContent = value;
  item.title = label;
  return item;
}

function makeBadge(text, variant) {
  const badge = document.createElement("span");
  badge.className = `badge ${variant || ""}`.trim();
  badge.textContent = text;
  return badge;
}

function jobStatus(job) {
  if (job.status === "completed") return "Completed";
  if (job.status === "failed") return "Failed";
  if (job.status === "queued") return "Queued";
  if (job.status === "paused") return "Paused";
  if (job.status === "cancelled") return "Canceled";
  if (job.status === "merging") return "Merging";
  if (job.percent) return `${job.percent}%`;
  return "Running";
}

function jobLine(job) {
  const parts = [job.message || job.error || ""];
  if (job.speed) parts.push(job.speed);
  if (job.eta) parts.push(`ETA ${job.eta}`);
  return parts.filter(Boolean).join(" · ");
}

function parseUrls(text) {
  const matches = String(text || "").match(/https?:\/\/[^\s,;"'<>]+/gi) || [];
  return Array.from(new Set(matches));
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) return "";
  const mb = value / (1024 * 1024);
  if (mb < 1024) return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB`;
  const gb = mb / 1024;
  return `${gb >= 10 ? Math.round(gb) : gb.toFixed(1)} GB`;
}

function showNotice(text, type) {
  noticeEl.textContent = text;
  noticeEl.className = `notice ${type || ""}`.trim();
  noticeEl.hidden = false;
}

function hideNotice() {
  noticeEl.hidden = true;
  noticeEl.textContent = "";
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(response);
    });
  });
}
