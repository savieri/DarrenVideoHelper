const HOST_NAME = "com.darren.videohelper";
const PAGE_EXTRACTOR_ID_PREFIX = "__page_extractor__:";
const STREAM_URL_PATTERN = /\.(m3u8|mp4|m4s|ts)(?:$|[?#])/i;
const IMAGE_URL_PATTERN = /\.(jpe?g|png|webp|gif|avif)(?:$|[?#])/i;
const BAD_CANDIDATE_PATTERN = /(?:thumbnail|thumb|sprite|preview|avatar|profile|icon|logo|banner|advert|\/ads?\/|doubleclick|googlesyndication|analytics|tracking)/i;
const MAX_STREAMS_PER_TAB = 100;
const MAX_HEADERS_PER_TAB = 140;
const MAX_LOG_LINES = 140;
const NATIVE_START_TIMEOUT_MS = 20 * 1000;
const NATIVE_HOST_LOG_PATH = "~/Library/Logs/DarrenVideoHelper/native-host.log";
const ACTIVE_JOB_STATUSES = new Set(["queued", "downloading", "merging"]);
const SESSION_ENRICH_RETRIES = 1;
const RECENT_MAIN_MEDIA_WINDOW_MS = 90 * 1000;
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
    captureNetworkStream(details.tabId, details.url, {
      method: details.method,
      requestId: details.requestId,
      documentUrl: details.documentUrl || "",
      initiator: details.initiator || "",
      documentId: details.documentId || "",
      frameId: details.frameId,
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
    captureNetworkStream(details.tabId, details.url, {
      headers,
      method: details.method,
      requestId: details.requestId,
      documentUrl: details.documentUrl || "",
      initiator: details.initiator || "",
      documentId: details.documentId || "",
      frameId: details.frameId,
      source: "network"
    });
  },
  { urls: ["<all_urls>"] },
  ["requestHeaders", "extraHeaders"]
);

chrome.tabs.onRemoved.addListener((tabId) => {
  tabState.delete(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url) {
    commitVideoNavigation(tabId, {
      pageUrl: changeInfo.url,
      pageIdentity: pageVideoIdentity(changeInfo.url),
      pageTitle: tab?.title || "video",
      reason: "tab-url"
    });
  } else if (changeInfo.title) {
    const state = tabState.get(tabId);
    if (state && !state.invalidated) state.pageTitle = changeInfo.title || state.pageTitle;
  }
});

if (chrome.webNavigation) {
  const handleNavigation = (details, reason, forceDocumentBoundary = false) => {
    if (details.frameId !== 0 || details.tabId < 0) return;
    commitVideoNavigation(details.tabId, {
      pageUrl: details.url,
      pageIdentity: pageVideoIdentity(details.url),
      documentId: details.documentId || "",
      reason,
      forceDocumentBoundary
    });
  };
  chrome.webNavigation.onCommitted.addListener((details) => handleNavigation(details, "navigation", true));
  chrome.webNavigation.onHistoryStateUpdated.addListener((details) => handleNavigation(details, "history"));
  chrome.webNavigation.onReferenceFragmentUpdated.addListener((details) => handleNavigation(details, "fragment"));
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object") return false;

  if (message.type === "getStreams") {
    getPopupState(message.tabId).then(sendResponse).catch((error) => {
      sendResponse({ ok: false, error: error.message || String(error) });
    });
    return true;
  }

  if (message.type === "download") {
    startDownload(message.tabId, message.selection || message, {
      forceRedownload: message.forceRedownload === true
    }).then(sendResponse).catch((error) => {
      sendResponse({ ok: false, error: error.message || String(error) });
    });
    return true;
  }

  if (message.type === "downloadRecommended") {
    downloadRecommended(message.tabId, message.selection, {
      forceRedownload: message.forceRedownload === true
    }).then(sendResponse).catch((error) => {
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

  if (message.type === "videoContext" && sender.tab?.id != null) {
    updateVideoContext(sender.tab.id, message.context || {});
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "videoNavigation" && sender.tab?.id != null) {
    const navigation = message.navigation || {};
    if (navigation.phase === "start") {
      invalidateVideoSession(sender.tab.id, navigation);
    } else {
      commitVideoNavigation(sender.tab.id, navigation);
    }
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

async function getPopupState(tabId, retryCount = 0) {
  const settings = await loadSettings();
  const tab = tabId ? await chrome.tabs.get(tabId) : await getActiveTab();
  if (!tab || !tab.id) {
    return { ok: false, error: "No active tab." };
  }

  let state = ensureVideoSession(tab.id, {
    pageUrl: tab.url || "",
    pageIdentity: pageVideoIdentity(tab.url || ""),
    pageTitle: tab.title || "video",
    reason: "popup"
  });
  if (state.invalidated) {
    return navigationPopupState(tab, state, settings);
  }
  state = await collectMediaHints(tab, state);
  if (state.invalidated) return navigationPopupState(tab, state, settings);
  const sessionSnapshot = snapshotVideoSession(state);

  const allSessionStreams = sortedStreams(state)
    .filter((stream) => !isHardExcludedUrl(stream.lastUrl || stream.url));
  const rawStreams = allSessionStreams
    .filter((stream) => settings.showAdvanced || stream.kind !== "segment")
    .map(snapshotStream);
  let enrichedStreams = await Promise.all(rawStreams.map((stream) => enrichStreamForPopup(sessionSnapshot, stream)));

  if (tabState.get(tab.id)?.sessionId !== sessionSnapshot.sessionId) {
    if (retryCount < SESSION_ENRICH_RETRIES) return getPopupState(tab.id, retryCount + 1);
    return { ok: false, stale: true, error: "页面视频已切换，请刷新后再下载。" };
  }

  enrichedStreams = linkPlaylistCandidates(enrichedStreams);
  const ranked = rankStreams(makePopupStreams(sessionSnapshot, enrichedStreams), sessionSnapshot);
  const streams = aggregateLogicalVideos(sessionSnapshot, ranked, settings)
    .map((stream, index) => ({ ...stream, recommended: index === 0, rank: index + 1 }));
  const recommended = streams[0] || null;

  const hasPageExtractor = Boolean(pageExtractorInfo(sessionSnapshot.pageUrl));
  const hasDetectedVideo = hasPageExtractor || allSessionStreams.some((stream) => stream.kind !== "segment");
  const warning = hasDetectedVideo || streams.length
    ? ""
    : "没检测到真实视频流。请先播放 3-5 秒后刷新；PAGE 不会作为可下载视频推荐。";

  return {
    ok: true,
    tabId: tab.id,
    sessionId: sessionSnapshot.sessionId,
    fingerprint: sessionSnapshot.fingerprint,
    pageTitle: sessionSnapshot.pageTitle,
    pageUrl: sessionSnapshot.pageUrl,
    thumbnailUrl: safeImageUrl(sessionSnapshot.thumbnailUrl),
    streams,
    recommended,
    detectedStreamCount: allSessionStreams.length + Number(hasPageExtractor),
    warning,
    settings,
    queuePaused,
    jobs: publicJobs()
  };
}

function navigationPopupState(tab, state, settings) {
  return {
    ok: true,
    navigating: true,
    tabId: tab.id,
    sessionId: state.sessionId,
    fingerprint: state.fingerprint,
    pageTitle: "正在切换视频…",
    pageUrl: tab.url || state.pendingPageUrl || state.pageUrl,
    thumbnailUrl: "",
    streams: [],
    recommended: null,
    detectedStreamCount: 0,
    warning: "页面正在切换，上一视频已失效。正在检测新视频…",
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
  if (!tab.url || !/^https?:\/\//i.test(tab.url)) return state;

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const absolute = (value) => {
          if (!value) return "";
          try {
            const url = new URL(value, location.href);
            return /^(?:https?|blob):$/.test(url.protocol) ? url.href : "";
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
        const metadataVideoId =
          document.querySelector("ytd-watch-flexy[video-id]")?.getAttribute("video-id") ||
          document.querySelector("#movie_player[data-video-id]")?.getAttribute("data-video-id") ||
          document.querySelector('meta[itemprop="videoId"]')?.content ||
          document.querySelector('meta[itemprop="identifier"]')?.content ||
          "";
        return {
          title: metaTitle,
          pageUrl: location.href,
          poster: absolute(videos.find((item) => item.poster)?.poster || metaImage),
          metadataVideoId,
          videos
        };
      }
    });

    const hints = results?.[0]?.result;
    if (!hints) return state;

    const videos = hints.videos || [];
    const playableVideos = videos.filter((video) => video.duration || video.height || video.width || video.currentSrc);
    const mainVideo = playableVideos.sort((a, b) => {
      const activeDiff = Number(!a.paused) - Number(!b.paused);
      if (activeDiff) return -activeDiff;
      const areaDiff = (b.width * b.height) - (a.width * a.height);
      if (areaDiff) return areaDiff;
      return (b.duration || 0) - (a.duration || 0);
    })[0];
    const extractor = pageExtractorInfo(hints.pageUrl);
    const metadataMatchesPage = !extractor?.videoId
      || !hints.metadataVideoId
      || extractor.videoId === hints.metadataVideoId;
    state = updateVideoContext(tab.id, {
      pageUrl: hints.pageUrl,
      pageIdentity: pageVideoIdentity(hints.pageUrl),
      videoId: extractor?.videoId || "",
      metadataVideoId: hints.metadataVideoId || "",
      metadataMatchesPage,
      pageTitle: metadataMatchesPage ? hints.title : "",
      poster: metadataMatchesPage ? hints.poster : "",
      hasVideoElement: Boolean(videos.length),
      mainVideo: metadataMatchesPage ? mainVideo : null,
      reason: "popup-hints"
    });

    for (const video of videos) {
      const urls = [video.currentSrc, ...(video.sourceUrls || [])].filter(Boolean);
      for (const url of urls) {
        if (!isStreamUrl(url) || isHardExcludedUrl(url)) continue;
        upsertStream(tab.id, url, {
          source: video === mainVideo ? "dom-main-video" : "dom-secondary-video",
          association: video === mainVideo ? "main-current-src" : "secondary-dom",
          quality: video.height || undefined,
          duration: video.duration || undefined
        });
      }
    }
  } catch {
    // Some pages, frames, and chrome:// URLs cannot be scripted. Network capture still works.
  }
  return tabState.get(tab.id) || state;
}

async function enrichStreamForPopup(session, stream) {
  const url = stream.lastUrl || stream.url;
  const playlistInfo = isHlsKind(stream.kind) ? await fetchPlaylistInfo(url) : {};
  const contentLength = stream.kind === "mp4" ? await fetchContentLength(url) : 0;
  const kind = playlistInfo.isMaster === true ? "hls_master"
    : playlistInfo.isMaster === false && isHlsKind(stream.kind) ? "hls_media"
      : stream.kind;
  const mainCurrentSrc = normalizeResourceUrl(session.currentSrc);
  const stronglyAssociated = stream.association === "main-current-src"
    || (mainCurrentSrc && normalizeResourceUrl(url) === mainCurrentSrc);
  const quality = stream.quality || playlistInfo.quality || (stronglyAssociated ? session.mainVideoHeight : 0) || 0;
  const duration = stream.duration || playlistInfo.duration || (stronglyAssociated ? session.videoDuration : 0) || 0;
  const sizeBytes = contentLength || stream.sizeBytes || playlistInfo.sizeBytes || estimateSizeBytes(quality, duration, stream.kind);
  const exactSize = Boolean(contentLength || stream.sizeExact || playlistInfo.sizeExact);
  const capturedAfterMain = !session.mainVideoObservedAt
    || stream.lastSeen >= session.mainVideoObservedAt;

  return {
    id: stream.id,
    resourceId: stream.id,
    resourceUrl: url,
    sessionId: session.sessionId,
    fingerprint: resourceFingerprint(session, stream),
    url: stream.url,
    lastUrl: url,
    pageUrl: session.pageUrl,
    kind,
    typeTag: streamTypeTag(kind),
    label: stream.label,
    quality,
    qualityLabel: quality ? `${quality}p` : "Auto",
    host: getHost(url),
    sourceTitle: stream.pageTitleAtCapture || session.pageTitle || getHost(url) || "Detected video",
    thumbnailUrl: safeImageUrl(session.thumbnailUrl),
    duration,
    durationLabel: formatDuration(duration),
    sizeBytes,
    sizeLabel: formatBytes(sizeBytes, !exactSize),
    exactSize,
    sampleCount: stream.sampleCount || 1,
    firstSeen: stream.firstSeen,
    lastSeen: stream.lastSeen,
    source: stream.source,
    association: stream.association || "session-network",
    initiator: stream.initiator || "",
    documentUrl: stream.documentUrl || "",
    variantUrls: playlistInfo.variantUrls || [],
    stronglyAssociated,
    capturedAfterMain,
    canDownloadWholeVideo: !["segment", "page", "dash_video", "dash_audio"].includes(kind),
    isRecommendable: !["segment", "page", "dash_video", "dash_audio"].includes(kind)
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
    return parsePlaylistInfo(text, url);
  } catch {
    return {};
  }
}

function parsePlaylistInfo(text, playlistUrl = "") {
  const info = {};
  info.isMaster = /#EXT-X-STREAM-INF:/i.test(text);
  if (info.isMaster) {
    const lines = String(text || "").split(/\r?\n/);
    const variants = [];
    for (let index = 0; index < lines.length; index += 1) {
      if (!/#EXT-X-STREAM-INF:/i.test(lines[index])) continue;
      const next = lines.slice(index + 1).find((line) => line.trim() && !line.trim().startsWith("#"));
      if (!next) continue;
      try {
        variants.push(new URL(next.trim(), playlistUrl).href);
      } catch {
        // Ignore malformed variant URLs.
      }
    }
    info.variantUrls = Array.from(new Set(variants));
  }
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
    info.sizeExact = true;
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

async function startDownload(tabId, selection, options = {}) {
  const settings = await loadSettings();
  const state = tabState.get(tabId);
  if (!state) return staleSelectionResponse();
  const resolved = validateDownloadSelection(state, selection || {});
  if (!resolved.ok) return resolved;

  const payload = buildDownloadPayload(state, resolved.stream, settings, {
    qualityPreference: selection?.qualityPreference || ""
  });
  return enqueueDownload(payload, settings, options);
}

async function downloadRecommended(tabId, selection, options = {}) {
  const popupState = selection ? null : await getPopupState(tabId);
  if (popupState && !popupState.ok) return popupState;
  const recommended = selection || popupState?.recommended;
  if (!recommended) return { ok: false, error: "没检测到视频，请先播放 3-5 秒后刷新 popup。" };
  return startDownload(tabId, recommended, options);
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
      resourceId: makeId("import"),
      resourceUrl: url,
      fingerprint: stableFingerprint(`import|${normalizePageUrl(url)}`),
      capturedAt: Date.now(),
      qualityPreference: settings.defaultQuality,
      settings
    };
    const response = await enqueueDownload(payload, settings, { quiet: true, forceRedownload: true });
    if (response.ok) jobIds.push(response.jobId);
  }
  processQueue();
  return { ok: true, jobIds };
}

function findDownloadStream(state, streamId) {
  const extractor = makePageExtractorCandidate(snapshotVideoSession(state));
  if (extractor && extractor.id === streamId) return extractor;
  return state.streams.get(streamId);
}

function validateDownloadSelection(state, selection) {
  const resourceId = selection.resourceId || selection.streamId || selection.id;
  if (state.invalidated || !resourceId || selection.sessionId !== state.sessionId) return staleSelectionResponse();
  const stream = findDownloadStream(state, resourceId);
  if (!stream || stream.kind === "page" || stream.kind === "segment"
    || stream.kind === "dash_video" || stream.kind === "dash_audio") return staleSelectionResponse();
  const resourceUrl = stream.lastUrl || stream.url;
  if (selection.resourceUrl && normalizeResourceUrl(selection.resourceUrl) !== normalizeResourceUrl(resourceUrl)) {
    return staleSelectionResponse();
  }
  const fingerprint = resourceFingerprint(state, stream);
  if (selection.fingerprint && selection.fingerprint !== fingerprint) return staleSelectionResponse();
  return { ok: true, stream };
}

function staleSelectionResponse() {
  return {
    ok: false,
    stale: true,
    error: "页面或播放器已切换，旧候选已失效。请刷新检测结果后再下载。"
  };
}

function buildDownloadPayload(state, stream, settings, options = {}) {
  const pageUrl = state.pageUrl || "";
  const streamUrl = stream.lastUrl || stream.url;
  const usePageExtractor = stream.kind === "page_extractor";
  const targetUrl = usePageExtractor ? pageUrl : streamUrl;
  const kind = usePageExtractor ? "page" : stream.kind;
  const headers = {
    ...(stream.headers || state.headersByUrl.get(headerKey(stream.url)) || {})
  };
  const resourceUrl = stream.lastUrl || stream.url;
  const payload = {
    action: "download",
    url: targetUrl,
    originalUrl: stream.url,
    resourceUrl,
    resourceId: stream.id,
    sessionId: state.sessionId,
    fingerprint: resourceFingerprint(state, stream),
    pageUrl,
    pageTitle: state.pageTitle || "video",
    sourceTitle: state.pageTitle || getHost(targetUrl) || "video",
    currentSrc: state.currentSrc || "",
    kind,
    expectedDuration: stream.duration || state.videoDuration || 0,
    headers,
    referer: headers.referer || pageUrl,
    preferPageUrl: usePageExtractor || stream.kind === "page",
    capturedAt: Date.now(),
    qualityPreference: options.qualityPreference || settings.defaultQuality,
    settings: { ...settings }
  };
  return deepFreeze(payload);
}

async function enqueueDownload(payload, settings, options = {}) {
  const activeJob = findActiveJob(payload);
  if (activeJob) {
    return {
      ok: true,
      activeDuplicate: true,
      reused: true,
      jobId: activeJob.id,
      message: "这个视频已在下载中，已复用现有任务。",
      job: publicJob(activeJob)
    };
  }
  const duplicate = settings.skipDownloaded ? await findDownloadedHistory(payload) : null;
  if (duplicate && options.forceRedownload !== true) {
    return {
      ok: false,
      duplicate: true,
      error: "这个视频有已完成记录。不会自动跳过；确认后可强制重新下载。",
      history: {
        completedAt: duplicate.completedAt,
        outputPath: duplicate.outputPath || "",
        fileSize: duplicate.fileSize || 0
      }
    };
  }
  const jobId = makeId("job");
  const job = {
    id: jobId,
    status: "queued",
    message: duplicate ? "检测到历史记录，已按要求重新下载。" : "等待下载...",
    outputPath: "",
    fileSize: 0,
    duration: 0,
    error: "",
    details: "",
    percent: "",
    speed: "",
    eta: "",
    logs: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    url: payload.url,
    pageUrl: payload.pageUrl,
    sessionId: payload.sessionId || "",
    resourceId: payload.resourceId || "",
    fingerprint: payload.fingerprint || "",
    title: payload.sourceTitle || payload.pageTitle || getHost(payload.url),
    payload
  };
  jobs.set(jobId, job);
  broadcastJob(job);
  if (!options.quiet) processQueue();
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
  let startTimer = null;
  const clearStartTimer = () => {
    if (startTimer) clearTimeout(startTimer);
    startTimer = null;
  };
  updateJob(job.id, {
    status: "downloading",
    message: "Starting native download...",
    percent: "",
    speed: "",
    eta: ""
  });

  try {
    port = chrome.runtime.connectNative(HOST_NAME);
  } catch (error) {
    const rawMessage = error?.message || String(error);
    const message = readableNativeDisconnectError(rawMessage);
    updateJob(job.id, {
      status: "failed",
      error: message,
      details: `${message}\nChrome: ${rawMessage}\nNative host log: ${NATIVE_HOST_LOG_PATH}`,
      message
    });
    processQueue();
    return;
  }

  runningPorts.set(job.id, port);
  startTimer = setTimeout(() => {
    const current = jobs.get(job.id);
    if (!current || !["downloading", "merging"].includes(current.status)) return;
    runningPorts.delete(job.id);
    updateJob(job.id, {
      status: "failed",
      error: "本地助手启动超时。",
      details: `Chrome 已连接，但 ${NATIVE_START_TIMEOUT_MS / 1000} 秒内没有收到任何响应。\nNative host log: ${NATIVE_HOST_LOG_PATH}`,
      message: "本地助手启动超时，任务已停止。"
    });
    safeDisconnect(port);
    processQueue();
  }, NATIVE_START_TIMEOUT_MS);

  port.onMessage.addListener((message) => {
    if (!message || message.jobId !== job.id) return;
    clearStartTimer();

    if (message.type === "progress") {
      const currentStatus = jobs.get(job.id)?.status;
      const patch = {
        status: message.stage === "merging" || currentStatus === "merging" ? "merging" : "downloading",
        message: message.message || "Downloading...",
        percent: message.percent ?? jobs.get(job.id)?.percent ?? "",
        speed: message.speed ?? jobs.get(job.id)?.speed ?? "",
        eta: message.eta ?? jobs.get(job.id)?.eta ?? ""
      };
      if (message.line) appendJobLog(job.id, message.line);
      updateJob(job.id, patch);
    }

    if (message.type === "complete") {
      const current = jobs.get(job.id);
      if (!current || current.status === "completed" || current.status === "cancelled") return;
      updateJob(job.id, {
        status: "completed",
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
      const current = jobs.get(job.id);
      if (!current || current.status === "completed" || current.status === "cancelled") return;
      updateJob(job.id, {
        status: "failed",
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
    clearStartTimer();
    runningPorts.delete(job.id);
    const current = jobs.get(job.id);
    if (!current || ["completed", "failed", "cancelled"].includes(current.status)) {
      processQueue();
      return;
    }
    const rawMessage = chrome.runtime.lastError?.message || "Native host disconnected before finishing.";
    const message = readableNativeDisconnectError(rawMessage);
    updateJob(job.id, {
      status: "failed",
      error: message,
      details: `${message}\nChrome: ${rawMessage}\nNative host log: ${NATIVE_HOST_LOG_PATH}`,
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
  try {
    port.postMessage(nativePayload);
  } catch (error) {
    clearStartTimer();
    runningPorts.delete(job.id);
    const rawMessage = error?.message || String(error);
    const message = readableNativeDisconnectError(rawMessage);
    updateJob(job.id, {
      status: "failed",
      error: message,
      details: `${message}\nChrome: ${rawMessage}\nNative host log: ${NATIVE_HOST_LOG_PATH}`,
      message
    });
    safeDisconnect(port);
    processQueue();
  }
}

function readableNativeDisconnectError(rawMessage) {
  const value = String(rawMessage || "");
  if (/native host has exited/i.test(value)) {
    return "本地助手意外退出，任务已停止。请展开错误详情查看日志位置。";
  }
  if (/specified native messaging host not found/i.test(value)) {
    return "本地助手未注册或注册路径无效。";
  }
  if (/access to the specified native messaging host is forbidden/i.test(value)) {
    return "扩展 ID 与本地助手授权不匹配。";
  }
  if (/error when communicating|disconnected before finishing/i.test(value)) {
    return "Chrome 无法与本地助手继续通信，任务已停止。";
  }
  return value || "本地助手在下载完成前断开，任务已停止。";
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
    status: "cancelled",
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
    sessionId: job.sessionId || "",
    resourceId: job.resourceId || "",
    fingerprint: job.fingerprint || "",
    status: "completed",
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
  if (!payload.fingerprint) return null;
  return history.find((item) => (
    item.status !== "failed"
    && item.status !== "cancelled"
    && item.outputPath
    && item.fingerprint
    && item.fingerprint === payload.fingerprint
  )) || null;
}

function findActiveJob(payload) {
  for (const job of jobs.values()) {
    if (!ACTIVE_JOB_STATUSES.has(job.status)) continue;
    const fingerprintMatches = Boolean(
      payload.fingerprint
      && job.fingerprint
      && payload.fingerprint === job.fingerprint
    );
    const bindingMatches = Boolean(
      payload.sessionId
      && payload.resourceId
      && payload.sessionId === job.sessionId
      && payload.resourceId === job.resourceId
    );
    if (fingerprintMatches || bindingMatches) return job;
  }
  return null;
}

function snapshotVideoSession(state) {
  return Object.freeze({
    sessionId: state.sessionId,
    tabId: state.tabId,
    pageUrl: state.pageUrl,
    pageTitle: state.pageTitle,
    pageIdentity: state.pageIdentity,
    videoId: state.videoId,
    currentSrc: state.currentSrc,
    createdAt: state.createdAt,
    fingerprint: state.fingerprint,
    thumbnailUrl: state.thumbnailUrl,
    hasVideoElement: state.hasVideoElement,
    videoDuration: state.videoDuration,
    mainVideoHeight: state.mainVideoHeight,
    mainVideoWidth: state.mainVideoWidth,
    mainVideoObservedAt: state.mainVideoObservedAt,
    invalidated: state.invalidated === true
  });
}

function snapshotStream(stream) {
  return Object.freeze({
    ...stream,
    headers: { ...(stream.headers || {}) }
  });
}

function linkPlaylistCandidates(streams) {
  const variantOwners = new Map();
  const stronglyAssociatedUrls = new Set(
    streams
      .filter((stream) => stream.stronglyAssociated)
      .map((stream) => normalizeResourceUrl(stream.resourceUrl))
  );
  for (const stream of streams) {
    if (stream.kind !== "hls_master") continue;
    for (const variantUrl of stream.variantUrls || []) {
      variantOwners.set(normalizeResourceUrl(variantUrl), stream);
    }
  }
  const linked = streams.map((stream) => {
    const master = variantOwners.get(normalizeResourceUrl(stream.resourceUrl));
    if (!master || master.resourceId === stream.resourceId) return stream;
    return {
      ...stream,
      parentMasterId: master.resourceId,
      masterStronglyAssociated: master.stronglyAssociated === true
    };
  });
  return linked.map((stream) => {
    if (stream.kind !== "hls_master") return stream;
    const hasStrongVariant = (stream.variantUrls || [])
      .some((url) => stronglyAssociatedUrls.has(normalizeResourceUrl(url)));
    return hasStrongVariant ? { ...stream, masterStronglyAssociated: true } : stream;
  });
}

function resourceFingerprint(session, stream) {
  return stableFingerprint([
    session.fingerprint || videoFingerprint(session.pageUrl, session.currentSrc),
    stream.kind || "unknown",
    normalizeResourceUrl(stream.lastUrl || stream.url || "")
  ].join("|"));
}

function videoFingerprint(pageUrl, currentSrc) {
  const stableCurrentSrc = isConcreteMediaSrc(currentSrc) ? normalizeResourceUrl(currentSrc) : "";
  return stableFingerprint(`${pageVideoIdentity(pageUrl)}|${stableCurrentSrc}`);
}

function stableFingerprint(value) {
  let hash = 2166136261;
  const text = String(value || "");
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fp:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function normalizePageUrl(url) {
  const parsed = safeUrl(url);
  if (!parsed) return String(url || "");
  return parsed.href;
}

function normalizeResourceUrl(url) {
  return stripHash(String(url || ""));
}

function samePageIdentity(left, right) {
  if (!left || !right) return false;
  return pageVideoIdentity(left) === pageVideoIdentity(right);
}

function sameDocumentContext(left, right) {
  if (!left || !right) return false;
  if (pageExtractorInfo(left) || pageExtractorInfo(right)) return samePageIdentity(left, right);
  return stripHash(normalizePageUrl(left)) === stripHash(normalizePageUrl(right));
}

function sameOriginContext(left, right) {
  const leftUrl = safeUrl(left);
  const rightUrl = safeUrl(right);
  return Boolean(leftUrl && rightUrl && leftUrl.origin === rightUrl.origin);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function pageExtractorInfo(url) {
  const parsed = safeUrl(url);
  if (!parsed) return null;
  const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
  let videoId = "";
  if (host === "youtu.be") {
    videoId = parsed.pathname.split("/").filter(Boolean)[0] || "";
  } else if (host === "youtube.com" || host.endsWith(".youtube.com")) {
    if (parsed.pathname === "/watch") videoId = parsed.searchParams.get("v") || "";
    else {
      const match = parsed.pathname.match(/^\/(?:shorts|live|embed)\/([^/?#]+)/i);
      videoId = match?.[1] || "";
    }
  }
  if (!videoId) return null;
  return {
    provider: "youtube",
    videoId,
    canonicalUrl: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
    typeTag: "YT",
    label: "YouTube 页面解析（DASH 音视频合并）"
  };
}

function pageVideoIdentity(url) {
  const extractor = pageExtractorInfo(url);
  if (extractor) return `${extractor.provider}:${extractor.videoId}`;
  return normalizePageUrl(url);
}

function makePageExtractorCandidate(state) {
  const info = pageExtractorInfo(state.pageUrl);
  if (!info) return null;
  const now = Date.now();
  const id = `${PAGE_EXTRACTOR_ID_PREFIX}${info.provider}:${info.videoId}`;
  const stream = {
    id,
    resourceId: id,
    resourceUrl: info.canonicalUrl,
    sessionId: state.sessionId,
    url: info.canonicalUrl,
    lastUrl: info.canonicalUrl,
    pageUrl: state.pageUrl,
    kind: "page_extractor",
    typeTag: info.typeTag,
    label: info.label,
    quality: state.mainVideoHeight || 0,
    qualityLabel: state.mainVideoHeight ? `${state.mainVideoHeight}p` : "Best",
    host: getHost(state.pageUrl),
    sourceTitle: state.pageTitle || "YouTube video",
    thumbnailUrl: safeImageUrl(state.thumbnailUrl),
    duration: state.videoDuration || 0,
    durationLabel: formatDuration(state.videoDuration || 0),
    sizeBytes: estimateSizeBytes(state.mainVideoHeight || 1080, state.videoDuration || 0, "page_extractor"),
    sizeLabel: formatBytes(
      estimateSizeBytes(state.mainVideoHeight || 1080, state.videoDuration || 0, "page_extractor"),
      true
    ),
    exactSize: false,
    sampleCount: 1,
    firstSeen: state.createdAt || now,
    lastSeen: now,
    stronglyAssociated: true,
    capturedAfterMain: true,
    canDownloadWholeVideo: true,
    isRecommendable: true,
    headers: {}
  };
  return {
    ...stream,
    fingerprint: resourceFingerprint(state, stream)
  };
}

function isConcreteMediaSrc(url) {
  return /^https?:\/\//i.test(url || "") && isStreamUrl(url);
}

function shouldRotateForCurrentSrc(previous, next) {
  if (!previous || !next) return false;
  if (!isConcreteMediaSrc(previous) || !isConcreteMediaSrc(next)) return false;
  return normalizeResourceUrl(previous) !== normalizeResourceUrl(next);
}

function makePopupStreams(state, detectedStreams) {
  const streams = [...detectedStreams];
  const extractor = makePageExtractorCandidate(state);
  if (extractor) streams.push(extractor);
  return streams;
}

function previewUrlForStream(stream) {
  const url = stream?.resourceUrl || stream?.lastUrl || stream?.url || "";
  return /^https?:\/\//i.test(url) ? url : "";
}

function choosePreviewSource(state, rankedStreams, primary) {
  const extractor = pageExtractorInfo(state.pageUrl);
  let candidates = [];

  if (extractor?.provider === "youtube") {
    candidates = rankedStreams.filter((stream) => stream.kind === "dash_video");
  } else if (primary.kind === "hls_master") {
    candidates = rankedStreams.filter((stream) => (
      stream.resourceId === primary.resourceId
      || stream.parentMasterId === primary.resourceId
    ));
  } else if (primary.kind === "hls_media" && primary.parentMasterId) {
    candidates = rankedStreams.filter((stream) => (
      stream.resourceId === primary.resourceId
      || stream.resourceId === primary.parentMasterId
      || stream.parentMasterId === primary.parentMasterId
    ));
  } else {
    candidates = [primary];
  }

  const previewable = candidates
    .filter((stream) => ["mp4", "dash_video", "hls_master", "hls_media"].includes(stream.kind))
    .filter((stream) => previewUrlForStream(stream))
    .sort((left, right) => {
      const leftQuality = Number(left.quality || 100000);
      const rightQuality = Number(right.quality || 100000);
      if (leftQuality !== rightQuality) return leftQuality - rightQuality;
      return Number(right.stronglyAssociated === true) - Number(left.stronglyAssociated === true);
    });
  const selected = previewable[0];
  if (!selected) return { previewUrl: "", previewSourceKind: "" };
  return {
    previewUrl: previewUrlForStream(selected),
    previewSourceKind: selected.kind
  };
}

function outputPipelineLabel(primary, extractor) {
  if (extractor?.provider === "youtube") return "DASH → MP4";
  if (isHlsKind(primary.kind)) return "HLS → MP4";
  if (primary.kind === "mp4") return "Direct MP4";
  return "Video → MP4";
}

function aggregateLogicalVideos(state, rankedStreams, settings = {}) {
  const primary = rankedStreams.find((stream) => stream.canDownloadWholeVideo && stream.isRecommendable);
  if (!primary) return [];

  const qualityValues = Array.from(new Set(
    rankedStreams
      .map((stream) => Number(stream.quality || 0))
      .filter((quality) => quality > 0)
  )).sort((left, right) => right - left);
  const qualityOptions = [{ value: "best", label: "最佳可用" }];
  for (const quality of qualityValues) {
    qualityOptions.push({ value: `${quality}p`, label: `${quality}p` });
  }
  const defaultQuality = settings.defaultQuality || "best";
  if (!qualityOptions.some((option) => option.value === defaultQuality)) {
    qualityOptions.push({ value: defaultQuality, label: defaultQuality });
  }

  const extractor = pageExtractorInfo(state.pageUrl);
  const providerLabel = extractor?.provider === "youtube"
    ? "YouTube"
    : (getHost(state.pageUrl) || primary.host || "网页视频");
  const pipelineLabel = outputPipelineLabel(primary, extractor);
  const previewSource = choosePreviewSource(state, rankedStreams, primary);
  const advancedSources = settings.showAdvanced === true
    ? rankedStreams.map((stream) => ({
      resourceId: stream.resourceId,
      sourceKind: stream.kind,
      typeTag: stream.typeTag,
      qualityLabel: stream.qualityLabel,
      label: stream.label,
      host: stream.host,
      downloadable: stream.canDownloadWholeVideo === true
    }))
    : [];

  return [{
    ...primary,
    id: `logical:${state.sessionId}`,
    logicalVideoId: `logical:${state.pageIdentity || state.fingerprint}`,
    kind: "logical_video",
    sourceKind: primary.kind,
    typeTag: "MP4",
    formatLabel: pipelineLabel,
    pipelineLabel,
    providerLabel,
    label: `${providerLabel} · ${pipelineLabel}`,
    host: providerLabel,
    sourceTitle: state.pageTitle || primary.sourceTitle || providerLabel,
    thumbnailUrl: safeImageUrl(state.thumbnailUrl || primary.thumbnailUrl),
    duration: state.videoDuration || primary.duration || 0,
    durationLabel: formatDuration(state.videoDuration || primary.duration || 0),
    quality: primary.quality || state.mainVideoHeight || 0,
    qualityLabel: primary.qualityLabel || (state.mainVideoHeight ? `${state.mainVideoHeight}p` : "最佳"),
    qualityOptions,
    defaultQuality,
    evidenceCount: rankedStreams.length,
    advancedSources,
    ...previewSource,
    canDownloadWholeVideo: true,
    isRecommendable: true
  }];
}

function rankStreams(streams, state) {
  return streams
    .filter((stream) => stream.canDownloadWholeVideo
      || stream.kind === "segment"
      || stream.kind === "dash_video"
      || stream.kind === "dash_audio")
    .sort((a, b) => {
      const scoreDiff = candidateScore(b, state) - candidateScore(a, state);
      if (scoreDiff) return scoreDiff;
      return (b.lastSeen || 0) - (a.lastSeen || 0);
    });
}

function candidateScore(stream, state) {
  let score = 0;
  if (stream.kind === "page") return -1000000;
  if (stream.kind === "page_extractor") score += 180000;
  if (stream.kind === "mp4") score += stream.stronglyAssociated ? 140000 : 105000;
  if (stream.kind === "hls_master") score += 100000;
  if (stream.kind === "hls_media") score += stream.parentMasterId ? 95000 : 85000;
  if (stream.kind === "segment") score -= 100000;
  if (stream.kind === "dash_video" || stream.kind === "dash_audio") score -= 120000;
  if (stream.stronglyAssociated) score += 22000;
  if (stream.masterStronglyAssociated) score += 16000;
  if (stream.capturedAfterMain) score += 5000;
  if (sameDocumentContext(stream.documentUrl, state.pageUrl)) score += 7000;
  if (sameOriginContext(stream.initiator, state.pageUrl)) score += 3500;
  if (stream.association === "secondary-dom") score -= 70000;
  score += Math.min(stream.duration || 0, 7200) * 4;
  score += (stream.quality || 0) * 18;
  const size = stream.sizeBytes || 0;
  if (
    size >= 3 * 1024 * 1024
    && size <= 12 * 1024 * 1024 * 1024
    && (stream.exactSize || stream.stronglyAssociated)
  ) score += 6000;
  if (size && size < 1024 * 1024) score -= 25000;
  const recentlyActive = !state.mainVideoObservedAt
    || (stream.lastSeen >= state.mainVideoObservedAt
      && Date.now() - stream.lastSeen <= RECENT_MAIN_MEDIA_WINDOW_MS);
  if (recentlyActive) score += 6000;
  else if (!stream.stronglyAssociated) score -= 30000;
  if (state.videoDuration > 120 && stream.duration > 0 && stream.duration < 45 && !stream.stronglyAssociated) {
    score -= 30000;
  }
  if (BAD_CANDIDATE_PATTERN.test(stream.lastUrl || stream.url || "")) score -= 120000;
  return score;
}

function createVideoSession(tabId, context = {}) {
  const pageUrl = context.pageUrl || "";
  const pageIdentity = context.pageIdentity || pageVideoIdentity(pageUrl);
  const extractor = pageExtractorInfo(pageUrl);
  const resetMetadata = context.resetMetadata === true;
  const currentSrc = resetMetadata ? "" : (context.currentSrc || "");
  const createdAt = Date.now();
  return {
    sessionId: makeId("session"),
    tabId,
    pageTitle: resetMetadata ? "正在检测视频…" : (context.pageTitle || "video"),
    pageUrl,
    pageIdentity,
    videoId: context.videoId || extractor?.videoId || "",
    documentId: context.documentId || "",
    currentSrc,
    createdAt,
    endedAt: 0,
    endReason: "",
    fingerprint: videoFingerprint(pageUrl, currentSrc),
    streams: new Map(),
    headersByUrl: new Map(),
    thumbnailUrl: "",
    hasVideoElement: false,
    videoDuration: 0,
    mainVideoHeight: 0,
    mainVideoWidth: 0,
    mainVideoObservedAt: currentSrc ? createdAt : 0,
    mainPoster: resetMetadata ? "" : (context.poster || ""),
    invalidated: false,
    invalidatedAt: 0,
    pendingPageUrl: "",
    navigationReason: context.reason || ""
  };
}

function ensureVideoSession(tabId, context = {}) {
  let state = tabState.get(tabId);
  if (!state) {
    state = createVideoSession(tabId, context);
    tabState.set(tabId, state);
    return state;
  }

  const incomingPageUrl = context.pageUrl || "";
  const incomingIdentity = context.pageIdentity || pageVideoIdentity(incomingPageUrl);
  if (incomingIdentity && state.pageIdentity && incomingIdentity !== state.pageIdentity) {
    return rotateVideoSession(tabId, {
      ...context,
      pageIdentity: incomingIdentity,
      forceSessionBoundary: true,
      resetMetadata: true
    });
  }
  if (!state.pageUrl && incomingPageUrl) state.pageUrl = incomingPageUrl;
  else if (incomingPageUrl && (!state.pageIdentity || incomingIdentity === state.pageIdentity)) {
    state.pageUrl = incomingPageUrl;
  }
  if (!state.pageIdentity && incomingIdentity) state.pageIdentity = incomingIdentity;
  if (context.videoId) state.videoId = context.videoId;
  if (context.pageTitle && !state.invalidated && context.metadataMatchesPage !== false) {
    state.pageTitle = context.pageTitle;
  }
  if (context.documentId && !state.documentId) state.documentId = context.documentId;
  state.fingerprint = videoFingerprint(state.pageUrl, state.currentSrc);
  return state;
}

function ensureTabState(tabId) {
  return ensureVideoSession(tabId);
}

function rotateVideoSession(tabId, context = {}) {
  const previous = tabState.get(tabId);
  const incomingPageUrl = context.pageUrl || previous?.pageUrl || "";
  const incomingIdentity = context.pageIdentity || pageVideoIdentity(incomingPageUrl);
  const documentChanged = Boolean(
    context.documentId && previous?.documentId && context.documentId !== previous.documentId
  );
  const pageChanged = Boolean(
    previous?.pageIdentity && incomingIdentity && previous.pageIdentity !== incomingIdentity
  );
  const forceDocumentBoundary = context.forceDocumentBoundary === true
    || (context.reason === "navigation" && documentChanged);
  const forceVideoBoundary = context.reason === "current-src";
  const forceSessionBoundary = context.forceSessionBoundary === true;
  if (previous && !pageChanged && !forceDocumentBoundary && !forceVideoBoundary && !forceSessionBoundary) {
    if (context.pageTitle && !previous.invalidated && context.metadataMatchesPage !== false) {
      previous.pageTitle = context.pageTitle;
    }
    if (incomingPageUrl) previous.pageUrl = incomingPageUrl;
    if (incomingIdentity) previous.pageIdentity = incomingIdentity;
    if (context.videoId) previous.videoId = context.videoId;
    if (context.documentId) previous.documentId = context.documentId;
    previous.fingerprint = videoFingerprint(previous.pageUrl, previous.currentSrc);
    return previous;
  }

  if (previous) {
    previous.endedAt = Date.now();
    previous.endReason = context.reason || "navigation";
  }
  const resetMetadata = context.resetMetadata === true || pageChanged || forceDocumentBoundary;
  const next = createVideoSession(tabId, {
    pageUrl: incomingPageUrl,
    pageIdentity: incomingIdentity,
    videoId: context.videoId || pageExtractorInfo(incomingPageUrl)?.videoId || "",
    pageTitle: resetMetadata ? "" : (context.pageTitle || previous?.pageTitle || "video"),
    documentId: context.documentId || "",
    currentSrc: context.currentSrc || "",
    poster: context.poster || "",
    resetMetadata,
    reason: context.reason || "navigation"
  });
  tabState.set(tabId, next);
  return next;
}

function invalidateVideoSession(tabId, context = {}) {
  let state = tabState.get(tabId);
  if (!state) {
    state = createVideoSession(tabId, {
      pageUrl: context.pageUrl || "",
      pageIdentity: context.pageIdentity || pageVideoIdentity(context.pageUrl || ""),
      videoId: context.videoId || "",
      resetMetadata: true,
      reason: context.reason || "navigation-start"
    });
    tabState.set(tabId, state);
  }
  if (state.invalidated) return state;
  state.invalidated = true;
  state.invalidatedAt = Date.now();
  state.pendingPageUrl = context.pageUrl || "";
  state.navigationReason = context.reason || "navigation-start";
  state.fingerprint = stableFingerprint(`${state.sessionId}|invalidated|${state.invalidatedAt}`);
  broadcastSessionState("videoSessionInvalidated", state);
  return state;
}

function commitVideoNavigation(tabId, context = {}) {
  const previous = tabState.get(tabId);
  const incomingPageUrl = context.pageUrl || previous?.pendingPageUrl || previous?.pageUrl || "";
  const incomingIdentity = context.pageIdentity || pageVideoIdentity(incomingPageUrl);
  const identityChanged = Boolean(
    previous?.pageIdentity && incomingIdentity && previous.pageIdentity !== incomingIdentity
  );
  const mustRotate = Boolean(
    previous && (
      identityChanged
      || context.forceDocumentBoundary === true
    )
  );
  let state;
  if (!previous) {
    state = createVideoSession(tabId, {
      ...context,
      pageUrl: incomingPageUrl,
      pageIdentity: incomingIdentity
    });
    tabState.set(tabId, state);
  } else if (mustRotate) {
    state = rotateVideoSession(tabId, {
      ...context,
      pageUrl: incomingPageUrl,
      pageIdentity: incomingIdentity,
      forceSessionBoundary: true,
      resetMetadata: true
    });
  } else {
    state = ensureVideoSession(tabId, {
      ...context,
      pageUrl: incomingPageUrl,
      pageIdentity: incomingIdentity
    });
  }
  state.invalidated = false;
  state.invalidatedAt = 0;
  state.pendingPageUrl = "";
  state.navigationReason = context.reason || "navigation-finish";
  state.fingerprint = videoFingerprint(state.pageUrl, state.currentSrc);
  broadcastSessionState("videoSessionChanged", state);
  return state;
}

function broadcastSessionState(type, state) {
  chrome.runtime.sendMessage({
    type,
    tabId: state.tabId,
    sessionId: state.sessionId,
    pageUrl: state.pageUrl,
    pageIdentity: state.pageIdentity,
    videoId: state.videoId
  }, () => {
    void chrome.runtime.lastError;
  });
}

function updateVideoContext(tabId, context = {}) {
  const metadataMatchesPage = context.metadataMatchesPage !== false;
  const mainVideo = metadataMatchesPage ? (context.mainVideo || {}) : {};
  const nextCurrentSrc = mainVideo.currentSrc || context.currentSrc || "";
  const nextPoster = metadataMatchesPage ? safeImageUrl(context.poster || mainVideo.poster || "") : "";
  const pageUrl = context.pageUrl || "";
  const pageIdentity = context.pageIdentity || pageVideoIdentity(pageUrl);
  let state = ensureVideoSession(tabId, { ...context, pageIdentity, metadataMatchesPage });
  if (state.invalidated) return state;
  const currentSrcChanged = shouldRotateForCurrentSrc(state.currentSrc, nextCurrentSrc);
  if (currentSrcChanged) {
    state = rotateVideoSession(tabId, {
      ...context,
      pageIdentity,
      metadataMatchesPage,
      currentSrc: nextCurrentSrc || state.currentSrc,
      poster: nextPoster,
      reason: "current-src"
    });
  }
  const firstMainObservation = Boolean(nextCurrentSrc && !state.currentSrc);
  if (nextCurrentSrc) state.currentSrc = nextCurrentSrc;
  if (firstMainObservation) state.mainVideoObservedAt = Date.now();
  if (context.pageTitle && metadataMatchesPage) state.pageTitle = context.pageTitle;
  if (context.pageUrl) state.pageUrl = context.pageUrl;
  if (pageIdentity) state.pageIdentity = pageIdentity;
  if (context.videoId) state.videoId = context.videoId;
  if (nextPoster) {
    state.thumbnailUrl = nextPoster;
    state.mainPoster = nextPoster;
  }
  state.hasVideoElement = context.hasVideoElement ?? state.hasVideoElement;
  state.videoDuration = mainVideo.duration || state.videoDuration || 0;
  state.mainVideoHeight = mainVideo.height || state.mainVideoHeight || 0;
  state.mainVideoWidth = mainVideo.width || state.mainVideoWidth || 0;
  state.fingerprint = videoFingerprint(state.pageUrl, state.currentSrc);
  return state;
}

function captureNetworkStream(tabId, url, details = {}) {
  const state = ensureVideoSession(tabId, {
    pageUrl: details.frameId === 0 ? details.documentUrl : ""
  });
  if (state.invalidated) return;
  if (
    state.pageUrl
    && details.frameId === 0
    && details.documentUrl
    && !sameDocumentContext(state.pageUrl, details.documentUrl)
  ) {
    return;
  }
  upsertStream(tabId, url, details);
}

function rememberHeaders(tabId, url, headers) {
  const state = ensureTabState(tabId);
  if (state.invalidated) return;
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
    existing.documentUrl = details.documentUrl || existing.documentUrl || "";
    existing.initiator = details.initiator || existing.initiator || "";
    existing.documentId = details.documentId || existing.documentId || "";
    if (details.association === "main-current-src" || !existing.association) {
      existing.association = details.association || existing.association || "session-network";
    }
    if (details.source === "dom-main-video") {
      existing.source = details.source;
      existing.pageTitleAtCapture = state.pageTitle;
      existing.capturedPageUrl = state.pageUrl;
    }
    if (!existing.quality && metadata.quality) existing.quality = metadata.quality;
    if (!existing.duration && (details.duration || metadata.duration)) {
      existing.duration = details.duration || metadata.duration;
    }
    if (!existing.sizeBytes && metadata.sizeBytes) {
      existing.sizeBytes = metadata.sizeBytes;
      existing.sizeExact = metadata.sizeExact;
    }
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
      duration: details.duration || metadata.duration || 0,
      sizeBytes: metadata.sizeBytes || 0,
      sizeExact: metadata.sizeExact || false,
      label: makeLabel(metadata.kind, metadata.quality, 1),
      source: details.source || "network",
      firstSeen: now,
      lastSeen: now,
      sampleCount: 1,
      sessionId: state.sessionId,
      documentUrl: details.documentUrl || "",
      initiator: details.initiator || "",
      documentId: details.documentId || "",
      association: details.association || "session-network",
      pageTitleAtCapture: state.pageTitle,
      capturedPageUrl: state.pageUrl
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
  if (stream.kind === "dash_video") score += 5000;
  if (stream.kind === "dash_audio") score += 3000;
  if (stream.quality === 1080) score += 20000;
  else if (stream.quality) score += Math.max(0, 10000 - Math.abs(1080 - stream.quality));
  return score;
}

function isStreamUrl(url) {
  return STREAM_URL_PATTERN.test(stripHash(url)) || isYouTubePlaybackUrl(url);
}

function isYouTubePlaybackUrl(url) {
  const parsed = safeUrl(url);
  if (!parsed) return false;
  const host = parsed.hostname.toLowerCase();
  return (host === "googlevideo.com" || host.endsWith(".googlevideo.com"))
    && /\/videoplayback(?:$|\/)/i.test(parsed.pathname);
}

function youtubeDashKind(url) {
  const parsed = safeUrl(url);
  const mime = (parsed?.searchParams.get("mime") || parsed?.searchParams.get("type") || "").toLowerCase();
  if (mime.startsWith("video/")) return "dash_video";
  if (mime.startsWith("audio/")) return "dash_audio";
  const itag = Number(parsed?.searchParams.get("itag") || 0);
  const audioOnlyItags = new Set([139, 140, 141, 171, 172, 249, 250, 251, 256, 258, 325, 328]);
  return audioOnlyItags.has(itag) ? "dash_audio" : "dash_video";
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
  if (isYouTubePlaybackUrl(url)) {
    kind = youtubeDashKind(url);
  } else if (/\.m3u8(?:$|[?#])/i.test(url)) {
    kind = /(master|playlist|index)\.m3u8/i.test(pathname) ? "hls_master" : "hls_media";
  } else if (/\.mp4(?:$|[?#])/i.test(url)) {
    kind = "mp4";
  } else if (/\.(m4s|ts)(?:$|[?#])/i.test(url)) {
    kind = "segment";
  }

  const parsed = safeUrl(url);
  const duration = Number(parsed?.searchParams.get("dur") || 0);
  const sizeBytes = Number(parsed?.searchParams.get("clen") || 0);
  return {
    kind,
    quality: explicitQuality || parseQuality(url),
    duration: Number.isFinite(duration) ? duration : 0,
    sizeBytes: Number.isFinite(sizeBytes) ? sizeBytes : 0,
    sizeExact: Number.isFinite(sizeBytes) && sizeBytes > 0
  };
}

function makeLabel(kind, quality, sampleCount) {
  const qualityText = quality ? `${quality}p` : "quality unknown";
  if (kind === "hls_master") return `Playlist - ${qualityText}`;
  if (kind === "hls_media") return `HLS stream - ${qualityText}`;
  if (kind === "page") return "Current page URL - yt-dlp";
  if (kind === "mp4") return `Direct file - ${qualityText}`;
  if (kind === "dash_video") return `YouTube DASH video-only - ${qualityText}`;
  if (kind === "dash_audio") return "YouTube DASH audio-only";
  if (kind === "segment") return `Segment sample - ${qualityText} (${sampleCount} seen)`;
  return `Stream - ${qualityText}`;
}

function streamTypeTag(kind) {
  if (kind === "hls_master" || kind === "hls_media") return "HLS";
  if (kind === "mp4") return "MP4";
  if (kind === "page_extractor") return "YT";
  if (kind === "dash_video") return "DASH-V";
  if (kind === "dash_audio") return "DASH-A";
  if (kind === "page") return "PAGE";
  if (kind === "segment") return "SEG";
  return "VIDEO";
}

function parseQuality(url) {
  const parsed = safeUrl(url);
  const explicitHeight = Number(parsed?.searchParams.get("height") || 0);
  if (explicitHeight > 0) return explicitHeight;
  const qualityLabel = parsed?.searchParams.get("quality_label") || parsed?.searchParams.get("quality") || "";
  const qualityMatch = qualityLabel.match(/(2160|1440|1080|720|576|540|480|360|240)/);
  if (qualityMatch) return Number(qualityMatch[1]);
  const youtubeItag = Number(parsed?.searchParams.get("itag") || 0);
  const itagHeights = {
    18: 360, 22: 720, 37: 1080, 38: 3072,
    133: 240, 134: 360, 135: 480, 136: 720, 137: 1080, 138: 2160,
    160: 144, 212: 480, 242: 240, 243: 360, 244: 480, 247: 720,
    248: 1080, 264: 1440, 266: 2160, 271: 1440, 272: 2160,
    278: 144, 298: 720, 299: 1080, 302: 720, 303: 1080, 308: 1440,
    313: 2160, 315: 2160, 330: 144, 331: 240, 332: 360, 333: 480,
    334: 720, 335: 1080, 336: 1440, 337: 2160, 394: 144, 395: 240,
    396: 360, 397: 480, 398: 720, 399: 1080, 400: 1440, 401: 2160
  };
  if (itagHeights[youtubeItag]) return itagHeights[youtubeItag];
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

  if (isYouTubePlaybackUrl(url)) {
    const itag = parsed.searchParams.get("itag") || "unknown";
    const mediaId = parsed.searchParams.get("id") || parsed.searchParams.get("docid") || "current";
    return `dash:${mediaId}:${itag}:${youtubeDashKind(url)}`;
  }

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
