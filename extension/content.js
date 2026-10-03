(() => {
  let lastSignature = "";
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

  function publish() {
    pendingTimer = 0;
    const mainVideo = selectMainVideo();
    const signature = [
      location.href,
      document.title,
      mainVideo?.currentSrc || "",
      mainVideo?.poster || "",
      Math.round(mainVideo?.duration || 0),
      mainVideo?.width || 0,
      mainVideo?.height || 0
    ].join("|");
    if (signature === lastSignature) return;
    lastSignature = signature;
    chrome.runtime.sendMessage({
      type: "videoContext",
      context: {
        pageUrl: location.href,
        pageTitle: document.title || "video",
        poster: mainVideo?.poster || "",
        hasVideoElement: Boolean(document.querySelector("video")),
        mainVideo,
        reason: "content-observer"
      }
    }, () => {
      void chrome.runtime.lastError;
    });
  }

  function schedule() {
    if (pendingTimer) return;
    pendingTimer = window.setTimeout(publish, 120);
  }

  for (const eventName of ["play", "loadedmetadata", "durationchange", "emptied", "abort"]) {
    document.addEventListener(eventName, schedule, true);
  }
  window.addEventListener("popstate", schedule, true);
  window.addEventListener("hashchange", schedule, true);
  document.addEventListener("visibilitychange", schedule, true);
  new MutationObserver(schedule).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["src", "poster"]
  });
  window.setInterval(schedule, 1500);
  schedule();
})();
