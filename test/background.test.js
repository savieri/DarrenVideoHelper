const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");

function event() {
  return {
    listener: null,
    addListener(listener) {
      this.listener = listener;
    }
  };
}

function loadBackground(options = {}) {
  const storage = { downloadHistory: [] };
  const sessionStorage = options.sessionStorage || {};
  const tabs = options.tabs || [{ id: 1, url: "https://site.test/a", title: "A" }];
  const chrome = {
    commands: { onCommand: event() },
    runtime: {
      lastError: null,
      onInstalled: event(),
      onMessage: event(),
      reload() {},
      sendMessage() {},
      connectNative() {
        throw new Error("not used in unit tests");
      }
    },
    scripting: { executeScript: async () => [] },
    storage: {
      session: {
        async get() { await options.sessionGet?.(); return structuredClone(sessionStorage); },
        async set(values) { Object.assign(sessionStorage, structuredClone(values)); },
        async remove(keys) { for (const key of [keys].flat()) delete sessionStorage[key]; }
      },
      local: {
        async get(defaults) { return { ...defaults, ...storage }; },
        async set(values) { Object.assign(storage, values); }
      },
      sync: {
        async get(defaults) { return { ...defaults }; },
        async set() {}
      }
    },
    tabs: {
      onRemoved: event(),
      onUpdated: event(),
      async get(tabId) { return tabs.find((tab) => tab.id === tabId) || { id: tabId, url: "https://site.test/a", title: "A" }; },
      async query() { return tabs; }
    },
    webNavigation: {
      onBeforeNavigate: event(),
      onErrorOccurred: event(),
      async getFrame({ tabId }) { return { documentId: tabs.find((tab) => tab.id === tabId)?.documentId || "" }; },
      onCommitted: event(),
      onHistoryStateUpdated: event(),
      onReferenceFragmentUpdated: event()
    },
    webRequest: {
      onBeforeRequest: event(),
      onBeforeSendHeaders: event(),
      onHeadersReceived: event()
    }
  };
  const context = vm.createContext({
    AbortController,
    URL,
    chrome,
    console,
    crypto: webcrypto,
    fetch: async () => ({
      ok: false,
      headers: { get: () => null },
      text: async () => ""
    }),
    setTimeout,
    clearTimeout
  });
  const source = fs.readFileSync(path.join(__dirname, "../extension/background.js"), "utf8");
  vm.runInContext(source, context, { filename: "background.js" });
  return { context, storage, sessionStorage, chrome, tabs };
}

function evaluate(context, expression) {
  return vm.runInContext(expression, context);
}

function installMediaPage(harness, { resources = [], pageUrl = harness.tabs[0].url, currentSrc = `blob:${pageUrl}/player` } = {}) {
  const video = {
    currentSrc, videoWidth: 1920, videoHeight: 1080, duration: 600, currentTime: 10,
    paused: false, querySelectorAll: () => []
  };
  harness.context.location = { href: pageUrl };
  harness.context.window = {};
  harness.context.document = {
    title: "HLS main video", querySelector: () => null,
    querySelectorAll: (selector) => selector === "video" ? [video] : []
  };
  harness.context.performance = { timeOrigin: Date.now() - 3600000, getEntriesByType: () => resources };
  harness.chrome.scripting.executeScript = async ({ func, args }) => [{
    documentId: harness.tabs[0].documentId,
    result: func(...args)
  }];
  harness.context.fetch = async (url) => ({
    ok: true, headers: { get: () => null },
    text: async () => /master|playlist/.test(url)
      ? "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080\n720.m3u8\n"
      : "#EXTM3U\n#EXTINF:600,\npart.ts\n#EXT-X-ENDLIST"
  });
  return { video, resources };
}

test("popup open and refresh actively recover preloaded HLS with only a blob video source", async () => {
  const harness = loadBackground({ tabs: [{ id: 1, url: "https://missav.ws/ch/mikr-122", documentId: "doc-a" }] });
  const entries = [
    { name: "https://cdn.test/main/master.m3u8", startTime: 1000 },
    ...Array.from({ length: 160 }, (_, index) => ({ name: `https://cdn.test/main/part-${index}.ts`, startTime: 10000 + index })),
    { name: "https://cdn.test/ads/master.m3u8", startTime: 2000 },
    { name: "https://analytics.test/video.mp4", startTime: 3000 },
    { name: "https://cdn.test/thumb.mp4", startTime: 4000 },
    { name: "https://cdn.test/poster.png", startTime: 5000 }
  ];
  installMediaPage(harness, { resources: entries });
  let scans = 0;
  const execute = harness.chrome.scripting.executeScript;
  harness.chrome.scripting.executeScript = async (request) => { scans++; return execute(request); };
  const request = () => new Promise((resolve) => harness.chrome.runtime.onMessage.listener({ type: "getStreams", tabId: 1 }, {}, resolve));
  const opened = await request();
  assert.equal(opened.recommended.resourceUrl, "https://cdn.test/main/master.m3u8");
  assert.equal(opened.streams.length, 1);
  assert.equal(opened.recommended.pipelineLabel, "HLS → MP4");
  assert.equal(evaluate(harness.context, "Array.from(tabState.get(1).streams.values()).some(s => /ads|analytics|thumb|png/.test(s.url))"), false);
  // A refresh recovers even if no request has fired since the first open.
  evaluate(harness.context, "tabState.get(1).streams.clear()");
  const refreshed = await request();
  assert.equal(refreshed.recommended.resourceUrl, opened.recommended.resourceUrl);
  assert.equal(scans, 2);
});

test("worker restart restores playlist, headers and timestamps without DOM/resource hints", async () => {
  const tabs = [{ id: 1, url: "https://missav.ws/ch/mikr-122", documentId: "doc-a" }];
  const first = loadBackground({ tabs });
  await evaluate(first.context, "detectionReady");
  evaluate(first.context, `updateVideoContext(1, { pageUrl: "${tabs[0].url}", mainVideo: { currentSrc: "blob:https://missav.ws/player", duration: 600 } });
    upsertStream(1, "https://cdn.test/playlist?token=one", { forcedKind: "hls", headers: { referer: "${tabs[0].url}", origin: "https://missav.ws", cookie: "test-only" } });
    upsertStream(1, "https://cdn.test/main/one.ts", {});`);
  await evaluate(first.context, "persistDetectionState(1)");
  const saved = first.sessionStorage["activeDetection:1"];
  assert.equal(saved.streams.length, 1);
  assert.equal(saved.streams[0].kind, "hls_media");
  const second = loadBackground({ tabs, sessionStorage: first.sessionStorage });
  const popup = await evaluate(second.context, "getPopupState(1)");
  assert.equal(popup.recommended.resourceUrl, saved.streams[0].url);
  assert.equal(popup.sessionId, saved.sessionId);
  const restored = evaluate(second.context, "Array.from(tabState.get(1).streams.values())[0]");
  assert.equal(restored.headers.cookie, "test-only");
  assert.equal(restored.headers.referer, tabs[0].url);
  assert.equal(restored.lastSeen, saved.streams[0].lastSeen);
  assert.equal(popup.streams.length, 1);
});

test("MIME identifies extensionless HLS/MP4, parses master/media and preserves DASH/segments", async () => {
  const harness = loadBackground();
  await evaluate(harness.context, "detectionReady");
  installMediaPage(harness);
  const emit = async (url, mime, overrides = {}) => harness.chrome.webRequest.onHeadersReceived.listener({
    tabId: 1, url, statusCode: 200, frameId: 0, initiator: "https://site.test", documentUrl: "https://site.test/a",
    responseHeaders: [{ name: "Content-Type", value: mime }], ...overrides
  });
  for (const [index, mime] of ["application/vnd.apple.mpegurl", "application/x-mpegURL; charset=UTF-8", "audio/mpegurl", "audio/x-mpegurl"].entries()) {
    await emit(`https://cdn.test/playlist?id=${index}`, mime);
  }
  await emit("https://cdn.test/media?id=one", "application/vnd.apple.mpegurl");
  await emit("https://cdn.test/file?id=one", "video/mp4");
  await emit("https://cdn.test/main/part.m4s", "video/mp4");
  await emit("https://r1.googlevideo.com/videoplayback?id=A&itag=137", "video/mp4");
  await emit("https://cdn.test/ads/playlist", "application/vnd.apple.mpegurl");
  await emit("https://cdn.test/analytics/file", "video/mp4");
  await emit("https://cdn.test/error", "video/mp4", { statusCode: 403 });
  await emit("https://cdn.test/html", "text/html");
  const streams = evaluate(harness.context, "Array.from(tabState.get(1).streams.values()).map(snapshotStream)");
  assert.equal(streams.length, 8);
  const master = await evaluate(harness.context, "enrichStreamForPopup(snapshotVideoSession(tabState.get(1)), Array.from(tabState.get(1).streams.values())[0])");
  assert.equal(master.kind, "hls_master");
  assert.equal(master.variantUrls[0], "https://cdn.test/720.m3u8");
  const media = await evaluate(harness.context, "enrichStreamForPopup(snapshotVideoSession(tabState.get(1)), Array.from(tabState.get(1).streams.values())[4])");
  assert.equal(media.kind, "hls_media");
  assert.equal(media.duration, 600);
  assert.equal(streams[5].kind, "mp4");
  assert.equal(streams[6].kind, "segment");
  assert.equal(streams[7].kind, "dash_video");
  assert.equal(evaluate(harness.context, 'parsePlaylistInfo("<html>not a playlist</html>").isMaster'), undefined);
});

