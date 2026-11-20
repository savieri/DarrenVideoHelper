let currentTabId = null;
let currentState = null;
const jobCache = new Map();
let sessionRefreshTimer = 0;
let activePreview = null;
let streamGeneration = 0;
let streamRequest = null;
let streamRefreshPending = false;
let navigationPolls = 0;
let lastJobRender = "";
const PREVIEW_HOVER_DELAY_MS = 240;
const PREVIEW_MAX_PLAY_MS = 8000;

const pageTitleEl = document.getElementById("pageTitle");
const noticeEl = document.getElementById("notice");
const streamsEl = document.getElementById("streams");
const resourceToolbar = document.getElementById("resourceToolbar");
const resourceCount = document.getElementById("resourceCount");
const resourceSort = document.getElementById("resourceSort");
const captureDetails = document.getElementById("captureDetails");
const captureGaps = document.getElementById("captureGaps");
const groupExpansion = new Map();
resourceSort.addEventListener("change", () => renderStreams(currentState?.streams || []));
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
document.getElementById("versionLabel").textContent = chrome.runtime.getManifest().version_name;
document.getElementById("diagnosticsButton").addEventListener("click", async () => {
  try {
    const result = await sendMessage({ type: "getDiagnostics", tabId: currentTabId });
    if (!result.ok) throw new Error(result.error);
    saveDiagnostics(result.diagnostics, "DarrenVideoHelper-diagnostics.json");
  } catch (error) { showNotice(error.message, "error"); }
});
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
    if (!currentState?.navigating) invalidateStreams();
    scheduleStreamRefresh();
    return;
  }
  if (message?.tabId === currentTabId && message.type === "videoSessionChanged") {
    if (currentState?.sessionId && message.sessionId && message.sessionId !== currentState.sessionId && !currentState.navigating) {
      invalidateStreams();
    }
    scheduleStreamRefresh();
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
  pageTitleEl.textContent = tabs?.[0]?.title || "当前网页";
  void refreshJobs();
  window.setInterval(refreshJobs, 1800);
  await loadStreams();
}

function invalidateStreams() {
  streamGeneration++;
  navigationPolls = 0;
  currentState = { ...(currentState || {}), navigating: true, streams: [], recommended: null };
  pageTitleEl.textContent = "正在切换视频…";
  captureDetails.hidden = true;
  renderStreams([]);
  showNotice("正在检测新视频…", "muted");
}

function scheduleStreamRefresh(delay = 250) {
  streamRefreshPending = true;
  if (streamRequest || sessionRefreshTimer) return;
  sessionRefreshTimer = window.setTimeout(() => {
    sessionRefreshTimer = 0;
    void loadStreams();
  }, delay);
}

function loadStreams() {
  if (streamRequest) return streamRequest;
  window.clearTimeout(sessionRefreshTimer);
  sessionRefreshTimer = 0;
  streamRefreshPending = false;
  streamRequest = scanStreams(streamGeneration).finally(() => {
    streamRequest = null;
    if (streamRefreshPending) scheduleStreamRefresh();
    else if (currentState?.navigating && navigationPolls < 8) {
      navigationPolls++;
      scheduleStreamRefresh(500);
    }
  });
  return streamRequest;
}

async function scanStreams(generation) {
  if (!currentState?.streams?.length && !currentState?.navigating) showNotice("正在检测…", "muted");
  try {
    const result = await sendMessage({ type: "getStreams", tabId: currentTabId });
    if (generation !== streamGeneration) return;
    if (!result?.ok) throw new Error(result?.error || "无法读取当前网页的媒体资源。");
    const alreadyRendered = currentState?.sessionId === result.sessionId &&
      JSON.stringify(currentState?.streams) === JSON.stringify(result.streams);
    currentState = result;
    document.getElementById("modeNotice").textContent = result.mode === "full"
      ? "Full · MP4/WebM 使用 Chrome 下载；HLS/站点解析需要安装 macOS Native Host。"
      : "Chrome 独立版 · 直接 MP4/WebM 免安装下载。HLS/DASH/站点解析需要 macOS Full。";
    if (!result.navigating) navigationPolls = 0;

    pageTitleEl.textContent = currentState.pageTitle || currentState.pageUrl || "当前网页";
    pageTitleEl.title = pageTitleEl.textContent;

    for (const job of currentState.jobs || []) jobCache.set(job.id, job);
    if (!alreadyRendered) renderStreams(currentState.streams || []);
    captureGaps.replaceChildren(...(result.captureGaps || []).map(gap => {
      const item = document.createElement("li");
      item.textContent = gap;
      return item;
    }));
    captureDetails.hidden = !captureGaps.children.length;
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
    if (generation === streamGeneration) showNotice(error.message || String(error), "error");
  }
}

