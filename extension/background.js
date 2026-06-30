const HOST_NAME = "com.darren.videohelper";
const PAGE_STREAM_ID = "__current_page__";
const STREAM_URL_PATTERN = /\.(m3u8|mp4|m4s|ts)(?:$|[?#])/i;
const IMAGE_URL_PATTERN = /\.(jpe?g|png|webp|gif|avif)(?:$|[?#])/i;
const BAD_CANDIDATE_PATTERN = /(?:thumbnail|thumb|sprite|preview|avatar|profile|icon|logo|banner|advert|\/ads?\/|doubleclick|googlesyndication|analytics|tracking)/i;
const MAX_STREAMS_PER_TAB = 100;
const MAX_HEADERS_PER_TAB = 140;
const MAX_LOG_LINES = 140;
const DEFAULT_SETTINGS = {
  outputDir: "~/Downloads/video_downloads",
  defaultQuality: "best",
  maxConcurrent: 2,
  autoCookies: true,
  skipDownloaded: true,
  onlyMp4: true,
  showAdvanced: false
};

const tabState = new Map();
const jobs = new Map();
const runningPorts = new Map();
let queuePaused = false;
let processingQueue = false;

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get(DEFAULT_SETTINGS).then((stored) => {
    chrome.storage.sync.set({ ...DEFAULT_SETTINGS, ...stored });
  });
});

chrome.commands.onCommand.addListener((command) => {
  if (command === "reload_extension") {
    chrome.runtime.reload();
  }
});

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0 || !isStreamUrl(details.url) || isHardExcludedUrl(details.url)) return;
    upsertStream(details.tabId, details.url, {
      method: details.method,
      requestId: details.requestId,
      source: "network"
    });
  },
  { urls: ["<all_urls>"] }
);

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const headers = normalizeHeaders(details.requestHeaders || []);
    rememberHeaders(details.tabId, details.url, headers);
    if (!isStreamUrl(details.url) || isHardExcludedUrl(details.url)) return;
    upsertStream(details.tabId, details.url, {
      headers,
      method: details.method,
      requestId: details.requestId,
      source: "network"
    });
  },
  { urls: ["<all_urls>"] },
  ["requestHeaders", "extraHeaders"]
);