test("MIME upgrades an unknown candidate and retains captured request headers", async () => {
  const harness = loadBackground();
  await evaluate(harness.context, "detectionReady");
  evaluate(harness.context, 'upsertStream(1, "https://cdn.test/file", {})');
  await harness.chrome.webRequest.onBeforeSendHeaders.listener({ tabId: 1, url: "https://cdn.test/file", requestHeaders: [{ name: "Referer", value: "https://site.test/a" }] });
  await harness.chrome.webRequest.onHeadersReceived.listener({ tabId: 1, url: "https://cdn.test/file", frameId: 0, statusCode: 200, responseHeaders: [{ name: "content-type", value: "video/mp4" }] });
  const stream = evaluate(harness.context, "Array.from(tabState.get(1).streams.values())[0]");
  assert.equal(stream.kind, "mp4");
  assert.equal(stream.headers.referer, "https://site.test/a");
});

test("navigation buffer merges the unique new playlist and rejects old document/origin candidates", () => {
  const harness = loadBackground();
  const result = evaluate(harness.context, `(() => {
    commitVideoNavigation(2, { pageUrl: "https://missav.ws/ch/a", documentId: "old" });
    invalidateVideoSession(2, { pageUrl: "https://missav.ws/ch/b", forceDocumentBoundary: true });
    captureNetworkStream(2, "https://cdn.test/new/playlist", { forcedKind: "hls", frameId: 0, documentId: "new", initiator: "https://missav.ws", headers: { referer: "https://missav.ws/ch/b" } });
    captureNetworkStream(2, "https://cdn.test/old/master.m3u8", { frameId: 0, documentId: "old", initiator: "https://missav.ws" });
    captureNetworkStream(2, "https://cdn.test/wrong/master.m3u8", { frameId: 0, initiator: "https://other.test" });
    captureNetworkStream(2, "https://cdn.test/stale/master.m3u8", { frameId: 0, documentId: "new", documentUrl: "https://missav.ws/ch/a" });
    updateVideoContext(2, { pageUrl: "https://missav.ws/ch/b" });
    const during = tabState.get(2).invalidated;
    commitVideoNavigation(2, { pageUrl: "https://missav.ws/ch/b", reason: "tab-url" });
    const stillPending = tabState.get(2).invalidated;
    const state = commitVideoNavigation(2, { pageUrl: "https://missav.ws/ch/b", documentId: "new", forceDocumentBoundary: true });
    return { during, stillPending, urls: Array.from(state.streams.values()).map(s => s.url), kind: Array.from(state.streams.values())[0].kind };
  })()`);
  assert.equal(result.during, true);
  assert.equal(result.stillPending, true);
  assert.deepEqual(Array.from(result.urls), ["https://cdn.test/new/playlist"]);
  assert.equal(result.kind, "hls_media");
});

test("same-document SPA buffer requires the new page context rather than same-origin evidence", () => {
  const harness = loadBackground();
  const urls = evaluate(harness.context, `(() => {
    commitVideoNavigation(2, { pageUrl: "https://missav.ws/ch/a", documentId: "spa" });
    upsertStream(2, "https://cdn.test/a/master.m3u8");
    invalidateVideoSession(2, { pageUrl: "https://missav.ws/ch/b" });
    captureNetworkStream(2, "https://cdn.test/b/master.m3u8", { frameId: 0, documentId: "spa", headers: { referer: "https://missav.ws/ch/b" } });
    captureNetworkStream(2, "https://cdn.test/a/retry.m3u8", { frameId: 0, documentId: "spa", headers: { referer: "https://missav.ws/ch/a" } });
    captureNetworkStream(2, "https://cdn.test/ambiguous.m3u8", { frameId: 0, documentId: "spa", initiator: "https://missav.ws" });
    const state = commitVideoNavigation(2, { pageUrl: "https://missav.ws/ch/b" });
    return Array.from(state.streams.values()).map(s => s.url);
  })()`);
  assert.deepEqual(Array.from(urls), ["https://cdn.test/b/master.m3u8"]);
  assert.equal(evaluate(harness.context, "tabState.get(2).documentId"), "spa");
});

test("buffer expires candidates, remains bounded and protects playlists against segment floods", () => {
  const harness = loadBackground();
  const result = evaluate(harness.context, `(() => {
    commitVideoNavigation(2, { pageUrl: "https://site.test/a", documentId: "old" });
    invalidateVideoSession(2, { pageUrl: "https://site.test/b" });
    captureNetworkStream(2, "https://cdn.test/expired.m3u8", { frameId: 0, documentId: "new" });
    tabState.get(2).pendingStreams.get("https://cdn.test/expired.m3u8").bufferedAt -= PENDING_MEDIA_TTL_MS + 1;
    captureNetworkStream(2, "https://cdn.test/b/master.m3u8", { frameId: 0, documentId: "new" });
    for (let n = 0; n < 140; n++) captureNetworkStream(2, "https://cdn.test/b/part-" + n + ".ts", { frameId: 0, documentId: "new" });
    const size = tabState.get(2).pendingStreams.size;
    const next = commitVideoNavigation(2, { pageUrl: "https://site.test/b", documentId: "new", forceDocumentBoundary: true });
    for (let n = 0; n < 140; n++) upsertStream(2, "https://cdn.test/unique-" + n + ".ts");
    return { size, expired: next.streams.has(streamKey("https://cdn.test/expired.m3u8")), master: next.streams.has(streamKey("https://cdn.test/b/master.m3u8")), streams: next.streams.size };
  })()`);
  assert.equal(result.size, 40);
  assert.equal(result.expired, false);
  assert.equal(result.master, true);
  assert.equal(result.streams, 100);
});

test("site video switch recovers new HLS while old timing entries cannot refill the session", async () => {
  const tabs = [{ id: 1, url: "https://missav.ws/ch/a", documentId: "spa" }];
  const harness = loadBackground({ tabs });
  const page = installMediaPage(harness, { resources: [{ name: "https://cdn.test/a/master.m3u8", startTime: 1000 }] });
  const first = await evaluate(harness.context, "getPopupState(1)");
  const boundary = Date.now() - 100;
  evaluate(harness.context, `invalidateVideoSession(1, { pageUrl: "https://missav.ws/ch/b", observedAt: ${boundary} })`);
  page.resources.push({ name: "https://cdn.test/b/master.m3u8", startTime: boundary + 50 - harness.context.performance.timeOrigin });
  tabs[0].url = harness.context.location.href = "https://missav.ws/ch/b";
  await harness.chrome.webNavigation.onHistoryStateUpdated.listener({ tabId: 1, frameId: 0, documentId: "spa", url: tabs[0].url });
  const next = await evaluate(harness.context, "getPopupState(1)");
  assert.notEqual(next.sessionId, first.sessionId);
  assert.equal(next.recommended.resourceUrl, "https://cdn.test/b/master.m3u8");
  assert.equal(evaluate(harness.context, 'Array.from(tabState.get(1).streams.values()).some(s => s.url.includes("/a/"))'), false);
});

