let currentTabId = null;
let currentState = null;
const jobCache = new Map();

const pageTitleEl = document.getElementById("pageTitle");
const noticeEl = document.getElementById("notice");
const streamsEl = document.getElementById("streams");
const refreshButton = document.getElementById("refreshButton");
const optionsButton = document.getElementById("optionsButton");
const reloadExtensionButton = document.getElementById("reloadExtensionButton");
const downloadRecommendedButton = document.getElementById("downloadRecommendedButton");
const pauseQueueButton = document.getElementById("pauseQueueButton");
const resumeQueueButton = document.getElementById("resumeQueueButton");
const importFileEl = document.getElementById("importFile");
const jobsEl = document.getElementById("jobs");
const jobListEl = document.getElementById("jobList");
const queueStateEl = document.getElementById("queueState");

document.addEventListener("DOMContentLoaded", init);
refreshButton.addEventListener("click", loadStreams);
optionsButton.addEventListener("click", () => chrome.runtime.openOptionsPage());
reloadExtensionButton.addEventListener("click", () => sendMessage({ type: "reloadExtension" }));
downloadRecommendedButton.addEventListener("click", downloadRecommended);
pauseQueueButton.addEventListener("click", async () => {
  await sendMessage({ type: "pauseQueue" });
  await refreshJobs();
});
resumeQueueButton.addEventListener("click", async () => {
  await sendMessage({ type: "resumeQueue" });
  await refreshJobs();
});
importFileEl.addEventListener("change", importUrlFile);

chrome.runtime.onMessage.addListener((message) => {
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
  streamsEl.innerHTML = "";
  downloadRecommendedButton.disabled = !currentState?.recommended;

  if (!streams.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "没检测到视频";
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

    const thumb = document.createElement("div");
    thumb.className = "thumb";
    if (stream.thumbnailUrl) {
      const img = document.createElement("img");
      img.src = stream.thumbnailUrl;
      img.alt = "";
      img.loading = "lazy";
      thumb.appendChild(img);
    } else {
      thumb.textContent = stream.typeTag || "MP4";
    }
    card.appendChild(thumb);

    const body = document.createElement("div");
    body.className = "stream-body";

    const titleRow = document.createElement("div");
    titleRow.className = "stream-title-row";
    const title = document.createElement("h2");
    title.textContent = stream.recommended
      ? `${stream.sourceTitle || stream.host || "Video"}`
      : (stream.sourceTitle || stream.host || "Detected video");
    titleRow.appendChild(title);
    if (stream.recommended) titleRow.appendChild(makeBadge("推荐", "recommend"));
    body.appendChild(titleRow);

    const meta = document.createElement("div");
    meta.className = "meta-grid";
    meta.appendChild(makeMeta(stream.qualityLabel || "Auto", "清晰度"));
    meta.appendChild(makeMeta(stream.typeTag || "VIDEO", "格式"));
    meta.appendChild(makeMeta(stream.sizeLabel || "约 -- MB", "大小"));
    meta.appendChild(makeMeta(stream.durationLabel || "--:--", "时长"));
    body.appendChild(meta);

    const source = document.createElement("p");
    source.className = "source";
    source.textContent = stream.host || stream.label || "";
    body.appendChild(source);

    const actions = document.createElement("div");
    actions.className = "actions";

    const copyButton = document.createElement("button");
    copyButton.type = "button";
    copyButton.className = "small";
    copyButton.textContent = "Copy URL";
    copyButton.addEventListener("click", async () => {
      await navigator.clipboard.writeText(stream.lastUrl || stream.url);
      copyButton.textContent = "Copied";
      window.setTimeout(() => { copyButton.textContent = "Copy URL"; }, 1200);
    });
    actions.appendChild(copyButton);

    const downloadButton = document.createElement("button");
    downloadButton.type = "button";
    downloadButton.className = "primary small";
    downloadButton.textContent = "Download MP4";
    downloadButton.disabled = !stream.canDownloadWholeVideo;
    downloadButton.addEventListener("click", () => downloadStream(stream, downloadButton));
    actions.appendChild(downloadButton);

    body.appendChild(actions);
    card.appendChild(body);
    streamsEl.appendChild(card);
  }
}

async function downloadStream(stream, button) {
  button.disabled = true;
  button.textContent = "Queued";
  try {
    let response = await requestDownload("download", stream, false);
    if (response.duplicate && window.confirm(`${response.error}\n\n是否强制重新下载？`)) {
      response = await requestDownload("download", stream, true);
    }
    if (!response.ok) throw new Error(response.error || "Download failed to start.");
    await refreshJobs();
  } catch (error) {
    showNotice(error.message || String(error), "error");
    button.disabled = false;
    button.textContent = "Download MP4";
  }
}

async function downloadRecommended() {
  downloadRecommendedButton.disabled = true;
  downloadRecommendedButton.textContent = "Queued";
  try {
    const stream = currentState?.recommended;
    if (!stream) throw new Error("当前没有可推荐的真实媒体资源。");
    let response = await requestDownload("downloadRecommended", stream, false);
    if (response.duplicate && window.confirm(`${response.error}\n\n是否强制重新下载？`)) {
      response = await requestDownload("downloadRecommended", stream, true);
    }
    if (!response.ok) throw new Error(response.error || "Download failed to start.");
    await refreshJobs();
  } catch (error) {
    showNotice(error.message || String(error), "error");
  } finally {
    downloadRecommendedButton.disabled = false;
    downloadRecommendedButton.textContent = "下载推荐";
  }
}

function requestDownload(type, stream, forceRedownload) {
  return sendMessage({
    type,
    tabId: currentTabId,
    forceRedownload,
    selection: {
      sessionId: stream.sessionId,
      resourceId: stream.resourceId || stream.id,
      resourceUrl: stream.resourceUrl || stream.lastUrl || stream.url,
      pageUrl: stream.pageUrl || currentState?.pageUrl || "",
      fingerprint: stream.fingerprint
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
    if (["queued", "paused", "downloading", "merging", "refreshing"].includes(job.status)) {
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
  if (job.status === "completed") return "Done";
  if (job.status === "failed") return "Failed";
  if (job.status === "queued") return "Queued";
  if (job.status === "paused") return "Paused";
  if (job.status === "cancelled") return "Canceled";
  if (job.status === "refreshing") return "Refreshing link";
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
