(() => {
  const NAVIGATION_SOURCE = "darren-video-helper-navigation";
  let lastContextSignature = "";
  let lastCommittedIdentity = "";
  let lastCommittedHref = "";
  let pendingTimer = 0;

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

  function selectMainVideo() {
    return Array.from(document.querySelectorAll("video"))
      .map(describe)
      .filter((video) => video.currentSrc || video.duration || video.width || video.height)
      .sort((left, right) => {
        const playingDiff = Number(!right.paused) - Number(!left.paused);
        if (playingDiff) return playingDiff;
        const areaDiff = (right.width * right.height) - (left.width * left.height);
        if (areaDiff) return areaDiff;
        return (right.duration || 0) - (left.duration || 0);
      })[0] || null;
  }

  function send(message) {
    chrome.runtime.sendMessage(message, () => {
      void chrome.runtime.lastError;
    });
  }

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