test("extensionless SPA playlist with only an origin referrer is confirmed by post-boundary timing", async () => {
  const harness = loadBackground({ tabs: [{ id: 1, url: "https://missav.ws/ch/a", documentId: "spa" }] });
  const page = installMediaPage(harness);
  await evaluate(harness.context, "detectionReady");
  const boundary = Date.now() - 100;
  evaluate(harness.context, `invalidateVideoSession(1, { pageUrl: "https://missav.ws/ch/b", observedAt: ${boundary} });
    captureNetworkStream(1, "https://cdn.test/b/playlist?id=one", { forcedKind: "hls", frameId: 0, documentId: "spa", initiator: "https://missav.ws", headers: { referer: "https://missav.ws/" } });
    captureNetworkStream(1, "https://cdn.test/stale/playlist", { forcedKind: "hls", frameId: 0, documentId: "old", initiator: "https://missav.ws" });
    commitVideoNavigation(1, { pageUrl: "https://missav.ws/ch/b", documentId: "spa" });`);
  harness.tabs[0].url = harness.context.location.href = "https://missav.ws/ch/b";
  page.resources.push({ name: "https://cdn.test/b/playlist?id=one", startTime: boundary + 50 - harness.context.performance.timeOrigin });
  assert.equal(evaluate(harness.context, "tabState.get(1).streams.size"), 0);
  await evaluate(harness.context, "persistDetectionState(1)");
  const restarted = loadBackground({ tabs: [{ id: 1, url: "https://missav.ws/ch/b", documentId: "spa" }], sessionStorage: structuredClone(harness.sessionStorage) });
  const restartedPage = installMediaPage(restarted);
  const withoutTiming = await evaluate(restarted.context, "getPopupState(1)");
  assert.equal(withoutTiming.recommended, null);
  restartedPage.resources.push({ name: "https://cdn.test/b/playlist?id=one", startTime: boundary + 50 - restarted.context.performance.timeOrigin });
  const restoredWithTiming = await evaluate(restarted.context, "getPopupState(1)");
  assert.equal(restoredWithTiming.recommended.resourceUrl, "https://cdn.test/b/playlist?id=one");
  const popup = await evaluate(harness.context, "getPopupState(1)");
  assert.equal(popup.recommended.resourceUrl, "https://cdn.test/b/playlist?id=one");
  assert.equal(popup.recommended.pipelineLabel, "HLS → MP4");
  assert.equal(evaluate(harness.context, "tabState.get(1).pendingStreams.size"), 0);
});

test("old network events cannot rotate the current document back to an earlier page", () => {
  const harness = loadBackground();
  const result = evaluate(harness.context, `(() => {
    const state = commitVideoNavigation(2, { pageUrl: "https://site.test/b", documentId: "new" });
    captureNetworkStream(2, "https://cdn.test/a/master.m3u8", { frameId: 0, documentId: "old", documentUrl: "https://site.test/a" });
    return { same: state === tabState.get(2), url: state.pageUrl, streams: state.streams.size };
  })()`);
  assert.equal(result.same, true);
  assert.equal(result.url, "https://site.test/b");
  assert.equal(result.streams, 0);
});

test("restore validates page/document identity and deletes closed-tab state", async () => {
  const harness = loadBackground();
  await evaluate(harness.context, "detectionReady");
  evaluate(harness.context, 'commitVideoNavigation(1, { pageUrl: "https://site.test/a", documentId: "old" }); upsertStream(1, "https://cdn.test/a.m3u8");');
  await evaluate(harness.context, "persistDetectionState(1)");
  for (const tab of [
    { id: 1, url: "https://site.test/b", documentId: "old" },
    { id: 1, url: "https://site.test/a", documentId: "new" }
  ]) {
    const saved = structuredClone(harness.sessionStorage);
    saved["activeDetection:999"] = saved["activeDetection:1"];
    const restarted = loadBackground({ tabs: [tab], sessionStorage: saved });
    await evaluate(restarted.context, "detectionReady");
    assert.equal(evaluate(restarted.context, "tabState.get(1).streams.size"), 0);
    assert.equal(saved["activeDetection:999"], undefined);
    await restarted.chrome.tabs.onRemoved.listener(1);
    await evaluate(restarted.context, "detectionWrites.get(1)");
    assert.equal(saved["activeDetection:1"], undefined);
  }
});

test("events received during asynchronous startup are applied after restore in order", async () => {
  const original = loadBackground();
  await evaluate(original.context, "detectionReady");
  evaluate(original.context, 'upsertStream(1, "https://cdn.test/a.m3u8")');
  await evaluate(original.context, "persistDetectionState(1)");
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const restarted = loadBackground({ sessionStorage: original.sessionStorage, sessionGet: () => gate });
  const navigation = restarted.chrome.webNavigation.onHistoryStateUpdated.listener({ tabId: 1, frameId: 0, url: "https://site.test/b" });
  const capture = restarted.chrome.webRequest.onBeforeRequest.listener({ tabId: 1, frameId: 0, url: "https://cdn.test/b.m3u8", documentUrl: "https://site.test/b" });
  release();
  await Promise.all([navigation, capture]);
  assert.equal(evaluate(restarted.context, "tabState.get(1).pageUrl"), "https://site.test/b");
  assert.deepEqual(Array.from(evaluate(restarted.context, "Array.from(tabState.get(1).streams.values()).map(s => s.url)")), ["https://cdn.test/b.m3u8"]);
  await evaluate(restarted.context, "persistDetectionState(1)");
  assert.equal(original.sessionStorage["activeDetection:1"].pageIdentity, "https://site.test/b");
});

test("a scan completing after navigation cannot bring back the previous playlist", async () => {
  const harness = loadBackground();
  await evaluate(harness.context, "detectionReady");
  let resolveScan;
  harness.chrome.scripting.executeScript = () => new Promise((resolve) => { resolveScan = resolve; });
  const scan = evaluate(harness.context, "collectMediaHints({ id: 1, url: 'https://site.test/a' }, tabState.get(1))");
  evaluate(harness.context, 'commitVideoNavigation(1, { pageUrl: "https://site.test/b" })');
  resolveScan([{ result: { pageUrl: "https://site.test/a", videos: [], resources: [{ url: "https://cdn.test/a/master.m3u8", observedAt: Date.now() }] } }]);
  await scan;
  assert.equal(evaluate(harness.context, "tabState.get(1).pageUrl"), "https://site.test/b");
  assert.equal(evaluate(harness.context, "tabState.get(1).streams.size"), 0);
});

test("lightweight navigation candidates survive a worker restart without persisting segments", async () => {
  const first = loadBackground({ tabs: [{ id: 1, url: "https://site.test/a", documentId: "old" }] });
  await evaluate(first.context, "detectionReady");
  evaluate(first.context, `invalidateVideoSession(1, { pageUrl: "https://site.test/b", forceDocumentBoundary: true });
    captureNetworkStream(1, "https://cdn.test/b/playlist", { forcedKind: "hls", frameId: 0, documentId: "new", headers: { referer: "https://site.test/b" } });
    captureNetworkStream(1, "https://cdn.test/b/one.ts", { frameId: 0, documentId: "new" });`);
  await evaluate(first.context, "persistDetectionState(1)");
  assert.equal(first.sessionStorage["activeDetection:1"].pendingMedia.length, 1);
  const restarted = loadBackground({ tabs: [{ id: 1, url: "https://site.test/b", documentId: "new" }], sessionStorage: first.sessionStorage });
  const popup = await evaluate(restarted.context, "getPopupState(1)");
  assert.equal(popup.recommended.resourceUrl, "https://cdn.test/b/playlist");
  assert.equal(popup.streams.length, 1);
});

test("aborted document navigation reactivates the original session", async () => {
  const harness = loadBackground();
  await evaluate(harness.context, "detectionReady");
  evaluate(harness.context, 'upsertStream(1, "https://cdn.test/a/master.m3u8")');
  const sessionId = evaluate(harness.context, "tabState.get(1).sessionId");
  await harness.chrome.webNavigation.onBeforeNavigate.listener({ tabId: 1, frameId: 0, url: "https://site.test/b" });
  await harness.chrome.webNavigation.onErrorOccurred.listener({ tabId: 1, frameId: 0, url: "https://site.test/b" });
  assert.equal(evaluate(harness.context, "tabState.get(1).invalidated"), false);
  assert.equal(evaluate(harness.context, "tabState.get(1).sessionId"), sessionId);
  const popup = await evaluate(harness.context, "getPopupState(1)");
  assert.equal(popup.recommended.resourceUrl, "https://cdn.test/a/master.m3u8");
});

