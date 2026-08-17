(() => {
  if (window.__darrenVideoNavigationBridgeInstalled) return;
  window.__darrenVideoNavigationBridgeInstalled = true;

  const SOURCE = "darren-video-helper-navigation";
  const PAGE_MEDIA_SOURCE = "darren-video-helper-page-media";
  let lastHref = location.href;
  let finishTimer = 0;
  let lastBilibiliSignature = "";

  function post(phase, reason, previousHref = lastHref) {
    const href = location.href;
    window.postMessage({
      source: SOURCE,
      type: "navigation",
      phase,
      reason,
      href,
      previousHref,
      at: Date.now()
    }, location.origin === "null" ? "*" : location.origin);
    lastHref = href;
  }

  function finishSoon(reason) {
    window.clearTimeout(finishTimer);
    finishTimer = window.setTimeout(() => post("finish", reason), 0);
  }

  function bilibiliPageInfo(url = location.href) {
    try {
      const parsed = new URL(url, location.href);
      const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
      if (host !== "bilibili.com" && !host.endsWith(".bilibili.com")) return null;
      const match = parsed.pathname.match(/^\/video\/(BV[0-9A-Za-z]+|av\d+)/i);
      if (!match) return null;
      const videoKey = match[1].toLowerCase();
      const page = parsed.searchParams.get("p") || "1";
      return {
        videoKey,
        page,
        pageIdentity: `bilibili:${videoKey}:p${page}`,
        pageUrl: parsed.href
      };
    } catch {
      return null;
    }
  }

  function requestIdentity(requestUrl, fallback) {
    try {
      const parsed = new URL(String(requestUrl || ""), location.href);
      const bvid = parsed.searchParams.get("bvid");
      const aid = parsed.searchParams.get("avid") || parsed.searchParams.get("aid");
      if (bvid) return `bilibili:${bvid.toLowerCase()}:p${fallback?.page || "1"}`;
      if (aid) return `bilibili:av${aid}:p${fallback?.page || "1"}`;
    } catch {
      // Fall back to the current page identity.
    }
    return fallback?.pageIdentity || "";
  }

  function mediaUrl(value) {
    if (!value) return "";
    try {
      const parsed = new URL(value, location.href);
      return /^https?:$/.test(parsed.protocol) ? parsed.href : "";
    } catch {
      return "";
    }
  }

  function bilibiliQuality(id, height) {
    const tiers = {
      6: 240, 16: 360, 32: 480, 64: 720, 74: 720,
      80: 1080, 112: 1080, 116: 1080, 120: 2160,
      125: 2160, 126: 1080, 127: 4320
    };
    return tiers[Number(id || 0)] || Number(height || 0);
  }

  function normalizeDashItems(items, kind) {
    if (!Array.isArray(items)) return [];
    return items.slice(0, 40).map((item) => {
      const baseUrl = mediaUrl(item?.baseUrl || item?.base_url || "");
      const backupUrls = (item?.backupUrl || item?.backup_url || [])
        .map(mediaUrl)
        .filter(Boolean)
        .slice(0, 4);
      return {
        id: Number(item?.id || 0),
        height: kind === "video" ? Number(item?.height || 0) : 0,
        quality: kind === "video" ? bilibiliQuality(item?.id, item?.height) : 0,
        width: kind === "video" ? Number(item?.width || 0) : 0,
        bandwidth: Number(item?.bandwidth || 0),
        codecid: Number(item?.codecid || 0),
        codecs: String(item?.codecs || ""),
        mimeType: String(item?.mimeType || item?.mime_type || ""),
        baseUrl,
        backupUrls
      };
    }).filter((item) => item.baseUrl);
  }

  function bilibiliMedia(payload, reason, requestUrl = "") {
    const page = bilibiliPageInfo();
    if (!page) return null;
    const initial = window.__INITIAL_STATE__ || {};
    const body = payload?.data?.dash ? payload.data
      : payload?.result?.dash ? payload.result
        : payload?.dash ? payload
          : null;
    const dash = body?.dash;
    if (!dash) return null;

    const videos = normalizeDashItems(dash.video, "video");
    const audios = normalizeDashItems(dash.audio, "audio");
    if (!videos.length || !audios.length) return null;

    const requestPageIdentity = requestIdentity(requestUrl, page);
    const initialBvid = initial.bvid || initial.videoData?.bvid || "";
    const initialAid = Number(initial.aid || initial.videoData?.aid || 0);
    const requestUrlValue = (() => {
      try { return new URL(String(requestUrl || ""), location.href); } catch { return null; }
    })();
    const requestBvid = requestUrlValue?.searchParams.get("bvid") || "";
    const requestAid = Number(requestUrlValue?.searchParams.get("avid") || requestUrlValue?.searchParams.get("aid") || 0);
    if (!requestBvid && !requestAid) {
      if (/^bv/i.test(page.videoKey) && initialBvid
        && page.videoKey !== String(initialBvid).toLowerCase()) return null;
      const pageAid = Number(page.videoKey.match(/^av(\d+)$/i)?.[1] || 0);
      if (pageAid && initialAid && pageAid !== initialAid) return null;
    }
    const bvid = requestBvid || initialBvid || (/^bv/i.test(page.videoKey) ? page.videoKey : "");
    const aid = requestAid || initialAid || Number(page.videoKey.match(/^av(\d+)$/i)?.[1] || 0);
    const cid = Number(body.cid || requestUrlValue?.searchParams.get("cid") || initial.cid || initial.videoData?.cid || 0);
    const identity = requestBvid || requestAid ? requestPageIdentity : page.pageIdentity;
    const initialMatches = (!bvid || !initialBvid || bvid.toLowerCase() === String(initialBvid).toLowerCase())
      && (!aid || !initialAid || aid === initialAid);
    const title = initialMatches ? String(initial.videoData?.title || initial.title || document.title || "") : "";
    const thumbnailUrl = initialMatches ? mediaUrl(initial.videoData?.pic || initial.pic || "") : "";
    const qualities = Array.from(new Set(videos.map((item) => item.quality).filter(Boolean))).sort((a, b) => b - a);

    return {
      provider: "bilibili",
      pageIdentity: identity,
      pageUrl: page.pageUrl,
      bvid: String(bvid || ""),
      aid,
      cid,
      title,
      thumbnailUrl,
      duration: Number(dash.duration || body.timelength / 1000 || 0),
      quality: qualities[0] || 0,
      qualities,
      videos,
      audios,
      observedAt: Date.now(),
      reason
    };
  }

  function postBilibiliMedia(payload, reason, requestUrl = "") {
    const media = bilibiliMedia(payload, reason, requestUrl);
    if (!media) return;
    const signature = [
      media.pageIdentity,
      media.cid,
      media.quality,
      media.videos[0]?.baseUrl,
      media.audios[0]?.baseUrl
    ].join("|");
    if (signature === lastBilibiliSignature && reason !== "content-request") return;
    lastBilibiliSignature = signature;
    window.postMessage({
      source: PAGE_MEDIA_SOURCE,
      type: "bilibili-media",
      media
    }, location.origin === "null" ? "*" : location.origin);
  }

  function publishBilibiliGlobals(reason) {
    postBilibiliMedia(window.__playinfo__, reason);
  }

  function isBilibiliPlayurl(url) {
    return /\/x\/player\/(?:wbi\/)?playurl(?:$|[?#])/i.test(String(url || ""));
  }

  if (bilibiliPageInfo()) {
    const originalFetch = window.fetch;
    if (typeof originalFetch === "function") {
      window.fetch = async function darrenVideoFetchBridge(...args) {
        const response = await originalFetch.apply(this, args);
        const requestUrl = typeof args[0] === "string" ? args[0] : args[0]?.url;
        if (isBilibiliPlayurl(requestUrl)) {
          response.clone().json().then((body) => {
            postBilibiliMedia(body, "fetch-playurl", requestUrl);
          }).catch(() => {});
        }
        return response;
      };
    }

    const xhrPrototype = window.XMLHttpRequest?.prototype;
    if (xhrPrototype) {
      const originalOpen = xhrPrototype.open;
      const originalSend = xhrPrototype.send;
      xhrPrototype.open = function darrenVideoXhrOpen(method, url, ...args) {
        this.__darrenVideoRequestUrl = String(url || "");
        return originalOpen.call(this, method, url, ...args);
      };
      xhrPrototype.send = function darrenVideoXhrSend(...args) {
        if (isBilibiliPlayurl(this.__darrenVideoRequestUrl)) {
          this.addEventListener("load", () => {
            try {
              const body = typeof this.response === "object" && this.response
                ? this.response
                : JSON.parse(this.responseText || "{}");
              postBilibiliMedia(body, "xhr-playurl", this.__darrenVideoRequestUrl);
            } catch {
              // Ignore non-JSON playurl responses.
            }
          }, { once: true });
        }
        return originalSend.apply(this, args);
      };
    }

    window.addEventListener("message", (event) => {
      if (event.source !== window || event.data?.source !== PAGE_MEDIA_SOURCE
        || event.data?.type !== "request-bilibili-media") return;
      publishBilibiliGlobals("content-request");
    }, true);
    window.setInterval(() => publishBilibiliGlobals("playinfo-poll"), 800);
    publishBilibiliGlobals("bridge-ready");
  }

  for (const eventName of ["youtube-navigate-start", "yt-navigate-start"]) {
    document.addEventListener(eventName, () => post("start", eventName), true);
  }

  for (const eventName of ["youtube-navigate-finish", "yt-navigate-finish"]) {
    document.addEventListener(eventName, () => post("finish", eventName), true);
  }

  for (const method of ["pushState", "replaceState"]) {
    const original = history[method];
    if (typeof original !== "function") continue;
    history[method] = function darrenVideoHistoryBridge(...args) {
      const previousHref = location.href;
      post("start", `history.${method}`, previousHref);
      const result = original.apply(this, args);
      post("commit", `history.${method}`, previousHref);
      finishSoon(`history.${method}`);
      return result;
    };
  }

  window.addEventListener("popstate", () => {
    post("start", "popstate");
    post("commit", "popstate");
    finishSoon("popstate");
  }, true);

  window.setInterval(() => {
    if (location.href === lastHref) return;
    const previousHref = lastHref;
    post("start", "location-poll", previousHref);
    post("commit", "location-poll", previousHref);
    finishSoon("location-poll");
  }, 500);

  post("commit", "bridge-ready");
})();