chrome.tabs.onRemoved.addListener((tabId) => {
  tabState.delete(tabId);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object") return false;

  if (message.type === "getStreams") {
    getPopupState(message.tabId).then(sendResponse).catch((error) => {
      sendResponse({ ok: false, error: error.message || String(error) });
    });
    return true;
  }

  if (message.type === "download") {
    startDownload(message.tabId, message.streamId).then(sendResponse).catch((error) => {
      sendResponse({ ok: false, error: error.message || String(error) });
    });
    return true;
  }

  if (message.type === "downloadRecommended") {
    downloadRecommended(message.tabId).then(sendResponse).catch((error) => {
      sendResponse({ ok: false, error: error.message || String(error) });
    });
    return true;
  }

  if (message.type === "importUrls") {
    importUrls(message.urls || []).then(sendResponse).catch((error) => {
      sendResponse({ ok: false, error: error.message || String(error) });
    });
    return true;
  }

  if (message.type === "pauseQueue") {
    queuePaused = true;
    updateQueuedJobs({ status: "paused", message: "队列已暂停。" });
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "resumeQueue") {
    queuePaused = false;
    updateQueuedJobs({ status: "queued", message: "等待下载..." });
    processQueue();
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "cancelJob") {
    cancelJob(message.jobId);
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "reloadExtension") {
    chrome.runtime.reload();
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "getJobs") {
    sendResponse({ ok: true, jobs: publicJobs(), queuePaused });
    return true;
  }

  if (message.type === "getSettings") {
    loadSettings().then((settings) => sendResponse({ ok: true, settings })).catch((error) => {
      sendResponse({ ok: false, error: error.message || String(error) });
    });
    return true;
  }

  if (message.type === "saveSettings") {
    saveSettings(message.settings || {}).then((settings) => {
      processQueue();
      sendResponse({ ok: true, settings });
    }).catch((error) => {
      sendResponse({ ok: false, error: error.message || String(error) });
    });
    return true;
  }

  if (message.type === "clearHistory") {
    chrome.storage.local.set({ downloadHistory: [] }).then(() => {
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message.type === "getHistory") {
    getHistory().then((history) => sendResponse({ ok: true, history }));
    return true;
  }

  return false;
});

async function getPopupState(tabId) {
  const settings = await loadSettings();
  const tab = tabId ? await chrome.tabs.get(tabId) : await getActiveTab();
  if (!tab || !tab.id) {
    return { ok: false, error: "No active tab." };
  }

  const state = ensureTabState(tab.id);
  state.pageUrl = tab.url || state.pageUrl || "";
  state.pageTitle = tab.title || state.pageTitle || "video";

  await collectMediaHints(tab, state);

  const rawStreams = sortedStreams(state)
    .filter((stream) => !isHardExcludedUrl(stream.lastUrl || stream.url))
    .filter((stream) => settings.showAdvanced || stream.kind !== "segment");
  const enrichedStreams = await Promise.all(rawStreams.map((stream) => enrichStreamForPopup(state, stream)));
  const streams = rankStreams(makePopupStreams(state, enrichedStreams), state)
    .map((stream, index) => ({
      ...stream,
      recommended: index === 0,
      rank: index + 1
    }));

  const hasDetectedVideo = rawStreams.some((stream) => stream.kind !== "segment");
  const warning = hasDetectedVideo || streams.length
    ? ""
    : "没检测到视频流。请先播放 3-5 秒后刷新，也可以尝试当前页面 URL。";

  return {
    ok: true,
    tabId: tab.id,
    pageTitle: state.pageTitle,
    pageUrl: state.pageUrl,
    thumbnailUrl: safeImageUrl(state.thumbnailUrl),
    streams,
    recommended: streams[0] || null,
    detectedStreamCount: rawStreams.length,
    warning,
    settings,
    queuePaused,
    jobs: publicJobs()
  };
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs && tabs[0];
}

async function collectMediaHints(tab, state) {
  if (!tab.url || !/^https?:\/\//i.test(tab.url)) return;

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const absolute = (value) => {
          if (!value) return "";
          try {
            const url = new URL(value, location.href);
            return /^https?:$/.test(url.protocol) ? url.href : "";
          } catch {
            return "";
          }
        };
        const videos = Array.from(document.querySelectorAll("video")).map((video) => {
          const sourceUrls = Array.from(video.querySelectorAll("source"))
            .map((source) => absolute(source.src || source.getAttribute("src") || ""))
            .filter(Boolean);
          return {
            currentSrc: absolute(video.currentSrc || video.src || ""),
            sourceUrls,
            poster: absolute(video.poster || ""),
            width: video.videoWidth || video.clientWidth || 0,
            height: video.videoHeight || video.clientHeight || 0,
            duration: Number.isFinite(video.duration) ? video.duration : 0,
            currentTime: Number.isFinite(video.currentTime) ? video.currentTime : 0,
            paused: video.paused
          };
        });
        const metaImage =
          document.querySelector('meta[property="og:image"]')?.content ||
          document.querySelector('meta[name="twitter:image"]')?.content ||
          "";
        const metaTitle =
          document.querySelector('meta[property="og:title"]')?.content ||
          document.querySelector('meta[name="twitter:title"]')?.content ||
          document.title ||
          "";
        return {
          title: metaTitle,
          pageUrl: location.href,
          poster: absolute(videos.find((item) => item.poster)?.poster || metaImage),
          videos
        };
      }
    });

    const hints = results?.[0]?.result;
    if (!hints) return;
    state.pageTitle = hints.title || state.pageTitle;
    state.pageUrl = hints.pageUrl || state.pageUrl;
    if (safeImageUrl(hints.poster)) state.thumbnailUrl = hints.poster;
    state.hasVideoElement = Boolean(hints.videos?.length);

    const videos = hints.videos || [];
    const playableVideos = videos.filter((video) => video.duration || video.height || video.width || video.currentSrc);
    const mainVideo = playableVideos.sort((a, b) => {
      const activeDiff = Number(!a.paused) - Number(!b.paused);
      if (activeDiff) return -activeDiff;
      const areaDiff = (b.width * b.height) - (a.width * a.height);
      if (areaDiff) return areaDiff;
      return (b.duration || 0) - (a.duration || 0);
    })[0];
    if (mainVideo) {
      state.videoDuration = mainVideo.duration || state.videoDuration || 0;
      state.mainVideoHeight = mainVideo.height || state.mainVideoHeight || 0;
      state.mainVideoWidth = mainVideo.width || state.mainVideoWidth || 0;
    }

    for (const video of videos) {
      const urls = [video.currentSrc, ...(video.sourceUrls || [])].filter(Boolean);
      for (const url of urls) {
        if (!isStreamUrl(url) || isHardExcludedUrl(url)) continue;
        upsertStream(tab.id, url, {
          source: "dom-video",
          quality: video.height || undefined,
          duration: video.duration || undefined
        });
      }
    }
  } catch {
    // Some pages, frames, and chrome:// URLs cannot be scripted. Network capture still works.
  }
}