test("HLS MP4 initialization fragments stay out of whole-video candidates and session storage", async () => {
  const harness = loadBackground();
  await evaluate(harness.context, "detectionReady");
  for (const name of ["init.mp4", "init-stream0.mp4", "initialization.mp4"]) {
    const kind = evaluate(harness.context, `inferStreamMetadata("https://cdn.test/${name}", 0, "mp4").kind`);
    assert.equal(kind, "segment");
    evaluate(harness.context, `upsertStream(1, "https://cdn.test/${name}", { forcedKind: "mp4" })`);
  }
  assert.equal(evaluate(harness.context, 'inferStreamMetadata("https://cdn.test/movie.mp4", 0, "mp4").kind'), "mp4");
  await evaluate(harness.context, "persistDetectionState(1)");
  assert.equal(harness.sessionStorage["activeDetection:1"].streams.length, 0);
});

test("navigation creates a new VideoSession and removes old candidates", () => {
  const { context } = loadBackground();
  const result = evaluate(context, `(() => {
    const first = ensureVideoSession(1, { pageUrl: "https://site.test/a", pageTitle: "A" });
    upsertStream(1, "https://cdn.test/a/master.m3u8", { source: "network" });
    const firstId = first.sessionId;
    const second = rotateVideoSession(1, { pageUrl: "https://site.test/b", pageTitle: "B", reason: "history" });
    return { firstId, secondId: second.sessionId, streamCount: second.streams.size, pageUrl: second.pageUrl };
  })()`);
  assert.notEqual(result.firstId, result.secondId);
  assert.equal(result.streamCount, 0);
  assert.equal(result.pageUrl, "https://site.test/b");
});

test("main player currentSrc change invalidates the previous session", () => {
  const { context } = loadBackground();
  const result = evaluate(context, `(() => {
    let state = updateVideoContext(2, {
      pageUrl: "https://site.test/watch",
      mainVideo: { currentSrc: "https://cdn.test/video-a/master.m3u8", duration: 600 }
    });
    upsertStream(2, "https://cdn.test/a.m3u8", { source: "network" });
    const firstId = state.sessionId;
    state = updateVideoContext(2, {
      pageUrl: "https://site.test/watch",
      mainVideo: { currentSrc: "https://cdn.test/video-b/master.m3u8", duration: 900 }
    });
    return { firstId, secondId: state.sessionId, streamCount: state.streams.size };
  })()`);
  assert.notEqual(result.firstId, result.secondId);
  assert.equal(result.streamCount, 0);
});

test("MSE blob currentSrc and poster churn do not reset the active session", () => {
  const { context } = loadBackground();
  const result = evaluate(context, `(() => {
    let state = updateVideoContext(20, {
      pageUrl: "https://www.youtube.com/watch?v=videoA",
      poster: "https://i.ytimg.com/one.jpg",
      mainVideo: { currentSrc: "blob:https://www.youtube.com/blob-one", duration: 600 }
    });
    upsertStream(20, "https://r1.googlevideo.com/videoplayback?id=videoA&itag=137&mime=video%2Fmp4", { source: "network" });
    const firstId = state.sessionId;
    state = updateVideoContext(20, {
      pageUrl: "https://www.youtube.com/watch?v=videoA&list=playlist",
      poster: "https://i.ytimg.com/two.jpg",
      mainVideo: { currentSrc: "blob:https://www.youtube.com/blob-two", duration: 600 }
    });
    return { firstId, secondId: state.sessionId, streamCount: state.streams.size };
  })()`);
  assert.equal(result.firstId, result.secondId);
  assert.equal(result.streamCount, 1);
});

test("YouTube extractor is a real full-video candidate and A to B rotates session", () => {
  const { context } = loadBackground();
  const result = evaluate(context, `(() => {
    const first = ensureVideoSession(21, { pageUrl: "https://www.youtube.com/watch?v=videoA", pageTitle: "A" });
    const extractor = makePopupStreams(snapshotVideoSession(first), [])[0];
    const valid = validateDownloadSelection(first, extractor);
    const payload = buildDownloadPayload(first, valid.stream, { defaultQuality: "best" });
    const second = rotateVideoSession(21, { pageUrl: "https://www.youtube.com/watch?v=videoB", reason: "history" });
    return {
      kind: extractor.kind,
      downloadable: extractor.canDownloadWholeVideo,
      payloadUrl: payload.url,
      payloadKind: payload.kind,
      preferPageUrl: payload.preferPageUrl,
      rotated: first.sessionId !== second.sessionId
    };
  })()`);
  assert.equal(result.kind, "page_extractor");
  assert.equal(result.downloadable, true);
  assert.equal(result.payloadUrl, "https://www.youtube.com/watch?v=videoA");
  assert.equal(result.payloadKind, "page");
  assert.equal(result.preferPageUrl, true);
  assert.equal(result.rotated, true);
});

test("YouTube SPA start invalidates A before B, back A, and forward B commit", () => {
  const { context } = loadBackground();
  const result = evaluate(context, `(() => {
    const a = commitVideoNavigation(22, {
      pageUrl: "https://www.youtube.com/watch?v=videoA",
      pageIdentity: "youtube:videoA",
      videoId: "videoA",
      reason: "content-ready"
    });
    const aCandidate = makePageExtractorCandidate(snapshotVideoSession(a));
    upsertStream(22, "https://r1.googlevideo.com/videoplayback?id=videoA&itag=137&mime=video%2Fmp4", { source: "network" });
    invalidateVideoSession(22, { reason: "youtube-navigate-start", pageUrl: a.pageUrl });
    const staleWhileNavigating = validateDownloadSelection(a, aCandidate);
    const b = commitVideoNavigation(22, {
      pageUrl: "https://www.youtube.com/watch?v=videoB",
      pageIdentity: "youtube:videoB",
      videoId: "videoB",
      reason: "youtube-navigate-finish"
    });
    const backA = (() => {
      invalidateVideoSession(22, { reason: "popstate", pageUrl: b.pageUrl });
      return commitVideoNavigation(22, {
        pageUrl: "https://www.youtube.com/watch?v=videoA",
        pageIdentity: "youtube:videoA",
        videoId: "videoA",
        reason: "popstate"
      });
    })();
    const forwardB = (() => {
      invalidateVideoSession(22, { reason: "popstate", pageUrl: backA.pageUrl });
      return commitVideoNavigation(22, {
        pageUrl: "https://www.youtube.com/watch?v=videoB",
        pageIdentity: "youtube:videoB",
        videoId: "videoB",
        reason: "popstate"
      });
    })();
    return {
      staleWhileNavigating,
      aId: a.sessionId,
      bId: b.sessionId,
      backAId: backA.sessionId,
      forwardBId: forwardB.sessionId,
      bIdentity: b.pageIdentity,
      backIdentity: backA.pageIdentity,
      forwardIdentity: forwardB.pageIdentity,
      bStreamCount: b.streams.size,
      bTitle: b.pageTitle
    };
  })()`);
  assert.equal(result.staleWhileNavigating.ok, false);
  assert.equal(result.staleWhileNavigating.stale, true);
  assert.notEqual(result.aId, result.bId);
  assert.notEqual(result.bId, result.backAId);
  assert.notEqual(result.backAId, result.forwardBId);
  assert.equal(result.bIdentity, "youtube:videoB");
  assert.equal(result.backIdentity, "youtube:videoA");
  assert.equal(result.forwardIdentity, "youtube:videoB");
  assert.equal(result.bStreamCount, 0);
  assert.equal(result.bTitle, "正在检测视频…");
});

