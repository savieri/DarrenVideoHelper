(() => {
  if (window.__darrenMediaObserver) return;
  const playlists = new Map();
  const SOURCE = "darren-video-helper-hls-response";
  const MAX_TEXT = 1024 * 1024;
  const remember = (url, text, observedAt) => {
    if (!/^\s*#EXTM3U\b/.test(text) || !/^https?:/i.test(url)) return;
    const item = { url, text: text.slice(0, MAX_TEXT), observedAt, pageUrl: location.href, userAgent: navigator.userAgent };
    playlists.set(url, item);
    while (playlists.size > 32) playlists.delete(playlists.keys().next().value);
    window.postMessage({ source: SOURCE, item }, "*");
  };
  window.__darrenMediaObserver = { snapshot: () => [...playlists.values()] };
  const inspect = async (response, observedAt) => {
    let clone;
    try {
      const mime = response.headers.get("content-type") || "";
      if (!response.ok || (!/mpegurl|text\/|octet-stream|application\/vnd.apple/i.test(mime)
        && !/\.m3u8(?:$|[?#])/i.test(response.url))) return;
      if (Number(response.headers.get("content-length")) > MAX_TEXT) return;
      clone = response.clone();
      const reader = clone.body?.getReader();
      if (!reader) return;
      const decoder = new TextDecoder();
      let text = "";
      const timer = setTimeout(() => { void reader.cancel().catch(() => {}); }, 5000);
      try {
        while (text.length <= MAX_TEXT) {
          const { done, value } = await reader.read();
          if (done) break;
          text += decoder.decode(value, { stream: true });
          if (text.length >= 16 && !/^\s*#EXTM3U\b/.test(text)) break;
        }
        if (text.length <= MAX_TEXT) remember(response.url, text, observedAt);
      } finally { clearTimeout(timer); void reader.cancel().catch(() => {}); }
    } catch { /* Observing a response must never change playback. */ }
  };
  const originalFetch = window.fetch;
  if (originalFetch) window.fetch = function (...args) {
    const observedAt = Date.now();
    const result = originalFetch.apply(this, args);
    void result.then(response => inspect(response, observedAt)).catch(() => {});
    return result;
  };
  const open = XMLHttpRequest.prototype.open;
  const send = XMLHttpRequest.prototype.send;
  const requests = new WeakMap();
  XMLHttpRequest.prototype.open = function (...args) {
    requests.set(this, {});
    return open.apply(this, args);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    const request = requests.get(this) || {};
    request.observedAt = Date.now();
    this.addEventListener("load", () => {
      try {
        if (this.status >= 200 && this.status < 300 && ["", "text"].includes(this.responseType)
          && this.responseText.length <= MAX_TEXT) remember(this.responseURL, this.responseText, request.observedAt);
      } catch { /* Binary/CORS responses remain untouched. */ }
    }, { once: true });
    return send.apply(this, args);
  };
})();
