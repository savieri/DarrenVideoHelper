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
const TERMINAL_JOB_STATUSES = new Set(["completed", "failed", "cancelled"]);
const SESSION_ENRICH_RETRIES = 1;
const RECENT_MAIN_MEDIA_WINDOW_MS = 90 * 1000;
const DETECTION_STORAGE_PREFIX = "activeDetection:";
const MAX_PERSISTED_MEDIA = 12;
const MAX_PENDING_MEDIA = 40;
const PENDING_MEDIA_TTL_MS = 30 * 1000;
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
const detectionWrites = new Map();
let detectionInitialized = false;
const detectionReady = restoreDetectionState().catch(() => {}).then(() => {
  detectionInitialized = true;
});

function withDetectionState(callback) {
  if (detectionInitialized) return callback();
  return detectionReady.then(callback);
}

function detectionSnapshot(state) {
  const streams = sortedStreams(state)
    .filter((stream) => (isHlsKind(stream.kind) || stream.kind === "mp4")
      && !isHardExcludedUrl(stream.lastUrl || stream.url))
    .slice(0, MAX_PERSISTED_MEDIA)
    .map((stream) => ({ ...stream, headers: { ...stream.headers } }));
  return {
    version: 1,
    savedAt: Date.now(),
    sessionId: state.sessionId,
    pageUrl: state.pageUrl,
    pageIdentity: state.pageIdentity,
    documentId: state.documentId,
    pageTitle: state.pageTitle,
    currentSrc: state.currentSrc,
    createdAt: state.createdAt,
    thumbnailUrl: state.thumbnailUrl,
    hasVideoElement: state.hasVideoElement,
    videoDuration: state.videoDuration,
    mainVideoHeight: state.mainVideoHeight,
    mainVideoWidth: state.mainVideoWidth,
    mainVideoObservedAt: state.mainVideoObservedAt,
    resourceSince: state.resourceSince,
    previousMediaUrls: Array.from(state.previousMediaUrls),
    invalidated: state.invalidated,
    invalidatedAt: state.invalidatedAt,
    pendingPageUrl: state.pendingPageUrl,
    pendingDocumentBoundary: state.pendingDocumentBoundary,
    streams: state.invalidated ? [] : streams,
    // A restart mid-navigation must still exclude the previous video's timing entries.
    invalidatedMediaUrls: state.invalidated ? streams.map((stream) => stream.lastUrl || stream.url) : [],
    pendingMedia: Array.from(state.pendingStreams.values())
      .filter((candidate) => {
        const kind = inferStreamMetadata(candidate.url, 0, candidate.details.forcedKind).kind;
        return (isHlsKind(kind) || kind === "mp4") && Date.now() - candidate.bufferedAt <= PENDING_MEDIA_TTL_MS;
      }).slice(0, MAX_PERSISTED_MEDIA)
  };
}

function persistDetectionState(tabId) {
  if (!chrome.storage.session) return Promise.resolve();
  const state = tabState.get(tabId);
  const key = `${DETECTION_STORAGE_PREFIX}${tabId}`;
  const snapshot = state?.pageUrl ? detectionSnapshot(state) : null;
  // Serialize writes per tab so a late old-session write cannot undo a navigation.
  const write = (detectionWrites.get(tabId) || Promise.resolve()).then(() =>
    snapshot ? chrome.storage.session.set({ [key]: snapshot }) : chrome.storage.session.remove(key)
  ).catch(() => {});
  detectionWrites.set(tabId, write);
  void write.then(() => {
    if (detectionWrites.get(tabId) === write) detectionWrites.delete(tabId);
  });
  return write;
}

async function restoreDetectionState() {
  if (!chrome.storage.session) return;
  const [stored, openTabs] = await Promise.all([
    chrome.storage.session.get(null), chrome.tabs.query({})
  ]);
  const openIds = new Set(openTabs.map((tab) => tab.id));
  const staleKeys = Object.keys(stored).filter((key) => key.startsWith(DETECTION_STORAGE_PREFIX)
    && !openIds.has(Number(key.slice(DETECTION_STORAGE_PREFIX.length))));
  if (staleKeys.length) await chrome.storage.session.remove(staleKeys);
  for (const tab of openTabs) {
    if (tab.id == null || !/^https?:/i.test(tab.url || "") || tabState.has(tab.id)) continue;
    let documentId = "";
    try {
      documentId = (await chrome.webNavigation?.getFrame?.({ tabId: tab.id, frameId: 0 }))?.documentId || "";
    } catch {
      // Closed/restricted tabs are rechecked by popup and navigation events.
    }
    if (tabState.has(tab.id)) continue;
    const saved = stored[`${DETECTION_STORAGE_PREFIX}${tab.id}`];
    const identity = pageVideoIdentity(tab.url);
    const matches = saved?.version === 1 && saved.pageIdentity === identity
      && (!documentId || !saved.documentId || documentId === saved.documentId);
    const state = createVideoSession(tab.id, {
      pageUrl: tab.url, pageTitle: tab.title, documentId,
      resourceSince: saved?.invalidated ? saved.invalidatedAt : 0,
      previousMediaUrls: saved?.invalidated && documentId === saved.documentId
        ? [...(saved.previousMediaUrls || []), ...(saved.invalidatedMediaUrls || [])] : []
    });
    if (matches) {
      for (const field of ["sessionId", "pageTitle", "currentSrc", "createdAt", "thumbnailUrl",
        "hasVideoElement", "videoDuration", "mainVideoHeight", "mainVideoWidth", "mainVideoObservedAt",
        "resourceSince", "invalidated", "invalidatedAt", "pendingPageUrl", "pendingDocumentBoundary"]) {
        if (saved[field] !== undefined) state[field] = saved[field];
      }
      state.documentId = documentId || saved.documentId || "";
      state.previousMediaUrls = new Set([
        ...(saved.previousMediaUrls || []), ...(saved.invalidatedMediaUrls || [])
      ]);
      for (const stream of (saved.streams || []).slice(0, MAX_PERSISTED_MEDIA)) {
        const url = stream.lastUrl || stream.url;
        if ((!isHlsKind(stream.kind) && stream.kind !== "mp4") || !/^https?:/i.test(url) || isHardExcludedUrl(url)) continue;
        state.streams.set(streamKey(url), { ...stream, sessionId: state.sessionId, headers: { ...stream.headers } });
        state.headersByUrl.set(headerKey(url), { ...stream.headers });
      }
      state.fingerprint = videoFingerprint(state.pageUrl, state.currentSrc);
    }
    tabState.set(tab.id, state);
    for (const candidate of saved?.pendingMedia || []) {
      if (Date.now() - candidate.bufferedAt > PENDING_MEDIA_TTL_MS) continue;
      if (state.invalidated || (candidate.needsTiming
        && pendingCandidateBelongsToSession(candidate, state, saved, true))) state.pendingStreams.set(candidate.url, candidate);
      else if (pendingCandidateBelongsToSession(candidate, state, saved)) upsertStream(tab.id, candidate.url, candidate.details);
    }
    if (saved && !matches) await persistDetectionState(tab.id);
  }
}

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
  (details) => withDetectionState(() => {
    if (details.tabId < 0 || !isStreamUrl(details.url) || isHardExcludedUrl(details.url)) return;
    captureNetworkStream(details.tabId, details.url, {
      method: details.method,
      requestId: details.requestId,
      documentUrl: details.documentUrl || "",
      initiator: details.initiator || "",
      documentId: details.documentId || "",
      frameId: details.frameId,
      parentDocumentId: details.parentDocumentId || "",
      observedAt: details.timeStamp,
      source: "network"
    });
  }),
  { urls: ["<all_urls>"] }
);

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => withDetectionState(() => {
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
      parentDocumentId: details.parentDocumentId || "",
      observedAt: details.timeStamp,
      source: "network"
    });
  }),
  { urls: ["<all_urls>"] },
  ["requestHeaders", "extraHeaders"]
);