test("stale YouTube metadata cannot repopulate a newly committed video", () => {
  const { context } = loadBackground();
  const result = evaluate(context, `(() => {
    commitVideoNavigation(23, {
      pageUrl: "https://www.youtube.com/watch?v=videoA",
      pageIdentity: "youtube:videoA",
      videoId: "videoA",
      pageTitle: "Video A"
    });
    const stale = updateVideoContext(23, {
      pageUrl: "https://www.youtube.com/watch?v=videoB",
      pageIdentity: "youtube:videoB",
      videoId: "videoB",
      metadataVideoId: "videoA",
      metadataMatchesPage: false,
      pageTitle: "Video A",
      poster: "https://i.ytimg.com/a.jpg",
      mainVideo: { currentSrc: "blob:https://www.youtube.com/a", duration: 600 }
    });
    const staleSnapshot = {
      title: stale.pageTitle,
      poster: stale.thumbnailUrl,
      duration: stale.videoDuration
    };
    const fresh = updateVideoContext(23, {
      pageUrl: "https://www.youtube.com/watch?v=videoB",
      pageIdentity: "youtube:videoB",
      videoId: "videoB",
      metadataVideoId: "videoB",
      metadataMatchesPage: true,
      pageTitle: "Video B",
      poster: "https://i.ytimg.com/b.jpg",
      mainVideo: { currentSrc: "blob:https://www.youtube.com/b", duration: 900 }
    });
    return {
      staleTitle: staleSnapshot.title,
      stalePoster: staleSnapshot.poster,
      staleDuration: staleSnapshot.duration,
      freshTitle: fresh.pageTitle,
      freshPoster: fresh.thumbnailUrl,
      freshDuration: fresh.videoDuration
    };
  })()`);
  assert.equal(result.staleTitle, "正在检测视频…");
  assert.equal(result.stalePoster, "");
  assert.equal(result.staleDuration, 0);
  assert.equal(result.freshTitle, "Video B");
  assert.equal(result.freshPoster, "https://i.ytimg.com/b.jpg");
  assert.equal(result.freshDuration, 900);
});

test("same YouTube video navigation briefly stales but does not rotate its session", () => {
  const { context } = loadBackground();
  const result = evaluate(context, `(() => {
    const state = commitVideoNavigation(26, {
      pageUrl: "https://www.youtube.com/watch?v=videoA",
      pageIdentity: "youtube:videoA",
      videoId: "videoA"
    });
    upsertStream(26, "https://r1.googlevideo.com/videoplayback?id=videoA&itag=137&mime=video%2Fmp4", { source: "network" });
    const firstId = state.sessionId;
    const streamCount = state.streams.size;
    invalidateVideoSession(26, {
      pageUrl: "https://www.youtube.com/watch?v=videoA&list=playlist",
      pageIdentity: "youtube:videoA",
      reason: "history.replaceState"
    });
    const invalidated = state.invalidated;
    const committed = commitVideoNavigation(26, {
      pageUrl: "https://www.youtube.com/watch?v=videoA&list=playlist",
      pageIdentity: "youtube:videoA",
      videoId: "videoA",
      reason: "history.replaceState"
    });
    return {
      firstId,
      committedId: committed.sessionId,
      invalidated,
      active: !committed.invalidated,
      beforeStreams: streamCount,
      afterStreams: committed.streams.size
    };
  })()`);
  assert.equal(result.invalidated, true);
  assert.equal(result.active, true);
  assert.equal(result.firstId, result.committedId);
  assert.equal(result.beforeStreams, 1);
  assert.equal(result.afterStreams, 1);
});

test("YouTube videoplayback DASH URLs are captured and grouped by media identity", () => {
  const { context } = loadBackground();
  const result = evaluate(context, `(() => {
    const videoOne = "https://r1.googlevideo.com/videoplayback?id=abc&itag=137&mime=video%2Fmp4&range=0-999";
    const videoTwo = "https://r1.googlevideo.com/videoplayback?id=abc&itag=137&mime=video%2Fmp4&range=1000-1999";
    const audio = "https://r1.googlevideo.com/videoplayback?id=abc&itag=140&mime=audio%2Fmp4";
    return {
      isVideo: isStreamUrl(videoOne),
      videoKind: inferStreamMetadata(videoOne).kind,
      audioKind: inferStreamMetadata(audio).kind,
      grouped: streamKey(videoOne) === streamKey(videoTwo)
    };
  })()`);
  assert.equal(result.isVideo, true);
  assert.equal(result.videoKind, "dash_video");
  assert.equal(result.audioKind, "dash_audio");
  assert.equal(result.grouped, true);
});

test("YouTube resolver and DASH evidence aggregate into one logical MP4 video", () => {
  const { context } = loadBackground();
  const result = evaluate(context, `(() => {
    const state = createVideoSession(24, {
      pageUrl: "https://www.youtube.com/watch?v=videoA",
      pageIdentity: "youtube:videoA",
      pageTitle: "Video A"
    });
    state.mainVideoHeight = 720;
    const extractor = makePageExtractorCandidate(snapshotVideoSession(state));
    const dashVideo = {
      resourceId: "dash-video", kind: "dash_video", typeTag: "DASH-V",
      quality: 1080, qualityLabel: "1080p", canDownloadWholeVideo: false,
      isRecommendable: false, lastSeen: Date.now(), firstSeen: Date.now(),
      url: "https://r1.googlevideo.com/videoplayback?id=videoA&itag=137",
      host: "r1.googlevideo.com"
    };
    const dashAudio = {
      resourceId: "dash-audio", kind: "dash_audio", typeTag: "DASH-A",
      quality: 0, qualityLabel: "Auto", canDownloadWholeVideo: false,
      isRecommendable: false, lastSeen: Date.now(), firstSeen: Date.now(),
      url: "https://r1.googlevideo.com/videoplayback?id=videoA&itag=140",
      host: "r1.googlevideo.com"
    };
    const cards = aggregateLogicalVideos(
      snapshotVideoSession(state),
      rankStreams([extractor, dashVideo, dashAudio], state),
      { defaultQuality: "best", showAdvanced: true }
    );
    return {
      count: cards.length,
      kind: cards[0].kind,
      sourceKind: cards[0].sourceKind,
      typeTag: cards[0].typeTag,
      resourceId: cards[0].resourceId,
      pipelineLabel: cards[0].pipelineLabel,
      previewUrl: cards[0].previewUrl,
      previewStrategy: cards[0].previewStrategy,
      evidenceCount: cards[0].evidenceCount,
      advancedKinds: cards[0].advancedSources.map((source) => source.sourceKind),
      qualityValues: cards[0].qualityOptions.map((option) => option.value)
    };
  })()`);
  assert.equal(result.count, 1);
  assert.equal(result.kind, "logical_video");
  assert.equal(result.sourceKind, "page_extractor");
  assert.equal(result.typeTag, "MP4");
  assert.equal(result.pipelineLabel, "DASH → MP4");
  assert.equal(result.previewUrl, "");
  assert.equal(result.previewStrategy, "page_player");
  assert.match(result.resourceId, /^__page_extractor__:/);
  assert.equal(result.evidenceCount, 3);
  assert.deepEqual(Array.from(result.advancedKinds).sort(), ["dash_audio", "dash_video", "page_extractor"]);
  assert.deepEqual(Array.from(result.qualityValues), ["best", "1080p", "720p"]);
});

test("Bilibili playinfo creates one real DASH to MP4 candidate at the actual available quality", () => {
  const { context } = loadBackground();
  const result = evaluate(context, `(() => {
    const state = commitVideoNavigation(30, {
      pageUrl: "https://www.bilibili.com/video/BV1test12345/",
      pageIdentity: "bilibili:bv1test12345:p1",
      reason: "content-ready"
    });
    const before = makePageExtractorCandidate(snapshotVideoSession(state));
    updateSiteMediaContext(30, {
      provider: "bilibili",
      pageIdentity: "bilibili:bv1test12345:p1",
      pageUrl: state.pageUrl,
      bvid: "BV1test12345",
      aid: 100,
      cid: 200,
      title: "Public Bilibili Video",
      thumbnailUrl: "https://i0.hdslb.com/test.jpg",
      duration: 300,
      videos: [
        { id: 80, height: 1080, width: 1920, bandwidth: 3000000, codecid: 12, baseUrl: "https://v.example/1080-av1.m4s", backupUrls: [] },
        { id: 80, height: 1080, width: 1920, bandwidth: 2800000, codecid: 7, baseUrl: "https://v.example/1080-avc.m4s", backupUrls: ["https://v-backup.example/1080.m4s"] },
        { id: 64, height: 720, width: 1280, bandwidth: 1800000, codecid: 7, baseUrl: "https://v.example/720.m4s", backupUrls: [] }
      ],
      audios: [
        { id: 30280, bandwidth: 192000, codecid: 0, baseUrl: "https://a.example/audio.m4s", backupUrls: ["https://a-backup.example/audio.m4s"] }
      ],
      observedAt: Date.now()
    });
    const active = tabState.get(30);
    const candidate = makePageExtractorCandidate(active);
    const cards = aggregateLogicalVideos(
      snapshotVideoSession(active),
      rankStreams([makePageExtractorCandidate(snapshotVideoSession(active))], active),
      { defaultQuality: "2160p", showAdvanced: true }
    );
    const payload = buildDownloadPayload(active, candidate, { defaultQuality: "best" }, { qualityPreference: "720p" });
    return {
      before,
      kind: candidate.kind,
      bestCodec: candidate.selectedVideo.codecid,
      cardCount: cards.length,
      providerLabel: cards[0].providerLabel,
      pipelineLabel: cards[0].pipelineLabel,
      quality: cards[0].quality,
      defaultQuality: cards[0].defaultQuality,
      qualityValues: cards[0].qualityOptions.map((item) => item.value),
      payloadKind: payload.kind,
      selectedHeight: payload.directMedia.videoHeight,
      videoUrl: payload.directMedia.videoUrl,
      audioUrl: payload.directMedia.audioUrl,
      referer: payload.referer,
      preferPageUrl: payload.preferPageUrl,
      allowPageFallback: payload.allowPageFallback
    };
  })()`);
  assert.equal(result.before, null);
  assert.equal(result.kind, "bilibili_dash");
  assert.equal(result.bestCodec, 7);
  assert.equal(result.cardCount, 1);
  assert.equal(result.providerLabel, "Bilibili");
  assert.equal(result.pipelineLabel, "DASH → MP4");
  assert.equal(result.quality, 1080);
  assert.equal(result.defaultQuality, "best");
  assert.deepEqual(Array.from(result.qualityValues), ["best", "1080p", "720p"]);
  assert.equal(result.payloadKind, "bilibili_dash");
  assert.equal(result.selectedHeight, 720);
  assert.equal(result.videoUrl, "https://v.example/720.m4s");
  assert.equal(result.audioUrl, "https://a.example/audio.m4s");
  assert.equal(result.referer, "https://www.bilibili.com/video/BV1test12345/");
  assert.equal(result.preferPageUrl, true);
  assert.equal(result.allowPageFallback, true);
});