function renderStreams(streams) {
  stopActivePreview();
  streamsEl.innerHTML = "";

  resourceToolbar.hidden = !streams.length;
  resourceCount.textContent = `${streams.length} 项资源`;
  if (!streams.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = currentState?.navigating ? "正在切换视频…" : "没检测到视频";
    streamsEl.appendChild(empty);
    return;
  }

  const groups = [["recommended", "推荐主视频"], ["other", "其他媒体资源"],
    ["preview", "广告／预览片"], ["uncertain", "无法确定的资源"]];
  for (const [key, label] of groups) {
    const rows = streams.filter(stream => (stream.group || "other") === key);
    if (!rows.length) continue;
    if (resourceSort.value !== "evidence") rows.sort((a, b) => (b[resourceSort.value] || 0) - (a[resourceSort.value] || 0));
    const group = document.createElement("details");
    group.className = "resource-group";
    group.open = groupExpansion.get(key) ?? key !== "preview";
    group.addEventListener("toggle", () => groupExpansion.set(key, group.open));
    const summary = document.createElement("summary");
    summary.textContent = `${label} · ${rows.length}`;
    group.appendChild(summary);
    for (const stream of rows) group.appendChild(renderResource(stream));
    streamsEl.appendChild(group);
  }
}

function renderResource(stream) {
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
    stream.host || "来源未知",
    stream.quality ? stream.qualityLabel : "分辨率未知",
    stream.sizeLabel || "大小未知"
  ].filter(Boolean).join(" · ");
  body.appendChild(source);

  const actions = document.createElement("div");
  actions.className = "actions";

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
  if (stream.qualityOptions?.length > 1) actions.appendChild(qualitySelect);

  const downloadButton = document.createElement("button");
  downloadButton.type = "button";
  downloadButton.className = "primary download-button";
  downloadButton.textContent = stream.requiresFull ? "需要 macOS Full" : "下载";
  downloadButton.disabled = !stream.canDownloadWholeVideo;
  downloadButton.addEventListener("click", () => downloadStream(stream, downloadButton, qualitySelect.value));
  if (downloadButton.disabled) downloadButton.title = stream.availability || "资源不可下载";
  actions.appendChild(downloadButton);
  const copyButton = document.createElement("button");
  copyButton.type = "button";
  copyButton.className = "small";
  copyButton.textContent = "复制 URL";
  copyButton.disabled = !stream.resourceUrl;
  copyButton.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(stream.resourceUrl); copyButton.textContent = "已复制"; }
    catch (error) { showNotice(error.message, "error"); }
  });
  actions.appendChild(copyButton);
  body.appendChild(actions);

  const details = document.createElement("details");
  details.className = "source-details";
  const summary = document.createElement("summary");
  summary.textContent = "查看详情";
  details.appendChild(summary);
  const list = document.createElement("ul");
  const detailsItems = [
    ["所属网页", stream.pageTitle || stream.pageUrl],
    ["来源", stream.sources?.filter(Boolean).join("、") || stream.source],
    ["播放器", stream.playerTitle || "未确认"],
    ["帧", stream.frameId == null ? "" : stream.frameId === 0 ? "顶层页面" : `iframe ${stream.frameId}`],
    ["播放状态", stream.playbackLabel || "未确认"],
    ["下载", stream.availability],
    ["大小依据", stream.sizeBasis || "未知"],
    ["码率", stream.variant?.averageBandwidth || stream.variant?.bandwidth
      ? `${Math.round((stream.variant.averageBandwidth || stream.variant.bandwidth) / 1000)} kbps` : ""],
    ["推荐依据", stream.recommendationReason]
  ];
  for (const [label, value] of detailsItems) {
    if (!value) continue;
    const item = document.createElement("li");
    item.textContent = `${label}　${value}`;
    list.appendChild(item);
  }
  details.appendChild(list);
  const previewDiagnostic = document.createElement("p");
  previewDiagnostic.className = "preview-diagnostic";
  previewDiagnostic.hidden = true;
  details.appendChild(previewDiagnostic);
  body.appendChild(details);
  card.appendChild(body);
  return card;
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
      mediaId: stream.mediaId || "",
      resourceId: stream.resourceId || stream.id,
      resourceUrl: stream.resourceUrl || stream.lastUrl || stream.url,
      sourceTitle: stream.sourceTitle,
      pageUrl: stream.pageUrl || currentState?.pageUrl || "",
      fingerprint: stream.fingerprint,
      exactSelection: stream.exactSelection === true,
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
  const snapshot = JSON.stringify([Boolean(currentState?.queuePaused), jobs]);
  if (snapshot === lastJobRender) return;
  lastJobRender = snapshot;
  const expanded = new Set(Array.from(jobListEl.querySelectorAll(".job details[open]"),
    item => item.closest(".job").dataset.jobId));
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
    title.title = job.title || "";
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

    if (job.outputPath && job.status === "completed") {
      const output = document.createElement("code");
      const size = job.fileSize ? ` (${formatBytes(job.fileSize)})` : "";
      output.textContent = `${job.outputPath.split(/[\\/]/).pop()}${size}`;
      item.appendChild(output);
    }

    const controls = document.createElement("div");
    controls.className = "job-controls";
    if (["queued", "paused", "downloading", "merging", "recovering", "verifying"].includes(job.status)) {
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "small";
      cancel.textContent = "Cancel";
      cancel.addEventListener("click", () => sendMessage({ type: "cancelJob", jobId: job.id, keepData: job.browserDownload ? true : window.confirm("保留此任务的恢复数据？点击取消将清理此任务的临时数据，不删除已完成文件。") }));
      controls.appendChild(cancel);
    }
    if (["failed", "incomplete", "attention"].includes(job.status) && (job.details || job.logs?.length)) {
      const details = document.createElement("details");
      details.open = expanded.has(job.id);
      const summary = document.createElement("summary");
      summary.textContent = "错误详情";
      details.appendChild(summary);
      const pre = document.createElement("pre");
      pre.textContent = [job.error, Number.isInteger(job.exitCode) ? `yt-dlp 退出码 ${job.exitCode}` : "",
        job.details, ...(job.logs || [])].filter(Boolean).join("\n");
      details.appendChild(pre);
      controls.appendChild(details);
    }
    if (["failed", "incomplete", "cancelled", "attention"].includes(job.status)) {
      const retry = document.createElement("button");
      retry.type = "button"; retry.className = "small";
      retry.textContent = job.canResume ? "验证后续传" : job.validationPending ? "重新校验" : "重新尝试";
      retry.addEventListener("click", async () => {
        const result = await sendMessage({ type: "retryJob", jobId: job.id });
        if (!result?.ok) showNotice(result?.error || "无法重试。", "error");
      });
      controls.appendChild(retry);
    }
    if (["completed", "failed", "incomplete", "cancelled", "attention"].includes(job.status)) {
      const diagnostics = document.createElement("button");
      diagnostics.type = "button";
      diagnostics.className = "small";
      diagnostics.textContent = "导出任务诊断";
      diagnostics.addEventListener("click", async () => {
        try {
          const result = await sendMessage({ type: "getJobDiagnostics", jobId: job.id });
          if (!result?.ok) throw new Error(result?.error || "读取任务诊断失败。");
          saveDiagnostics(result.diagnostics, `DarrenVideoHelper-${job.id.replace(/[^\w-]/g, "-")}.json`);
        } catch (error) { showNotice(error.message, "error"); }
      });
      controls.appendChild(diagnostics);
    }
    if (["attention", "incomplete", "failed"].includes(job.status) && /^hls/.test(job.kind || "")) {
      const refresh = document.createElement("button"); refresh.type = "button"; refresh.className = "small";
      refresh.textContent = "重新检测并恢复";
      refresh.addEventListener("click", async () => {
        const result = await sendMessage({ type: "resumeWithCurrent", jobId: job.id });
        if (!result?.ok) showNotice(result?.error || "无法恢复。", "error");
      }); controls.appendChild(refresh);
    }
    if (["attention", "failed", "incomplete", "cancelled"].includes(job.status) && (job.canResume || job.fragmentsDone > 0)) {
      const clear = document.createElement("button"); clear.type = "button"; clear.className = "small"; clear.textContent = "清理恢复数据";
      clear.addEventListener("click", async () => {
        if (!window.confirm("仅清理此任务的临时恢复数据？已完成文件不会被删除。")) return;
        const result = await sendMessage({ type: "cancelJob", jobId: job.id, keepData: false });
        if (!result?.ok) showNotice(result?.error || "无法清理。", "error");
      }); controls.appendChild(clear);
    }
    if (job.status === "completed") {
      const open = document.createElement("button"); open.type = "button"; open.className = "small"; open.textContent = "显示文件";
      open.addEventListener("click", async () => {
        const result = await sendMessage({ type: "openJobOutput", jobId: job.id });
        if (!result?.ok) showNotice(result?.error || "无法显示文件。", "error");
      }); controls.appendChild(open);
    }
    if (controls.childNodes.length) item.appendChild(controls);

    jobListEl.appendChild(item);
  }
}