chrome.webRequest.onHeadersReceived.addListener(
  (details) => withDetectionState(() => {
    if (details.tabId < 0 || isHardExcludedUrl(details.url)) return;
    if (details.statusCode < 200 || details.statusCode >= 300) return;
    const contentType = details.responseHeaders?.find((header) =>
      String(header.name).toLowerCase() === "content-type")?.value || "";
    const forcedKind = mediaKindFromContentType(contentType);
    if (!forcedKind) return;
    captureNetworkStream(details.tabId, details.url, {
      forcedKind,
      method: details.method,
      requestId: details.requestId,
      documentUrl: details.documentUrl || "",
      initiator: details.initiator || "",
      documentId: details.documentId || "",
      parentDocumentId: details.parentDocumentId || "",
      frameId: details.frameId,
      observedAt: details.timeStamp,
      source: "network-mime"
    });
  }),
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

chrome.tabs.onRemoved.addListener((tabId) => withDetectionState(() => {
  tabState.delete(tabId);
  persistDetectionState(tabId);
}));

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => withDetectionState(() => {
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
}));

if (chrome.webNavigation) {
  const handleNavigation = (details, reason, forceDocumentBoundary = false) => withDetectionState(() => {
    if (details.frameId !== 0 || details.tabId < 0) return;
    commitVideoNavigation(details.tabId, {
      pageUrl: details.url,
      pageIdentity: pageVideoIdentity(details.url),
      documentId: details.documentId || "",
      reason,
      forceDocumentBoundary
    });
  });
  chrome.webNavigation.onBeforeNavigate.addListener((details) => withDetectionState(() => {
    if (details.frameId !== 0 || details.tabId < 0) return;
    invalidateVideoSession(details.tabId, {
      pageUrl: details.url,
      reason: "document-navigation-start",
      forceDocumentBoundary: true,
      observedAt: details.timeStamp
    });
  }));
  chrome.webNavigation.onErrorOccurred.addListener((details) => withDetectionState(() => {
    if (details.frameId !== 0 || details.tabId < 0) return;
    const state = tabState.get(details.tabId);
    if (!state?.invalidated || state.pendingPageUrl !== details.url) return;
    state.invalidated = false;
    state.invalidatedAt = 0;
    state.pendingDocumentBoundary = false;
    state.pendingPageUrl = "";
    state.pendingStreams.clear();
    state.fingerprint = videoFingerprint(state.pageUrl, state.currentSrc);
    persistDetectionState(details.tabId);
    broadcastSessionState("videoSessionChanged", state);
  }));
  chrome.webNavigation.onCommitted.addListener((details) => handleNavigation(details, "navigation", true));
  chrome.webNavigation.onHistoryStateUpdated.addListener((details) => handleNavigation(details, "history"));
  chrome.webNavigation.onReferenceFragmentUpdated.addListener((details) => handleNavigation(details, "fragment"));
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!detectionInitialized && ["videoContext", "videoNavigation", "siteMediaContext"].includes(message?.type)) {
    detectionReady.then(() => handleRuntimeMessage(message, sender, sendResponse));
    return true;
  }
  return handleRuntimeMessage(message, sender, sendResponse);
});

function handleRuntimeMessage(message, sender, sendResponse) {
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
    const senderIdentity = pageVideoIdentity(sender.tab.url || "");
    const contextIdentity = message.context?.pageIdentity || pageVideoIdentity(message.context?.pageUrl || "");
    if ((sender.documentId && tabState.get(sender.tab.id)?.documentId
      && sender.documentId !== tabState.get(sender.tab.id).documentId)
      || (senderIdentity && contextIdentity && senderIdentity !== contextIdentity)) {
      sendResponse({ ok: true });
      return false;
    }
    updateVideoContext(sender.tab.id, { ...message.context, documentId: sender.documentId || "" });
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "videoNavigation" && sender.tab?.id != null) {
    const navigation = { ...message.navigation, documentId: sender.documentId || "" };
    const knownDocument = tabState.get(sender.tab.id)?.documentId;
    if (knownDocument && sender.documentId && knownDocument !== sender.documentId) {
      sendResponse({ ok: true });
      return false;
    }
    if (navigation.phase === "start") {
      invalidateVideoSession(sender.tab.id, navigation);
    } else {
      const senderIdentity = pageVideoIdentity(sender.tab.url || "");
      const navigationIdentity = navigation.pageIdentity || pageVideoIdentity(navigation.pageUrl || "");
      if (!senderIdentity || !navigationIdentity || senderIdentity === navigationIdentity) {
        commitVideoNavigation(sender.tab.id, navigation);
      }
    }
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "siteMediaContext" && sender.tab?.id != null) {
    updateSiteMediaContext(sender.tab.id, message.media || {});
    sendResponse({ ok: true });
    return false;
  }

  return false;
}