test("stale Bilibili playinfo cannot refill a newly committed BV session", () => {
  const { context } = loadBackground();
  const result = evaluate(context, `(() => {
    commitVideoNavigation(31, {
      pageUrl: "https://www.bilibili.com/video/BVold/",
      pageIdentity: "bilibili:bvold:p1"
    });
    const next = commitVideoNavigation(31, {
      pageUrl: "https://www.bilibili.com/video/BVnew/",
      pageIdentity: "bilibili:bvnew:p1"
    });
    updateSiteMediaContext(31, {
      provider: "bilibili",
      pageIdentity: "bilibili:bvold:p1",
      pageUrl: "https://www.bilibili.com/video/BVold/",
      videos: [{ height: 1080, baseUrl: "https://v.example/old.m4s" }],
      audios: [{ bandwidth: 192000, baseUrl: "https://a.example/old.m4s" }]
    });
    return {
      identity: tabState.get(31).pageIdentity,
      sessionId: tabState.get(31).sessionId,
      expectedSessionId: next.sessionId,
      hasSiteMedia: Boolean(tabState.get(31).siteMedia),
      hasCandidate: Boolean(makePageExtractorCandidate(tabState.get(31)))
    };
  })()`);
  assert.equal(result.identity, "bilibili:bvnew:p1");
  assert.equal(result.sessionId, result.expectedSessionId);
  assert.equal(result.hasSiteMedia, false);
  assert.equal(result.hasCandidate, false);
});

test("HLS master and variants aggregate into one main-video card", () => {
  const { context } = loadBackground();
  const result = evaluate(context, `(() => {
    const state = createVideoSession(25, { pageUrl: "https://site.test/watch", pageTitle: "Main" });
    const master = {
      resourceId: "master", kind: "hls_master", typeTag: "HLS", quality: 1080,
      qualityLabel: "1080p", canDownloadWholeVideo: true, isRecommendable: true,
      stronglyAssociated: true, capturedAfterMain: true, lastSeen: Date.now(), firstSeen: Date.now(),
      duration: 600, url: "https://cdn.test/master.m3u8", host: "cdn.test"
    };
    const variant = {
      resourceId: "variant", kind: "hls_media", typeTag: "HLS", quality: 720,
      qualityLabel: "720p", canDownloadWholeVideo: true, isRecommendable: true,
      parentMasterId: "master", lastSeen: Date.now(), firstSeen: Date.now(),
      duration: 600, url: "https://cdn.test/720.m3u8", host: "cdn.test"
    };
    return aggregateLogicalVideos(state, rankStreams([master, variant], state), { defaultQuality: "720p" });
  })()`);
  assert.equal(result.length, 1);
  assert.equal(result[0].typeTag, "MP4");
  assert.equal(result[0].pipelineLabel, "HLS → MP4");
  assert.equal(result[0].previewUrl, "");
  assert.equal(result[0].previewStrategy, "page_player");
  assert.equal(result[0].resourceId, "master");
  assert.equal(result[0].defaultQuality, "720p");
});

test("stale popup selection cannot resolve against a new session", () => {
  const { context } = loadBackground();
  const result = evaluate(context, `(() => {
    const first = ensureVideoSession(3, { pageUrl: "https://site.test/a" });
    upsertStream(3, "https://cdn.test/a.m3u8", { source: "network" });
    const stream = Array.from(first.streams.values())[0];
    const selection = {
      sessionId: first.sessionId,
      resourceId: stream.id,
      resourceUrl: stream.lastUrl,
      fingerprint: resourceFingerprint(first, stream)
    };
    const second = rotateVideoSession(3, { pageUrl: "https://site.test/b", reason: "history" });
    return validateDownloadSelection(second, selection);
  })()`);
  assert.equal(result.ok, false);
  assert.equal(result.stale, true);
});

test("download payload is an immutable resource snapshot", () => {
  const { context } = loadBackground();
  const result = evaluate(context, `(() => {
    const state = ensureVideoSession(4, { pageUrl: "https://site.test/a", pageTitle: "Video A" });
    updateVideoContext(4, { pageUrl: state.pageUrl, mainVideo: { currentSrc: "https://cdn.test/a.m3u8", duration: 500 } });
    upsertStream(4, "https://cdn.test/a.m3u8", { headers: { referer: state.pageUrl }, source: "dom-main-video", association: "main-current-src" });
    const stream = Array.from(state.streams.values())[0];
    const payload = buildDownloadPayload(state, stream, { defaultQuality: "best" });
    const before = payload.resourceUrl;
    stream.lastUrl = "https://cdn.test/b.m3u8";
    return {
      before,
      after: payload.resourceUrl,
      frozen: Object.isFrozen(payload) && Object.isFrozen(payload.headers) && Object.isFrozen(payload.settings),
      hasBinding: Boolean(payload.sessionId && payload.resourceId && payload.fingerprint && payload.referer)
    };
  })()`);
  assert.equal(result.before, "https://cdn.test/a.m3u8");
  assert.equal(result.after, result.before);
  assert.equal(result.frozen, true);
  assert.equal(result.hasBinding, true);
});

test("PAGE is never recommendable and scores below HLS", () => {
  const { context } = loadBackground();
  const result = evaluate(context, `(() => {
    const state = createVideoSession(5, { pageUrl: "https://site.test/a" });
    const page = { kind: "page", canDownloadWholeVideo: false, isRecommendable: false, url: state.pageUrl };
    const hls = {
      kind: "hls_master", canDownloadWholeVideo: true, isRecommendable: true,
      resourceId: "hls", lastSeen: Date.now(), firstSeen: Date.now(), quality: 720,
      sizeBytes: 10 * 1024 * 1024, duration: 600, stronglyAssociated: true,
      capturedAfterMain: true, url: "https://cdn.test/master.m3u8"
    };
    return {
      pageRecommendable: page.isRecommendable,
      pageDownloadable: page.canDownloadWholeVideo,
      pageScore: candidateScore(page, state),
      hlsScore: candidateScore(hls, state)
    };
  })()`);
  assert.equal(result.pageRecommendable, false);
  assert.equal(result.pageDownloadable, false);
  assert.ok(result.hlsScore > result.pageScore);
});

test("master playlist variants inherit their master's association evidence", () => {
  const { context } = loadBackground();
  const result = evaluate(context, `linkPlaylistCandidates([
    { kind: "hls_master", resourceId: "master", resourceUrl: "https://cdn.test/master.m3u8", variantUrls: ["https://cdn.test/720.m3u8"], stronglyAssociated: true },
    { kind: "hls_media", resourceId: "variant", resourceUrl: "https://cdn.test/720.m3u8" }
  ])[1]`);
  assert.equal(result.parentMasterId, "master");
  assert.equal(result.masterStronglyAssociated, true);
});