async function enrichStreamForPopup(state, stream) {
  const url = stream.lastUrl || stream.url;
  const playlistInfo = isHlsKind(stream.kind) ? await fetchPlaylistInfo(url) : {};
  const contentLength = stream.kind === "mp4" ? await fetchContentLength(url) : 0;
  const quality = stream.quality || playlistInfo.quality || state.mainVideoHeight || 0;
  const duration = stream.duration || playlistInfo.duration || state.videoDuration || 0;
  const sizeBytes = contentLength || playlistInfo.sizeBytes || estimateSizeBytes(quality, duration, stream.kind);
  const exactSize = Boolean(contentLength || playlistInfo.sizeBytes);

  return {
    id: stream.id,
    url: stream.url,
    lastUrl: url,
    kind: stream.kind,
    typeTag: streamTypeTag(stream.kind),
    label: stream.label,
    quality,
    qualityLabel: quality ? `${quality}p` : "Auto",
    host: getHost(url),
    sourceTitle: state.pageTitle || getHost(url) || "Detected video",
    thumbnailUrl: safeImageUrl(state.thumbnailUrl),
    duration,
    durationLabel: formatDuration(duration),
    sizeBytes,
    sizeLabel: formatBytes(sizeBytes, !exactSize),
    sampleCount: stream.sampleCount || 1,
    firstSeen: stream.firstSeen,
    lastSeen: stream.lastSeen,
    canDownloadWholeVideo: stream.kind !== "segment"
  };
}

async function fetchContentLength(url) {
  if (!/^https?:\/\//i.test(url)) return 0;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    const response = await fetch(url, {
      method: "HEAD",
      credentials: "include",
      cache: "no-store",
      signal: controller.signal
    });
    clearTimeout(timer);
    const value = Number(response.headers.get("content-length") || 0);
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