async function getPopupState(tabId, retryCount = 0) {
  await detectionReady;
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
  await persistDetectionState(tab.id);
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

  const hasPageExtractor = Boolean(makePageExtractorCandidate(sessionSnapshot));
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

  if (pageExtractorInfo(tab.url)?.provider === "bilibili" && typeof chrome.tabs.sendMessage === "function") {
    try {
      const response = await chrome.tabs.sendMessage(tab.id, { type: "refreshSiteMedia" });
      if (response?.media) state = updateSiteMediaContext(tab.id, response.media);
    } catch {
      // The MAIN-world snapshot below remains available when the content bridge is still starting.
    }
  }

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      args: [state.resourceSince || 0, Array.from(state.pendingStreams.values())
        .filter((candidate) => pendingCandidateBelongsToSession(candidate, state, state, true))
        .map((candidate) => ({ url: candidate.url, forcedKind: candidate.details.forcedKind }))],
      func: (resourceSince, pendingMedia) => {
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
        // Resource timing keeps the original playlist even when MSE exposes only blob:.
        // Scan the current document's history, not just its most recent segments.
        const resources = (() => {
          try {
            const media = /\.(m3u8|mp4|m4s|ts)(?:$|[?#])/i;
            const knownMedia = new Map((pendingMedia || []).map((candidate) => [candidate.url, candidate.forcedKind]));
            const excluded = /(?:\.(?:jpe?g|png|webp|gif|avif)(?:$|[?#])|thumbnail|thumb|sprite|preview|avatar|profile|icon|logo|banner|advert|\/ads?\/|doubleclick|googlesyndication|analytics|tracking)/i;
            const priority = (url) => /\.m3u8(?:$|[?#])/i.test(url) || /^hls/.test(knownMedia.get(url) || "") ? 0
              : /\.mp4(?:$|[?#])/i.test(url) ? 1 : 2;
            return performance.getEntriesByType("resource")
              .map((entry) => ({
                url: absolute(entry.name),
                forcedKind: knownMedia.get(absolute(entry.name)),
                observedAt: performance.timeOrigin + entry.startTime
              }))
              .filter((entry) => /^https?:/i.test(entry.url) && (media.test(entry.url) || knownMedia.has(entry.url))
                && !excluded.test(entry.url) && entry.observedAt >= resourceSince)
              .sort((a, b) => priority(a.url) - priority(b.url) || b.observedAt - a.observedAt)
              .filter((entry, index, entries) => entries.findIndex((other) => other.url === entry.url) === index)
              .slice(0, 100);
          } catch {
            return [];
          }
        })();
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
        const siteMedia = (() => {
          try {
            const parsed = new URL(location.href);
            const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
            const match = parsed.pathname.match(/^\/video\/(BV[0-9A-Za-z]+|av\d+)/i);
            if ((host !== "bilibili.com" && !host.endsWith(".bilibili.com")) || !match) return null;
            const payload = window.__playinfo__;
            const body = payload?.data?.dash ? payload.data
              : payload?.result?.dash ? payload.result
                : payload?.dash ? payload
                  : null;
            if (!body?.dash) return null;
            const bilibiliQuality = (id, height) => ({
              6: 240, 16: 360, 32: 480, 64: 720, 74: 720,
              80: 1080, 112: 1080, 116: 1080, 120: 2160,
              125: 2160, 126: 1080, 127: 4320
            })[Number(id || 0)] || Number(height || 0);
            const normalizeItems = (items, kind) => (Array.isArray(items) ? items : [])
              .slice(0, 40)
              .map((item) => ({
                id: Number(item?.id || 0),
                height: kind === "video" ? Number(item?.height || 0) : 0,
                quality: kind === "video" ? bilibiliQuality(item?.id, item?.height) : 0,
                width: kind === "video" ? Number(item?.width || 0) : 0,
                bandwidth: Number(item?.bandwidth || 0),
                codecid: Number(item?.codecid || 0),
                codecs: String(item?.codecs || ""),
                mimeType: String(item?.mimeType || item?.mime_type || ""),
                baseUrl: absolute(item?.baseUrl || item?.base_url || ""),
                backupUrls: (item?.backupUrl || item?.backup_url || [])
                  .map(absolute)
                  .filter((url) => /^https?:/i.test(url))
                  .slice(0, 4)
              }))
              .filter((item) => /^https?:/i.test(item.baseUrl));
            const dashVideos = normalizeItems(body.dash.video, "video");
            const dashAudios = normalizeItems(body.dash.audio, "audio");
            if (!dashVideos.length || !dashAudios.length) return null;
            const initial = window.__INITIAL_STATE__ || {};
            const videoKey = match[1].toLowerCase();
            const initialBvid = String(initial.bvid || initial.videoData?.bvid || "").toLowerCase();
            const initialAid = Number(initial.aid || initial.videoData?.aid || 0);
            if (/^bv/i.test(videoKey) && initialBvid && videoKey !== initialBvid) return null;
            const pageAid = Number(videoKey.match(/^av(\d+)$/i)?.[1] || 0);
            if (pageAid && initialAid && pageAid !== initialAid) return null;
            const qualities = Array.from(new Set(dashVideos.map((item) => item.quality).filter(Boolean)))
              .sort((left, right) => right - left);
            return {
              provider: "bilibili",
              pageIdentity: `bilibili:${videoKey}:p${parsed.searchParams.get("p") || "1"}`,
              pageUrl: parsed.href,
              bvid: String(initial.bvid || initial.videoData?.bvid || (/^bv/i.test(videoKey) ? videoKey : "")),
              aid: Number(initial.aid || initial.videoData?.aid || videoKey.match(/^av(\d+)$/i)?.[1] || 0),
              cid: Number(body.cid || initial.cid || initial.videoData?.cid || 0),
              title: String(initial.videoData?.title || initial.title || document.title || ""),
              thumbnailUrl: absolute(initial.videoData?.pic || initial.pic || ""),
              duration: Number(body.dash.duration || body.timelength / 1000 || 0),
              quality: qualities[0] || 0,
              qualities,
              videos: dashVideos,
              audios: dashAudios,
              observedAt: Date.now(),
              reason: "popup-main-world"
            };
          } catch {
            return null;
          }
        })();
        return {
          title: metaTitle,
          pageUrl: location.href,
          poster: absolute(videos.find((item) => item.poster)?.poster || metaImage),
          metadataVideoId,
          siteMedia,
          resources,
          videos
        };
      }
    });

    const hints = results?.[0]?.result;
    if (!hints) return state;
    // Discard a scan that completed in a document/session we have already left.
    const current = tabState.get(tab.id);
    if (current !== state || current.invalidated || !samePageIdentity(hints.pageUrl, current.pageUrl)
      || (results[0].documentId && current.documentId && results[0].documentId !== current.documentId)) {
      return current || state;
    }

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
      documentId: results[0].documentId || state.documentId,
      videoId: extractor?.videoId || "",
      metadataVideoId: hints.metadataVideoId || "",
      metadataMatchesPage,
      pageTitle: metadataMatchesPage ? hints.title : "",
      poster: metadataMatchesPage ? hints.poster : "",
      hasVideoElement: Boolean(videos.length),
      mainVideo: metadataMatchesPage ? mainVideo : null,
      reason: "popup-hints"
    });
    if (hints.siteMedia) state = updateSiteMediaContext(tab.id, hints.siteMedia);

    for (const resource of hints.resources || []) {
      if (resource.observedAt < state.resourceSince || state.previousMediaUrls.has(resource.url)) continue;
      if ((!isStreamUrl(resource.url) && !resource.forcedKind) || isHardExcludedUrl(resource.url)) continue;
      upsertStream(tab.id, resource.url, {
        source: "performance-recovery",
        forcedKind: resource.forcedKind,
        association: "session-performance",
        documentUrl: hints.pageUrl,
        documentId: results[0].documentId || state.documentId,
        initiator: safeUrl(hints.pageUrl)?.origin || "",
        headers: state.headersByUrl.get(headerKey(resource.url)) || { referer: hints.pageUrl },
        observedAt: resource.observedAt
      });
      state.pendingStreams.delete(resource.url);
    }

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
  if (!/^https?:\/\//i.test(url)) return {};
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
  if (!/^\s*#EXTM3U\b/i.test(String(text || ""))) return {};
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
  await detectionReady;
  const settings = await loadSettings();
  let state = tabState.get(tabId);
  if (!state) return staleSelectionResponse();
  if (pageExtractorInfo(state.pageUrl)?.provider === "bilibili") {
    state = await refreshSiteMediaForDownload(tabId, state);
  }
  const resolved = validateDownloadSelection(state, selection || {});
  if (!resolved.ok) return resolved;

  const payload = buildDownloadPayload(state, resolved.stream, settings, {
    qualityPreference: selection?.qualityPreference || ""
  });
  return enqueueDownload(payload, settings, options);
}

async function refreshSiteMediaForDownload(tabId, state) {
  if (typeof chrome.tabs.sendMessage !== "function") return state;
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: "refreshSiteMedia" });
    if (response?.media) return updateSiteMediaContext(tabId, response.media);
  } catch {
    // Use the most recent validated playinfo snapshot when the content bridge is unavailable.
  }
  return tabState.get(tabId) || state;
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
  const useBilibiliDash = stream.kind === "bilibili_dash";
  const selectedBilibiliVideo = useBilibiliDash
    ? selectBilibiliVideo(stream.videoRepresentations, options.qualityPreference || settings.defaultQuality)
    : null;
  const selectedBilibiliAudio = useBilibiliDash
    ? selectBilibiliAudio(stream.audioRepresentations)
    : null;
  const targetUrl = usePageExtractor ? pageUrl
    : useBilibiliDash ? (selectedBilibiliVideo?.baseUrl || streamUrl)
      : streamUrl;
  const kind = usePageExtractor ? "page" : stream.kind;
  const headers = {
    ...(stream.headers || state.headersByUrl.get(headerKey(targetUrl)) || {})
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
    preferPageUrl: usePageExtractor || stream.kind === "page" || useBilibiliDash,
    allowPageFallback: useBilibiliDash,
    directMedia: useBilibiliDash ? {
      provider: "bilibili",
      videoUrl: selectedBilibiliVideo?.baseUrl || "",
      videoBackupUrls: selectedBilibiliVideo?.backupUrls || [],
      audioUrl: selectedBilibiliAudio?.baseUrl || "",
      audioBackupUrls: selectedBilibiliAudio?.backupUrls || [],
      videoHeight: Number(selectedBilibiliVideo?.height || 0),
      videoQuality: Number(selectedBilibiliVideo?.quality || selectedBilibiliVideo?.height || 0),
      videoCodecId: Number(selectedBilibiliVideo?.codecid || 0),
      audioCodecId: Number(selectedBilibiliAudio?.codecid || 0),
      bvid: stream.bvid || "",
      aid: Number(stream.aid || 0),
      cid: Number(stream.cid || 0),
      observedAt: Number(state.siteMedia?.observedAt || 0)
    } : undefined,
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

    const current = jobs.get(job.id);
    if (!current || TERMINAL_JOB_STATUSES.has(current.status)) return;

    if (message.type === "progress") {
      const currentStatus = current.status;
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
      updateJob(job.id, {
        status: "completed",
        message: message.message || "下载完成，已输出 MP4。",
        outputPath: message.outputPath || "",
        fileSize: message.fileSize || 0,
        duration: message.duration || 0,
        width: message.width || 0,
        height: message.height || 0,
        videoStreams: message.videoStreams || 0,
        audioStreams: message.audioStreams || 0,
        hasAudio: message.hasAudio === true,
        videoCodec: message.videoCodec || "",
        audioCodec: message.audioCodec || "",
        error: "",
        details: "",
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
  if (!job) return false;
  if (TERMINAL_JOB_STATUSES.has(job.status)) return false;
  Object.assign(job, patch, { updatedAt: Date.now() });
  jobs.set(jobId, job);
  broadcastJob(job);
  return true;
}

function appendJobLog(jobId, line) {
  const job = jobs.get(jobId);
  if (!job || !line || TERMINAL_JOB_STATUSES.has(job.status)) return;
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
    siteMedia: state.siteMedia ? Object.freeze({
      ...state.siteMedia,
      qualities: Object.freeze([...(state.siteMedia.qualities || [])]),
      videos: Object.freeze((state.siteMedia.videos || []).map((item) => Object.freeze({
        ...item,
        backupUrls: Object.freeze([...(item.backupUrls || [])])
      }))),
      audios: Object.freeze((state.siteMedia.audios || []).map((item) => Object.freeze({
        ...item,
        backupUrls: Object.freeze([...(item.backupUrls || [])])
      })))
    }) : null,
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
  let provider = "";
  if (host === "youtu.be") {
    videoId = parsed.pathname.split("/").filter(Boolean)[0] || "";
    provider = "youtube";
  } else if (host === "youtube.com" || host.endsWith(".youtube.com")) {
    if (parsed.pathname === "/watch") videoId = parsed.searchParams.get("v") || "";
    else {
      const match = parsed.pathname.match(/^\/(?:shorts|live|embed)\/([^/?#]+)/i);
      videoId = match?.[1] || "";
    }
    provider = "youtube";
  } else if (host === "bilibili.com" || host.endsWith(".bilibili.com")) {
    const match = parsed.pathname.match(/^\/video\/(BV[0-9A-Za-z]+|av\d+)/i);
    videoId = match?.[1] || "";
    provider = "bilibili";
  }
  if (!videoId) return null;
  if (provider === "bilibili") {
    const page = parsed.searchParams.get("p") || "1";
    const canonicalUrl = new URL(`https://www.bilibili.com/video/${encodeURIComponent(videoId)}/`);
    if (page !== "1") canonicalUrl.searchParams.set("p", page);
    return {
      provider,
      videoId,
      page,
      canonicalUrl: canonicalUrl.href,
      typeTag: "BILI",
      label: "Bilibili DASH 音视频合并"
    };
  }
  return {
    provider,
    videoId,
    canonicalUrl: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
    typeTag: "YT",
    label: "YouTube 页面解析（DASH 音视频合并）"
  };
}

function pageVideoIdentity(url) {
  const extractor = pageExtractorInfo(url);
  if (extractor?.provider === "bilibili") {
    return `bilibili:${extractor.videoId.toLowerCase()}:p${extractor.page || "1"}`;
  }
  if (extractor) return `${extractor.provider}:${extractor.videoId}`;
  return normalizePageUrl(url);
}

function selectBilibiliVideo(representations, qualityPreference = "best") {
  const videos = (representations || []).filter((item) => item?.baseUrl && Number(item.height || 0) > 0);
  if (!videos.length) return null;
  const requested = Number(String(qualityPreference || "best").match(/(\d{3,4})/)?.[1] || 0);
  const eligible = requested ? videos.filter((item) => Number(item.quality || item.height || 0) <= requested) : videos;
  const pool = eligible.length ? eligible : videos;
  return [...pool].sort((left, right) => {
    const qualityDiff = Number(right.quality || right.height || 0) - Number(left.quality || left.height || 0);
    if (qualityDiff) return qualityDiff;
    const avcDiff = Number(Number(right.codecid || 0) === 7) - Number(Number(left.codecid || 0) === 7);
    if (avcDiff) return avcDiff;
    return Number(right.bandwidth || 0) - Number(left.bandwidth || 0);
  })[0] || null;
}

function selectBilibiliAudio(representations) {
  return [...(representations || [])]
    .filter((item) => item?.baseUrl)
    .sort((left, right) => Number(right.bandwidth || 0) - Number(left.bandwidth || 0))[0] || null;
}

function mediaHeaders(state, media) {
  const urls = [
    ...(media?.videos || []).flatMap((item) => [item.baseUrl, ...(item.backupUrls || [])]),
    ...(media?.audios || []).flatMap((item) => [item.baseUrl, ...(item.backupUrls || [])])
  ].filter(Boolean);
  for (const url of urls) {
    const headers = state?.headersByUrl?.get?.(headerKey(url));
    if (headers && Object.keys(headers).length) return { ...headers, referer: headers.referer || state.pageUrl };
  }
  return { referer: state?.pageUrl || media?.pageUrl || "" };
}

function makePageExtractorCandidate(state) {
  const info = pageExtractorInfo(state.pageUrl);
  if (!info) return null;
  const bilibiliMedia = info.provider === "bilibili" ? state.siteMedia : null;
  if (info.provider === "bilibili" && (
    bilibiliMedia?.pageIdentity !== state.pageIdentity
    || !bilibiliMedia?.videos?.length
    || !bilibiliMedia?.audios?.length
  )) return null;
  const now = Date.now();
  const id = `${PAGE_EXTRACTOR_ID_PREFIX}${info.provider}:${info.videoId}${info.provider === "bilibili" ? `:p${info.page || "1"}` : ""}`;
  const bestBilibiliVideo = selectBilibiliVideo(bilibiliMedia?.videos, "best");
  const bestBilibiliAudio = selectBilibiliAudio(bilibiliMedia?.audios);
  const quality = info.provider === "bilibili"
    ? Number(bestBilibiliVideo?.quality || bestBilibiliVideo?.height || bilibiliMedia?.quality || 0)
    : state.mainVideoHeight || 0;
  const duration = info.provider === "bilibili"
    ? Number(bilibiliMedia?.duration || state.videoDuration || 0)
    : state.videoDuration || 0;
  const stream = {
    id,
    resourceId: id,
    resourceUrl: info.canonicalUrl,
    sessionId: state.sessionId,
    url: info.canonicalUrl,
    lastUrl: info.canonicalUrl,
    pageUrl: state.pageUrl,
    kind: info.provider === "bilibili" ? "bilibili_dash" : "page_extractor",
    provider: info.provider,
    typeTag: info.typeTag,
    label: info.label,
    quality,
    qualityLabel: quality ? `${quality}p` : "Best",
    host: getHost(state.pageUrl),
    sourceTitle: state.pageTitle || (info.provider === "bilibili" ? "Bilibili video" : "YouTube video"),
    thumbnailUrl: safeImageUrl(state.thumbnailUrl || bilibiliMedia?.thumbnailUrl),
    duration,
    durationLabel: formatDuration(duration),
    sizeBytes: estimateSizeBytes(quality || 1080, duration, "page_extractor"),
    sizeLabel: formatBytes(
      estimateSizeBytes(quality || 1080, duration, "page_extractor"),
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
    headers: info.provider === "bilibili" ? mediaHeaders(state, bilibiliMedia) : {},
    bvid: bilibiliMedia?.bvid || "",
    aid: Number(bilibiliMedia?.aid || 0),
    cid: Number(bilibiliMedia?.cid || 0),
    availableQualities: bilibiliMedia?.qualities || [],
    videoRepresentations: bilibiliMedia?.videos || [],
    audioRepresentations: bilibiliMedia?.audios || [],
    selectedVideo: bestBilibiliVideo,
    selectedAudio: bestBilibiliAudio
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

  if (extractor?.provider === "youtube" || extractor?.provider === "bilibili") {
    return {
      previewUrl: "",
      previewSourceKind: "page_player",
      previewStrategy: "page_player"
    };
  } else if (primary.kind === "hls_master") {
    return {
      previewUrl: "",
      previewSourceKind: "page_player",
      previewStrategy: "page_player"
    };
  } else if (primary.kind === "hls_media" && primary.parentMasterId) {
    return {
      previewUrl: "",
      previewSourceKind: "page_player",
      previewStrategy: "page_player"
    };
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
  if (!selected) return { previewUrl: "", previewSourceKind: "", previewStrategy: "poster" };
  return {
    previewUrl: previewUrlForStream(selected),
    previewSourceKind: selected.kind,
    previewStrategy: selected.kind === "mp4" ? "popup_video" : "page_player"
  };
}

function outputPipelineLabel(primary, extractor) {
  if (extractor?.provider === "youtube" || extractor?.provider === "bilibili") return "DASH → MP4";
  if (isHlsKind(primary.kind)) return "HLS → MP4";
  if (primary.kind === "mp4") return "Direct MP4";
  return "Video → MP4";
}

function aggregateLogicalVideos(state, rankedStreams, settings = {}) {
  const primary = rankedStreams.find((stream) => stream.canDownloadWholeVideo && stream.isRecommendable);
  if (!primary) return [];

  const qualityValues = Array.from(new Set(
    rankedStreams
      .flatMap((stream) => [Number(stream.quality || 0), ...(stream.availableQualities || []).map(Number)])
      .filter((quality) => quality > 0)
  )).sort((left, right) => right - left);
  const qualityOptions = [{ value: "best", label: "最佳可用" }];
  for (const quality of qualityValues) {
    qualityOptions.push({ value: `${quality}p`, label: `${quality}p` });
  }
  const extractor = pageExtractorInfo(state.pageUrl);
  const savedDefaultQuality = settings.defaultQuality || "best";
  const defaultQuality = extractor?.provider === "bilibili"
    && !qualityOptions.some((option) => option.value === savedDefaultQuality)
    ? "best"
    : savedDefaultQuality;
  if (extractor?.provider !== "bilibili" && !qualityOptions.some((option) => option.value === defaultQuality)) {
    qualityOptions.push({ value: defaultQuality, label: defaultQuality });
  }

  const providerLabel = extractor?.provider === "youtube"
    ? "YouTube"
    : extractor?.provider === "bilibili"
      ? "Bilibili"
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
    qualityLabel: primary.quality
      ? `${primary.quality}p`
      : (primary.qualityLabel || (state.mainVideoHeight ? `${state.mainVideoHeight}p` : "最佳")),
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
  if (stream.kind === "bilibili_dash") score += 180000;
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
    siteMedia: null,
    siteMediaSignature: "",
    invalidated: false,
    invalidatedAt: 0,
    pendingPageUrl: "",
    pendingDocumentBoundary: false,
    pendingStreams: new Map(),
    resourceSince: Number(context.resourceSince || 0),
    previousMediaUrls: new Set(context.previousMediaUrls || []),
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
  if (state.invalidated) return state;

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
    documentId: context.documentId || (forceDocumentBoundary ? "" : previous?.documentId) || "",
    currentSrc: context.currentSrc || "",
    poster: context.poster || "",
    resetMetadata,
    resourceSince: forceDocumentBoundary ? 0
      : previous?.invalidatedAt || context.observedAt || Date.now(),
    previousMediaUrls: forceDocumentBoundary ? [] : [
      ...(previous?.previousMediaUrls || []),
      ...Array.from(previous?.streams?.values() || [])
        .filter((stream) => stream.kind !== "segment"
          && stream.firstSeen < (previous?.invalidatedAt || context.observedAt || Date.now()))
        .map((stream) => stream.lastUrl || stream.url)
    ].slice(-MAX_STREAMS_PER_TAB),
    reason: context.reason || "navigation"
  });
  tabState.set(tabId, next);
  persistDetectionState(tabId);
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
  if (state.invalidated) {
    if (context.forceDocumentBoundary === true) {
      state.pendingDocumentBoundary = true;
      state.pendingPageUrl = context.pageUrl || state.pendingPageUrl;
      persistDetectionState(tabId);
    }
    return state;
  }
  state.invalidated = true;
  state.invalidatedAt = context.observedAt || Date.now();
  state.pendingPageUrl = context.pageUrl || "";
  state.pendingDocumentBoundary = context.forceDocumentBoundary === true;
  state.navigationReason = context.reason || "navigation-start";
  state.fingerprint = stableFingerprint(`${state.sessionId}|invalidated|${state.invalidatedAt}`);
  broadcastSessionState("videoSessionInvalidated", state);
  persistDetectionState(tabId);
  return state;
}

function commitVideoNavigation(tabId, context = {}) {
  const previous = tabState.get(tabId);
  // tabs.onUpdated/content-ready can precede the authoritative document commit.
  if (previous?.invalidated && previous.pendingDocumentBoundary && !context.forceDocumentBoundary) return previous;
  const pending = Array.from(previous?.pendingStreams?.values() || []);
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
  state.pendingDocumentBoundary = false;
  state.pendingStreams.clear();
  state.navigationReason = context.reason || "navigation-finish";
  state.fingerprint = videoFingerprint(state.pageUrl, state.currentSrc);
  for (const candidate of pending) {
    if (pendingCandidateBelongsToSession(candidate, state, previous)) {
      upsertStream(tabId, candidate.url, candidate.details);
    } else if (pendingCandidateBelongsToSession(candidate, state, previous, true)) {
      // Same-origin SPA MIME candidates need timing evidence from the new page epoch.
      state.pendingStreams.set(candidate.url, { ...candidate, needsTiming: true });
    }
  }
  persistDetectionState(tabId);
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
  persistDetectionState(tabId);
  return state;
}

function sanitizeDashRepresentation(item, kind) {
  const base = safeUrl(item?.baseUrl || "");
  if (!base || !/^https?:$/.test(base.protocol)) return null;
  const backupUrls = (item?.backupUrls || [])
    .map((url) => safeUrl(url))
    .filter((url) => url && /^https?:$/.test(url.protocol))
    .map((url) => url.href)
    .slice(0, 4);
  return {
    id: Number(item?.id || 0),
    height: kind === "video" ? Number(item?.height || 0) : 0,
    quality: kind === "video" ? Number(item?.quality || item?.height || 0) : 0,
    width: kind === "video" ? Number(item?.width || 0) : 0,
    bandwidth: Number(item?.bandwidth || 0),
    codecid: Number(item?.codecid || 0),
    codecs: String(item?.codecs || "").slice(0, 80),
    mimeType: String(item?.mimeType || "").slice(0, 80),
    baseUrl: base.href,
    backupUrls
  };
}

function sanitizeSiteMedia(media) {
  if (media?.provider !== "bilibili" || !String(media.pageIdentity || "").startsWith("bilibili:")) return null;
  const videos = (media.videos || [])
    .slice(0, 40)
    .map((item) => sanitizeDashRepresentation(item, "video"))
    .filter((item) => item && item.height > 0 && item.quality > 0);
  const audios = (media.audios || [])
    .slice(0, 12)
    .map((item) => sanitizeDashRepresentation(item, "audio"))
    .filter(Boolean);
  if (!videos.length || !audios.length) return null;
  const qualities = Array.from(new Set(videos.map((item) => item.quality))).sort((left, right) => right - left);
  return {
    provider: "bilibili",
    pageIdentity: String(media.pageIdentity),
    pageUrl: String(media.pageUrl || ""),
    bvid: String(media.bvid || "").slice(0, 32),
    aid: Number(media.aid || 0),
    cid: Number(media.cid || 0),
    title: String(media.title || "").slice(0, 500),
    thumbnailUrl: safeImageUrl(media.thumbnailUrl || ""),
    duration: Math.max(0, Number(media.duration || 0)),
    quality: qualities[0] || 0,
    qualities,
    videos,
    audios,
    observedAt: Number(media.observedAt || Date.now()),
    reason: String(media.reason || "page-playinfo").slice(0, 80)
  };
}

function updateSiteMediaContext(tabId, rawMedia = {}) {
  const media = sanitizeSiteMedia(rawMedia);
  let state = tabState.get(tabId);
  if (!media) return state || ensureTabState(tabId);
  if (!state) {
    state = ensureVideoSession(tabId, {
      pageUrl: media.pageUrl,
      pageIdentity: media.pageIdentity,
      reason: "site-media"
    });
  }
  if (state.invalidated || media.pageIdentity !== state.pageIdentity) return state;

  const signature = [
    media.pageIdentity,
    media.cid,
    media.quality,
    media.videos[0]?.baseUrl,
    media.audios[0]?.baseUrl
  ].join("|");
  const changed = signature !== state.siteMediaSignature;
  state.siteMedia = media;
  state.siteMediaSignature = signature;
  if (media.title) state.pageTitle = media.title;
  if (media.thumbnailUrl) {
    state.thumbnailUrl = media.thumbnailUrl;
    state.mainPoster = media.thumbnailUrl;
  }
  if (media.duration) state.videoDuration = media.duration;
  if (media.quality) state.mainVideoHeight = media.quality;
  state.fingerprint = videoFingerprint(state.pageUrl, state.currentSrc);
  if (changed) broadcastSessionState("videoSessionChanged", state);
  return state;
}

function captureNetworkStream(tabId, url, details = {}) {
  if (isHardExcludedUrl(url) || (!isStreamUrl(url) && !details.forcedKind)) return;
  const state = tabState.get(tabId) || ensureVideoSession(tabId, {
    pageUrl: details.frameId === 0 ? details.documentUrl : ""
  });
  const remembered = state.headersByUrl.get(headerKey(url));
  const pendingHeaders = state.pendingStreams.get(url)?.details.headers;
  details = { ...details, headers: details.headers || pendingHeaders || remembered };
  if (state.invalidated) {
    bufferPendingStream(state, url, details);
    return;
  }
  if (details.frameId === 0 && state.documentId && details.documentId
    && state.documentId !== details.documentId) return;
  if (state.previousMediaUrls.has(url)) return;
  const requestPage = details.documentUrl || fullMediaReferer(details.headers);
  if (
    state.pageUrl
    && details.frameId === 0
    && requestPage
    && !sameDocumentContext(state.pageUrl, requestPage)
  ) {
    bufferPendingStream(state, url, details);
    return;
  }
  const previousKind = state.streams.get(streamKey(url))?.kind;
  upsertStream(tabId, url, details);
  const kind = state.streams.get(streamKey(url))?.kind;
  if ((isHlsKind(kind) || kind === "mp4") && kind !== previousKind) {
    broadcastSessionState("videoSessionChanged", state);
  }
}

function fullMediaReferer(headers) {
  const referer = safeUrl(headers?.referer);
  return referer && (referer.pathname !== "/" || referer.search) ? referer.href : "";
}

function rememberHeaders(tabId, url, headers) {
  const state = ensureTabState(tabId);
  state.headersByUrl.set(headerKey(url), headers);
  while (state.headersByUrl.size > MAX_HEADERS_PER_TAB) {
    const firstKey = state.headersByUrl.keys().next().value;
    state.headersByUrl.delete(firstKey);
  }
}

function bufferPendingStream(state, url, details) {
  const now = Date.now();
  for (const [key, candidate] of state.pendingStreams) {
    if (now - candidate.bufferedAt > PENDING_MEDIA_TTL_MS) state.pendingStreams.delete(key);
  }
  const existing = state.pendingStreams.get(url);
  state.pendingStreams.set(url, {
    url,
    bufferedAt: now,
    details: { ...existing?.details, ...details, forcedKind: details.forcedKind || existing?.details.forcedKind }
  });
  while (state.pendingStreams.size > MAX_PENDING_MEDIA) {
    const candidates = Array.from(state.pendingStreams.values());
    const disposable = candidates.find((candidate) => inferStreamMetadata(candidate.url, 0, candidate.details.forcedKind).kind === "segment") || candidates[0];
    state.pendingStreams.delete(disposable.url);
  }
  const kind = inferStreamMetadata(url, 0, details.forcedKind).kind;
  if (isHlsKind(kind) || kind === "mp4") persistDetectionState(state.tabId);
}

function pendingCandidateBelongsToSession(candidate, state, previous, timingRecovery = false) {
  if (Date.now() - candidate.bufferedAt > PENDING_MEDIA_TTL_MS) return false;
  const details = candidate.details;
  const isMainFrame = details.frameId === 0;
  if (isMainFrame && state.documentId && details.documentId && state.documentId !== details.documentId) return false;
  if (!isMainFrame && state.documentId && details.parentDocumentId && state.documentId !== details.parentDocumentId) return false;
  if (details.documentUrl && !sameDocumentContext(state.pageUrl, details.documentUrl)) return false;
  const fullReferer = fullMediaReferer(details.headers);
  if (fullReferer && !sameDocumentContext(state.pageUrl, fullReferer)) return false;
  if (state.previousMediaUrls.has(candidate.url)) return false;
  const newDocument = state.documentId && state.documentId !== previous?.documentId;
  if (newDocument && ((isMainFrame && details.documentId === state.documentId)
    || (!isMainFrame && details.parentDocumentId === state.documentId))) return true;
  if (details.documentUrl || fullReferer) return true;
  // An origin alone cannot distinguish A and B within the same SPA document.
  // Ambiguous candidates are recovered from post-boundary resource timing instead.
  if (!timingRecovery && previous?.pageIdentity !== state.pageIdentity && sameOriginContext(previous?.pageUrl, state.pageUrl)) return false;
  return sameOriginContext(details.initiator, state.pageUrl);
}

function upsertStream(tabId, url, details = {}) {
  const state = ensureTabState(tabId);
  if (state.invalidated || isHardExcludedUrl(url)) return;
  const id = streamKey(url);
  const now = Number(details.observedAt || Date.now());
  const metadata = inferStreamMetadata(url, details.quality, details.forcedKind);
  const existing = state.streams.get(id);
  const headers = details.headers || state.headersByUrl.get(headerKey(url)) || existing?.headers || {};

  if (existing) {
    existing.lastUrl = url;
    existing.headers = headers;
    existing.lastSeen = Math.max(existing.lastSeen, now);
    if (details.forcedKind && !isYouTubePlaybackUrl(url) && existing.kind !== "segment") existing.kind = metadata.kind;
    existing.sampleCount = (existing.sampleCount || 1) + 1;
    existing.documentUrl = details.documentUrl || existing.documentUrl || "";
    existing.initiator = details.initiator || existing.initiator || "";
    existing.documentId = details.documentId || existing.documentId || "";
    existing.frameId = details.frameId ?? existing.frameId;
    existing.parentDocumentId = details.parentDocumentId || existing.parentDocumentId || "";
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
      frameId: details.frameId,
      parentDocumentId: details.parentDocumentId || "",
      association: details.association || "session-network",
      pageTitleAtCapture: state.pageTitle,
      capturedPageUrl: state.pageUrl
    });
  }

  while (state.streams.size > MAX_STREAMS_PER_TAB) {
    const oldest = Array.from(state.streams.values()).sort((a, b) =>
      Number(a.kind !== "segment") - Number(b.kind !== "segment") || a.lastSeen - b.lastSeen)[0];
    if (!oldest) break;
    state.streams.delete(oldest.id);
  }
  if (isHlsKind(metadata.kind) || metadata.kind === "mp4") persistDetectionState(tabId);
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

function mediaKindFromContentType(contentType) {
  const mime = String(contentType || "").split(";", 1)[0].trim().toLowerCase();
  if (["application/vnd.apple.mpegurl", "application/x-mpegurl", "application/mpegurl", "audio/mpegurl", "audio/x-mpegurl"].includes(mime)) return "hls";
  if (mime === "video/mp4") return "mp4";
  return "";
}

function inferStreamMetadata(url, explicitQuality, forcedKind) {
  const pathname = safeUrl(url)?.pathname.toLowerCase() || url.toLowerCase();
  let kind = "unknown";
  if (isYouTubePlaybackUrl(url)) {
    kind = youtubeDashKind(url);
  } else if (/\.(m4s|ts)(?:$|[?#])/i.test(url)
    || /\/(?:init|initialization)(?:[-_.][a-z0-9_-]+)?\.mp4$/i.test(pathname)) {
    kind = "segment";
  } else if (["hls", "hls_master", "hls_media", "mp4"].includes(forcedKind)) {
    kind = forcedKind === "hls" ? "hls_media" : forcedKind;
  } else if (/\.m3u8(?:$|[?#])/i.test(url)) {
    kind = /(master|playlist|index)\.m3u8/i.test(pathname) ? "hls_master" : "hls_media";
  } else if (/\.mp4(?:$|[?#])/i.test(url)) {
    kind = "mp4";
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
  if (kind === "bilibili_dash") return "BILI";
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