test("master playlist inherits strong evidence from the current variant", () => {
  const { context } = loadBackground();
  const result = evaluate(context, `linkPlaylistCandidates([
    { kind: "hls_master", resourceId: "master", resourceUrl: "https://cdn.test/master.m3u8", variantUrls: ["https://cdn.test/720.m3u8"] },
    { kind: "hls_media", resourceId: "variant", resourceUrl: "https://cdn.test/720.m3u8", stronglyAssociated: true }
  ])[0]`);
  assert.equal(result.masterStronglyAssociated, true);
});

test("strong current-player HLS outranks a weak short MP4 candidate", () => {
  const { context } = loadBackground();
  const result = evaluate(context, `(() => {
    const state = createVideoSession(6, { pageUrl: "https://site.test/watch" });
    state.videoDuration = 1200;
    state.mainVideoObservedAt = Date.now() - 1000;
    const hls = {
      kind: "hls_master", stronglyAssociated: true, capturedAfterMain: true,
      duration: 1200, quality: 1080, exactSize: false, sizeBytes: 0,
      firstSeen: Date.now(), lastSeen: Date.now(), documentUrl: state.pageUrl,
      initiator: state.pageUrl, url: "https://cdn.test/content/master.m3u8"
    };
    const weakMp4 = {
      kind: "mp4", stronglyAssociated: false, capturedAfterMain: false,
      duration: 20, quality: 720, exactSize: true, sizeBytes: 3 * 1024 * 1024,
      firstSeen: Date.now() - 5000, lastSeen: Date.now() - 5000,
      documentUrl: state.pageUrl, initiator: state.pageUrl,
      url: "https://cdn.test/preroll.mp4"
    };
    return { hls: candidateScore(hls, state), weakMp4: candidateScore(weakMp4, state) };
  })()`);
  assert.ok(result.hls > result.weakMp4);
});

test("weak candidate does not inherit main-video metadata", async () => {
  const { context } = loadBackground();
  const result = await evaluate(context, `enrichStreamForPopup({
    sessionId: "session:test", fingerprint: "fp:session", pageUrl: "https://site.test/watch",
    pageTitle: "Main video", currentSrc: "blob:https://site.test/main", thumbnailUrl: "",
    mainVideoHeight: 1080, videoDuration: 1800, mainVideoObservedAt: Date.now() - 1000
  }, {
    id: "weak", url: "https://cdn.test/preroll.mp4", lastUrl: "https://cdn.test/preroll.mp4",
    kind: "mp4", quality: 0, duration: 0, association: "session-network",
    firstSeen: Date.now() - 5000, lastSeen: Date.now() - 5000
  })`);
  assert.equal(result.quality, 0);
  assert.equal(result.duration, 0);
  assert.equal(result.stronglyAssociated, false);
});

test("download history matches only the completed resource fingerprint", async () => {
  const { context, storage } = loadBackground();
  storage.downloadHistory = [{
    fingerprint: "fp:one",
    status: "completed",
    outputPath: "/tmp/video.mp4",
    pageUrl: "https://site.test/watch"
  }];
  const same = await evaluate(context, `findDownloadedHistory({ fingerprint: "fp:one", pageUrl: "https://site.test/watch" })`);
  const other = await evaluate(context, `findDownloadedHistory({ fingerprint: "fp:two", pageUrl: "https://site.test/watch" })`);
  assert.equal(same.fingerprint, "fp:one");
  assert.equal(other, null);
});

test("an active resource is reused even when force redownload is requested", async () => {
  const { context } = loadBackground();
  const result = await evaluate(context, `(async () => {
    const payload = {
      action: "download",
      url: "https://cdn.test/video.m3u8",
      pageUrl: "https://site.test/watch",
      sourceTitle: "Video",
      sessionId: "session:one",
      resourceId: "resource:one",
      fingerprint: "fingerprint:one"
    };
    const settings = { skipDownloaded: false };
    const first = await enqueueDownload(payload, settings, { quiet: true });
    const second = await enqueueDownload(payload, settings, { quiet: true, forceRedownload: true });
    return { first, second, jobCount: jobs.size };
  })()`);
  assert.equal(result.first.ok, true);
  assert.equal(result.second.ok, true);
  assert.equal(result.second.activeDuplicate, true);
  assert.equal(result.second.jobId, result.first.jobId);
  assert.equal(result.jobCount, 1);
});

test("native host exits are converted to a readable diagnostic", () => {
  const { context } = loadBackground();
  const result = evaluate(context, `readableNativeDisconnectError("Native host has exited.")`);
  assert.match(result, /本地助手意外退出/);
});

test("a disconnected native port fails the active job instead of leaving Starting", async () => {
  const { context } = loadBackground();
  const result = await evaluate(context, `(async () => {
    const payload = {
      action: "download", url: "https://cdn.test/video.m3u8",
      pageUrl: "https://site.test/watch", sourceTitle: "Video",
      sessionId: "session:disconnect", resourceId: "resource:disconnect",
      fingerprint: "fingerprint:disconnect"
    };
    const created = await enqueueDownload(payload, { skipDownloaded: false }, { quiet: true });
    const onMessage = { listener: null, addListener(listener) { this.listener = listener; } };
    const onDisconnect = { listener: null, addListener(listener) { this.listener = listener; } };
    const port = { onMessage, onDisconnect, postMessage() {}, disconnect() {} };
    chrome.runtime.connectNative = () => port;
    startNativeJob(jobs.get(created.jobId), { outputDir: "~/Downloads/video_downloads" });
    chrome.runtime.lastError = { message: "Native host has exited." };
    onDisconnect.listener();
    const job = jobs.get(created.jobId);
    return { status: job.status, message: job.message, details: job.details, running: runningPorts.size };
  })()`);
  assert.equal(result.status, "failed");
  assert.match(result.message, /本地助手意外退出/);
  assert.match(result.details, /native-host\.log/);
  assert.equal(result.running, 0);
});

test("progress then complete stays completed after late progress and error", async () => {
  const { context } = loadBackground();
  const result = await evaluate(context, `(async () => {
    const payload = {
      action: "download", url: "https://cdn.test/video.m3u8",
      pageUrl: "https://site.test/watch", sourceTitle: "Video",
      sessionId: "session:complete", resourceId: "resource:complete",
      fingerprint: "fingerprint:complete"
    };
    const created = await enqueueDownload(payload, { skipDownloaded: false }, { quiet: true });
    const onMessage = { listener: null, addListener(listener) { this.listener = listener; } };
    const onDisconnect = { listener: null, addListener(listener) { this.listener = listener; } };
    const port = { onMessage, onDisconnect, postMessage() {}, disconnect() {} };
    chrome.runtime.connectNative = () => port;
    startNativeJob(jobs.get(created.jobId), { outputDir: "~/Downloads/video_downloads" });
    onMessage.listener({
      type: "progress", jobId: created.jobId, percent: "99.0",
      message: "下载中... 99.0%", stage: "downloading"
    });
    onMessage.listener({
      type: "complete", jobId: created.jobId, outputPath: "/tmp/video.mp4",
      fileSize: 123456, duration: 120, width: 1920, height: 1080,
      videoStreams: 1, audioStreams: 1, hasAudio: true
    });
    onMessage.listener({
      type: "progress", jobId: created.jobId, percent: "100.0",
      message: "late progress", stage: "merging"
    });
    onMessage.listener({
      type: "error", jobId: created.jobId, error: "late SSL EOF", details: "late SSL EOF"
    });
    const job = jobs.get(created.jobId);
    return {
      status: job.status,
      outputPath: job.outputPath,
      error: job.error,
      message: job.message,
      hasAudio: job.hasAudio,
      percent: job.percent
    };
  })()`);
  assert.equal(result.status, "completed");
  assert.equal(result.outputPath, "/tmp/video.mp4");
  assert.equal(result.error, "");
  assert.match(result.message, /下载完成/);
  assert.equal(result.hasAudio, true);
  assert.equal(result.percent, "100");
});

test("popup CSS keeps the document and long diagnostic content inside 390px", () => {
  const css = fs.readFileSync(path.join(__dirname, "../extension/style.css"), "utf8");
  assert.match(css, /html,\s*body\s*\{[^}]*width:\s*390px;[^}]*max-width:\s*390px;/s);
  assert.match(css, /pre\s*\{[^}]*overflow-wrap:\s*anywhere;[^}]*word-break:\s*break-word;/s);
  assert.match(css, /code\s*\{[^}]*overflow-wrap:\s*anywhere;/s);
});