async function fetchPlaylistInfo(url) {
  if (!/^https?:\/\//i.test(url) || !/\.m3u8(?:$|[?#])/i.test(url)) return {};
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const response = await fetch(url, {
      credentials: "include",
      cache: "no-store",
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!response.ok) return {};
    const text = await response.text();
    return parsePlaylistInfo(text);
  } catch {
    return {};
  }
}

function parsePlaylistInfo(text) {
  const info = {};
  const resolutionMatches = Array.from(text.matchAll(/RESOLUTION=(\d+)x(\d+)/gi));
  if (resolutionMatches.length) {
    info.quality = Math.max(...resolutionMatches.map((match) => Number(match[2]) || 0));
  }

  const bandwidthMatches = Array.from(text.matchAll(/BANDWIDTH=(\d+)/gi));
  const bandwidth = bandwidthMatches.length
    ? Math.max(...bandwidthMatches.map((match) => Number(match[1]) || 0))
    : 0;

  const durationMatches = Array.from(text.matchAll(/#EXTINF:([0-9.]+)/gi));
  const duration = durationMatches.reduce((sum, match) => sum + Number(match[1] || 0), 0);
  if (duration > 0) info.duration = duration;

  const byterangeMatches = Array.from(text.matchAll(/#EXT-X-BYTERANGE:(\d+)/gi));
  const byterangeSize = byterangeMatches.reduce((sum, match) => sum + Number(match[1] || 0), 0);
  if (byterangeSize > 0) {
    info.sizeBytes = byterangeSize;
  } else if (bandwidth && duration) {
    info.sizeBytes = Math.round((bandwidth * duration) / 8);
  }
  return info;
}

function estimateSizeBytes(quality, duration, kind) {
  const seconds = duration > 0 ? duration : 600;
  const height = quality || (kind === "mp4" ? 720 : 1080);
  const bitrateKbps = height >= 2160 ? 12000
    : height >= 1440 ? 8500
      : height >= 1080 ? 5000
        : height >= 720 ? 3000
          : height >= 540 ? 1800
            : height >= 480 ? 1300
              : 850;
  return Math.max(2 * 1024 * 1024, Math.round((bitrateKbps * 1000 * seconds) / 8));
}

async function startDownload(tabId, streamId) {
  const settings = await loadSettings();
  const state = ensureTabState(tabId);
  const stream = findDownloadStream(state, streamId);
  if (!stream) {
    return { ok: false, error: "Stream no longer exists. Play the video again and refresh the popup." };
  }

  const payload = buildDownloadPayload(state, stream, settings);
  return enqueueDownload(payload, settings);
}

async function downloadRecommended(tabId) {
  const state = await getPopupState(tabId);
  if (!state.ok) return state;
  const recommended = state.streams.find((stream) => stream.canDownloadWholeVideo) || state.streams[0];
  if (!recommended) return { ok: false, error: "没检测到视频，请先播放 3-5 秒后刷新 popup。" };
  return startDownload(tabId, recommended.id);
}

async function importUrls(urls) {
  const cleanUrls = (urls || [])
    .map((url) => String(url || "").trim())
    .filter(Boolean)
    .filter((url) => /^https?:\/\//i.test(url));
  if (!cleanUrls.length) {
    return { ok: false, error: "没有可导入的视频 URL。" };
  }

  const settings = await loadSettings();
  const jobIds = [];
  for (const url of cleanUrls) {
    const host = getHost(url) || "Imported URL";
    const payload = {
      action: "download",
      url,
      originalUrl: url,
      pageUrl: url,
      pageTitle: host,
      sourceTitle: host,
      kind: "page",
      headers: {},
      preferPageUrl: true,
      qualityPreference: settings.defaultQuality,
      settings
    };
    const response = await enqueueDownload(payload, settings, { quiet: true });
    if (response.ok) jobIds.push(response.jobId);
  }
  processQueue();
  return { ok: true, jobIds };
}

function findDownloadStream(state, streamId) {
  if (streamId === PAGE_STREAM_ID && state.pageUrl) {
    return {
      id: PAGE_STREAM_ID,
      url: state.pageUrl,
      lastUrl: state.pageUrl,
      headers: {},
      kind: "page",
      quality: state.mainVideoHeight || 0
    };
  }
  return state.streams.get(streamId);
}

function buildDownloadPayload(state, stream, settings) {
  const pageUrl = state.pageUrl || "";
  const isYoutube = isYoutubeUrl(pageUrl);
  const streamUrl = stream.lastUrl || stream.url;
  const targetUrl = isYoutube ? pageUrl : streamUrl;
  const kind = isYoutube ? "page" : stream.kind;
  const headers = stream.headers || state.headersByUrl.get(headerKey(stream.url)) || {};
  return {
    action: "download",
    url: targetUrl,
    originalUrl: stream.url,
    pageUrl,
    pageTitle: state.pageTitle || "video",
    sourceTitle: state.pageTitle || getHost(targetUrl) || "video",
    kind,
    headers,
    preferPageUrl: isYoutube || stream.kind === "page",
    qualityPreference: settings.defaultQuality,
    settings
  };
}

async function enqueueDownload(payload, settings, options = {}) {
  const duplicate = settings.skipDownloaded ? await findDownloadedHistory(payload) : null;
  const jobId = makeId("job");
  const job = {
    id: jobId,
    status: duplicate ? "complete" : "queued",
    message: duplicate ? "已跳过，历史记录中已下载。" : "等待下载...",
    outputPath: duplicate?.outputPath || "",
    fileSize: duplicate?.fileSize || 0,
    duration: duplicate?.duration || 0,
    error: "",
    details: "",
    percent: duplicate ? "100" : "",
    speed: "",
    eta: "",
    logs: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    url: payload.url,
    pageUrl: payload.pageUrl,
    title: payload.sourceTitle || payload.pageTitle || getHost(payload.url),
    payload
  };
  jobs.set(jobId, job);
  broadcastJob(job);
  if (!duplicate && !options.quiet) processQueue();
  return { ok: true, jobId };
}

async function processQueue() {
  if (processingQueue || queuePaused) return;
  processingQueue = true;
  try {
    const settings = await loadSettings();
    const maxConcurrent = Math.max(1, Math.min(6, Number(settings.maxConcurrent) || 2));
    while (!queuePaused && runningPorts.size < maxConcurrent) {
      const job = Array.from(jobs.values()).find((item) => item.status === "queued");
      if (!job) break;
      startNativeJob(job, settings);
    }
  } finally {
    processingQueue = false;
  }
}

function startNativeJob(job, settings) {
  let port;
  updateJob(job.id, {
    status: "running",
    message: "Starting native download...",
    percent: "",
    speed: "",
    eta: ""
  });

  try {
    port = chrome.runtime.connectNative(HOST_NAME);
  } catch (error) {
    updateJob(job.id, {
      status: "error",
      error: error.message || String(error),
      message: "本地助手无法启动。请先运行 native/install_host.sh 注册 Native Messaging Host。"
    });
    processQueue();
    return;
  }

  runningPorts.set(job.id, port);

  port.onMessage.addListener((message) => {
    if (!message || message.jobId !== job.id) return;

    if (message.type === "progress") {
      const patch = {
        status: "running",
        message: message.message || "Downloading...",
        percent: message.percent ?? jobs.get(job.id)?.percent ?? "",
        speed: message.speed ?? jobs.get(job.id)?.speed ?? "",
        eta: message.eta ?? jobs.get(job.id)?.eta ?? ""
      };
      if (message.line) appendJobLog(job.id, message.line);
      updateJob(job.id, patch);
    }

    if (message.type === "complete") {
      updateJob(job.id, {
        status: "complete",
        message: message.message || "下载完成，已输出 MP4。",
        outputPath: message.outputPath || "",
        fileSize: message.fileSize || 0,
        duration: message.duration || 0,
        width: message.width || 0,
        height: message.height || 0,
        percent: "100",
        speed: "",
        eta: ""
      });
      saveHistory(publicJob(jobs.get(job.id)));
      runningPorts.delete(job.id);
      safeDisconnect(port);
      processQueue();
    }

    if (message.type === "error") {
      updateJob(job.id, {
        status: "error",
        error: message.error || "Download failed.",
        details: message.details || message.error || "Download failed.",
        message: message.message || message.error || "Download failed."
      });
      runningPorts.delete(job.id);
      safeDisconnect(port);
      processQueue();
    }
  });

  port.onDisconnect.addListener(() => {
    runningPorts.delete(job.id);
    const current = jobs.get(job.id);
    if (!current || ["complete", "error", "canceled"].includes(current.status)) {
      processQueue();
      return;
    }
    const message = chrome.runtime.lastError?.message || "Native host disconnected before finishing.";
    updateJob(job.id, {
      status: "error",
      error: message,
      details: message,
      message
    });
    processQueue();
  });

  const nativePayload = {
    ...job.payload,
    jobId: job.id,
    settings: {
      ...settings,
      outputDir: settings.outputDir || DEFAULT_SETTINGS.outputDir
    }
  };
  port.postMessage(nativePayload);
}

function cancelJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;
  const port = runningPorts.get(jobId);
  if (port) {
    safeDisconnect(port);
    runningPorts.delete(jobId);
  }
  updateJob(jobId, {
    status: "canceled",
    message: "已取消。",
    error: "",
    details: ""
  });
  processQueue();
}

function updateQueuedJobs(patch) {
  for (const job of jobs.values()) {
    if (job.status === "queued" || job.status === "paused") {
      updateJob(job.id, patch);
    }
  }
}

function updateJob(jobId, patch) {
  const job = jobs.get(jobId);
  if (!job) return;
  Object.assign(job, patch, { updatedAt: Date.now() });
  jobs.set(jobId, job);
  broadcastJob(job);
}

function appendJobLog(jobId, line) {
  const job = jobs.get(jobId);
  if (!job || !line) return;
  job.logs = [...(job.logs || []), String(line).slice(0, 600)];
  if (job.logs.length > MAX_LOG_LINES) job.logs = job.logs.slice(-MAX_LOG_LINES);
}

function broadcastJob(job) {
  chrome.runtime.sendMessage({ type: "jobUpdate", job: publicJob(job), queuePaused }, () => {
    void chrome.runtime.lastError;
  });
}

function publicJobs() {
  return Array.from(jobs.values()).map(publicJob);
}

function publicJob(job) {
  if (!job) return null;
  const {
    payload,
    ...visible
  } = job;
  return visible;
}

function safeDisconnect(port) {
  try {
    port.disconnect();
  } catch {
    // Already closed.
  }
}

async function loadSettings() {
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    maxConcurrent: Math.max(1, Math.min(6, Number(stored.maxConcurrent || DEFAULT_SETTINGS.maxConcurrent) || 2)),
    autoCookies: stored.autoCookies !== false,
    skipDownloaded: stored.skipDownloaded !== false,
    onlyMp4: stored.onlyMp4 !== false,
    showAdvanced: stored.showAdvanced === true
  };
}

async function saveSettings(nextSettings) {
  const settings = {
    ...DEFAULT_SETTINGS,
    ...nextSettings,
    maxConcurrent: Math.max(1, Math.min(6, Number(nextSettings.maxConcurrent || DEFAULT_SETTINGS.maxConcurrent) || 2)),
    autoCookies: nextSettings.autoCookies !== false,
    skipDownloaded: nextSettings.skipDownloaded !== false,
    onlyMp4: nextSettings.onlyMp4 !== false,
    showAdvanced: nextSettings.showAdvanced === true
  };
  await chrome.storage.sync.set(settings);
  return settings;
}

async function getHistory() {
  const result = await chrome.storage.local.get({ downloadHistory: [] });
  return Array.isArray(result.downloadHistory) ? result.downloadHistory : [];
}

async function saveHistory(job) {
  const history = await getHistory();
  const next = [{
    id: job.id,
    url: job.url,
    pageUrl: job.pageUrl,
    title: job.title,
    outputPath: job.outputPath,
    fileSize: job.fileSize || 0,
    duration: job.duration || 0,
    createdAt: job.createdAt,
    completedAt: Date.now()
  }, ...history].slice(0, 1000);
  await chrome.storage.local.set({ downloadHistory: next });
}

async function findDownloadedHistory(payload) {
  const history = await getHistory();
  return history.find((item) => (
    item.outputPath
    && (item.url === payload.url || item.pageUrl === payload.pageUrl || item.url === payload.pageUrl)
  ));
}

function makePopupStreams(state, detectedStreams) {
  const streams = [...detectedStreams];
  if (!state.pageUrl || !/^https?:\/\//i.test(state.pageUrl)) return streams;

  const pageStream = {
    id: PAGE_STREAM_ID,
    url: state.pageUrl,
    lastUrl: state.pageUrl,
    kind: "page",
    typeTag: "PAGE",
    label: "Current page URL - yt-dlp",
    quality: state.mainVideoHeight || 0,
    qualityLabel: state.mainVideoHeight ? `${state.mainVideoHeight}p` : "Auto",
    host: getHost(state.pageUrl),
    sourceTitle: state.pageTitle || getHost(state.pageUrl),
    thumbnailUrl: safeImageUrl(state.thumbnailUrl),
    duration: state.videoDuration || 0,
    durationLabel: formatDuration(state.videoDuration || 0),
    sizeBytes: estimateSizeBytes(state.mainVideoHeight || 1080, state.videoDuration || 0, "page"),
    sizeLabel: formatBytes(estimateSizeBytes(state.mainVideoHeight || 1080, state.videoDuration || 0, "page"), true),
    sampleCount: 1,
    firstSeen: Date.now(),
    lastSeen: Date.now(),
    canDownloadWholeVideo: true
  };

  const hasSameUrl = streams.some((stream) => stream.lastUrl === state.pageUrl || stream.url === state.pageUrl);
  if (!hasSameUrl) streams.push(pageStream);
  return streams;
}

function rankStreams(streams, state) {
  return streams
    .filter((stream) => stream.canDownloadWholeVideo || stream.kind === "segment")
    .sort((a, b) => {
      const scoreDiff = candidateScore(b, state) - candidateScore(a, state);
      if (scoreDiff) return scoreDiff;
      return (b.lastSeen || 0) - (a.lastSeen || 0);
    });
}

function candidateScore(stream, state) {
  let score = 0;
  if (stream.kind === "page" && (state.hasVideoElement || isYoutubeUrl(state.pageUrl))) score += 95000;
  else if (stream.kind === "page") score += 65000;
  if (stream.kind === "hls_master") score += 90000;
  if (stream.kind === "hls_media") score += 82000;
  if (stream.kind === "mp4") score += 76000;
  if (stream.kind === "segment") score += 1000;
  score += Math.min(stream.duration || 0, 7200) * 4;
  score += (stream.quality || 0) * 18;
  const size = stream.sizeBytes || 0;
  if (size >= 3 * 1024 * 1024 && size <= 12 * 1024 * 1024 * 1024) score += 6000;
  if (size && size < 1024 * 1024) score -= 25000;
  if (BAD_CANDIDATE_PATTERN.test(stream.lastUrl || stream.url || "")) score -= 60000;
  return score;
}

function ensureTabState(tabId) {
  if (!tabState.has(tabId)) {
    tabState.set(tabId, {
      streams: new Map(),
      headersByUrl: new Map(),
      pageTitle: "video",
      pageUrl: "",
      thumbnailUrl: "",
      hasVideoElement: false,
      videoDuration: 0,
      mainVideoHeight: 0,
      mainVideoWidth: 0
    });
  }
  return tabState.get(tabId);
}

function rememberHeaders(tabId, url, headers) {
  const state = ensureTabState(tabId);
  state.headersByUrl.set(headerKey(url), headers);
  while (state.headersByUrl.size > MAX_HEADERS_PER_TAB) {
    const firstKey = state.headersByUrl.keys().next().value;
    state.headersByUrl.delete(firstKey);
  }
}

function upsertStream(tabId, url, details = {}) {
  const state = ensureTabState(tabId);
  const id = streamKey(url);
  const now = Date.now();
  const metadata = inferStreamMetadata(url, details.quality);
  const existing = state.streams.get(id);
  const headers = details.headers || state.headersByUrl.get(headerKey(url)) || existing?.headers || {};

  if (existing) {
    existing.lastUrl = url;
    existing.headers = headers;
    existing.lastSeen = now;
    existing.sampleCount = (existing.sampleCount || 1) + 1;
    if (!existing.quality && metadata.quality) existing.quality = metadata.quality;
    if (!existing.duration && details.duration) existing.duration = details.duration;
    existing.label = makeLabel(existing.kind, existing.quality, existing.sampleCount);
    state.streams.set(id, existing);
  } else {
    state.streams.set(id, {
      id,
      url,
      lastUrl: url,
      headers,
      kind: metadata.kind,
      quality: metadata.quality,
      duration: details.duration || 0,
      label: makeLabel(metadata.kind, metadata.quality, 1),
      source: details.source || "network",
      firstSeen: now,
      lastSeen: now,
      sampleCount: 1
    });
  }

  while (state.streams.size > MAX_STREAMS_PER_TAB) {
    const oldest = Array.from(state.streams.values()).sort((a, b) => a.lastSeen - b.lastSeen)[0];
    if (!oldest) break;
    state.streams.delete(oldest.id);
  }
}

function sortedStreams(state) {
  return Array.from(state.streams.values()).sort((a, b) => {
    const scoreDiff = streamScore(b) - streamScore(a);
    if (scoreDiff) return scoreDiff;
    return b.lastSeen - a.lastSeen;
  });
}

function streamScore(stream) {
  let score = 0;
  if (stream.kind === "hls_master") score += 50000;
  if (stream.kind === "hls_media") score += 40000;
  if (stream.kind === "page") score += 35000;
  if (stream.kind === "mp4") score += 30000;
  if (stream.kind === "segment") score += 1000;
  if (stream.quality === 1080) score += 20000;
  else if (stream.quality) score += Math.max(0, 10000 - Math.abs(1080 - stream.quality));
  return score;
}

function isStreamUrl(url) {
  return STREAM_URL_PATTERN.test(stripHash(url));
}

function isHardExcludedUrl(url) {
  const clean = stripHash(url || "");
  return IMAGE_URL_PATTERN.test(clean) || BAD_CANDIDATE_PATTERN.test(clean);
}

function isHlsKind(kind) {
  return kind === "hls_master" || kind === "hls_media";
}

function inferStreamMetadata(url, explicitQuality) {
  const pathname = safeUrl(url)?.pathname.toLowerCase() || url.toLowerCase();
  let kind = "unknown";
  if (/\.m3u8(?:$|[?#])/i.test(url)) {
    kind = /(master|playlist|index)\.m3u8/i.test(pathname) ? "hls_master" : "hls_media";
  } else if (/\.mp4(?:$|[?#])/i.test(url)) {
    kind = "mp4";
  } else if (/\.(m4s|ts)(?:$|[?#])/i.test(url)) {
    kind = "segment";
  }

  return {
    kind,
    quality: explicitQuality || parseQuality(url)
  };
}

function makeLabel(kind, quality, sampleCount) {
  const qualityText = quality ? `${quality}p` : "quality unknown";
  if (kind === "hls_master") return `Playlist - ${qualityText}`;
  if (kind === "hls_media") return `HLS stream - ${qualityText}`;
  if (kind === "page") return "Current page URL - yt-dlp";
  if (kind === "mp4") return `Direct file - ${qualityText}`;
  if (kind === "segment") return `Segment sample - ${qualityText} (${sampleCount} seen)`;
  return `Stream - ${qualityText}`;
}

function streamTypeTag(kind) {
  if (kind === "hls_master" || kind === "hls_media") return "HLS";
  if (kind === "mp4") return "MP4";
  if (kind === "page") return "PAGE";
  if (kind === "segment") return "SEG";
  return "VIDEO";
}

function parseQuality(url) {
  const decoded = decodeURIComponent(url);
  const pMatch = decoded.match(/(?:^|[^0-9])(2160|1440|1080|720|576|540|480|360|240)p(?:[^0-9]|$)/i);
  if (pMatch) return Number(pMatch[1]);

  const sizeMatch = decoded.match(/(?:^|[^0-9])(?:\d{3,5})x(2160|1440|1080|720|576|540|480|360|240)(?:[^0-9]|$)/i);
  if (sizeMatch) return Number(sizeMatch[1]);

  const heightMatch = decoded.match(/(?:height|res|quality|q)[=:_-](2160|1440|1080|720|576|540|480|360|240)/i);
  if (heightMatch) return Number(heightMatch[1]);

  return 0;
}

function normalizeHeaders(requestHeaders) {
  const wanted = new Set([
    "accept",
    "accept-language",
    "cookie",
    "origin",
    "referer",
    "user-agent"
  ]);
  const headers = {};
  for (const header of requestHeaders) {
    const name = (header.name || "").toLowerCase();
    if (wanted.has(name) && header.value) headers[name] = header.value;
  }
  return headers;
}

function streamKey(url) {
  const parsed = safeUrl(url);
  if (!parsed) return makeId("stream");

  const pathname = parsed.pathname;
  const isSegment = /\.(m4s|ts)$/i.test(pathname);
  if (!isSegment) return `stream:${parsed.href}`;

  const collapsedPath = pathname
    .replace(/[0-9a-f]{12,}/gi, "{hex}")
    .replace(/\d{3,}/g, "{n}");
  const collapsedSearch = parsed.search
    .replace(/[0-9a-f]{12,}/gi, "{hex}")
    .replace(/\d{3,}/g, "{n}");
  return `segment:${parsed.origin}${collapsedPath}${collapsedSearch}`;
}

function headerKey(url) {
  return stripHash(url);
}

function stripHash(url) {
  const hashIndex = url.indexOf("#");
  return hashIndex >= 0 ? url.slice(0, hashIndex) : url;
}

function getHost(url) {
  return safeUrl(url)?.host || "";
}

function safeUrl(url) {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function safeImageUrl(url) {
  if (!url) return "";
  const parsed = safeUrl(url);
  return parsed && /^https?:$/.test(parsed.protocol) ? parsed.href : "";
}

function isYoutubeUrl(url) {
  const host = getHost(url).replace(/^www\./, "");
  return host === "youtube.com" || host.endsWith(".youtube.com") || host === "youtu.be";
}

function formatDuration(seconds) {
  const value = Number(seconds || 0);
  if (!Number.isFinite(value) || value <= 0) return "--:--";
  const whole = Math.round(value);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatBytes(bytes, approximate = false) {
  const value = Number(bytes || 0);
  const prefix = approximate ? "约 " : "";
  if (!Number.isFinite(value) || value <= 0) return "约 -- MB";
  const mb = value / (1024 * 1024);
  if (mb < 1024) return `${prefix}${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB`;
  const gb = mb / 1024;
  return `${prefix}${gb >= 10 ? Math.round(gb) : gb.toFixed(1)} GB`;
}

function makeId(prefix) {
  if (crypto.randomUUID) return `${prefix}:${crypto.randomUUID()}`;
  return `${prefix}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}