function saveDiagnostics(data, filename) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function focusJob(jobId) {
  const item = Array.from(jobListEl.querySelectorAll(".job"))
    .find((candidate) => candidate.dataset.jobId === jobId);
  if (!item) return;
  item.scrollIntoView({ block: "nearest", behavior: "smooth" });
  item.focus({ preventScroll: true });
}

function jobStatus(job) {
  const labels = { queued: "Waiting", downloading: "Downloading", paused: "Paused", recovering: "Recovering",
    attention: "Requires attention", verifying: "Verifying", merging: "Verifying · 合并中",
    completed: "Completed", failed: "Failed", cancelled: "Cancelled" };
  if (job.status === "incomplete") return job.canResume ? "Paused · 可验证后续传" : "Requires attention";
  return labels[job.status] || "Requires attention";
}

function jobLine(job) {
  const parts = [job.message || job.error || ""];
  if (job.fragmentsTotal) parts.push(`分片 ${job.fragmentsDone || 0}/${job.fragmentsTotal}`);
  if (job.downloadedBytes) parts.push(`已接收 ${formatBytes(job.downloadedBytes)}`);
  if (["downloading", "recovering"].includes(job.status) && job.speed) parts.push(job.speed);
  if (["downloading", "recovering"].includes(job.status) && job.eta) parts.push(`ETA ${job.eta}`);
  if (["merging", "verifying"].includes(job.status)) parts.push("下载阶段结束，尚未确认完成");
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