test("popup preview is muted, bounded, single-instance, and silently falls back to page frames", () => {
  const popup = fs.readFileSync(path.join(__dirname, "../extension/popup.js"), "utf8");
  const content = fs.readFileSync(path.join(__dirname, "../extension/content.js"), "utf8");
  assert.match(popup, /PREVIEW_MAX_PLAY_MS\s*=\s*8000/);
  assert.match(popup, /video\.muted\s*=\s*true/);
  assert.match(popup, /video\.playsInline\s*=\s*true/);
  assert.match(popup, /video\.preload\s*=\s*"none"/);
  assert.match(popup, /stopActivePreview\(preview\)/);
  assert.match(popup, /video\.removeAttribute\("src"\)/);
  assert.match(popup, /startPagePreview/);
  assert.match(popup, /pagePreviewFrame/);
  assert.doesNotMatch(popup, /此媒体地址不支持 popup 预览/);
  assert.match(content, /canvas\.toDataURL\("image\/jpeg"/);
  assert.match(content, /PAGE_PREVIEW_MAX_MS\s*=\s*8000/);
  assert.match(content, /video\.paused/);
  assert.doesNotMatch(content, /video\.play\(/);
  assert.doesNotMatch(content, /video\.pause\(/);
});

test("advertising MP4 flood cannot evict the main HLS master or its variants", async () => {
  const h = loadBackground(); await evaluate(h.context, "detectionReady");
  evaluate(h.context, `upsertStream(1, 'https://cdn.test/main/playlist.m3u8', {forcedKind:'hls_master', association:'main-player'});
    upsertStream(1, 'https://cdn.test/main/1080p/video.m3u8', {forcedKind:'hls_media', association:'main-player'});
    for(let i=0;i<350;i++) upsertStream(1, 'https://live.test/live_'+i+'_abc_1789392384.mp4', {});`);
  assert.equal(evaluate(h.context, "tabState.get(1).streams.size"), 100);
  assert.equal(evaluate(h.context, "[...tabState.get(1).streams.values()].filter(s=>s.association==='main-player').length"), 2);
  assert.equal(evaluate(h.context, "inferStreamMetadata('https://live.test/132789258_240p_h264_init_abc.mp4').kind"), "segment");
  assert.equal(evaluate(h.context, "inferStreamMetadata('https://live.test/132789258_240p_h264_813_abc_1789392384.mp4').kind"), "segment");
});

test("playlist segment ownership demotes MP4 and disguised JPEG fragments", async () => {
  const h = loadBackground(); await evaluate(h.context, "detectionReady");
  evaluate(h.context, `upsertStream(1, 'https://cdn.test/live/file.mp4', {});
    recordPlaylist(tabState.get(1), 'https://cdn.test/live/media', parsePlaylistInfo('#EXTM3U\\n#EXT-X-MAP:URI="init.mp4"\\n#EXTINF:2,\\nfile.mp4\\n#EXTINF:2,\\nvideo1.jpeg', 'https://cdn.test/live/media'));
    upsertStream(1, 'https://cdn.test/live/file.mp4', {forcedKind:'mp4'});`);
  assert.equal(evaluate(h.context, "tabState.get(1).streams.get(streamKey('https://cdn.test/live/file.mp4')).kind"), "segment");
  assert.equal(evaluate(h.context, "tabState.get(1).segmentOwners.get('https://cdn.test/live/video1.jpeg')"), "https://cdn.test/live/media");
});

test("paused feature wins over smaller autoplay live widgets", async () => {
  const h = loadBackground(); await evaluate(h.context, "detectionReady");
  assert.ok(evaluate(h.context, "compareMainVideos({width:1920,height:1080,duration:10532,paused:true},{width:426,height:240,duration:0,paused:false})") < 0);
});

test("bound Hls instance recovers an evicted playlist after resource timing was cleared", async () => {
  const h = loadBackground(); await evaluate(h.context, "detectionReady");
  const {video} = installMediaPage(h);
  video.paused = true;
  h.context.window.hls = { media:video, url:"https://cdn.test/main/playlist.m3u8", levels:[
    {height:360,url:["https://cdn.test/main/360p/video.m3u8"]},
    {height:1080,url:["https://cdn.test/main/1080p/video.m3u8"]}
  ]};
  const p = await evaluate(h.context, "getPopupState(1)");
  assert.equal(p.recommended.resourceUrl, "https://cdn.test/main/playlist.m3u8");
  assert.equal(p.recommended.stronglyAssociated, true);
  assert.ok(p.recommended.qualityOptions.some(o=>o.value === "360p"));
  assert.ok(p.recommended.qualityOptions.some(o=>o.value === "1080p"));
  h.context.window.hls.media = {}; // Unrelated advertising player is not trusted as primary.
  evaluate(h.context, "tabState.get(1).streams.clear()");
  const unrelated = await evaluate(h.context, "getPopupState(1)");
  assert.equal(unrelated.recommended, null);
});

test("top and cross-origin nested frame snapshots preserve top page identity", async () => {
  const h = loadBackground({tabs:[{id:1,url:"https://site.test/a",documentId:"top"}]});
  await evaluate(h.context, "detectionReady");
  h.chrome.scripting.executeScript = async () => [
    {frameId:0,documentId:"top",result:{pageUrl:"https://site.test/a",title:"Feature",videos:[],resources:[]}},
    {frameId:8,documentId:"nested",result:{pageUrl:"https://player.test/embed",videos:[{
      currentSrc:"blob:https://player.test/feature",duration:600,width:1280,height:720,paused:false,
      playerSources:[{url:"https://cdn.test/main/playlist",variants:[]}]
    }],resources:[]}}
  ];
  const p=await evaluate(h.context,"getPopupState(1)");
  assert.equal(p.pageUrl,"https://site.test/a");
  assert.equal(p.recommended.resourceUrl,"https://cdn.test/main/playlist");
  assert.equal(evaluate(h.context,"tabState.get(1).mainFrameId"),8);
});

test("Range GET derives full size and cancels the response without using HEAD", async () => {
  const h=loadBackground(); await evaluate(h.context,"detectionReady");
  let cancelled=false;
  h.context.fetch=async (url,options)=>{
    assert.equal(options.method,"GET"); assert.equal(options.headers.range,"bytes=0-0");
    return {ok:true,status:206,headers:{get:n=>n==='content-range'?'bytes 0-0/12345678':'1'},body:{cancel:async()=>{cancelled=true}}};
  };
  assert.equal(await evaluate(h.context,"fetchContentLength('https://cdn.test/no-extension')"),12345678);
  assert.equal(cancelled,true);
});

test("master classification is not downgraded by generic HLS MIME",async()=>{
  const h=loadBackground();await evaluate(h.context,"detectionReady");
  evaluate(h.context,"upsertStream(1,'https://cdn.test/master.m3u8',{});upsertStream(1,'https://cdn.test/master.m3u8',{forcedKind:'hls'});");
  assert.equal(evaluate(h.context,"[...tabState.get(1).streams.values()][0].kind"),"hls_master");
});

test("changing a bound HLS playlist on the same page stales the old download selection",async()=>{
  const h=loadBackground();await evaluate(h.context,"detectionReady");
  const {video}=installMediaPage(h);
  h.context.window.hls={media:video,url:'https://cdn.test/a/master.m3u8',levels:[]};
  const first=await evaluate(h.context,"getPopupState(1)");
  h.context.window.hls.url='https://cdn.test/b/master.m3u8';
  const next=await evaluate(h.context,"getPopupState(1)");
  assert.notEqual(first.sessionId,next.sessionId);
  assert.equal(next.recommended.resourceUrl,'https://cdn.test/b/master.m3u8');
  assert.equal(evaluate(h.context,"[...tabState.get(1).streams.values()].some(s=>s.url.includes('/a/'))"),false);
});

test("exported diagnostic URLs redact query credentials and userinfo",async()=>{
  const h=loadBackground();await evaluate(h.context,"detectionReady");
  assert.equal(evaluate(h.context,"diagnosticUrl('https://alice:secret@cdn.test/playlist?token=abc#secret')"),
    'https://cdn.test/playlist?token=%5Bredacted%5D');
});
