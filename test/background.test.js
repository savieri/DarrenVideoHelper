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

function loadBackground() {
  const storage = { downloadHistory: [] };
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
      async get(tabId) { return { id: tabId, url: "https://site.test/a", title: "A" }; },
      async query() { return [{ id: 1, url: "https://site.test/a", title: "A" }]; }
    },
    webNavigation: {
      onCommitted: event(),
      onHistoryStateUpdated: event(),
      onReferenceFragmentUpdated: event()
    },
    webRequest: {
      onBeforeRequest: event(),
      onBeforeSendHeaders: event()
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
  return { context, storage };
}

function evaluate(context, expression) {
  return vm.runInContext(expression, context);
}

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
  assert.match(result.previewUrl, /googlevideo\.com\/videoplayback/);
  assert.match(result.resourceId, /^__page_extractor__:/);
  assert.equal(result.evidenceCount, 3);
  assert.deepEqual(Array.from(result.advancedKinds).sort(), ["dash_audio", "dash_video", "page_extractor"]);
  assert.deepEqual(Array.from(result.qualityValues), ["best", "1080p", "720p"]);
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
  assert.equal(result[0].previewUrl, "https://cdn.test/720.m3u8");
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

test("a verified completion cannot be overwritten by a later native error", async () => {
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
      type: "complete", jobId: created.jobId, outputPath: "/tmp/video.mp4",
      fileSize: 123456, duration: 120, width: 1920, height: 1080
    });
    onMessage.listener({
      type: "error", jobId: created.jobId, error: "late SSL EOF", details: "late SSL EOF"
    });
    const job = jobs.get(created.jobId);
    return { status: job.status, outputPath: job.outputPath, error: job.error };
  })()`);
  assert.equal(result.status, "completed");
  assert.equal(result.outputPath, "/tmp/video.mp4");
  assert.equal(result.error, "");
});

test("popup CSS keeps the document and long diagnostic content inside 390px", () => {
  const css = fs.readFileSync(path.join(__dirname, "../extension/style.css"), "utf8");
  assert.match(css, /html,\s*body\s*\{[^}]*width:\s*390px;[^}]*max-width:\s*390px;/s);
  assert.match(css, /pre\s*\{[^}]*overflow-wrap:\s*anywhere;[^}]*word-break:\s*break-word;/s);
  assert.match(css, /code\s*\{[^}]*overflow-wrap:\s*anywhere;/s);
});

test("popup preview is muted, metadata-light, bounded, and single-instance", () => {
  const popup = fs.readFileSync(path.join(__dirname, "../extension/popup.js"), "utf8");
  assert.match(popup, /PREVIEW_MAX_PLAY_MS\s*=\s*8000/);
  assert.match(popup, /video\.muted\s*=\s*true/);
  assert.match(popup, /video\.playsInline\s*=\s*true/);
  assert.match(popup, /video\.preload\s*=\s*"none"/);
  assert.match(popup, /stopActivePreview\(preview\)/);
  assert.match(popup, /video\.removeAttribute\("src"\)/);
});
