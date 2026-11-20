(() => {
  const MEDIA_SOURCE = "darren-video-helper-active-media";
  const tokens = new WeakMap();
  const snapshots = new WeakMap();
  const interactionAt = new WeakMap();
  const frameToken = crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`;
  let nextToken = 0;

  function absolute(value) {
    if (!value) return "";
    try {
      const url = new URL(value, location.href);
      return /^(?:https?|blob):$/.test(url.protocol) ? url.href : "";
    } catch { return ""; }
  }

  function elementToken(video) {
    let token = tokens.get(video);
    if (!token) {
      token = `${frameToken}:${++nextToken}`;
      tokens.set(video, token);
    }
    return token;
  }

  function sourceIdentity(video) {
    return [
      absolute(video.currentSrc || video.src || ""),
      ...Array.from(video.querySelectorAll("source")).map(source => absolute(source.src || source.getAttribute("src") || ""))
    ].filter(Boolean).join("|");
  }

  function nearbyTitle(video) {
    const explicit = video.getAttribute("title") || video.getAttribute("aria-label") || "";
    if (explicit.trim()) return explicit.trim().slice(0, 300);
    const container = video.closest("article, figure, [data-title], [aria-label], .video, .player") || video.parentElement;
    const value = container?.getAttribute?.("data-title") || container?.getAttribute?.("aria-label")
      || container?.querySelector?.("figcaption, h1, h2, h3, [data-title]")?.textContent || "";
    return value.replace(/\s+/g, " ").trim().slice(0, 300);
  }

  function visibility(video) {
    const rect = video.getBoundingClientRect();
    const viewportWidth = Math.max(1, innerWidth || document.documentElement.clientWidth || 1);
    const viewportHeight = Math.max(1, innerHeight || document.documentElement.clientHeight || 1);
    const left = Math.max(0, rect.left);
    const top = Math.max(0, rect.top);
    const right = Math.min(viewportWidth, rect.right);
    const bottom = Math.min(viewportHeight, rect.bottom);
    const visibleArea = Math.max(0, right - left) * Math.max(0, bottom - top);
    const area = Math.max(0, rect.width) * Math.max(0, rect.height);
    return { visible: visibleArea > 0 && getComputedStyle(video).visibility !== "hidden",
      intersectionRatio: area ? visibleArea / area : 0, area };
  }

  function sendCandidate(video, eventName = "scan") {
    if (!(video instanceof HTMLVideoElement) || !video.isConnected) return;
    const now = Date.now();
    const previous = snapshots.get(video) || {};
    const currentTime = Number.isFinite(video.currentTime) ? video.currentTime : 0;
    const sourceKey = sourceIdentity(video);
    const progressed = currentTime > Number(previous.currentTime || 0) + 0.04;
    const sourceChanged = Boolean(previous.sourceKey !== undefined && previous.sourceKey !== sourceKey);
    const next = {
      sourceKey,
      sourceEpoch: Number(previous.sourceEpoch || 0) + Number(sourceChanged),
      currentTime,
      lastCurrentTime: Number(previous.currentTime || 0),
      lastTimeProgressAt: progressed ? now : Number(previous.lastTimeProgressAt || 0),
      lastPlayAt: eventName === "play" ? now : Number(previous.lastPlayAt || 0),
      lastPlayingAt: eventName === "playing" || progressed ? now : Number(previous.lastPlayingAt || 0),
      lastPauseAt: eventName === "pause" ? now : Number(previous.lastPauseAt || 0),
      lastSourceChangeAt: sourceChanged || ["loadstart", "emptied", "source-change"].includes(eventName)
        ? now : Number(previous.lastSourceChangeAt || 0)
    };
    snapshots.set(video, next);
    const view = visibility(video);
    try {
      chrome.runtime.sendMessage({
        type: "mediaCandidateUpdate",
        candidate: {
          videoElementToken: elementToken(video), sourceKey,
          sourceEpoch: next.sourceEpoch,
          src: absolute(video.src || ""), currentSrc: absolute(video.currentSrc || ""),
          duration: Number.isFinite(video.duration) ? video.duration : 0,
          videoWidth: video.videoWidth || 0, videoHeight: video.videoHeight || 0,
          paused: video.paused, ended: video.ended, currentTime,
          lastCurrentTime: next.lastCurrentTime, lastTimeProgressAt: next.lastTimeProgressAt,
          lastPlayAt: next.lastPlayAt, lastPlayingAt: next.lastPlayingAt,
          lastPauseAt: next.lastPauseAt, lastSourceChangeAt: next.lastSourceChangeAt,
          lastUserInteractionAt: Number(interactionAt.get(video) || 0),
          visibility: view.visible, intersectionRatio: view.intersectionRatio,
          boundingRectArea: view.area, title: nearbyTitle(video),
          poster: absolute(video.poster || ""), event: eventName, observedAt: now
        }
      }, () => { void chrome.runtime.lastError; });
    } catch { /* An old isolated world can survive extension reload. */ }
  }

  function scan(eventName = "scan") {
    document.querySelectorAll("video").forEach(video => sendCandidate(video, eventName));
  }

  for (const eventName of ["play", "playing", "pause", "loadstart", "loadedmetadata", "durationchange",
    "timeupdate", "seeking", "seeked", "emptied", "ended", "waiting", "canplay"]) {
    document.addEventListener(eventName, event => sendCandidate(event.target, eventName), true);
  }
  for (const eventName of ["pointerdown", "click", "touchstart"]) {
    document.addEventListener(eventName, event => {
      const video = event.target?.closest?.("video");
      if (!video) return;
      interactionAt.set(video, Date.now());
      sendCandidate(video, "user-interaction");
    }, true);
  }
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "rescanActiveMedia") return false;
    scan("manual-rescan");
    sendResponse({ ok: true, count: document.querySelectorAll("video").length });
    return false;
  });
  new MutationObserver(records => {
    let changed = false;
    for (const record of records) {
      if (record.type === "attributes" && record.target instanceof HTMLVideoElement) {
        sendCandidate(record.target, "source-change"); changed = true;
      }
      for (const node of record.addedNodes) {
        if (node instanceof HTMLVideoElement) sendCandidate(node, "added");
        node.querySelectorAll?.("video").forEach(video => sendCandidate(video, "added"));
      }
      for (const node of record.removedNodes) {
        const removed = node instanceof HTMLVideoElement ? [node] : Array.from(node.querySelectorAll?.("video") || []);
        for (const video of removed) {
          try { chrome.runtime.sendMessage({ type: "mediaCandidateRemoved", videoElementToken: tokens.get(video) || "" }); } catch {}
        }
      }
    }
    if (changed) queueMicrotask(() => scan("mutation"));
  }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ["src"] });
  window.setInterval(() => scan("heartbeat"), 750);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => scan("ready"), { once: true });
  else scan("ready");

  window.addEventListener("message", event => {
    if (event.source === window && event.data?.source === "darren-video-helper-media-request") {
      const item = event.data.item;
      if (item && typeof item.url === "string" && item.url.length < 32768 && /^https?:/i.test(item.url)) {
        try { chrome.runtime.sendMessage({ type: "observedMediaRequest", item }, () => { void chrome.runtime.lastError; }); } catch {}
      }
      return;
    }
    if (event.source !== window || event.data?.source !== "darren-video-helper-hls-response") return;
    const item = event.data.item;
    if (!item || !/^https?:/i.test(item.url || "") || typeof item.text !== "string"
      || item.text.length > 1024 * 1024 || !/^\s*#EXTM3U\b/.test(item.text)) return;
    try {
      chrome.runtime.sendMessage({ type: "observedPlaylist", item }, () => { void chrome.runtime.lastError; });
    } catch { /* An old isolated world can survive an extension reload. */ }
  }, true);
})();
