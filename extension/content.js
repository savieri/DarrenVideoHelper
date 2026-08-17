(() => {
  const NAVIGATION_SOURCE = "darren-video-helper-navigation";
  let lastContextSignature = "";
  let lastCommittedIdentity = "";
  let lastCommittedHref = "";
  let pendingTimer = 0;
  let activePreviewSession = null;
  const PAGE_PREVIEW_INTERVAL_MS = 320;
  const PAGE_PREVIEW_MAX_MS = 8000;

  function absolute(value) {
    if (!value) return "";
    try {
      const url = new URL(value, location.href);
      return ["http:", "https:", "blob:"].includes(url.protocol) ? url.href : "";
    } catch {
      return "";
    }
  }

  function youtubeVideoId(url = location.href) {
    try {
      const parsed = new URL(url, location.href);
      const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
      if (host === "youtu.be") return parsed.pathname.split("/").filter(Boolean)[0] || "";
      if (host !== "youtube.com" && !host.endsWith(".youtube.com")) return "";
      if (parsed.pathname === "/watch") return parsed.searchParams.get("v") || "";
      return parsed.pathname.match(/^\/(?:shorts|live|embed)\/([^/?#]+)/i)?.[1] || "";
    } catch {
      return "";
    }
  }

  function metadataVideoId() {
    const candidates = [
      document.querySelector("ytd-watch-flexy[video-id]")?.getAttribute("video-id"),
      document.querySelector("#movie_player[data-video-id]")?.getAttribute("data-video-id"),
      document.querySelector('meta[itemprop="videoId"]')?.content,
      document.querySelector('meta[itemprop="identifier"]')?.content
    ];
    return candidates.find(Boolean) || "";
  }

  function pageIdentity(url = location.href) {
    const videoId = youtubeVideoId(url);
    if (videoId) return `youtube:${videoId}`;
    try {
      const parsed = new URL(url, location.href);
      parsed.hash = "";
      return parsed.href;
    } catch {
      return String(url || "");
    }
  }

  function describe(video) {
    return {
      currentSrc: absolute(video.currentSrc || video.src || ""),
      width: video.videoWidth || video.clientWidth || 0,
      height: video.videoHeight || video.clientHeight || 0,
      duration: Number.isFinite(video.duration) ? video.duration : 0,
      currentTime: Number.isFinite(video.currentTime) ? video.currentTime : 0,
      paused: video.paused,
      poster: absolute(video.poster || "")
    };
  }

  function selectMainVideoElement() {
    return Array.from(document.querySelectorAll("video"))
      .filter((video) => video.currentSrc || video.src || video.duration || video.videoWidth || video.clientWidth)
      .sort((left, right) => {
        const playingDiff = Number(!right.paused) - Number(!left.paused);
        if (playingDiff) return playingDiff;
        const leftArea = (left.videoWidth || left.clientWidth || 0) * (left.videoHeight || left.clientHeight || 0);
        const rightArea = (right.videoWidth || right.clientWidth || 0) * (right.videoHeight || right.clientHeight || 0);
        const areaDiff = rightArea - leftArea;
        if (areaDiff) return areaDiff;
        return (right.duration || 0) - (left.duration || 0);
      })[0] || null;
  }

  function selectMainVideo() {
    const video = selectMainVideoElement();
    return video ? describe(video) : null;
  }

  function send(message) {
    chrome.runtime.sendMessage(message, () => {
      void chrome.runtime.lastError;
    });
  }

  function sendPreviewEvent(message) {
    send({ source: "darren-video-helper-page-preview", ...message });
  }

  function stopPagePreview(token = "", reason = "stopped") {
    const session = activePreviewSession;
    if (!session || (token && session.token !== token)) return false;
    activePreviewSession = null;
    window.clearTimeout(session.timer);
    window.clearTimeout(session.stopTimer);
    if (reason !== "replaced") {
      sendPreviewEvent({ type: "pagePreviewStopped", token: session.token, reason });
    }
    return true;
  }

  function capturePagePreviewFrame(session) {
    if (activePreviewSession !== session || Date.now() >= session.deadline) {
      stopPagePreview(session.token, "timeout");
      return;
    }

    const video = selectMainVideoElement();
    const sourceWidth = video?.videoWidth || video?.clientWidth || 0;
    const sourceHeight = video?.videoHeight || video?.clientHeight || 0;
    if (!video || video.readyState < 2 || !sourceWidth || !sourceHeight) {
      if (Date.now() - session.startedAt > 1800) {
        sendPreviewEvent({ type: "pagePreviewUnavailable", token: session.token });
        stopPagePreview(session.token, "unavailable");
        return;
      }
      session.timer = window.setTimeout(() => capturePagePreviewFrame(session), 120);
      return;
    }

    const width = Math.min(336, sourceWidth);
    const height = Math.max(1, Math.round(width * sourceHeight / sourceWidth));
    try {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) throw new Error("2D canvas is unavailable");
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "medium";
      context.drawImage(video, 0, 0, width, height);
      sendPreviewEvent({
        type: "pagePreviewFrame",
        token: session.token,
        frame: canvas.toDataURL("image/jpeg", 0.68),
        pageTime: Number.isFinite(video.currentTime) ? video.currentTime : 0,
        pagePaused: video.paused
      });
      session.frameCount += 1;
    } catch {
      sendPreviewEvent({ type: "pagePreviewUnavailable", token: session.token });
      stopPagePreview(session.token, "unavailable");
      return;
    }

    session.timer = window.setTimeout(
      () => capturePagePreviewFrame(session),
      PAGE_PREVIEW_INTERVAL_MS
    );
  }

  function startPagePreview(token, requestedDuration) {
    stopPagePreview("", "replaced");
    const video = selectMainVideoElement();
    if (!token || !video) return false;
    const duration = Math.max(500, Math.min(PAGE_PREVIEW_MAX_MS, Number(requestedDuration) || PAGE_PREVIEW_MAX_MS));
    const session = {
      token,
      startedAt: Date.now(),
      deadline: Date.now() + duration,
      frameCount: 0,
      timer: 0,
      stopTimer: 0
    };
    activePreviewSession = session;
    session.stopTimer = window.setTimeout(() => stopPagePreview(token, "timeout"), duration);
    capturePagePreviewFrame(session);
    return true;
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "startPagePreview") {
      const ok = startPagePreview(message.token, message.maxDurationMs);
      sendResponse({ ok });
      return false;
    }
    if (message?.type === "stopPagePreview") {
      stopPagePreview(message.token || "", "popup-leave");
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });

  function navigationContext(phase, reason, href = location.href, previousHref = "") {
    const videoId = youtubeVideoId(href);
    return {
      type: "videoNavigation",
      navigation: {
        phase,
        reason,
        pageUrl: href,
        previousPageUrl: previousHref,
        pageIdentity: pageIdentity(href),
        videoId,
        observedAt: Date.now()
      }
    };
  }

  function publishNavigation(phase, reason, href = location.href, previousHref = "") {
    const identity = pageIdentity(href);
    if (phase !== "start" && identity === lastCommittedIdentity && href === lastCommittedHref && reason !== "bridge-ready") {
      return;
    }
    send(navigationContext(phase, reason, href, previousHref));
    if (phase !== "start") {
      lastCommittedIdentity = identity;
      lastCommittedHref = href;
    }
  }

  function publishContext() {
    pendingTimer = 0;
    const mainVideo = selectMainVideo();
    const videoId = youtubeVideoId();
    const metadataId = metadataVideoId();
    const metadataMatchesPage = !videoId || !metadataId || videoId === metadataId;
    const signature = [
      pageIdentity(),
      location.href,
      metadataId,
      document.title,
      mainVideo?.currentSrc || "",
      mainVideo?.poster || "",
      Math.round(mainVideo?.duration || 0),
      mainVideo?.width || 0,
      mainVideo?.height || 0
    ].join("|");
    if (signature === lastContextSignature) return;
    lastContextSignature = signature;
    send({
      type: "videoContext",
      context: {
        pageUrl: location.href,
        pageIdentity: pageIdentity(),
        videoId,
        metadataVideoId: metadataId,
        metadataMatchesPage,
        pageTitle: metadataMatchesPage ? (document.title || "video") : "",
        poster: metadataMatchesPage ? (mainVideo?.poster || "") : "",
        hasVideoElement: Boolean(document.querySelector("video")),
        mainVideo: metadataMatchesPage ? mainVideo : null,
        reason: "content-observer"
      }
    });
  }

  function schedule() {
    if (pendingTimer) return;
    pendingTimer = window.setTimeout(publishContext, 100);
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== NAVIGATION_SOURCE || event.data?.type !== "navigation") return;
    publishNavigation(event.data.phase, event.data.reason, event.data.href, event.data.previousHref || "");
    schedule();
  }, true);

  for (const eventName of [
    "youtube-navigate-start",
    "youtube-navigate-finish",
    "yt-navigate-start",
    "yt-navigate-finish"
  ]) {
    document.addEventListener(eventName, () => {
      const phase = eventName.endsWith("start") ? "start" : "finish";
      publishNavigation(phase, eventName);
      schedule();
    }, true);
  }

  for (const eventName of ["play", "loadedmetadata", "durationchange", "emptied", "abort"]) {
    document.addEventListener(eventName, schedule, true);
  }
  window.addEventListener("popstate", () => {
    publishNavigation("commit", "content-popstate");
    schedule();
  }, true);
  window.addEventListener("hashchange", schedule, true);
  document.addEventListener("visibilitychange", schedule, true);
  new MutationObserver(schedule).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["src", "poster", "video-id", "data-video-id", "content"]
  });

  window.setInterval(() => {
    const identity = pageIdentity();
    if (identity !== lastCommittedIdentity || location.href !== lastCommittedHref) {
      publishNavigation("start", "content-location-poll", location.href, lastCommittedHref);
      publishNavigation("commit", "content-location-poll", location.href, lastCommittedHref);
    }
    schedule();
  }, 500);

  publishNavigation("commit", "content-ready");
  schedule();
})();
