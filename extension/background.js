const HOST_NAME = "com.darren.videohelper";
const PAGE_EXTRACTOR_ID_PREFIX = "__page_extractor__:";
const HLS_PATH_PATTERN = /\/index-[^/?#]+|\/(?:master|manifest|playlist)(?:[/?#]|$)/i;
const STREAM_URL_PATTERN = /\.(m3u8|mp4|webm|m4s|ts)(?:$|[?#])/i;
const IMAGE_URL_PATTERN = /\.(jpe?g|png|webp|gif|avif)(?:$|[?#])/i;
const BAD_CANDIDATE_PATTERN = /(?:thumbnail|thumb|sprite|preview|avatar|profile|icon|logo|banner|advert|\/ads?\/|doubleclick|googlesyndication|analytics|tracking)/i;
const MAX_STREAMS_PER_TAB = 100;
const MAX_WHOLE_RESOURCES_PER_TAB = 300;
const MAX_HEADERS_PER_TAB = 140;
const MAX_LOG_LINES = 140;
const NATIVE_START_TIMEOUT_MS = 20 * 1000;
const NATIVE_HOST_LOG_PATH = "~/Library/Logs/DarrenVideoHelper/native-host.log";
const ACTIVE_JOB_STATUSES = new Set(["queued", "downloading", "merging"]);
const TERMINAL_JOB_STATUSES = new Set(["completed", "failed", "cancelled", "incomplete"]);
const SESSION_ENRICH_RETRIES = 1;
const RECENT_MAIN_MEDIA_WINDOW_MS = 90 * 1000;
const DETECTION_STORAGE_PREFIX = "activeDetection:";
const MAX_PERSISTED_MEDIA = MAX_WHOLE_RESOURCES_PER_TAB;
const MAX_PLAYLIST_PROBES = 48;
const MAX_PLAYLIST_BYTES = 4 * 1024 * 1024;
const MAX_PLAYLIST_RECORDS = 180;
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
  const streams = Array.from(state.streams.values()).sort((a, b) => retentionScore(b) - retentionScore(a) || b.lastSeen - a.lastSeen)
    .filter((stream) => (isHlsKind(stream.kind) || isDirectVideoKind(stream.kind))
      && !isHardExcludedUrl(stream.lastUrl || stream.url))
    .slice(0, MAX_PERSISTED_MEDIA)
    .map((stream) => ({ ...stream, headers: { ...stream.headers } }));
  return {
    version: 2,
    savedAt: Date.now(),
    sessionId: state.sessionId,
    pageUrl: state.pageUrl,
    pageIdentity: state.pageIdentity,
    documentId: state.documentId,
    pageTitle: state.pageTitle,
    currentSrc: state.currentSrc,
    mainPlaylistUrl: state.mainPlaylistUrl,
    mainFrameId: state.mainFrameId,
    createdAt: state.createdAt,
    thumbnailUrl: state.thumbnailUrl,
    hasVideoElement: state.hasVideoElement,
    videoDuration: state.videoDuration,
    mainVideoHeight: state.mainVideoHeight,
    mainVideoWidth: state.mainVideoWidth,
    mainVideoObservedAt: state.mainVideoObservedAt,
    resourceSince: state.resourceSince,
    previousMediaUrls: Array.from(state.previousMediaUrls),
    recentMedia: (state.recentMedia || []).slice(-80),
    activeMediaId: state.activeMediaId || "",
    activeMediaChangedAt: state.activeMediaChangedAt || 0,
    mediaCandidates: Array.from(state.mediaCandidates?.values?.() || [])
      .filter(candidate => Date.now() - candidate.lastSeenAt < 10 * 60 * 1000)
      .slice(-40),
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
        return (isHlsKind(kind) || isDirectVideoKind(kind)) && Date.now() - candidate.bufferedAt <= PENDING_MEDIA_TTL_MS;
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
    const matches = saved?.version === 2 && saved.pageIdentity === identity
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
        "resourceSince", "mainPlaylistUrl", "mainFrameId", "activeMediaId", "activeMediaChangedAt",
        "invalidated", "invalidatedAt", "pendingPageUrl", "pendingDocumentBoundary"]) {
        if (saved[field] !== undefined) state[field] = saved[field];
      }
      for (const candidate of saved.mediaCandidates || []) {
        if (candidate?.mediaId && Date.now() - Number(candidate.lastSeenAt || 0) < 10 * 60 * 1000) {
          state.mediaCandidates.set(candidate.mediaId, candidate);
        }
      }
      state.recentMedia = (saved.recentMedia || []).filter(item => Date.now() - item.observedAt < 90000);
      state.documentId = documentId || saved.documentId || "";
      state.previousMediaUrls = new Set([
        ...(saved.previousMediaUrls || []), ...(saved.invalidatedMediaUrls || [])
      ]);
      for (const stream of (saved.streams || []).slice(0, MAX_PERSISTED_MEDIA)) {
        const url = stream.lastUrl || stream.url;
        if ((!isHlsKind(stream.kind) && !isDirectVideoKind(stream.kind)) || !/^https?:/i.test(url) || isHardExcludedUrl(url)) continue;
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
    
    const headers = Object.fromEntries((details.responseHeaders || []).map(header => [header.name.toLowerCase(), header.value]));
    const forcedKind = mediaKindFromContentType(headers["content-type"]);
    const totalBytes = details.statusCode === 206 ? Number(headers["content-range"]?.match(/\/(\d+)$/)?.[1])
      : details.statusCode === 200 && !headers["content-encoding"] ? Number(headers["content-length"]) : 0;
    if (!forcedKind && !isStreamUrl(details.url)) return;
    if (details.statusCode >= 400 && !isHlsKind(forcedKind) && !isStreamUrl(details.url)) return;
    captureNetworkStream(details.tabId, details.url, {
      forcedKind,
      status: details.statusCode, type: details.type, totalBytes,
      method: details.method,
      requestId: details.requestId,
      documentUrl: details.documentUrl || "",
      initiator: details.initiator || "",
      documentId: details.documentId || "",
      parentDocumentId: details.parentDocumentId || "",
      frameId: details.frameId,
      observedAt: details.timeStamp,
      source: "webRequest"
    });
  }),
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

chrome.webRequest.onErrorOccurred?.addListener(details => withDetectionState(() => {
  if (details.tabId < 0 || !isStreamUrl(details.url) || details.error === "net::ERR_ABORTED") return;
  captureNetworkStream(details.tabId, details.url, { networkError: details.error,
    frameId: details.frameId, documentId: details.documentId, observedAt: details.timeStamp, source: "webRequest" });
}), { urls: ["<all_urls>"] });

chrome.tabs.onRemoved.addListener((tabId) => withDetectionState(() => {
  void jobsReady.then(() => {
    for (const job of jobs.values()) if (job.payload.tabId === tabId && REFRESH_PHASES.has(job.flowState)) void failRefreshJob(job, "原视频标签页已关闭，无法恢复下载。");
  });
  tabState.delete(tabId);
  persistDetectionState(tabId);
}));

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => withDetectionState(() => {
  if (changeInfo.status === "complete") void wakeRefreshForTab(tabId, "reload complete");
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
      observedAt: details.timeStamp,
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
  if (message?.type === "CONTENT_READY" && sender.tab?.id != null) {
    wakeRefreshForTab(sender.tab.id, "content READY", sender).then(() => sendResponse({ ok: true })).catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message?.type === "getJobs" && !jobsInitialized) {
    jobsReady.then(() => sendResponse({ ok: true, jobs: publicJobs(), queuePaused }));
    return true;
  }
  if (message?.type === "mediaCandidateUpdate" && sender.tab?.id != null) {
    withDetectionState(() => updateMediaCandidate(sender.tab.id, sender.frameId || 0,
      sender.documentId || "", sender.url || "", message.candidate || {}));
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === "mediaCandidateRemoved" && sender.tab?.id != null) {
    withDetectionState(() => removeMediaCandidate(sender.tab.id, sender.frameId || 0,
      String(message.videoElementToken || "")));
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === "observedMediaRequest" && sender.tab?.id != null) {
    withDetectionState(async () => {
      const item = message.item;
      const forcedKind = mediaKindFromContentType(item?.mime);
      if (!item || !/^https?:/i.test(item.url || "") || (!forcedKind && !isStreamUrl(item.url))) return;
      const frame = await chrome.webNavigation.getFrame({ tabId: sender.tab.id, frameId: sender.frameId || 0 });
      if (!frame || (sender.documentId && frame.documentId !== sender.documentId)) return;
      captureNetworkStream(sender.tab.id, item.url, { forcedKind, source: String(item.source || "performance"),
        status: Number(item.status) || 0, observedAt: Math.min(Date.now(), Number(item.observedAt) || 0),
        frameId: sender.frameId || 0, documentId: sender.documentId || "", documentUrl: sender.url || "" });
    });
    return false;
  }
  if (message?.type === "observedPlaylist" && sender.tab?.id != null) {
    withDetectionState(async () => {
      const state = tabState.get(sender.tab.id);
      const item = message.item;
      if (!state || !item || typeof item.text !== "string" || item.text.length > 1024 * 1024) return;
      // Frame document identity is authoritative; iframe URLs need not match the top URL.
      const frame = await chrome.webNavigation.getFrame({ tabId: sender.tab.id, frameId: sender.frameId || 0 });
      if (!frame || (sender.documentId && frame.documentId !== sender.documentId)) return;
      if (state !== tabState.get(sender.tab.id) || state.invalidated || item.observedAt < state.resourceSince) return;
      const info = parsePlaylistInfo(item.text, item.url);
      if (info.isMaster === undefined || !/^https?:/i.test(item.url)) return;
      const oldDuration = state.playlistInfo.get(item.url)?.duration;
      recordPlaylist(state, item.url, info, { status: 200, source: "page-response", frameId: sender.frameId || 0,
        documentId: sender.documentId || "", documentUrl: sender.url || "", observedAt: item.observedAt, headers: { "user-agent": String(item.userAgent || "").slice(0,1000) } });
      detectionLog(state, "playlist-response", { url: item.url, frameId: sender.frameId || 0,
        master: info.isMaster, live: info.live, segments: info.segmentUrls?.length || 0 });
      if (info.live === false && info.duration && info.duration !== oldDuration) {
        broadcastSessionState("videoSessionChanged", state);
      }
      await persistDetectionState(state.tabId);
    }).catch(() => {});
    sendResponse({ ok: true });
    return false;
  }
  if (message?.type === "getDiagnostics") {
    getPopupState(message.tabId).then(p => {
      const state = tabState.get(p.tabId);
      sendResponse({ ok: true, diagnostics: {
        version: chrome.runtime.getManifest().version_name, generatedAt: new Date().toISOString(),
        pageUrl: diagnosticUrl(state?.pageUrl), documentId: state?.documentId,
        sessionId: state?.sessionId, currentSrc: diagnosticUrl(state?.currentSrc), resourceSince: state?.resourceSince,
        mainFrameId: state?.mainFrameId, duration: state?.videoDuration, invalidated: state?.invalidated,
        selectedUrl: diagnosticUrl(p.recommended?.resourceUrl), candidates: [...(state?.streams.values() || [])]
          .filter(s => s.kind !== "segment").map(s => ({ url: diagnosticUrl(s.lastUrl), kind: s.kind,
            association: s.association, frameId: s.frameId, firstSeen: s.firstSeen, lastSeen: s.lastSeen,
            playlistDuration: playlistDuration(state, s), mediaId: s.mediaId,
            matchesActivePlayer: streamMatchesActiveMedia(state, s), rejection: activeResourceRejection(state, s) })),
        requestContext: (() => {
          const headers = state?.streams.get(p.recommended?.resourceId)?.headers || {};
          return { userAgent: headers["user-agent"] || "", origin: diagnosticUrl(headers.origin),
            referer: diagnosticUrl(headers.referer), hasCookie: Boolean(headers.cookie) };
        })(), frames: state?.diagnosticFrames || [], events: state?.diagnostics || [],
        captureGaps: p.captureGaps || [], resources: (p.streams || []).map(stream => ({
          url: diagnosticUrl(stream.resourceUrl), sources: stream.sources, duration: stream.duration, sizeBytes: stream.sizeBytes,
          sizeBasis: stream.sizeBasis, quality: stream.quality, group: stream.group, availability: stream.availability,
          player: stream.playerTitle, frameId: stream.frameId, recommended: Boolean(stream.recommended),
          reason: stream.recommendationReason
        }))
      } });
    }).catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
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

  if (message.type === "retryJob") {
    retryJob(message.jobId).then(() => sendResponse({ ok: true })).catch(error => sendResponse({ ok: false, error: error.message }));
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

  if (message.type === "getJobDiagnostics") {
    exportJobDiagnostics(message.jobId).then(diagnostics => sendResponse({ ok: true, diagnostics }))
      .catch(error => sendResponse({ ok: false, error: error.message }));
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
    const state = tabState.get(sender.tab.id);
    const knownDocument = state?.documentId;
    if (knownDocument && sender.documentId && knownDocument !== sender.documentId) {
      sendResponse({ ok: true });
      return false;
    }
    if (navigation.phase === "start") {
      const urlChanged = navigation.previousPageUrl && !samePageIdentity(navigation.previousPageUrl, navigation.pageUrl);
      const alreadyCommitted = urlChanged && !state?.invalidated && samePageIdentity(state?.pageUrl, navigation.pageUrl);
      if (!alreadyCommitted) invalidateVideoSession(sender.tab.id, navigation);
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
  if (state.invalidated) state = await recoverPopupNavigation(tab, state);
  if (state.invalidated) return navigationPopupState(tab, state, settings);
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "rescanActiveMedia" });
    await new Promise(resolve => setTimeout(resolve, 40));
  } catch { /* Restricted/starting frames are still covered by executeScript below. */ }
  state = await collectMediaHints(tab, state);
  if (state.invalidated) return navigationPopupState(tab, state, settings);
  const sessionSnapshot = snapshotVideoSession(state);

  await recoverHistoryResources(state);
  const observed = sortedStreams(state).filter(stream => isWholeResource(stream.kind))
    .sort((a, b) => Number(isBoundToMainPlayer(state, b)) - Number(isBoundToMainPlayer(state, a))
      || Number(b.frameId === state.mainFrameId) - Number(a.frameId === state.mainFrameId)
      || b.lastSeen - a.lastSeen);
  const probes = { remaining: MAX_PLAYLIST_PROBES };
  const enriched = await mapMediaProbes(observed, stream =>
    enrichStreamForPopup(sessionSnapshot, snapshotStream(stream), probes));
  await addPlaylistRenditions(state, sessionSnapshot, enriched, probes);
  if (tabState.get(tab.id)?.sessionId !== sessionSnapshot.sessionId || state.invalidated) {
    if (retryCount < SESSION_ENRICH_RETRIES) return getPopupState(tab.id, retryCount + 1);
    return { ok: false, stale: true, error: "页面视频已切换，请刷新检测。" };
  }
  const resources = new Map(enriched.map(stream => [stream.resourceId, stream]));
  const additions = sortedStreams(state).filter(stream =>
    isWholeResource(stream.kind) && !resources.has(stream.id));
  for (const stream of await mapMediaProbes(additions, stream =>
    enrichStreamForPopup(sessionSnapshot, snapshotStream(stream), probes))) resources.set(stream.resourceId, stream);
  if (tabState.get(tab.id)?.sessionId !== sessionSnapshot.sessionId || state.invalidated) {
    if (retryCount < SESSION_ENRICH_RETRIES) return getPopupState(tab.id, retryCount + 1);
    return { ok: false, stale: true, error: "页面视频已切换，请刷新检测。" };
  }

  const extractor = makePageExtractorCandidate(sessionSnapshot);
  const streams = [...resources.values()].flatMap(stream => {
    const original = state.streams.get(stream.resourceId);
    return original && isWholeResource(original.kind) && !state.segmentOwners.has(stream.resourceUrl)
      ? [describeResource(state, stream, original)] : [];
  });
  if (extractor) {
    const [card] = aggregateLogicalVideos(sessionSnapshot, [extractor], settings);
    streams.push({ ...card, exactSelection: false, group: "other", recommended: false,
      availability: "站点解析", recommendationReason: "由站点解析器按当前网页选择媒体" });
  }
  const recommended = recommendMainResource(streams, state);
  if (recommended) {
    recommended.group = "recommended";
    recommended.recommended = true;
  }
  detectionLog(state, "popup-selection", { url: recommended?.resourceUrl || "", candidateCount: streams.length,
    mainFrameId: state.mainFrameId, missing: state.captureGaps || [] });
  await persistDetectionState(tab.id);

  const warning = recommended ? "" : streams.length
    ? "未确认主视频。可查看全部已发现资源并手动选择。"
    : "未捕获到可列出的媒体资源。播放目标视频后刷新检测。";
  return {
    ok: true,
    tabId: tab.id,
    sessionId: sessionSnapshot.sessionId,
    fingerprint: sessionSnapshot.fingerprint,
    pageTitle: sessionSnapshot.pageTitle,
    pageUrl: sessionSnapshot.pageUrl,
    activeMediaId: sessionSnapshot.activeMediaId || "",
    thumbnailUrl: safeImageUrl(sessionSnapshot.thumbnailUrl),
    streams,
    recommended,
    detectedStreamCount: streams.length,
    warning,
    mainPlayerDuration: state.videoDuration,
    captureGaps: [
      ...(state.captureGaps || []),
      ...(!streams.length && !state.hasVideoElement ? ["未读到 HTML 视频元素或可公开读取的播放器来源"] : []),
      ...(state.currentSrc.startsWith("blob:") && !state.mainPlaylistUrl && !recommended
        ? ["主播放器使用 blob，当前没有与它绑定的 HTTP 清单"] : []),
      ...(!recommended && state.hasVideoElement && !streams.some(stream => stream.hasNetworkEvidence && stream.preferredFrame)
        ? ["主播放器所在帧未观察到可识别的媒体网络响应"] : []),
      ...(!recommended && state.videoDuration && streams.some(stream => isHlsKind(stream.kind))
        && !streams.some(stream => stream.matches)
        ? ["已读到播放器时长，但未找到时长吻合的完整媒体清单"] : []),
      ...(probes.remaining < 0 ? ["本次清单探测达到上限，未探测的资源仍保留"] : []),
      ...(state.inventoryEvicted ? ["当前标签页的资源缓存已达上限"] : [])
    ],
    settings,
    queuePaused,
    jobs: publicJobs()
  };
}

async function recoverPopupNavigation(tab, state) {
  if (!tab.url || tab.pendingUrl && tab.pendingUrl !== tab.url) return state;
  let frame;
  try {
    frame = await chrome.webNavigation?.getFrame?.({ tabId: tab.id, frameId: 0 });
  } catch {
    return tabState.get(tab.id) || state;
  }
  const current = tabState.get(tab.id);
  if (current !== state) return current || state;
  if (!state.invalidated || !frame?.documentId || frame.url !== tab.url
    || (frame.documentLifecycle && frame.documentLifecycle !== "active")) return state;
  const newDocument = Boolean(state.documentId && state.documentId !== frame.documentId);
  const newPage = !samePageIdentity(state.pageUrl, frame.url);
  const finishedWithoutChange = tab.status === "complete" && Date.now() - state.invalidatedAt >= 1500;
  if (!newDocument && !newPage && !finishedWithoutChange) return state;
  return commitVideoNavigation(tab.id, {
    pageUrl: frame.url, pageTitle: tab.title, documentId: frame.documentId,
    reason: "popup-confirmed-navigation", forceDocumentBoundary: newDocument,
    confirmedActiveFrame: true
  });
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
    const scriptRequest = {
      target: { tabId: tab.id, allFrames: true },
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
        const playerSources = new Map();
        const addSources = (video, sources, source) => {
          if (!video?.matches?.("video")) return;
          const known = playerSources.get(video) || [];
          for (const value of sources) {
            const url = absolute(typeof value === "string" ? value : value?.file || value?.src);
            if (url && /^https?:/i.test(url)) known.push({ url, source, type: value?.type || "", variants: [] });
          }
          if (known.length) playerSources.set(video, known);
        };
        try {
          for (const player of Object.values(window.videojs?.getPlayers?.() || {})) {
            const video = player?.el?.()?.querySelector("video");
            const current = player?.currentSource?.();
            addSources(video, [current?.src ? current : player?.currentSrc?.()], "video.js");
          }
        } catch { /* Public player API unavailable. */ }
        try {
          for (const element of document.querySelectorAll(".jwplayer[id]")) {
            const item = window.jwplayer?.(element.id)?.getPlaylistItem?.();
            addSources(element.querySelector("video"), [...(item?.sources || []), item?.file], "JW Player");
          }
        } catch { /* Public player API unavailable. */ }
        const videos = Array.from(document.querySelectorAll("video")).map((video) => {
          const sourceElements = Array.from(video.querySelectorAll("source"));
          const sourceUrls = sourceElements.map(source => absolute(source.src || source.getAttribute("src") || "")).filter(Boolean);
          const sourceTypes = Object.fromEntries(sourceElements.map(source => [
            absolute(source.src || source.getAttribute("src") || ""), source.type || source.getAttribute("type") || ""
          ]));
          const rect = typeof video.getBoundingClientRect === "function"
            ? video.getBoundingClientRect() : { width: video.clientWidth || 0, height: video.clientHeight || 0,
              top: 0, left: 0, right: video.clientWidth || 0, bottom: video.clientHeight || 0 };
          return {
            currentSrc: absolute(video.currentSrc || video.src || ""),
            sourceUrls, sourceTypes,
            poster: absolute(video.poster || ""),
            width: video.videoWidth || video.clientWidth || 0,
            height: video.videoHeight || video.clientHeight || 0,
            duration: Number.isFinite(video.duration) ? video.duration : 0,
            currentTime: Number.isFinite(video.currentTime) ? video.currentTime : 0,
            paused: video.paused,
            ended: video.ended,
            visible: (() => { return rect.width > 0 && rect.height > 0
              && rect.bottom > 0 && rect.right > 0
              && rect.top < (typeof innerHeight === "number" ? innerHeight : Number.MAX_SAFE_INTEGER)
              && rect.left < (typeof innerWidth === "number" ? innerWidth : Number.MAX_SAFE_INTEGER); })(),
            boundingRectArea: Math.max(0, rect.width) * Math.max(0, rect.height),
            title: String(video.getAttribute?.("title") || video.getAttribute?.("aria-label")
              || video.closest?.("article,figure,[data-title],[aria-label]")?.getAttribute?.("data-title")
              || video.closest?.("article,figure,[data-title],[aria-label]")?.getAttribute?.("aria-label") || "").slice(0, 300),
            playerSources: (() => {
              // Only recover an Hls instance actually bound to this video element.
              const instances = [window.hls, window.player?.hls, window.player?.engine?.hls];
              const hlsSources = instances.filter(h => h?.media === video && /^https?:/i.test(h.url || ""))
                .map(h => ({ url: h.url, source: "hls.js", type: "hls",
                  currentVariantUrls: [h.levels?.[h.currentLevel]?.url].flat().map(absolute).filter(Boolean),
                  variants: (h.levels || []).map(level => ({
                  quality: level.height || 0, bandwidth: level.bitrate || 0,
                  urls: (Array.isArray(level.url) ? level.url : [level.url]).map(absolute).filter(Boolean)
                })) }));
              return [...hlsSources, ...(playerSources.get(video) || [])];
            })()
          };
        });
        // Resource timing keeps the original playlist even when MSE exposes only blob:.
        // Scan the current document's history, not just its most recent segments.
        const resources = (() => {
          try {
            const media = /\.(m3u8|mp4|webm|m4s|ts)(?:$|[?#])|\/index-[^/?#]+|\/(?:master|manifest|playlist)(?:[/?#]|$)/i;
            const knownMedia = new Map((pendingMedia || []).map((candidate) => [candidate.url, candidate.forcedKind]));
            const excluded = /\.(?:jpe?g|png|webp|gif|avif)(?:$|[?#])/i;
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
          userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
          title: metaTitle,
          pageUrl: location.href,
          poster: absolute(videos.find((item) => item.poster)?.poster || metaImage),
          metadataVideoId,
          siteMedia,
          resources,
          observedPlaylists: window.__darrenMediaObserver?.snapshot?.() || [],
          observedRequests: window.__darrenMediaObserver?.requests?.() || [],
          scriptHints: (() => {
            const found = new Set();
            let budget = 1024 * 1024;
            for (const script of document.querySelectorAll("script:not([src])")) {
              if (budget <= 0) break;
              const text = (script.textContent || "").slice(0, budget).replace(/\\\//g, "/");
              budget -= text.length;
              for (const match of text.matchAll(/https?:\/\/[^\s"'<>\\]+/g)) {
                if (/\.m3u8(?:[?#]|$)|\/index-[^/?#]+/i.test(match[0])) found.add(match[0]);
                if (found.size >= 32) return [...found];
              }
            }
            return [...found];
          })(),
          resourceCount: performance.getEntriesByType("resource").length,
          serviceWorkerUrl: typeof navigator !== "undefined" ? navigator.serviceWorker?.controller?.scriptURL || "" : "",
          videos
        };
      }
    };
    let results, knownFrames;
    try {
      results = await chrome.scripting.executeScript(scriptRequest);
    } catch (error) {
      knownFrames = await chrome.webNavigation.getAllFrames?.({ tabId: tab.id }).catch(() => []) || [];
      if (!knownFrames.length) throw error;
      const scans = await Promise.allSettled(knownFrames.map(frame => chrome.scripting.executeScript({
        ...scriptRequest, target: { tabId: tab.id, frameIds: [frame.frameId] }
      })));
      results = scans.flatMap(scan => scan.status === "fulfilled" ? scan.value : []);
    }
    knownFrames ??= await chrome.webNavigation.getAllFrames?.({ tabId: tab.id }).catch(() => []) || [];
    const foundFrames = new Set((results || []).filter(item => item.result).map(item => item.frameId));
    state.captureGaps = knownFrames.filter(frame => !foundFrames.has(frame.frameId)).map(frame =>
      `帧 ${frame.frameId}（${getHost(frame.url) || "受限页面"}）未返回播放器信息`);
    const topResult = results?.find(r => r.frameId === 0);
    const hints = topResult?.result || (results?.length ? { pageUrl: state.pageUrl, title: state.pageTitle } : null);
    if (!hints) return state;
    const current = tabState.get(tab.id);
    if (current !== state || current.invalidated ||
      (topResult && (!samePageIdentity(hints.pageUrl, current.pageUrl) ||
        topResult.documentId && current.documentId && topResult.documentId !== current.documentId))) {
      return current || state;
    }
    const frames = results.filter(r => r.result).map(r => ({ ...r.result,
      frameId: r.frameId || 0, documentId: r.documentId || "" }));
    state.diagnosticFrames = frames.map(f => ({ frameId: f.frameId, documentId: f.documentId,
      url: diagnosticUrl(f.pageUrl), videos: f.videos?.length || 0, resourceCount: f.resourceCount,
      observedPlaylists: f.observedPlaylists?.length || 0, serviceWorkerUrl: diagnosticUrl(f.serviceWorkerUrl) }));
    const videos = frames.flatMap(f => (f.videos || []).map(v => ({ ...v,
      frameId: f.frameId, documentId: f.documentId, frameUrl: f.pageUrl })));
    for (const video of videos) {
      const candidate = findMatchingMediaCandidate(state, video);
      if (candidate) Object.assign(video, {
        mediaId: candidate.mediaId, lastPlayAt: candidate.lastPlayAt, lastPlayingAt: candidate.lastPlayingAt,
        lastTimeProgressAt: candidate.lastTimeProgressAt, lastUserInteractionAt: candidate.lastUserInteractionAt,
        lastNetworkActivityAt: candidate.lastNetworkActivityAt, lastSourceChangeAt: candidate.lastSourceChangeAt
      });
    }
    const mainVideo = videos.filter(v => v.duration || v.height || v.width || v.currentSrc)
      .sort((a, b) => compareMainVideos(a, b, state))[0];
    const extractor = pageExtractorInfo(hints.pageUrl);
    const metadataMatchesPage = !extractor?.videoId
      || !hints.metadataVideoId
      || extractor.videoId === hints.metadataVideoId;
    state = updateVideoContext(tab.id, {
      pageUrl: hints.pageUrl,
      pageIdentity: pageVideoIdentity(hints.pageUrl),
      documentId: topResult?.documentId || state.documentId,
      videoId: extractor?.videoId || "",
      metadataVideoId: hints.metadataVideoId || "",
      metadataMatchesPage,
      pageTitle: metadataMatchesPage ? (mainVideo?.title || hints.title) : "",
      poster: metadataMatchesPage ? (mainVideo?.poster || hints.poster) : "",
      hasVideoElement: Boolean(videos.length),
      mainVideo: metadataMatchesPage ? mainVideo : null,
      activeMediaId: mainVideo?.mediaId || state.activeMediaId || "",
      reason: "popup-hints"
    });
    if (hints.siteMedia) state = updateSiteMediaContext(tab.id, hints.siteMedia);

    const selectedVideo = videos.find(video => video.currentSrc === state.currentSrc && video.mediaId === state.activeMediaId)
      || (mainVideo?.currentSrc === state.currentSrc ? mainVideo : null);
    const mainPlaylist = selectedVideo?.playerSources?.find(source => source.type === "hls" || /\.m3u8(?:$|[?#])/i.test(source.url));
    if (mainPlaylist && state.mainPlaylistUrl && state.mainPlaylistUrl !== mainPlaylist.url
      && mediaPath(state.mainPlaylistUrl) !== mediaPath(mainPlaylist.url)
      && !state.previousMediaUrls.has(mainPlaylist.url)) {
      const freshInfo = new Map([...state.playlistInfo].filter(([url]) => url === mainPlaylist.url
        || mainPlaylist.variants?.some(v => v.urls.includes(url))));
      state = rotateVideoSession(tab.id, { pageUrl: state.pageUrl, documentId: state.documentId,
        pageTitle: state.pageTitle, currentSrc: mainVideo.currentSrc,
        reason: "player-playlist-change", forceSessionBoundary: true });
      state.playlistInfo = freshInfo;
      state.videoDuration = mainVideo.duration || 0;
      state.mainVideoHeight = mainVideo.height || 0;
      detectionLog(state, "player-playlist-change", { url: mainPlaylist.url });
      broadcastSessionState("videoSessionChanged", state);
    }
    if (mainPlaylist && !state.previousMediaUrls.has(mainPlaylist.url)) state.mainPlaylistUrl = mainPlaylist.url;

    state.mainFrameId = selectedVideo?.frameId ?? state.mainFrameId;
    for (const frame of frames) {
      for (const url of frame.scriptHints || []) {
        if (!state.previousMediaUrls.has(url)) upsertStream(tab.id, url, { source: "player-config",
          frameId: frame.frameId, documentUrl: frame.pageUrl, observedAt: state.createdAt });
      }
      for (const item of frame.observedRequests || []) {
        if (item.observedAt < state.resourceSince || state.previousMediaUrls.has(item.url)) continue;
        captureNetworkStream(tab.id, item.url, { forcedKind: mediaKindFromContentType(item.mime), source: item.source, status: item.status,
          observedAt: item.observedAt, frameId: frame.frameId, documentUrl: frame.pageUrl });
      }
      for (const item of frame.observedPlaylists || []) {
        if (item.observedAt < state.resourceSince || state.previousMediaUrls.has(item.url)) continue;
        recordPlaylist(state, item.url, parsePlaylistInfo(item.text, item.url), {
          frameId: frame.frameId, documentId: frame.documentId,
          documentUrl: frame.pageUrl, observedAt: item.observedAt, status: 200, source: "page-response",
          headers: { "user-agent": frame.userAgent || "" }
        });
      }
      for (const resource of frame.resources || []) {
        if (resource.observedAt < state.resourceSince || state.previousMediaUrls.has(resource.url)) continue;
        if ((!isStreamUrl(resource.url) && !resource.forcedKind) || isHardExcludedUrl(resource.url)) continue;
        upsertStream(tab.id, resource.url, {
          source: "performance-recovery", forcedKind: resource.forcedKind,
          association: "session-performance", frameId: frame.frameId,
          documentUrl: frame.pageUrl, documentId: frame.documentId,
          initiator: safeUrl(frame.pageUrl)?.origin || "",
          headers: state.headersByUrl.get(headerKey(resource.url)) || { referer: frame.pageUrl },
          observedAt: resource.observedAt
        });
        state.pendingStreams.delete(resource.url);
      }
    }
    for (const video of videos) {
      const playerResources = [...(video.playerSources || []),
        ...[video.currentSrc, ...(video.sourceUrls || [])].filter(Boolean).map(url => ({ url, source: "<video>/<source>", type: video.sourceTypes?.[url] }))];
      for (const source of playerResources) {
        const { url } = source;
        if (state.previousMediaUrls.has(url) || !/^https?:/i.test(url)) continue;
        const type = String(source.type || "").toLowerCase();
        const forcedKind = /^(?:hls|m3u8)$|mpegurl/.test(type) ? (source.variants?.length ? "hls_master" : "hls")
          : mediaKindFromContentType(type);
        if (!forcedKind && !isStreamUrl(url)) continue;
        const main = video === selectedVideo;
        const association = main && (source.source !== "<video>/<source>" || url === video.currentSrc)
          ? "main-player" : "secondary-dom";
        upsertStream(tab.id, url, {
          source: source.source || "player-api", association, forcedKind,
          playerName: source.source || "HTML video", playerSrc: video.currentSrc,
          frameId: video.frameId, documentId: video.documentId, documentUrl: video.frameUrl,
          quality: url === video.currentSrc ? video.height : 0,
          verifiedHeight: isDirectVideoKind(forcedKind || inferStreamMetadata(url).kind) && url === video.currentSrc ? video.height : 0,
          duration: url === video.currentSrc ? video.duration : 0, mediaId: video.mediaId,
          headers: { referer: video.frameUrl || state.pageUrl,
            "user-agent": frames.find(frame => frame.frameId === video.frameId)?.userAgent || hints.userAgent || "",
            ...state.headersByUrl.get(headerKey(url)) }
        });
        const resource = state.streams.get(streamKey(url));
        if (resource && source.currentVariantUrls) resource.currentVariantUrls = source.currentVariantUrls;
        if (!resource || !source.variants?.length) continue;
        const variants = source.variants.flatMap(level => level.urls.map(url => ({
          url, height: level.quality, bandwidth: level.bandwidth
        })));
        if (!resource.variants?.length) resource.variants = variants;
        resource.variantUrls = resource.variants.map(variant => variant.url);
        resource.availableQualities = [...new Set(resource.variants.map(variant => variant.height).filter(Boolean))];
      }
    }
  } catch (error) {
    state.captureGaps = [`播放器扫描未完成：${error.message}`];
  }
  return tabState.get(tab.id) || state;
}

function mediaActivityScore(video, state, now = Date.now()) {
  const ageScore = (timestamp, points, windowMs) => timestamp && now - timestamp <= windowMs
    ? Math.round(points * (1 - (now - timestamp) / windowMs)) : 0;
  const area = Number(video.boundingRectArea || (video.width || 0) * (video.height || 0));
  let score = 0;
  if (!video.paused && !video.ended && now - Number(video.lastTimeProgressAt || 0) <= 2500) score += 1_000_000;
  // "autoplay and not paused" alone is weak evidence; ads often satisfy it.
  if (!video.paused && !video.ended && (video.lastPlayAt || video.lastPlayingAt)) score += 10_000;
  score += ageScore(video.lastPlayingAt || video.lastPlayAt, 450_000, 30_000);
  score += ageScore(video.lastNetworkActivityAt, 260_000, 20_000);
  score += ageScore(video.lastUserInteractionAt, 180_000, 30_000);
  score += ageScore(video.lastSourceChangeAt, 100_000, 20_000);
  if (video.visible) score += 50_000 + Math.min(80_000, area / 20);
  if (video.mediaId && video.mediaId === state?.activeMediaId) score += 30_000;
  if (video.ended) score -= 200_000;
  return score;
}

function compareMainVideos(a, b, state, now = Date.now()) {
  const area = v => Number(v.boundingRectArea || (v.width || v.videoWidth || 0) * (v.height || v.videoHeight || 0));
  // Keep a visible long-form player ahead of small autoplay clips and overlays.
  const dominatesClip = (main, clip) => (main.visible || main.visibility) &&
    main.duration >= 120 && clip.duration > 0 && clip.duration <= 30 &&
    area(main) >= Math.max(1, area(clip)) && !clip.lastUserInteractionAt;
  if (dominatesClip(a, b)) return -1;
  if (dominatesClip(b, a)) return 1;
  const activity = mediaActivityScore(b, state, now) - mediaActivityScore(a, state, now);
  if (activity) return activity;
  return area(b) - area(a) || (b.duration || 0) - (a.duration || 0);
}

async function enrichStreamForPopup(session, stream, budget) {
  const url = stream.lastUrl || stream.url;
  const playlistInfo = isHlsKind(stream.kind) ? await fetchPlaylistInfo(url, stream, session, budget) : {};
  const contentLength = isDirectVideoKind(stream.kind) && !stream.sizeExact && (!budget || budget.remaining-- > 0)
    ? await fetchContentLength(url, stream, session) : 0;
  const kind = playlistInfo.isMaster === true ? "hls_master"
    : playlistInfo.isMaster === false && isHlsKind(stream.kind) ? "hls_media"
      : stream.kind;
  const mainCurrentSrc = normalizeResourceUrl(session.currentSrc);
  const activeMediaMatch = Boolean(session.activeMediaId && stream.mediaId === session.activeMediaId);
  const stronglyAssociated = activeMediaMatch || ["main-current-src", "main-player"].includes(stream.association)
    || (mainCurrentSrc && normalizeResourceUrl(url) === mainCurrentSrc);
  const state = tabState.get(session.tabId);
  const quality = stream.variant?.height || stream.quality || playlistInfo.quality || 0;
  const measuredDuration = playlistInfo.live === false ? playlistInfo.duration : stream.verifiedDuration || 0;
  const duration = measuredDuration || stream.duration || 0;
  const manifestSize = isHlsKind(kind) ? playlistSize(state || {}, playlistInfo, stream.variant) : null;
  const sizeBytes = manifestSize?.sizeBytes || (isDirectVideoKind(kind) ? contentLength || stream.sizeBytes : 0) || 0;
  const exactSize = !manifestSize && Boolean(contentLength || stream.sizeExact);
  const sizeBasis = manifestSize?.sizeBasis || (exactSize ? "媒体响应总字节数" : "");
  const capturedAfterMain = !session.mainVideoObservedAt
    || stream.lastSeen >= session.mainVideoObservedAt;

  return {
    id: stream.id,
    resourceId: stream.id,
    resourceUrl: url,
    detectedAt: stream.detectedAt || stream.firstSeen,
    ...mediaUrlContext(url),
    masterUrl: hlsMasterUrl(session, stream),
    sourceContext: { frameId: stream.frameId, documentUrl: stream.documentUrl, source: stream.source },
    mediaId: stream.mediaId || "",
    activeMediaMatch,
    sessionId: session.sessionId,
    fingerprint: resourceFingerprint(session, stream),
    url: stream.url,
    lastUrl: url,
    pageUrl: session.pageUrl,
    kind,
    typeTag: streamTypeTag(kind),
    label: stream.label,
    quality,
    qualityLabel: quality ? (stream.variant?.width ? `${stream.variant.width}×${quality}` : `${quality}p`) : "分辨率未知",
    host: getHost(url),
    sourceTitle: stream.pageTitleAtCapture || session.pageTitle || getHost(url) || "Detected video",
    thumbnailUrl: safeImageUrl(session.thumbnailUrl),
    duration,
    durationLabel: formatDuration(duration),
    sizeBytes,
    sizeLabel: sizeBytes ? formatBytes(sizeBytes, !exactSize) : "大小未知",
    exactSize, sizeBasis, measuredDuration, variant: stream.variant,
    sources: stream.sources || [stream.source], httpStatus: stream.httpStatus || 0,
    networkError: stream.networkError || "", drm: Boolean(playlistInfo.drm || stream.masterDrm),
    availability: playlistInfo.probeStatus || "",
    sampleCount: stream.sampleCount || 1,
    firstSeen: stream.firstSeen,
    lastSeen: stream.lastSeen,
    source: stream.source,
    association: stream.association || "session-network",
    initiator: stream.initiator || "",
    documentUrl: stream.documentUrl || "",
    frameId: stream.frameId,
    live: playlistInfo.live,
    playlistVerified: playlistInfo.isMaster !== undefined,
    variantUrls: playlistInfo.variantUrls || stream.variantUrls || [],
    availableQualities: stream.availableQualities || playlistInfo.availableQualities || [],
    stronglyAssociated,
    capturedAfterMain,
    canDownloadWholeVideo: (isHlsKind(kind) || isDirectVideoKind(kind)) && !stream.audioOnly,
    isRecommendable: (isHlsKind(kind) || isDirectVideoKind(kind)) && !stream.audioOnly
  };
}

function probeHeaders(stream = {}, session = {}) {
  const headers = {};
  for (const name of ["authorization", "accept", "origin", "referer"]) {
    if (stream.headers?.[name]) headers[name] = stream.headers[name];
  }
  if (!headers.referer) headers.referer = stream.documentUrl || session.pageUrl || "";
  return headers;
}

async function fetchContentLength(url, stream = {}, session = {}) {
  if (!/^https?:/i.test(url)) return 0;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    // Range GET follows the actual playback method; HEAD often has different routing.
    const response = await fetch(url, { method: "GET", credentials: "include", cache: "no-store",
      headers: { ...probeHeaders(stream, session), range: "bytes=0-0" }, signal: controller.signal });
    const total = Number(response.headers.get("content-range")?.match(/\/(\d+)$/)?.[1]
      || (response.status === 200 && !response.headers.get("content-encoding") &&
        isDirectVideoKind(mediaKindFromContentType(response.headers.get("content-type")))
        ? response.headers.get("content-length") : 0) || 0);
    await response.body?.cancel?.();
    return response.ok && Number.isFinite(total) ? total : 0;
  } catch { return 0; } finally { clearTimeout(timer); }
}

async function fetchPlaylistInfo(url, stream = {}, session = {}, budget) {
  if (!/^https?:/i.test(url)) return {};
  const state = tabState.get(session.tabId);
  const cached = state?.playlistInfo.get(url);
  if (cached && (cached.observedOnPage && cached.live === false || Date.now() - cached.checkedAt < 15000)) return cached;
  if (stream.probeFailedAt && Date.now() - stream.probeFailedAt < 15000) return { ...cached, probeStatus: stream.probeStatus };
  const signalFailure = status => {
    const resource = state?.streams.get(streamKey(url));
    if (resource && state.sessionId === session.sessionId) Object.assign(resource, { probeStatus: status, probeFailedAt: Date.now() });
    return { ...cached, probeStatus: status };
  };
  if (budget && budget.remaining-- <= 0) return { ...cached, probeStatus: "本次尚未探测清单" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetch(url, { credentials: "include", cache: "no-store",
      headers: probeHeaders(stream, session), signal: controller.signal });
    if (!response.ok) {
      detectionLog(state, "probe-failed", { url, status: response.status });
      await response.body?.cancel?.();
      return signalFailure(`清单探测 HTTP ${response.status}`);
    }
    const text = await readPlaylistText(response);
    if (text == null) return signalFailure("清单超过本次解析上限");
    const info = parsePlaylistInfo(text, response.url || url);
    if (info.isMaster === undefined) {
      detectionLog(state, "probe-not-playlist", { url, status: response.status });
      return signalFailure("响应不是 HLS 清单");
    }
    if (state && state.sessionId === session.sessionId) recordPlaylist(state, url, info);
    return info;
  } catch (error) {
    detectionLog(state, "probe-error", { url, error: error.message });
    return signalFailure("扩展无法读取清单");
  }
  finally { clearTimeout(timer); }
}

async function readPlaylistText(response) {
  const reader = response.body?.getReader?.();
  if (!reader) return response.text();
  const decoder = new TextDecoder();
  let text = "", bytes = 0;
  try {
    while (bytes <= MAX_PLAYLIST_BYTES) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      bytes += value.byteLength;
      text += decoder.decode(value, { stream: true });
      if (text.length > 16 && !/^\s*#EXTM3U\b/.test(text)) return text;
    }
    return null;
  } finally { void reader.cancel().catch(() => {}); }
}

async function mapMediaProbes(items, callback) {
  const result = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(items.length, 10) }, async () => {
    while (next < items.length) {
      const index = next++;
      result[index] = await callback(items[index]);
    }
  }));
  return result;
}

function isWholeResource(kind) {
  return isHlsKind(kind) || isDirectVideoKind(kind);
}

async function addPlaylistRenditions(state, session, manifests, budget) {
  let pending = manifests.filter(stream => stream.kind === "hls_master").map(stream => stream.resourceUrl);
  const seen = new Set();
  while (pending.length && state.sessionId === session.sessionId) {
    const children = [];
    for (const url of pending) {
      if (seen.has(url)) continue;
      seen.add(url);
      const info = state.playlistInfo.get(url) || state.streams.get(streamKey(url));
      const parent = state.streams.get(streamKey(url));
      for (const audio of info?.audioRenditions || []) {
        const item = state.streams.get(streamKey(audio.url));
        if (item) item.audioOnly = true;
        state.audioPlaylists.add(audio.url);
      }
      for (const variant of info?.variants || []) {
        const existing = state.streams.get(streamKey(variant.url));
        if (!existing) upsertStream(state.tabId, variant.url, { forcedKind: "hls_media", source: "hls-variant",
          observedAt: parent?.firstSeen, frameId: parent?.frameId, documentId: parent?.documentId,
          documentUrl: parent?.documentUrl, mediaId: parent?.mediaId,
          headers: { referer: parent?.headers?.referer || parent?.documentUrl || state.pageUrl,
            origin: parent?.headers?.origin, "user-agent": parent?.headers?.["user-agent"] } });
        const item = state.streams.get(streamKey(variant.url));
        if (!item) continue;
        const audioTracks = (info.audioRenditions || []).filter(audio => audio.group === variant.audioGroup);
        item.variant = { ...variant, masterUrl: url, audioUrl: (audioTracks.find(audio => audio.default) || audioTracks[0])?.url || "" };
        item.masterDrm ||= Boolean(info.drm);
        item.masterUrl = url;
        if (variant.height) item.quality = variant.height;
        children.push(item);
      }
    }
    const unique = [...new Set(children)];
    const results = await mapMediaProbes(unique, stream =>
      fetchPlaylistInfo(stream.lastUrl || stream.url, stream, session, budget));
    pending = unique.filter((stream, index) => results[index]?.isMaster).map(stream => stream.lastUrl || stream.url);
  }
}

async function recoverHistoryResources(state) {
  if (!state.pageUrl) return;
  const history = await getHistory();
  if (tabState.get(state.tabId) !== state || state.invalidated) return;
  const now = Date.now();
  const prior = [...jobs.values()].filter(job => job.payload).map(job => ({
    ...job.payload, url: job.payload.resourceUrl || job.payload.url, title: job.title, updatedAt: job.updatedAt
  })).concat(history);
  for (const item of prior) {
    if (!/^https?:/i.test(item.url || "") || !samePageIdentity(item.pageUrl, state.pageUrl) || (!isStreamUrl(item.url || "") && !isWholeResource(item.kind)) ||
        now - (item.updatedAt || item.completedAt || item.createdAt || 0) > 24 * 60 * 60 * 1000 ||
        expiryRemaining(item.url) <= 0 || state.previousMediaUrls.has(item.url) ||
        state.streams.has(streamKey(item.url))) continue;
    upsertStream(state.tabId, item.url, { source: "history", observedAt: item.updatedAt || item.completedAt,
      documentUrl: item.pageUrl, resourceTitle: item.title, forcedKind: item.kind });
  }
}

function resourceAvailability(state, stream) {
  const url = stream.lastUrl || stream.url;
  if (stream.audioOnly || state.audioPlaylists.has(url)) return "独立音轨";
  if (stream.drm || stream.masterDrm || state.playlistInfo.get(url)?.drm ||
      state.playlistInfo.get(stream.variant?.audioUrl)?.drm) return "DRM 或不支持的加密";
  if (expiryRemaining(url) <= 0 || stream.httpStatus === 410) return "链接已失效";
  if (stream.httpStatus >= 400) return `播放请求 HTTP ${stream.httpStatus}`;
  if (stream.networkError) return stream.networkError;
  return "";
}

function describeResource(state, stream, original) {
  const parent = original.variant?.masterUrl && state.streams.get(streamKey(original.variant.masterUrl));
  const player = state.mediaCandidates.get(original.mediaId || parent?.mediaId);
  const bound = isBoundToMainPlayer(state, original) && streamMatchesActiveMedia(state, original)
    || Boolean(parent && isBoundToMainPlayer(state, parent) && streamMatchesActiveMedia(state, parent));
  const preferredFrame = (original.frameId ?? parent?.frameId) === state.mainFrameId;
  const matches = Boolean(state.videoDuration && stream.measuredDuration && durationMatches(state.videoDuration, stream.measuredDuration));
  const hasNetworkEvidence = [...(stream.sources || []), ...(parent?.sources || [])].some(source =>
    /^(?:network|webRequest|page-response|fetch|xhr|performance)/.test(source));
  const url = safeUrl(stream.resourceUrl);
  const clip = BAD_CANDIDATE_PATTERN.test(url?.hostname + (url?.pathname || "")) ||
    Boolean(!bound && state.videoDuration >= 120 && stream.measuredDuration > 0 && stream.measuredDuration < state.videoDuration * 0.25);
  const unavailable = resourceAvailability(state, original);
  const probeStatus = stream.availability;
  const hasReadableMedia = stream.playlistVerified || stream.httpStatus >= 200 && stream.httpStatus < 300 ||
    isDirectVideoKind(stream.kind) && (stream.exactSize || bound);
  const effectivePlayable = stream.canDownloadWholeVideo && !unavailable;
  const activeOwner = player && player.mediaId === state.activeMediaId && !player.stale;
  const format = stream.kind === "hls_master" ? "HLS 主清单" : stream.kind === "hls_media" ? "HLS 媒体清单" : stream.kind.toUpperCase();
  const reason = clip ? "路径或时长像广告／预览" : unavailable ? unavailable
    : matches ? "媒体清单时长与播放器一致"
    : bound ? "与播放器直接关联" : "缺少主播放器关联或完整时长证据";
  return {
    ...stream, fingerprint: resourceFingerprint(state, original),
    exactSelection: true, bound, preferredFrame, matches, hasNetworkEvidence, clip,
    sourceTitle: detectedResourceTitle(state, original, player),
    pageTitle: state.pageTitle, formatLabel: format, pipelineLabel: outputPipelineLabel(stream, null),
    playerTitle: original.playerName || parent?.playerName || player?.title ||
      (bound ? "主播放器" : preferredFrame ? "主播放器所在帧" : ""),
    playbackLabel: bound && activeOwner && !player.paused && !player.ended && Date.now() - player.lastTimeProgressAt < 5000
      ? (parent?.currentVariantUrls?.includes(stream.resourceUrl) || state.currentSrc === stream.resourceUrl
        ? "此资源正在播放" : "播放器正在播放，实际清晰度未确认")
      : activeOwner && player?.paused && player.currentTime > 0 ? "播放器已暂停" : "",
    ...(bound && !clip ? choosePreviewSource(state, [stream], stream) : { previewStrategy: "poster", thumbnailUrl: "" }),
    group: clip ? "preview" : unavailable || probeStatus || (!bound && !matches) ? "uncertain" : "other",
    availability: unavailable || probeStatus || (hasReadableMedia ? "可尝试下载" : "待验证，可手动尝试"),
    canDownloadWholeVideo: effectivePlayable,
    recommendationReason: reason
  };
}

function detectedResourceTitle(state, stream, player = state.mediaCandidates.get(stream.mediaId)) {
  const url = safeUrl(stream.lastUrl || stream.url);
  const basename = url?.pathname.split("/").filter(Boolean).at(-1);
  const title = [stream.resourceTitle, player?.title, state.pageTitle, stream.pageTitleAtCapture]
    .map(value => String(value || "").trim())
    .find(value => value && !/\.(?:m3u8?|mpd)(?:$|[?#])/i.test(value)
      && !/^(?:video|正在检测视频…|正在切换视频…)$/i.test(value));
  const pageSlug = safeUrl(state.pageUrl)?.pathname.split("/").filter(Boolean).at(-1);
  return title || (!isHlsKind(stream.kind) && basename) || pageSlug || url?.hostname || "video";
}

function recommendMainResource(streams, state) {
  const eligible = streams.filter(stream => stream.exactSelection && stream.canDownloadWholeVideo &&
    !stream.clip && stream.kind !== "hls_master" && !state.streams.get(stream.resourceId)?.historyOnly &&
    (stream.matches && (stream.bound || stream.preferredFrame && stream.hasNetworkEvidence &&
      streamMatchesActiveMedia(state, state.streams.get(stream.resourceId))) ||
      stream.bound && isDirectVideoKind(stream.kind) && stream.duration > 0 && state.videoDuration > 0 &&
      durationMatches(state.videoDuration, stream.duration)));
  const score = stream => Number(stream.bound) * 8 + Number(stream.preferredFrame) * 4 +
    Number(stream.hasNetworkEvidence && Date.now() - stream.lastSeen < RECENT_MAIN_MEDIA_WINDOW_MS) * 2;
  const masterScores = new Map();
  for (const stream of eligible) if (stream.variant?.masterUrl) {
    masterScores.set(stream.variant.masterUrl, Math.max(masterScores.get(stream.variant.masterUrl) || 0, score(stream)));
  }
  const evidence = stream => masterScores.get(stream.variant?.masterUrl) ?? score(stream);
  return eligible.sort((a, b) => evidence(b) - evidence(a) ||
    b.quality - a.quality || b.sizeBytes - a.sizeBytes || b.lastSeen - a.lastSeen)[0] || null;
}

function recordPlaylist(state, url, info, details = {}) {
  if (!state || state.invalidated || info.isMaster === undefined) return;
  state.playlistInfo.set(url, { ...info, checkedAt: Date.now(), observedOnPage: details.source === "page-response" });
  while (state.playlistInfo.size > MAX_PLAYLIST_RECORDS) state.playlistInfo.delete(state.playlistInfo.keys().next().value);
  if (details.source) upsertStream(state.tabId, url, { ...details,
    headers: { origin: safeUrl(details.documentUrl)?.origin || "", referer: details.documentUrl || state.pageUrl,
      ...(state.headersByUrl.get(headerKey(url)) || {}), ...(details.headers || {}) },
    forcedKind: info.isMaster ? "hls_master" : "hls_media" });
  const resource = state.streams.get(streamKey(url));
  if (resource && isHlsKind(resource.kind)) {
    resource.probeFailedAt = 0;
    resource.probeStatus = "";
    resource.kind = info.isMaster ? "hls_master" : "hls_media";
    resource.verifiedDuration = info.live === false ? info.duration || 0 : 0;
    if (info.variantUrls?.length) resource.variantUrls = info.variantUrls;
    if (info.isMaster) {
      resource.variants = info.variants;
      resource.audioRenditions = info.audioRenditions;
    }
    resource.drm = Boolean(info.drm);
  }
  for (const segment of info.segmentUrls || []) {
    state.segmentOwners.set(segment, url);
    const existing = state.streams.get(streamKey(segment));
    if (existing) { existing.kind = "segment"; existing.label = "HLS 分片"; }
  }
  while (state.segmentOwners.size > 16000) state.segmentOwners.delete(state.segmentOwners.keys().next().value);
}

function playlistAttributes(text) {
  return Object.fromEntries([...text.matchAll(/(?:^|,) *([A-Z0-9-]+)=("[^"]*"|[^,]*)/gi)]
    .map(([, key, value]) => [key.toUpperCase(), value.replace(/^"|"$/g, "")]));
}

function parsePlaylistInfo(text, playlistUrl = "") {
  if (!/^\s*#EXTM3U\b/i.test(String(text || ""))) return {};
  const lines = text.split(/\r?\n/).map(line => line.trim());
  const variants = [], audioRenditions = [], segments = [], maps = new Map();
  const resolve = value => {
    if (!value) return "";
    try {
      const url = new URL(value, playlistUrl);
      return /^https?:$/.test(url.protocol) ? url.href : "";
    } catch { return ""; }
  };
  let attributes, duration = 0, segmentDuration = 0, range = "", previousRangeEnd = 0, previousRangeUrl = "";
  let drm = false;
  for (const line of lines) {
    if (line.startsWith("#EXT-X-STREAM-INF:")) attributes = playlistAttributes(line.slice(18));
    else if (line.startsWith("#EXT-X-MEDIA:")) {
      const track = playlistAttributes(line.slice(13));
      const url = resolve(track.URI);
      if (url && track.TYPE === "AUDIO") audioRenditions.push({ url, group: track["GROUP-ID"], name: track.NAME, default: track.DEFAULT === "YES" });
    } else if (/^#EXT-X-(?:SESSION-)?KEY:/i.test(line)) {
      const key = playlistAttributes(line.split(/:(.*)/s)[1] || "");
      drm ||= Boolean(key.KEYFORMAT && key.KEYFORMAT.toLowerCase() !== "identity" || /SAMPLE-AES/i.test(key.METHOD || ""));
    } else if (line.startsWith("#EXTINF:")) segmentDuration = Number(line.slice(8).split(",")[0]) || 0;
    else if (line.startsWith("#EXT-X-BYTERANGE:")) range = line.slice(17);
    else if (line.startsWith("#EXT-X-MAP:")) {
      const map = playlistAttributes(line.slice(11));
      const url = resolve(map.URI);
      if (url) maps.set(url + (map.BYTERANGE || ""), { url, bytes: Number(map.BYTERANGE?.split("@")[0]) || 0 });
    } else if (line && !line.startsWith("#")) {
      const url = resolve(line);
      if (attributes) {
        const [width, height] = (attributes.RESOLUTION || "").split("x").map(Number);
        if (url) variants.push({ url, width: width || 0, height: height || 0,
          bandwidth: Number(attributes.BANDWIDTH) || 0, averageBandwidth: Number(attributes["AVERAGE-BANDWIDTH"]) || 0,
          codecs: attributes.CODECS || "", audioGroup: attributes.AUDIO || "" });
        attributes = null;
      } else {
        if (url) {
          const [length, offset] = range.split("@").map(Number);
          const start = Number.isFinite(offset) ? offset : previousRangeUrl === url ? previousRangeEnd : 0;
          segments.push({ url, duration: segmentDuration, bytes: length || 0, start });
          previousRangeUrl = length ? url : "";
          previousRangeEnd = start + (length || 0);
        }
        duration += segmentDuration;
        segmentDuration = 0;
        range = "";
      }
    }
  }
  const isMaster = lines.some(line => line.startsWith("#EXT-X-STREAM-INF:"));
  if (isMaster) return { isMaster, drm, variants, audioRenditions,
    variantUrls: [...new Set(variants.map(variant => variant.url))],
    availableQualities: [...new Set(variants.map(variant => variant.height).filter(Boolean))],
    quality: Math.max(0, ...variants.map(variant => variant.height)) };
  return {
    isMaster, drm, live: !lines.includes("#EXT-X-ENDLIST"), duration,
    segments, maps: [...maps.values()], segmentCount: segments.length,
    segmentUrls: [...new Set([...segments, ...maps.values()].map(segment => segment.url))]
  };
}

function playlistSize(state, info, variant) {
  if (!info.duration || info.live !== false) return { sizeBytes: 0, exactSize: false, sizeBasis: "" };
  const parts = [...(info.segments || []), ...(info.maps || [])];
  let totalBytes = 0, sampledSeconds = 0;
  const timedSegments = info.segments || [];
  for (const [index, part] of parts.entries()) {
    const bytes = part.bytes || state.segmentSizes?.get(part.url) || 0;
    totalBytes += bytes;
    if (bytes && index < timedSegments.length) sampledSeconds += part.duration || 0;
  }
  if (!variant?.audioGroup && parts.length && parts.every(part => part.bytes || state.segmentSizes?.has(part.url))) {
    return { sizeBytes: totalBytes, exactSize: false, sizeBasis: "全部媒体分片字节数" };
  }
  const bitrate = variant?.averageBandwidth || variant?.bandwidth;
  if (!variant?.audioGroup && sampledSeconds > 0 && timedSegments.filter(part => part.bytes || state.segmentSizes?.has(part.url)).length >= 3) {
    return { sizeBytes: Math.round(totalBytes * info.duration / sampledSeconds), exactSize: false, sizeBasis: "已观察分片推算" };
  }
  if (bitrate > 0) {
    return { sizeBytes: Math.round(bitrate * info.duration / 8), exactSize: false,
      sizeBasis: variant.averageBandwidth ? "清单平均码率 × 时长" : "清单峰值码率 × 时长" };
  }
  return { sizeBytes: 0, exactSize: false, sizeBasis: "" };
}

// Signed media URLs are transport values: never decode/re-encode their query.
function mediaUrlContext(url) {
  const parsed = safeUrl(url);
  const expiry = {};
  if (parsed) for (const [key, value] of parsed.searchParams) {
    if (/^(e|exp|expire|expires|expiry)$/i.test(key)) expiry[key] = /^\d+$/.test(value) ? value : "present";
  }
  return { ephemeral: Boolean(parsed && (/\.phncdn\.com$/i.test(parsed.hostname)
    || [...parsed.searchParams.keys()].some(key => /^(e|exp|expire|expires|expiry|token|signature|sig|hash|h|hdnts|hdnea)$/i.test(key)))), expiry };
}

async function mediaUrlHash(url) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(url)));
  return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

function hlsMasterUrl(state, stream) {
  state = state.streams ? state : tabState.get(state.tabId) || state;
  const url = stream.lastUrl || stream.url;
  if (stream.kind === "hls_master") return url;
  for (const owner of state.streams?.values() || []) {
    if (owner.kind === "hls_master" && streamMatchesActiveMedia(state, owner)
      && !activeResourceRejection(state, owner)
      && (!stream.mediaId || !owner.mediaId || stream.mediaId === owner.mediaId) && (owner.variantUrls || state.playlistInfo?.get?.(owner.lastUrl || owner.url)?.variantUrls || []).includes(url)) {
      return owner.lastUrl || owner.url;
    }
  }
  const savedMaster = state.streams?.get?.(streamKey(stream.masterUrl || ""));
  return savedMaster && streamMatchesActiveMedia(state, savedMaster) && !activeResourceRejection(state, savedMaster)
    && (!stream.mediaId || !savedMaster.mediaId || stream.mediaId === savedMaster.mediaId) ? stream.masterUrl : "";
}

async function checkCurrentHls(url, headers, pageUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(url, { credentials: "include", cache: "no-store",
      headers: probeHeaders({ headers }, { pageUrl }), signal: controller.signal });
    if (!response.ok) { await response.body?.cancel?.(); return response.status; }
    const reader = response.body?.getReader?.();
    if (!reader) { await response.body?.cancel?.(); return 0; }
    try {
      let prefix = "";
      const decoder = new TextDecoder();
      while (prefix.length < 32) {
        const { value, done } = await reader.read();
        if (value) prefix += decoder.decode(value.slice(0, 128), { stream: true });
        if (done || /^\s*#EXTM3U\b/.test(prefix)) break;
      }
      return /^\s*#EXTM3U\b/.test(prefix) ? response.status : 0;
    } finally { await reader.cancel(); }
  } catch { return 0; } // No proof of validity: wait for a successful page/network observation.
  finally { clearTimeout(timer); }
}

// A refresh is a persisted job, never a promise owned by a popup or document.
const JOB_STORAGE_KEY = "downloadJobsV6";
const REFRESH_TIMEOUT_MS = 120000;
const REFRESH_TIMEOUT_MESSAGE = "未捕获到有效的新媒体链接。请播放视频后重试；页面未自动刷新。";
const REFRESH_PHASES = new Set(["WAITING_FOR_FRESH_MEDIA_REQUEST", "URL_STALE", "REFRESH_REQUESTED", "PAGE_RELOADING", "CONTENT_READY", "RESNIFFING", "FRESH_CANDIDATE_FOUND"]);
const refreshRunners = new Set();
const refreshTimers = new Map();
const refreshDeadlineTimers = new Map();
let jobWrites = Promise.resolve();
let jobsInitialized = false;
const jobsReady = detectionReady.then(restoreDownloadJobs).then(() => {
  jobsInitialized = true;
  for (const job of jobs.values()) {
    if (REFRESH_PHASES.has(job.flowState)) void continueRefresh(job.id);
  }
  void processQueue();
}).catch(error => {
  console.error("[VideoHelperJobs] restore failed", error.message);
  jobsInitialized = true;
});

function persistDownloadJobs() {
  const list = [...jobs.values()];
  const retained = list.filter(job => !TERMINAL_JOB_STATUSES.has(job.status))
    .concat(list.filter(job => TERMINAL_JOB_STATUSES.has(job.status)).slice(-30));
  const snapshot = JSON.parse(JSON.stringify(retained));
  const write = jobWrites.catch(() => {}).then(async () => {
    await chrome.storage.session.set({ [JOB_STORAGE_KEY]: snapshot, downloadQueuePausedV6: queuePaused });
    // Persist job history across browser restarts; request cookies remain session-only.
    const durable = snapshot.map(job => {
      const clean = structured => {
        const copy = { ...structured };
        for (const key of ["headers", "renditionMasterHeaders"]) if (copy[key]) {
          copy[key] = { ...copy[key] };
          delete copy[key].cookie;
          delete copy[key].authorization;
        }
        return copy;
      };
      return { ...job, payload: clean(job.payload), originalPayload: clean(job.originalPayload) };
    });
    await chrome.storage.local.set({ downloadJobsV8: durable });
  });
  jobWrites = write;
  return write;
}

async function restoreDownloadJobs() {
  const saved = await chrome.storage.session.get({ [JOB_STORAGE_KEY]: [], downloadQueuePausedV6: false });
  queuePaused = saved.downloadQueuePausedV6 === true;
  const durable = await chrome.storage.local.get({ downloadJobsV8: [] });
  const merged = new Map((durable.downloadJobsV8 || []).map(job => [job.id, job]));
  for (const job of saved[JOB_STORAGE_KEY] || []) merged.set(job.id, job);
  for (const job of merged.values()) if (job?.id && job.payload && !jobs.has(job.id)) jobs.set(job.id, job);
  for (const job of jobs.values()) {
    if (!["completed", "cancelled"].includes(job.status) && (job.nativeDispatched || ["failed", "incomplete"].includes(job.status))) {
      await reconcileNativeJob(job);
    }
    if (TERMINAL_JOB_STATUSES.has(job.status) || job.reconciling) continue;
    if (REFRESH_PHASES.has(job.flowState)) {
      job.status = "downloading";
      await armRefreshDeadline(job);
    } else if (job.nativeDispatched) {
      // A detached native process has no reconnect API. Never silently duplicate it.
      job.status = "incomplete"; job.flowState = "INCOMPLETE";
      job.error = job.message = "下载连接已中断，未确认完成；可重试/续传。";
    } else {
      job.status = queuePaused ? "paused" : "queued";
    }
  }
  await persistDownloadJobs();
}

function queryNativeJob(jobId) {
  return new Promise((resolve, reject) => {
    let port, timer;
    let settled = false;
    const finish = (value, error) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (port) safeDisconnect(port);
      error ? reject(error) : resolve(value);
    };
    try {
      port = chrome.runtime.connectNative(HOST_NAME);
      port.onMessage.addListener(message => {
        if (message.jobId === jobId && message.type === "job_status") finish(message);
      });
      port.onDisconnect.addListener(() => finish(null, new Error("本地状态查询连接中断。")));
      timer = setTimeout(() => finish(null, new Error("本地状态查询超时。")), 15000);
      timer.unref?.();
      port.postMessage({ action: "status", jobId });
    } catch (error) { finish(null, error); }
  });
}

async function exportJobDiagnostics(jobId) {
  await jobsReady;
  const job = jobs.get(jobId);
  if (!job) throw new Error("找不到下载任务。");
  const snapshot = {
    version: chrome.runtime.getManifest().version_name, generatedAt: new Date().toISOString(),
    jobId, title: job.title, status: job.status, message: job.message, error: job.error,
    details: job.details, exitCode: job.exitCode ?? null, logs: job.logs, flow: job.flowLog,
    pageUrl: diagnosticUrl(job.pageUrl), resourceUrl: diagnosticUrl(job.payload.url)
  };
  let port;
  try {
    const nativeLog = await new Promise((resolve, reject) => {
      port = chrome.runtime.connectNative(HOST_NAME);
      const chunks = [];
      let timer;
      const finish = (error) => {
        clearTimeout(timer);
        error ? reject(error) : resolve(chunks.join(""));
      };
      const read = offset => {
        clearTimeout(timer);
        timer = setTimeout(() => finish(new Error("读取本地诊断超时。")), 10000);
        port.postMessage({ action: "diagnostics", jobId, offset });
      };
      port.onDisconnect.addListener(() => finish(new Error("本地诊断连接中断。")));
      port.onMessage.addListener(response => {
        if (response.type !== "job_diagnostics" || response.jobId !== jobId) return;
        chunks.push(response.data);
        if (response.done) finish();
        else read(response.offset);
      });
      read(0);
    });
    snapshot.nativeLog = nativeLog.split("\n").filter(Boolean).map(line => JSON.parse(line));
    if (snapshot.exitCode == null) {
      snapshot.exitCode = snapshot.nativeLog.findLast(entry => entry.event === "process_exit")?.exitCode ?? null;
    }
  } catch (error) {
    snapshot.nativeLogError = error.message;
  } finally {
    if (port) safeDisconnect(port);
  }
  return snapshot;
}

async function reconcileNativeJob(job) {
  if (job.status === "completed") return;
  const generation = job.attemptId;
  try {
    const result = await queryNativeJob(job.id);
    if (generation !== job.attemptId || job.status === "completed") return;
    const saved = result.state || {};
    if (result.active) {
      Object.assign(job, { status: "downloading", reconciling: true, message: "本地任务仍在处理，正在恢复状态…" });
      await chrome.alarms?.create?.(`video-status:${job.id}`, { when: Date.now() + 5000 });
    } else if (saved.status === "completed") {
      // Authoritative disk ledger may repair a beta.7 failed card.
      const { outputPath, fileSize, duration, hasAudio, width, height } = saved;
      Object.assign(job, { outputPath, fileSize, duration, hasAudio, width, height,
        status: "completed", flowState: "DONE", reconciling: false,
        percent: "100", error: "", details: "", validationPending: false, exitCode: saved.exitCode ?? job.exitCode,
        message: "下载完成，最终 MP4 已通过校验。" });
      await saveHistory(publicJob(job));
    } else {
      Object.assign(job, { status: saved.status === "failed" ? "failed" : "incomplete",
        flowState: "INCOMPLETE", reconciling: false, outputPath: saved.outputPath || job.outputPath,
        exitCode: saved.exitCode ?? job.exitCode, error: saved.error || job.error, speed: "", eta: "",
        validationPending: Boolean(saved.validationPending),
        details: saved.details || job.details, message: saved.message || "未确认完成，可重试/续传。" });
    }
  } catch (error) {
    job.status = "incomplete"; job.reconciling = false;
    job.message = `未确认完成：${error.message} 可稍后重试/续传。`;
  }
  await persistDownloadJobs(); broadcastJob(job);
}

async function retryJob(jobId) {
  const job = jobs.get(jobId);
  if (!job || !["incomplete", "failed", "cancelled"].includes(job.status)) return;
  await reconcileNativeJob(job);
  if (job.status === "completed" || job.reconciling) return;
  Object.assign(job, { status: "queued", flowState: "DOWNLOAD_START", retryCount: 0,
    nativeDispatched: false, rejectedUrls: [], error: "", details: "", exitCode: null, percent: "",
    speed: "", eta: "",
    playerRefreshAttempted: false, refreshRequestedAt: 0, refreshDeadline: 0, message: "准备重试…" });
  const state = tabState.get(job.payload.tabId);
  const resource = state?.streams.get(job.payload.resourceId);
  const sameResource = resource && (resource.lastUrl || resource.url) === job.payload.resourceUrl;
  job.payload = deepFreeze({ ...job.payload, refreshAttempt: 0,
    headers: sameResource ? downloadHeaders(state, resource, job.payload.url) : job.payload.headers,
    renditionMasterHeaders: sameResource && job.payload.renditionMasterUrl
      ? downloadHeaders(state, resource, job.payload.renditionMasterUrl) : job.payload.renditionMasterHeaders });
  await persistDownloadJobs(); broadcastJob(job); void processQueue();
}

function logJobFlow(job, event, details = {}) {
  const entry = { at: Date.now(), jobId: job.id, event, ...details };
  job.flowLog = [...(job.flowLog || []), entry].slice(-120);
  console.info("[VideoHelperJobs]", entry);
}

async function transitionJob(job, flowState, message, patch = {}) {
  if (TERMINAL_JOB_STATUSES.has(job.status)) return false;
  Object.assign(job, patch, { flowState, message, updatedAt: Date.now() });
  logJobFlow(job, flowState);
  await persistDownloadJobs(); // This must finish before reload or native dispatch.
  broadcastJob(job);
  return !TERMINAL_JOB_STATUSES.has(job.status);
}

async function failRefreshJob(job, message) {
  if (TERMINAL_JOB_STATUSES.has(job.status)) return;
  updateJob(job.id, { status: job.outputPath ? "incomplete" : "failed", error: message, message: job.outputPath ? `${message} 未完成，可重试/续传。` : message, flowState: "FAILED" });
  const port = runningPorts.get(job.id);
  runningPorts.delete(job.id);
  if (port) safeDisconnect(port);
  clearTimeout(refreshTimers.get(job.id)); refreshTimers.delete(job.id);
  clearTimeout(refreshDeadlineTimers.get(job.id)); refreshDeadlineTimers.delete(job.id);
  await chrome.alarms?.clear?.(`video-refresh:${job.id}`);
  await persistDownloadJobs();
  void processQueue();
}

async function armRefreshDeadline(job) {
  if (!job.refreshDeadline) return;
  clearTimeout(refreshDeadlineTimers.get(job.id));
  const timer = setTimeout(() => { void expireRefreshJob(job.id); }, Math.max(1, job.refreshDeadline - Date.now()));
  timer.unref?.();
  refreshDeadlineTimers.set(job.id, timer);
  await chrome.alarms?.create?.(`video-refresh:${job.id}`, { when: Math.max(Date.now() + 1, job.refreshDeadline) });
}

function scheduleRefresh(job) {
  if (refreshTimers.has(job.id) || !REFRESH_PHASES.has(job.flowState) || TERMINAL_JOB_STATUSES.has(job.status)) return;
  const timer = setTimeout(() => {
    refreshTimers.delete(job.id);
    void continueRefresh(job.id);
  }, Math.max(1, Math.min(2000, (job.refreshDeadline || Date.now() + 2000) - Date.now())));
  timer.unref?.();
  refreshTimers.set(job.id, timer);
}

async function wakeRefreshForTab(tabId, event, sender = {}) {
  await jobsReady;
  for (const job of jobs.values()) {
    if (job.payload.tabId !== tabId || !REFRESH_PHASES.has(job.flowState) || TERMINAL_JOB_STATUSES.has(job.status)) continue;
    if (sender.url && !samePageIdentity(sender.url, job.payload.pageUrl)) continue;
    if (event === "content READY") {
      if (sender.frameId && sender.frameId !== 0) continue;
      if (job.reloaded && sender.documentId && sender.documentId === job.reloadDocumentId) continue;
      logJobFlow(job, event, { documentId: sender.documentId || "" });
      if (job.reloaded) {
        await transitionJob(job, "CONTENT_READY", "页面已就绪，正在重新检测 HLS…", { contentReadyAt: Date.now() });
      }
      try { await chrome.tabs.sendMessage(tabId, { type: "resniffMedia", jobId: job.id }); } catch {}
    } else {
      logJobFlow(job, event);
      await persistDownloadJobs();
    }
    void continueRefresh(job.id);
  }
}

async function expireRefreshJob(jobId) {
  await jobsReady;
  const job = jobs.get(jobId);
  if (!job || !REFRESH_PHASES.has(job.flowState) || TERMINAL_JOB_STATUSES.has(job.status)) return;
  if (Date.now() >= job.refreshDeadline) await failRefreshJob(job, REFRESH_TIMEOUT_MESSAGE);
  else { await armRefreshDeadline(job); void continueRefresh(jobId); }
}

chrome.alarms?.onAlarm.addListener(alarm => {
  if (alarm.name.startsWith("video-status:")) {
    void jobsReady.then(async () => { const job = jobs.get(alarm.name.slice(13)); if (job) await reconcileNativeJob(job); void processQueue(); });
    return;
  }
  if (!alarm.name.startsWith("video-refresh:")) return;
  void expireRefreshJob(alarm.name.slice("video-refresh:".length));
});

function mediaPath(url) {
  const parsed = safeUrl(url);
  if (!parsed) return "";
  const ids = [...parsed.searchParams].filter(([key]) => /^(id|video_?id|vid|asset_?id|content_?id|cid|bvid)$/i.test(key));
  const origin = /(?:^|\.)phncdn\.com$/i.test(parsed.hostname) ? "https://phncdn.com" : parsed.origin;
  return origin + parsed.pathname + (ids.length ? "?" + JSON.stringify(ids.sort()) : "");
}

function matchingHlsCandidates(job, state, freshOnly, allowProbe = false) {
  const original = job.originalPayload || job.payload;
  const source = original.masterUrl || original.url;
  const originalPaths = new Set([source, original.resourceUrl, ...(original.variantUrls || [])].filter(Boolean).map(mediaPath));
  const rejected = new Set(job.rejectedUrls || []);
  return [...state.streams.values()].filter(stream => {
    const url = stream.lastUrl || stream.url;
    if (!isHlsKind(stream.kind) || !samePageIdentity(state.pageUrl, original.pageUrl)
      || !streamMatchesActiveMedia(state, stream) || state.playlistInfo.get(url)?.drm) return false;
    const rejection = activeResourceRejection(state, stream);
    if (rejection && rejection !== "unverified-player") return false;
    const snapshot = original.mediaSnapshot;
    const active = state.mediaCandidates?.get?.(state.activeMediaId);
    if (snapshot && active) {
      if (snapshot.videoElementToken && snapshot.videoElementToken !== active.videoElementToken) return false;
      if (snapshot.frameId != null && snapshot.frameId !== active.frameId) return false;
      if (snapshot.mediaId !== active.mediaId && snapshot.currentSrc && active.currentSrc &&
        mediaPath(snapshot.currentSrc) !== mediaPath(active.currentSrc)) return false;
    }
    if (stream.capturedPageUrl && !samePageIdentity(stream.capturedPageUrl, original.pageUrl)) return false;
    // Never widen matching to an arbitrary HLS on the same page. Exact CDN asset paths
    // and a captured master/variant relationship are stronger than a mutable page title.
    const master = hlsMasterUrl(state, stream);
    const relatedMaster = stream.kind === "hls_master" &&
      (stream.variantUrls || state.playlistInfo.get(url)?.variantUrls || []).some(value => originalPaths.has(mediaPath(value)));
    if (!originalPaths.has(mediaPath(url)) && !originalPaths.has(mediaPath(master)) && !relatedMaster) return false;
    // A captured matching variant is usable when the old master has expired.
    const title = value => String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
    const candidateTitle = state.mediaCandidates?.get?.(state.activeMediaId || stream.mediaId)?.title || state.pageTitle;
    if (original.pageTitle && candidateTitle && title(original.pageTitle) !== title(candidateTitle)) return false;
    if (original.videoIdentity && state.videoId && state.videoId !== original.videoIdentity) return false;
    const duration = playlistDuration(state, stream) || Number(stream.duration || 0);
    if (duration && original.expectedDuration && Math.abs(duration - original.expectedDuration) > Math.max(10, original.expectedDuration * 0.1)) return false;
    if (stream.kind !== "hls_master" && original.selectedHeight && stream.quality && stream.quality !== original.selectedHeight) return false;
    if (rejected.has(url)) return false;
    const recent = (state.recentMedia || []).filter(item => item.url === url).at(-1);
    if ((recent?.status >= 400 && (freshOnly || url !== job.payload.url)) || expiryRemaining(url) < 60) return false;
    // Player/config snapshots are hints, not evidence of a newly issued request.
    if ((!allowProbe || freshOnly) && (!recent || Date.now() - recent.observedAt > 90000)) return false;
    if (freshOnly && recent.observedAt < (job.refreshRequestedAt || 0) && url === job.payload.url) return false;
    if (job.reloaded && (stream.detectedAt || stream.firstSeen || 0) < job.reloadStartedAt) return false;
    return true;
  }).sort((a, b) => {
    if (!freshOnly) {
      const selected = stream => Number((stream.lastUrl || stream.url) === job.payload.url);
      const priority = selected(b) - selected(a);
      if (priority) return priority;
    }
    return b.lastSeen - a.lastSeen || Number(b.kind === "hls_master") - Number(a.kind === "hls_master");
  });
}

async function sniffJobCandidate(job, freshOnly) {
  const tab = await chrome.tabs.get(job.payload.tabId);
  if (!samePageIdentity(tab.url, job.payload.pageUrl)) throw new Error("原视频页面已切换，无法恢复下载。请在原视频页面重新加入。");
  let state = tabState.get(tab.id);
  if (!state || state.invalidated) return null;
  state = await collectMediaHints(tab, state);
  if (!state || state.invalidated) return null;
  const candidates = matchingHlsCandidates(job, state, freshOnly, true);
  logJobFlow(job, "candidate count", { count: candidates.length, titleMatches: state.pageTitle === (job.originalPayload || job.payload).pageTitle });
  for (const stream of candidates.slice(0, 3)) {
    const url = stream.lastUrl || stream.url;
    const recent = (state.recentMedia || []).filter(item => item.url === url).at(-1);
    const headers = downloadHeaders(state, stream, url);
    const knownStatus = recent?.status && Date.now() - recent.observedAt <= 30000 ? recent.status : 0;
    const status = knownStatus || await checkCurrentHls(url, headers, job.payload.pageUrl);
    if (TERMINAL_JOB_STATUSES.has(job.status)) return null;
    const currentTab = await chrome.tabs.get(tab.id);
    if (!samePageIdentity(currentTab.url, job.payload.pageUrl)) throw new Error("刷新期间页面已切换，已停止下载。");
    const currentState = tabState.get(tab.id);
    if (currentState !== state || !streamMatchesActiveMedia(state, stream)) return null;
    const rejection = activeResourceRejection(state, stream);
    if (rejection && rejection !== "unverified-player") continue;
    if (status >= 400) job.details = `HLS 链接预检返回 HTTP ${status}。`;
    // Extension fetch can have a different Cookie and referrer policy from
    // playback. Let the native downloader check the exact selected request.
    const useNativeCheck = !freshOnly && url === job.payload.url && [0, 401, 403].includes(status);
    if (!useNativeCheck && (status === 403 || status === 410)) {
      job.rejectedUrls = [...new Set([...(job.rejectedUrls || []), url])];
      logJobFlow(job, "URL_STALE", { status });
      continue;
    }
    if (!useNativeCheck && !(status >= 200 && status < 300)) {
      if (!freshOnly && url === job.payload.url && [404, 429].includes(status)) {
        throw new Error(`HLS 请求返回 HTTP ${status}。`);
      }
      continue;
    }
    if (expiryRemaining(url) < 60) continue;
    const requestAge = recent ? Date.now() - recent.observedAt : null;
    const next = { ...job.payload, url, resourceUrl: url, kind: stream.kind,
      masterUrl: hlsMasterUrl(state, stream), variantUrls: stream.variantUrls || state.playlistInfo.get(url)?.variantUrls || [],
      detectedAt: stream.detectedAt || stream.firstSeen, ...mediaUrlContext(url), headers,
      sourceContext: { frameId: stream.frameId, documentId: stream.documentId, documentUrl: stream.documentUrl, source: stream.source },
      referer: headers.referer || job.payload.referer, refreshedAt: Date.now(),
      refreshBeforeHash: await mediaUrlHash((job.originalPayload || job.payload).url), refreshAfterHash: await mediaUrlHash(url),
      refreshAttempt: job.retryCount || 0 };
    logJobFlow(job, "selected URL hash", { hash: next.refreshAfterHash, source: requestAge != null && requestAge <= 30000 ? recent.source : "preflight", lastGoodMediaRequestAgeMs: requestAge != null && requestAge <= 30000 ? requestAge : 0, expiryRemaining: Number.isFinite(expiryRemaining(url)) ? expiryRemaining(url) : null });
    return next;
  }
  return null;
}

async function requestJobRefresh(job, status) {
  if (TERMINAL_JOB_STATUSES.has(job.status) || REFRESH_PHASES.has(job.flowState)) return;
  // Native only requests refresh after its writer has exited. Detach this generation
  // before awaiting persistence so late old-port events cannot alter the job.
  const oldPort = runningPorts.get(job.id);
  runningPorts.delete(job.id);
  if (oldPort) safeDisconnect(oldPort);
  if ((job.retryCount || 0) >= 1) {
    return failRefreshJob(job, `重新获取链接后仍返回 HTTP ${status}，已停止自动重试。`);
  }
  if (!await transitionJob(job, "URL_STALE", "媒体请求失败或链接将过期，正在重新检测…", {
    retryCount: 1, refreshAttempts: 1, nativeDispatched: false, refreshRequestedAt: Date.now(),
    refreshDeadline: Date.now() + REFRESH_TIMEOUT_MS,
    rejectedUrls: [...new Set([...(job.rejectedUrls || []), ...([403, 410].includes(Number(status)) ? [job.payload.url] : [])])]
  })) return;
  await transitionJob(job, "REFRESH_REQUESTED", "正在重新获取当前视频的 HLS 链接…");
  logJobFlow(job, "refresh requested", { status });
  await armRefreshDeadline(job);
  await persistDownloadJobs();
  const port = runningPorts.get(job.id);
  runningPorts.delete(job.id);
  if (port) safeDisconnect(port);
  void continueRefresh(job.id);
}

async function resumeJobDownload(job, freshPayload) {
  if (TERMINAL_JOB_STATUSES.has(job.status)) return;
  const tab = !job.payload.exactSelection && job.payload.tabId != null ? await chrome.tabs.get(job.payload.tabId) : null;
  if (tab && !samePageIdentity(tab.url, job.payload.pageUrl)) throw new Error("原视频页面已切换，已停止恢复下载。");
  job.payload = deepFreeze(freshPayload || job.payload);
  if (!await transitionJob(job, "RESUME_DOWNLOAD", "已获得媒体链接，正在恢复下载…", { nativeDispatched: true, status: "downloading" })) return;
  await chrome.alarms?.clear?.(`video-refresh:${job.id}`);
  clearTimeout(refreshTimers.get(job.id)); refreshTimers.delete(job.id);
  clearTimeout(refreshDeadlineTimers.get(job.id)); refreshDeadlineTimers.delete(job.id);
  logJobFlow(job, "resume download");
  await startNativeJob(job, job.payload.settings || await loadSettings());
}

async function continueRefresh(jobId) {
  const job = jobs.get(jobId);
  if (!job || TERMINAL_JOB_STATUSES.has(job.status) || !REFRESH_PHASES.has(job.flowState) || refreshRunners.has(jobId)) return;
  refreshRunners.add(jobId);
  try {
    if (job.refreshDeadline && Date.now() >= job.refreshDeadline) return await failRefreshJob(job, REFRESH_TIMEOUT_MESSAGE);
    if (job.flowState === "FRESH_CANDIDATE_FOUND") return await resumeJobDownload(job, job.payload);
    if (job.flowState !== "WAITING_FOR_FRESH_MEDIA_REQUEST")
      await transitionJob(job, "WAITING_FOR_FRESH_MEDIA_REQUEST", "等待播放器生成新的媒体链接…可播放视频以继续。");
    const next = await sniffJobCandidate(job, true);
    if (TERMINAL_JOB_STATUSES.has(job.status)) return;
    if (next) {
      if (!await transitionJob(job, "FRESH_CANDIDATE_FOUND", "已捕获新的 HLS 链接…", { payload: next })) return;
      return await resumeJobDownload(job, next);
    }
    if (!job.playerRefreshAttempted) {
      job.playerRefreshAttempted = true;
      await persistDownloadJobs();
      await requestPlayerMedia(job);
    }
    await persistDownloadJobs();
  } catch (error) {
    await failRefreshJob(job, error.message || "刷新媒体链接失败。");
  } finally {
    refreshRunners.delete(jobId);
    scheduleRefresh(job);
  }
}

async function startDownload(tabId, selection, options = {}) {
  await jobsReady;
  const settings = await loadSettings();
  let state = tabState.get(tabId);
  if (!state) return staleSelectionResponse();
  if (pageExtractorInfo(state.pageUrl)?.provider === "bilibili") {
    state = await refreshSiteMediaForDownload(tabId, state);
  }
  const resolved = validateDownloadSelection(state, selection || {});
  if (!resolved.ok) return resolved;

  let payload = buildDownloadPayload(state, resolved.stream, settings, {
    qualityPreference: selection?.qualityPreference || "", exact: resolved.exact,
    displayedTitle: typeof selection?.sourceTitle === "string" ? selection.sourceTitle.trim().slice(0, 300) : ""
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
  if (!stream) return staleSelectionResponse();
  const exact = selection.exactSelection === true;
  const resourceUrl = stream.lastUrl || stream.url;
  if (exact) {
    if (!isWholeResource(stream.kind) || state.segmentOwners.has(resourceUrl) ||
      stream.audioOnly || selection.resourceUrl !== resourceUrl) return staleSelectionResponse();
    const unavailable = resourceAvailability(state, stream);
    if (unavailable) return { ok: false, error: unavailable };
  } else if (!["page_extractor", "bilibili_dash"].includes(stream.kind)) {
    return staleSelectionResponse();
  } else if (selection.resourceUrl && normalizeResourceUrl(selection.resourceUrl) !== normalizeResourceUrl(resourceUrl)) {
    return staleSelectionResponse();
  }
  const fingerprint = resourceFingerprint(state, stream);
  if (selection.fingerprint && selection.fingerprint !== fingerprint) return staleSelectionResponse();
  return { ok: true, stream, exact };
}

function staleSelectionResponse() {
  return {
    ok: false,
    stale: true,
    error: "页面或播放器已切换，旧候选已失效。请刷新检测结果后再下载。"
  };
}

function playlistDuration(state, stream) {
  const url = stream.lastUrl || stream.url;
  const playlist = state.playlistInfo?.get(url);
  return playlist?.live === false ? Number(playlist.duration || 0)
    : Number(stream.verifiedDuration || state.streams?.get(streamKey(url))?.verifiedDuration || 0);
}

function durationMatches(expected, actual) {
  return Math.abs(expected - actual) <= Math.max(8, expected * 0.15);
}

function variantDurations(state, stream) {
  const url = stream.lastUrl || stream.url;
  const variants = state.playlistInfo?.get(url)?.variantUrls || stream.variantUrls || [];
  return variants.map(variant => playlistDuration(state, { url: variant })).filter(Boolean);
}

function matchingVariantDuration(state, stream) {
  if (!state.videoDuration || !isHlsKind(stream.kind)) return 0;
  return variantDurations(state, stream).find(duration => durationMatches(state.videoDuration, duration)) || 0;
}

function activeResourceRejection(state, stream) {
  if (!isHlsKind(stream.kind) && !isDirectVideoKind(stream.kind)) return "";
  const expected = state.videoDuration;
  const duration = playlistDuration(state, stream) || (stream.association === "secondary-dom" ? stream.duration : 0);
  if (!expected && state.hasVideoElement && duration > 0 && duration <= 30 && !isBoundToMainPlayer(state, stream)) {
    return "unverified-short-clip";
  }
  if (!(expected >= 120)) return "";
  if (state.mainFrameId != null && stream.frameId != null && state.mainFrameId !== stream.frameId) return "different-frame";
  if (duration) return durationMatches(expected, duration) ? "" : "duration-mismatch";
  const measuredVariants = variantDurations(state, stream);
  if (measuredVariants.some(value => !durationMatches(expected, value))) return "variant-duration-mismatch";
  if (isBoundToMainPlayer(state, stream) || measuredVariants.length) return "";
  // Frame/timing evidence is useful for discovery, but does not identify a long-form video.
  return "unverified-player";
}

function isBoundToMainPlayer(state, stream) {
  const url = stream.lastUrl || stream.url;
  const direct = Boolean(state.currentSrc && normalizeResourceUrl(url) === normalizeResourceUrl(state.currentSrc));
  return direct || ["main-current-src", "main-player"].includes(stream.association) &&
    (!stream.playerSrc || stream.playerSrc === state.currentSrc);
}

function streamMatchesActiveMedia(state, stream) {
  if (!state.activeMediaId || (!isHlsKind(stream.kind) && !isDirectVideoKind(stream.kind))) return true;
  const url = stream.lastUrl || stream.url;
  if (state.currentSrc && normalizeResourceUrl(url) === normalizeResourceUrl(state.currentSrc)) return true;
  if (stream.mediaId && stream.mediaId !== state.activeMediaId) {
    const owner = state.mediaCandidates?.get(stream.mediaId);
    const duration = playlistDuration(state, stream) || matchingVariantDuration(state, stream);
    // Recover an HLS request initially attributed to a short overlay in the same frame.
    return Boolean(owner && !owner.stale && owner.duration > 0 && owner.duration <= 30 &&
      owner.frameId === state.mainFrameId && state.videoDuration >= 120 && duration &&
      durationMatches(state.videoDuration, duration));
  }
  if (stream.mediaId) return true;
  const active = state.mediaCandidates?.get?.(state.activeMediaId);
  return !active || stream.frameId === active.frameId &&
    (stream.firstSeen || stream.lastSeen || 0) >= (active.lastSourceChangeAt || state.activeMediaChangedAt || 0) - 1500;
}

function downloadHeaders(state, stream, targetUrl) {
  const target = state.headersByUrl.get(headerKey(targetUrl)) || state.streams.get(streamKey(targetUrl))?.headers || {};
  const headers = { ...stream.headers, ...target };
  if (headerKey(targetUrl) !== headerKey(stream.lastUrl || stream.url)) {
    // Never carry Cookie/Authorization from a different request into this URL.
    for (const name of ["cookie", "authorization"]) if (!target[name]) delete headers[name];
  }
  return headers;
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
  const exact = options.exact === true;
  const targetUrl = exact ? streamUrl : usePageExtractor ? pageUrl
    : useBilibiliDash ? (selectedBilibiliVideo?.baseUrl || streamUrl)
      : (isHlsKind(stream.kind) ? hlsMasterUrl(state, stream) || streamUrl : streamUrl);
  const kind = usePageExtractor ? "page" : stream.kind;
  const headers = downloadHeaders(state, stream, targetUrl);
  const owner = state.mediaCandidates.get(stream.mediaId);
  const variant = exact && stream.variant?.audioUrl ? stream.variant : null;
  const ownDuration = playlistDuration(state, stream) || stream.duration || 0;
  const bound = isBoundToMainPlayer(state, stream) && streamMatchesActiveMedia(state, stream);
  const masterDurations = exact && stream.kind === "hls_master" ? variantDurations(state, stream) : [];
  const commonDuration = masterDurations.length && masterDurations.every(value => durationMatches(masterDurations[0], value))
    ? masterDurations[0] : 0;
  const expectedDuration = exact ? ownDuration || commonDuration || (bound ? state.videoDuration : 0)
    : state.videoDuration || owner?.duration || ownDuration;
  const resourceTitle = exact ? options.displayedTitle || detectedResourceTitle(state, stream, owner)
    : state.mediaCandidates?.get?.(state.activeMediaId || stream.mediaId)?.title || state.pageTitle || getHost(targetUrl) || "video";
  const resourceUrl = stream.lastUrl || stream.url;
  const payload = {
    action: "download",
    exactSelection: exact,
    renditionUrl: variant ? streamUrl : "",
    renditionAudioUrl: variant?.audioUrl || "",
    renditionMasterUrl: variant?.masterUrl || "",
    renditionMasterHeaders: variant ? downloadHeaders(state, stream, variant.masterUrl) : undefined,
    tabId: state.tabId,
    mediaId: state.activeMediaId || stream.mediaId || "",
    mediaSnapshot: (() => {
      const candidate = state.mediaCandidates?.get?.(state.activeMediaId || stream.mediaId);
      return candidate ? { mediaId: candidate.mediaId, frameId: candidate.frameId,
        videoElementToken: candidate.videoElementToken, currentSrc: candidate.currentSrc,
        duration: candidate.duration, title: candidate.title, capturedAt: Date.now() } : undefined;
    })(),
    detectedAt: stream.detectedAt || stream.firstSeen,
    videoIdentity: state.videoId || "",
    selectedHeight: stream.quality || 0,
    downloadFormat: "mp4",
    masterUrl: isHlsKind(stream.kind) ? hlsMasterUrl(state, stream) : "",
    variantUrls: stream.variantUrls || state.playlistInfo.get(hlsMasterUrl(state, stream))?.variantUrls || [],
    sourceContext: { frameId: stream.frameId, documentUrl: stream.documentUrl, source: stream.source },
    ...mediaUrlContext(targetUrl),
    url: targetUrl,
    originalUrl: stream.url,
    resourceUrl,
    resourceId: stream.id,
    sessionId: state.sessionId,
    fingerprint: resourceFingerprint(state, stream),
    pageUrl,
    pageTitle: exact ? state.pageTitle || resourceTitle : resourceTitle,
    sourceTitle: resourceTitle,
    currentSrc: state.currentSrc || "",
    kind,
    expectedDuration,
    expectedHeight: exact ? stream.variant?.height || stream.verifiedHeight || 0 : 0,
    enforceDuration: exact ? expectedDuration > 0 : Boolean(isWholeResource(kind) && state.videoDuration >= 120),
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
    qualityPreference: exact ? "best" : options.qualityPreference || settings.defaultQuality,
    settings: { ...settings }
  };
  return deepFreeze(payload);
}

async function enqueueDownload(payload, settings, options = {}) {
  await jobsReady;
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
    payload,
    originalPayload: payload,
    flowState: "DOWNLOAD_START",
    retryCount: 0,
    downloadFormat: "mp4",
    nativeDispatched: false
  };
  jobs.set(jobId, job);
  logJobFlow(job, "DOWNLOAD_START");
  await persistDownloadJobs();
  broadcastJob(job);
  if (!options.quiet) processQueue();
  return { ok: true, jobId };
}

async function processQueue() {
  if (!jobsInitialized || processingQueue || queuePaused) return;
  processingQueue = true;
  try {
    const settings = await loadSettings();
    const maxConcurrent = Math.max(1, Math.min(6, Number(settings.maxConcurrent) || 2));
    while (!queuePaused && [...jobs.values()].filter(item => ["downloading", "merging"].includes(item.status)).length < maxConcurrent) {
      const job = Array.from(jobs.values()).find((item) => item.status === "queued");
      if (!job) break;
      try {
        await transitionJob(job, "DOWNLOAD_START", "正在检查当前媒体链接…", { status: "downloading" });
        const hls = !job.payload.exactSelection && isHlsKind(job.payload.kind) && job.payload.tabId != null;
        const next = hls ? await sniffJobCandidate(job, false) : job.payload;
        if (TERMINAL_JOB_STATUSES.has(job.status)) continue;
        if (hls && !next) await requestJobRefresh(job, "preflight");
        else await resumeJobDownload(job, next);
      } catch (error) {
        await failRefreshJob(job, error.message);
      }
    }
  } finally {
    processingQueue = false;
  }
}

async function startNativeJob(job, settings) {
  if (job.status === "completed" || runningPorts.has(job.id)) return;
  const attemptId = crypto.randomUUID();
  job.attemptId = attemptId;
  job.nativeDispatched = true;
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
    if (!current || current.attemptId !== attemptId || runningPorts.get(job.id) !== port || !["downloading", "merging"].includes(current.status)) return;
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

  port.onMessage.addListener(async (message) => {
    if (!message || message.jobId !== job.id) return;
    clearStartTimer();

    const current = jobs.get(job.id);
    if (!current || current.attemptId !== attemptId || runningPorts.get(job.id) !== port || (message.attemptId && message.attemptId !== attemptId) || TERMINAL_JOB_STATUSES.has(current.status)) return;

    if (["download_started", "finalizing"].includes(message.type)) {
      updateJob(job.id, { outputPath: message.outputPath || current.outputPath,
        status: message.type === "finalizing" ? "merging" : "downloading", message: message.message });
    }
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

    if (message.type === "complete" || message.type === "completed") {
      logJobFlow(current, "native result", { type: "complete" });
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
        exitCode: message.exitCode ?? null,
        warningCount: Number(message.warningCount || 0),
        warnings: Array.isArray(message.warnings) ? message.warnings.slice(0, 10) : [],
        error: "",
        details: "",
        validationPending: false,
        percent: "100",
        speed: "",
        eta: ""
      });
      saveHistory(publicJob(jobs.get(job.id)));
      runningPorts.delete(job.id);
      safeDisconnect(port);
      processQueue();
    }

    if (message.type === "refresh_required") {
      logJobFlow(current, "native result", { type: message.type, status: message.status });
      updateJob(job.id, { exitCode: message.exitCode ?? null, details: message.details || "" });
      try { await requestJobRefresh(current, message.status); }
      catch (error) { await failRefreshJob(current, error.message); }
      return;
    }

    if (["error", "failed", "incomplete"].includes(message.type)) {
      logJobFlow(current, "native result", { type: "error" });
      updateJob(job.id, {
        status: message.type === "incomplete" ? "incomplete" : "failed",
        error: message.error || "Download failed.",
        details: message.details || message.error || "Download failed.",
        validationPending: Boolean(message.validationPending),
        speed: "", eta: "",
        exitCode: message.exitCode ?? null,
        message: message.message || message.error || "Download failed."
      });
      runningPorts.delete(job.id);
      safeDisconnect(port);
      processQueue();
    }
  });

  port.onDisconnect.addListener(() => {
    clearStartTimer();
    if (runningPorts.get(job.id) !== port) return;
    runningPorts.delete(job.id);
    const current = jobs.get(job.id);
    if (!current || ["completed", "failed", "cancelled"].includes(current.status)) {
      processQueue();
      return;
    }
    if (current.attemptId !== attemptId) return;
    updateJob(job.id, { status: "merging", message: "连接中断，正在核对本地结果…" });
    void reconcileNativeJob(current).then(() => processQueue());
    processQueue();
  });

  const nativePayload = {
    ...job.payload,
    jobId: job.id,
    attemptId,
    downloadStartedAt: Date.now(),
    settings: {
      ...settings,
      outputDir: settings.outputDir || DEFAULT_SETTINGS.outputDir
    }
  };
  try {
    await persistDownloadJobs();
    if (job.attemptId !== attemptId || TERMINAL_JOB_STATUSES.has(job.status)) { safeDisconnect(port); return; }
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
    runningPorts.delete(jobId);
    safeDisconnect(port);
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
  if (TERMINAL_JOB_STATUSES.has(job.status)) {
    console.info("[job] IGNORED_STALE_TERMINAL_UPDATE", { jobId, attemptId: job.attemptId,
      current: job.status, requested: patch.status || job.status });
    return false;
  }
  Object.assign(job, patch, { updatedAt: Date.now() });
  if (TERMINAL_JOB_STATUSES.has(job.status)) {
    job.flowState = job.status === "completed" ? "DONE" : job.status === "incomplete" ? "INCOMPLETE" : "FAILED";
    logJobFlow(job, job.flowState);
    console.info("[job] JOB_TERMINAL:", job.id, "->", job.status.toUpperCase(),
      { attemptId: job.attemptId, output: job.outputPath || "" });
    clearTimeout(refreshTimers.get(job.id)); refreshTimers.delete(job.id);
    clearTimeout(refreshDeadlineTimers.get(job.id)); refreshDeadlineTimers.delete(job.id);
    void chrome.alarms?.clear?.(`video-refresh:${job.id}`);
  }
  void persistDownloadJobs().catch(error => console.error("Job persistence failed", error.message));
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
    originalPayload,
    rejectedUrls,
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
    kind: jobs.get(job.id)?.payload.kind,
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
    mainFrameId: state.mainFrameId,
    activeMediaId: state.activeMediaId || "",
    activeMediaChangedAt: state.activeMediaChangedAt || 0,
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
    stream.mediaId || session.activeMediaId || "",
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
    sizeBytes: 0,
    sizeLabel: "大小未知",
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
    .filter(stream => isWholeResource(stream.kind) || stream.kind === "dash_video")
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
    previewStrategy: isDirectVideoKind(selected.kind) ? "popup_video" : "page_player"
  };
}

function outputPipelineLabel(primary, extractor) {
  if (extractor?.provider === "youtube" || extractor?.provider === "bilibili") return "DASH → MP4";
  if (isHlsKind(primary.kind)) return "HLS → MP4";
  if (isDirectVideoKind(primary.kind)) return primary.kind.toUpperCase() + " → MP4";
  return "Video → MP4";
}

function aggregateLogicalVideos(state, rankedStreams, settings = {}) {
  const primary = rankedStreams.find((stream) => stream.canDownloadWholeVideo && stream.isRecommendable);
  if (!primary) return [];

  const qualityValues = Array.from(new Set(
    rankedStreams.filter(stream => ["page_extractor", "bilibili_dash"].includes(primary.kind)
      || !(primary.stronglyAssociated || primary.masterStronglyAssociated) || stream.stronglyAssociated
      || stream.parentMasterId === primary.resourceId || stream.resourceId === primary.parentMasterId)
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
    logicalVideoId: `logical:${state.activeMediaId || state.pageIdentity || state.fingerprint}`,
    mediaId: state.activeMediaId || primary.mediaId || "",
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
    duration: primary.duration || state.videoDuration || 0,
    durationLabel: formatDuration(primary.duration || state.videoDuration || 0),
    quality: primary.quality || state.mainVideoHeight || 0,
    qualityLabel: primary.quality
      ? `${primary.quality}p`
      : (primary.qualityLabel || (state.mainVideoHeight ? `${state.mainVideoHeight}p` : "最佳")),
    qualityOptions,
    defaultQuality,
    evidenceCount: rankedStreams.filter(s => s.kind !== "segment").length,
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
  if (isDirectVideoKind(stream.kind)) score += stream.stronglyAssociated ? 140000 : 105000;
  if (stream.kind === "hls_master") score += 100000;
  if (stream.kind === "hls_media") score += stream.parentMasterId ? 95000 : 85000;
  if (stream.kind === "segment") score -= 100000;
  if (stream.kind === "dash_video" || stream.kind === "dash_audio") score -= 120000;
  if (stream.stronglyAssociated) score += 180000;
  if (state.activeMediaId && stream.mediaId === state.activeMediaId) score += 500000;
  else if (state.activeMediaId && stream.mediaId && stream.mediaId !== state.activeMediaId) score -= 400000;
  if (stream.live && state.videoDuration > 120 && !stream.stronglyAssociated) score -= 180000;
  if (stream.frameId !== undefined && stream.frameId !== state.mainFrameId && !stream.stronglyAssociated) score -= 70000;
  if (stream.masterStronglyAssociated) score += 180000;
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
    mainPlaylistUrl: "",
    createdAt,
    endedAt: 0,
    endReason: "",
    fingerprint: videoFingerprint(pageUrl, currentSrc),
    streams: new Map(),
    playlistInfo: new Map(),
    segmentOwners: new Map(),
    diagnostics: [],
    segmentSizes: new Map(),
    audioPlaylists: new Set(),
    mainFrameId: 0,
    mediaCandidates: new Map(),
    activeMediaId: "",
    activeMediaChangedAt: 0,
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
  if (previous?.invalidated && previous.pendingDocumentBoundary && !context.forceDocumentBoundary && !context.confirmedActiveFrame) return previous;
  const pending = Array.from(previous?.pendingStreams?.values() || []);
  const incomingPageUrl = context.pageUrl || previous?.pendingPageUrl || previous?.pageUrl || "";
  const incomingIdentity = context.pageIdentity || pageVideoIdentity(incomingPageUrl);
  const identityChanged = Boolean(
    previous?.pageIdentity && incomingIdentity && previous.pageIdentity !== incomingIdentity
  );
  const sameDocument = context.documentId && previous?.documentId === context.documentId;
  if (previous && !previous.invalidated && !identityChanged && (!context.forceDocumentBoundary || sameDocument)) {
    return ensureVideoSession(tabId, { ...context, pageUrl: incomingPageUrl, pageIdentity: incomingIdentity });
  }
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
    previous.invalidated = false;
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

function sanitizeMediaCandidate(frameId, documentId, frameUrl, raw = {}) {
  const token = String(raw.videoElementToken || "").slice(0, 160);
  if (!token) return null;
  const sourceKey = String(raw.sourceKey || raw.currentSrc || raw.src || "").slice(0, 32768);
  const sourceEpoch = Math.max(0, Number(raw.sourceEpoch || 0));
  const mediaId = `${frameId}:${token}:${stableFingerprint(`${sourceEpoch}|${normalizeResourceUrl(sourceKey)}`)}`;
  const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
  return {
    mediaId, frameId, documentId, frameUrl, videoElementToken: token, sourceEpoch,
    src: String(raw.src || "").slice(0, 32768), currentSrc: String(raw.currentSrc || "").slice(0, 32768),
    sourceKey, duration: Math.max(0, number(raw.duration)), videoWidth: Math.max(0, number(raw.videoWidth)),
    videoHeight: Math.max(0, number(raw.videoHeight)), paused: raw.paused !== false,
    ended: raw.ended === true, currentTime: Math.max(0, number(raw.currentTime)),
    lastCurrentTime: Math.max(0, number(raw.lastCurrentTime)), lastTimeProgressAt: number(raw.lastTimeProgressAt),
    lastPlayAt: number(raw.lastPlayAt), lastPlayingAt: number(raw.lastPlayingAt),
    lastPauseAt: number(raw.lastPauseAt), lastSourceChangeAt: number(raw.lastSourceChangeAt),
    lastUserInteractionAt: number(raw.lastUserInteractionAt), lastNetworkActivityAt: number(raw.lastNetworkActivityAt),
    visibility: raw.visibility === true, intersectionRatio: Math.max(0, Math.min(1, number(raw.intersectionRatio))),
    boundingRectArea: Math.max(0, number(raw.boundingRectArea)), title: String(raw.title || "").replace(/\s+/g, " ").trim().slice(0, 300),
    poster: safeImageUrl(raw.poster || ""), event: String(raw.event || "scan").slice(0, 40),
    lastSeenAt: Math.min(Date.now(), number(raw.observedAt) || Date.now()), stale: false
  };
}

function findMatchingMediaCandidate(state, video = {}) {
  const candidates = Array.from(state.mediaCandidates?.values?.() || [])
    .filter(candidate => !candidate.stale && candidate.frameId === Number(video.frameId || 0));
  const currentSrc = normalizeResourceUrl(video.currentSrc || "");
  if (currentSrc) {
    const exact = candidates.filter(candidate => normalizeResourceUrl(candidate.currentSrc || candidate.src) === currentSrc)
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)[0];
    return exact || null;
  }
  return candidates.length === 1 && !(candidates[0].currentSrc || candidates[0].src) ? candidates[0] : null;
}

function mediaCandidateForNetwork(state, details = {}, observedAt = Date.now()) {
  const frameId = Number(details.frameId || 0);
  return Array.from(state.mediaCandidates?.values?.() || [])
    .filter(candidate => !candidate.stale && candidate.frameId === frameId && candidate.lastSeenAt >= observedAt - 30_000)
    .sort((a, b) => {
      const aBefore = Math.max(a.lastPlayingAt || 0, a.lastPlayAt || 0, a.lastTimeProgressAt || 0) <= observedAt ? 1 : 0;
      const bBefore = Math.max(b.lastPlayingAt || 0, b.lastPlayAt || 0, b.lastTimeProgressAt || 0) <= observedAt ? 1 : 0;
      return bBefore - aBefore || mediaActivityScore(b, state, observedAt) - mediaActivityScore(a, state, observedAt);
    })[0] || null;
}

function recomputeActiveMedia(state, reason = "candidate-update") {
  const now = Date.now();
  for (const [id, candidate] of state.mediaCandidates) {
    if (now - candidate.lastSeenAt > 10 * 60 * 1000) state.mediaCandidates.delete(id);
  }
  const active = Array.from(state.mediaCandidates.values()).filter(candidate => !candidate.stale)
    .sort((a, b) => compareMainVideos(a, b, state, now) || b.lastSeenAt - a.lastSeenAt)[0];
  if (!active) return null;
  const previousId = state.activeMediaId || "";
  if (previousId !== active.mediaId) {
    state.activeMediaId = active.mediaId;
    state.activeMediaChangedAt = now;
    state.sessionId = makeId("session");
    state.mainFrameId = active.frameId;
    state.mainVideoObservedAt = now;
    state.currentSrc = active.currentSrc || active.src || "";
    state.videoDuration = active.duration || 0;
    state.mainVideoWidth = active.videoWidth || 0;
    state.mainVideoHeight = active.videoHeight || 0;
    if (active.title) state.pageTitle = active.title;
    if (active.poster) state.thumbnailUrl = active.poster;
    state.fingerprint = stableFingerprint(`${state.pageUrl}|${active.mediaId}|${normalizeResourceUrl(state.currentSrc)}`);
    for (const stream of state.streams.values()) {
      const closeToPlayback = stream.frameId === active.frameId
        && stream.firstSeen >= Math.max(0, active.lastSourceChangeAt || active.lastPlayAt || active.lastPlayingAt || now) - 1500
        && stream.lastSeen <= now + 2_000;
      if (closeToPlayback && !stream.mediaId && (isHlsKind(stream.kind) || isDirectVideoKind(stream.kind))) {
        stream.mediaId = active.mediaId;
        stream.sessionId = state.sessionId;
        active.lastNetworkActivityAt = Math.max(active.lastNetworkActivityAt || 0, stream.lastSeen || 0);
      }
    }
    console.info("[media] ACTIVE_MEDIA_CHANGED:", previousId || "none", "->", active.mediaId,
      { tabId: state.tabId, frameId: active.frameId, event: active.event, candidateCount: state.mediaCandidates.size,
        duration: active.duration, paused: active.paused, currentTime: active.currentTime });
    detectionLog(state, "ACTIVE_MEDIA_CHANGED", { before: previousId, after: active.mediaId,
      frameId: active.frameId, reason, candidateCount: state.mediaCandidates.size });
    broadcastSessionState("videoSessionChanged", state);
  } else {
    state.mainFrameId = active.frameId;
    state.currentSrc = active.currentSrc || active.src || state.currentSrc;
    state.videoDuration = active.duration || state.videoDuration;
    state.mainVideoWidth = active.videoWidth || state.mainVideoWidth;
    state.mainVideoHeight = active.videoHeight || state.mainVideoHeight;
    if (active.title) state.pageTitle = active.title;
    if (active.poster) state.thumbnailUrl = active.poster;
  }
  return active;
}

function updateMediaCandidate(tabId, frameId, documentId, frameUrl, rawCandidate) {
  const state = ensureVideoSession(tabId, { pageUrl: frameId === 0 ? frameUrl : "" });
  if (state.invalidated) return state;
  const candidate = sanitizeMediaCandidate(frameId, documentId, frameUrl, rawCandidate);
  if (!candidate) return state;
  for (const existing of state.mediaCandidates.values()) {
    if (existing.frameId === frameId && existing.videoElementToken === candidate.videoElementToken
      && existing.mediaId !== candidate.mediaId) existing.stale = true;
  }
  const previous = state.mediaCandidates.get(candidate.mediaId);
  if (previous) {
    for (const timestamp of ["lastTimeProgressAt", "lastPlayAt", "lastPlayingAt", "lastPauseAt",
      "lastSourceChangeAt", "lastUserInteractionAt", "lastNetworkActivityAt"]) {
      candidate[timestamp] = Math.max(candidate[timestamp] || 0, previous[timestamp] || 0);
    }
  }
  state.mediaCandidates.set(candidate.mediaId, { ...previous, ...candidate });
  recomputeActiveMedia(state, candidate.event);
  persistDetectionState(tabId);
  return state;
}

function removeMediaCandidate(tabId, frameId, videoElementToken) {
  const state = tabState.get(tabId);
  if (!state) return;
  for (const candidate of state.mediaCandidates.values()) {
    if (candidate.frameId === frameId && candidate.videoElementToken === videoElementToken) candidate.stale = true;
  }
  recomputeActiveMedia(state, "removed");
  persistDetectionState(tabId);
}

function updateVideoContext(tabId, context = {}) {
  const metadataMatchesPage = context.metadataMatchesPage !== false;
  const existingState = tabState.get(tabId);
  const trackedActive = existingState?.mediaCandidates?.get?.(existingState.activeMediaId);
  const reported = context.mainVideo;
  const reportedMediaId = reported?.mediaId || "";
  const preferSnapshot = context.reason === "popup-hints" && reported?.currentSrc && (
    reportedMediaId === trackedActive?.mediaId || !trackedActive || compareMainVideos(reported, trackedActive, existingState) < 0);
  const mainVideo = metadataMatchesPage
    ? (trackedActive && !preferSnapshot && (!reported?.mediaId || reportedMediaId !== trackedActive.mediaId)
      ? { currentSrc: trackedActive.currentSrc || trackedActive.src, width: trackedActive.videoWidth,
        height: trackedActive.videoHeight, duration: trackedActive.duration, currentTime: trackedActive.currentTime,
        paused: trackedActive.paused, poster: trackedActive.poster, mediaId: trackedActive.mediaId }
      : (context.mainVideo || {})) : {};
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
  if (mainVideo.mediaId) state.activeMediaId = mainVideo.mediaId;
  else if (preferSnapshot) state.activeMediaId = "";
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
  if (!/^https?:/i.test(url) || isHardExcludedUrl(url) || (!isStreamUrl(url) && !details.forcedKind)) return;
  const state = tabState.get(tabId) || ensureVideoSession(tabId, {
    pageUrl: details.frameId === 0 ? details.documentUrl : ""
  });
  if (details.frameId === 0 && state.documentId && details.documentId &&
      state.documentId !== details.documentId && !state.invalidated) return;
  if (details.totalBytes > 0 && details.forcedKind !== "hls" && !isHlsKind(details.forcedKind) &&
      (!details.method || details.method === "GET") && !state.invalidated) {
    state.segmentSizes.set(url, details.totalBytes);
    while (state.segmentSizes.size > 16000) state.segmentSizes.delete(state.segmentSizes.keys().next().value);
  }
  const owner = state.segmentOwners.get(url);
  if (owner) {
    const playlist = state.streams.get(streamKey(owner));
    if (playlist) playlist.lastSeen = details.observedAt || Date.now();
    return;
  }
  const remembered = state.headersByUrl.get(headerKey(url));
  const pendingHeaders = state.pendingStreams.get(url)?.details.headers;
  details = { ...details, headers: details.headers || pendingHeaders || remembered };
  if (state.invalidated) {
    bufferPendingStream(state, url, details);
    return;
  }
  if (details.frameId === 0 && state.documentId && details.documentId
    && state.documentId !== details.documentId) return;
  if (state.previousMediaUrls.has(url)) {
    // A fresh request in the current document may legitimately reuse a signed URL.
    if (details.observedAt < state.resourceSince || (state.documentId && details.documentId
      && details.frameId === 0 && details.documentId !== state.documentId)) return;
    state.previousMediaUrls.delete(url);
  }
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
  if ((isHlsKind(kind) || isDirectVideoKind(kind)) && kind !== previousKind) {
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
  if (isHlsKind(kind) || isDirectVideoKind(kind)) persistDetectionState(state.tabId);
}

function pendingCandidateBelongsToSession(candidate, state, previous, timingRecovery = false) {
  if (Date.now() - candidate.bufferedAt > PENDING_MEDIA_TTL_MS) return false;
  const details = candidate.details;
  const isMainFrame = details.frameId === 0;
  if (isMainFrame && state.documentId && details.documentId && state.documentId !== details.documentId) return false;
  if (!isMainFrame && state.documentId && details.parentDocumentId && state.documentId !== details.parentDocumentId) return false;
  if (isMainFrame && details.documentUrl && !sameDocumentContext(state.pageUrl, details.documentUrl)) return false;
  const fullReferer = fullMediaReferer(details.headers);
  if (isMainFrame && fullReferer && !sameDocumentContext(state.pageUrl, fullReferer)) return false;
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
  const networkCandidate = details.mediaId ? state.mediaCandidates.get(details.mediaId)
    : mediaCandidateForNetwork(state, details, now);
  if (networkCandidate) {
    details = { ...details, mediaId: networkCandidate.mediaId };
    networkCandidate.lastNetworkActivityAt = Math.max(networkCandidate.lastNetworkActivityAt || 0, now);
  }
  const metadata = inferStreamMetadata(url, details.quality, state.segmentOwners.has(url) ? "segment" : details.forcedKind);
  const existing = state.streams.get(id);
  if (isHlsKind(metadata.kind) && /network|webRequest|performance|page-response|fetch|xhr/.test(details.source || "network")) {
    const ring = state.recentMedia || (state.recentMedia = []);
    const previous = ring.filter(item => item.url === url).at(-1);
    if (!previous || now >= previous.observedAt) {
      if (previous) ring.splice(ring.indexOf(previous), 1);
      ring.push({ url, observedAt: now, status: details.status ?? previous?.status ?? 0,
        source: details.source || "network", type: details.type || metadata.kind, frameId: details.frameId,
        initiator: details.initiator || "", pageIdentity: state.pageIdentity,
        documentId: details.documentId || "", headers: { ...details.headers } });
      state.recentMedia = ring.filter(item => Date.now() - item.observedAt < 90000).slice(-80);
    }
  }
  const headers = { ...existing?.headers, ...state.headersByUrl.get(headerKey(url)), ...details.headers };

  if (existing) {
    if (details.mediaId && existing.mediaId && details.mediaId !== existing.mediaId
      && !["main-current-src", "main-player"].includes(details.association)) {
      // An old player can keep fetching in the same frame after a source switch.
      details = { ...details, mediaId: existing.mediaId };
    }
    if (now >= existing.lastSeen) existing.lastUrl = url;
    existing.masterUrl = details.masterUrl || existing.masterUrl || "";
    if (details.playerName) {
      existing.playerName = details.playerName;
      existing.playerSrc = details.playerSrc;
    }
    existing.detectedAt = existing.detectedAt || existing.firstSeen;
    Object.assign(existing, mediaUrlContext(url));
    existing.headers = headers;
    existing.lastSeen = Math.max(existing.lastSeen, now);
    if (details.forcedKind && !isYouTubePlaybackUrl(url) && existing.kind !== "segment"
      && !(existing.kind === "hls_master" && details.forcedKind === "hls")) existing.kind = metadata.kind;
    existing.sampleCount = (existing.sampleCount || 1) + 1;
    existing.documentUrl = details.documentUrl || existing.documentUrl || "";
    existing.initiator = details.initiator || existing.initiator || "";
    existing.documentId = details.documentId || existing.documentId || "";
    existing.frameId = details.frameId ?? existing.frameId;
    existing.mediaId = details.mediaId || existing.mediaId || "";
    existing.parentDocumentId = details.parentDocumentId || existing.parentDocumentId || "";
    if (["main-current-src", "main-player"].includes(details.association) || !existing.association) {
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
      playerName: details.playerName, playerSrc: details.playerSrc,
      resourceTitle: details.resourceTitle, historyOnly: details.source === "history",
      detectedAt: now,
      ...mediaUrlContext(url),
      pageUrl: state.pageUrl,
      masterUrl: details.masterUrl || "",
      firstSeen: now,
      lastSeen: now,
      sampleCount: 1,
      sessionId: state.sessionId,
      documentUrl: details.documentUrl || "",
      initiator: details.initiator || "",
      documentId: details.documentId || "",
      frameId: details.frameId,
      mediaId: details.mediaId || "",
      parentDocumentId: details.parentDocumentId || "",
      association: details.association || "session-network",
      pageTitleAtCapture: state.pageTitle,
      capturedPageUrl: state.pageUrl
    });
  }

  const resource = state.streams.get(id);
  if (details.verifiedHeight) resource.verifiedHeight = details.verifiedHeight;
  if (details.source && details.source !== "history") resource.historyOnly = false;
  if (state.audioPlaylists.has(url)) resource.audioOnly = true;
  if (((details.status && details.method !== "HEAD") || details.networkError) && now >= (resource.statusAt || 0)) {
    Object.assign(resource, { httpStatus: details.status || 0, networkError: details.networkError || "", statusAt: now });
  }
  if (details.totalBytes > 0 && isDirectVideoKind(resource.kind)) {
    Object.assign(resource, { sizeBytes: details.totalBytes, sizeExact: true });
  }
  resource.sources = [...new Set([...(resource.sources || []), details.source || resource.source])];
  const wholeCount = [...state.streams.values()].filter(item => isWholeResource(item.kind)).length;
  const streamLimit = MAX_STREAMS_PER_TAB + Math.max(0, Math.min(wholeCount, MAX_WHOLE_RESOURCES_PER_TAB) - MAX_STREAMS_PER_TAB);
  while (state.streams.size > streamLimit) {
    const oldest = Array.from(state.streams.values()).sort((a, b) =>
      retentionScore(a) - retentionScore(b) || a.lastSeen - b.lastSeen)[0];
    if (!oldest) break;
    state.streams.delete(oldest.id);
    if (isWholeResource(oldest.kind)) state.inventoryEvicted = true;
  }
  if (isHlsKind(metadata.kind) || isDirectVideoKind(metadata.kind)) persistDetectionState(tabId);
  if (networkCandidate && (isHlsKind(metadata.kind) || isDirectVideoKind(metadata.kind))) {
    recomputeActiveMedia(state, "network-activity");
  }
  if (isHlsKind(metadata.kind) && jobsInitialized) for (const job of jobs.values()) {
    if (job.payload.tabId === tabId) scheduleRefresh(job);
  }
}

function retentionScore(stream) {
  if (["main-player", "main-current-src"].includes(stream.association)) return 10;
  if (isHlsKind(stream.kind)) return 5;
  if (stream.kind === "segment") return 0;
  return 1;
}

function diagnosticUrl(value) {
  const url = safeUrl(value || "");
  if (!url) return "";
  // Export only the current tab, with query secrets and userinfo removed.
  url.username = ""; url.password = ""; url.hash = "";
  for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, "[redacted]");
  return url.href;
}

function detectionLog(state, event, details = {}) {
  if (!state) return;
  const entry = { at: new Date().toISOString(), event, ...details };
  if (entry.url) entry.url = diagnosticUrl(entry.url);
  state.diagnostics.push(entry);
  state.diagnostics = state.diagnostics.slice(-120);
  console.debug("[DarrenDetection]", entry);
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
  if (isDirectVideoKind(stream.kind)) score += 30000;
  if (stream.kind === "segment") score += 1000;
  if (stream.kind === "dash_video") score += 5000;
  if (stream.kind === "dash_audio") score += 3000;
  if (stream.quality === 1080) score += 20000;
  else if (stream.quality) score += Math.max(0, 10000 - Math.abs(1080 - stream.quality));
  return score;
}

function isStreamUrl(url) {
  return STREAM_URL_PATTERN.test(stripHash(url)) || HLS_PATH_PATTERN.test(stripHash(url)) || isYouTubePlaybackUrl(url);
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
  const hostname = safeUrl(url)?.hostname || "";
  return IMAGE_URL_PATTERN.test(stripHash(url || "")) || /(?:^|\.)(?:doubleclick\.net|googlesyndication\.com)$/i.test(hostname) &&
    !STREAM_URL_PATTERN.test(url || "");
}

function isDirectVideoKind(kind) {
  return kind === "mp4" || kind === "webm";
}

function isHlsKind(kind) {
  return kind === "hls_master" || kind === "hls_media";
}

function mediaKindFromContentType(contentType) {
  const mime = String(contentType || "").split(";", 1)[0].trim().toLowerCase();
  if (["application/vnd.apple.mpegurl", "application/x-mpegurl", "application/mpegurl", "audio/mpegurl", "audio/x-mpegurl"].includes(mime)) return "hls";
  if (mime === "video/mp4") return "mp4";
  if (mime === "video/webm") return "webm";
  return "";
}

function inferStreamMetadata(url, explicitQuality, forcedKind) {
  const pathname = safeUrl(url)?.pathname.toLowerCase() || url.toLowerCase();
  let kind = "unknown";
  if (isYouTubePlaybackUrl(url)) {
    kind = youtubeDashKind(url);
  } else if (forcedKind === "segment" || /\.(m4s|ts)(?:$|[?#])/i.test(url)
    || /(?:[_/-]init[_-]|[_/-](?:seg|fragment|chunk)[_-]\d+|_\d+_[A-Za-z0-9_-]+_\d{10}\.mp4$)/i.test(pathname)
    || /\/(?:init|initialization)(?:[-_.][a-z0-9_-]+)?\.mp4$/i.test(pathname)) {
    kind = "segment";
  } else if (["hls", "hls_master", "hls_media", "mp4", "webm"].includes(forcedKind)) {
    kind = forcedKind === "hls" ? "hls_media" : forcedKind;
  } else if (HLS_PATH_PATTERN.test(url)) {
    kind = "hls_media";
  } else if (/\.m3u8(?:$|[?#])/i.test(url)) {
    kind = /(master|playlist|index)\.m3u8/i.test(pathname) ? "hls_master" : "hls_media";
  } else if (/\.webm(?:$|[?#])/i.test(url)) {
    kind = "webm";
  } else if (/\.mp4(?:$|[?#])/i.test(url)) {
    kind = "mp4";
  }

  const parsed = safeUrl(url);
  const duration = Number(parsed?.searchParams.get("dur") || 0);
  const sizeBytes = isYouTubePlaybackUrl(url) ? Number(parsed?.searchParams.get("clen") || 0) : 0;
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
  if (isDirectVideoKind(kind)) return `Direct file - ${qualityText}`;
  if (kind === "dash_video") return `YouTube DASH video-only - ${qualityText}`;
  if (kind === "dash_audio") return "YouTube DASH audio-only";
  if (kind === "segment") return `Segment sample - ${qualityText} (${sampleCount} seen)`;
  return `Stream - ${qualityText}`;
}

function streamTypeTag(kind) {
  if (kind === "hls_master" || kind === "hls_media") return "HLS";
  if (isDirectVideoKind(kind)) return kind.toUpperCase();
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
  let decoded = url;
  try { decoded = decodeURIComponent(url); } catch { /* Preserve malformed escaped CDN paths. */ }
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
  if (!isSegment) { parsed.hash = ""; return `stream:${parsed.href}`; }

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

// Opaque tokens do not encode a knowable expiry. Numeric and Akamai exp values do.
function expiryRemaining(url) {
  const parsed = safeUrl(url);
  const times = [];
  for (const [key, value] of parsed?.searchParams || []) {
    if (/^(e|exp|expire|expires|expiry)$/i.test(key) && /^\d+$/.test(value)) times.push(Number(value));
    if (/^(hdnts|hdnea|token)$/i.test(key)) {
      const match = value.match(/(?:^|[~&])exp=(\d+)/);
      if (match) times.push(Number(match[1]));
    }
  }
  return times.length ? Math.min(...times.map(t => t > 1e12 ? t / 1000 : t)) - Date.now() / 1000 : Infinity;
}

async function requestPlayerMedia(job) {
  const results = await chrome.scripting.executeScript({ target: { tabId: job.payload.tabId, allFrames: true }, world: "MAIN",
    func: () => {
      // Only touch a proven Hls.js instance bound to a currently playing video.
      // startLoad keeps currentTime and playback state, unlike loadSource/video.load.
      const videos = [...document.querySelectorAll("video")];
      const instances = [window.hls, window.player?.hls, window.player?.engine?.hls];
      let triggered = false;
      for (const hls of new Set(instances)) {
        if (hls && videos.includes(hls.media) && !hls.media.paused && typeof hls.startLoad === "function") {
          try { hls.startLoad(hls.media.currentTime); triggered = true; } catch {}
        }
      }
      return { triggered, playing: videos.some(v => !v.paused), method: triggered ? "hls.startLoad" : "passive-listener" };
    } });
  logJobFlow(job, "player request", { frames: results.map(result => result.result) });
}
