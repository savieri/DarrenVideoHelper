(() => {
  window.addEventListener("message", event => {
    if (event.source !== window || event.data?.source !== "darren-video-helper-hls-response") return;
    const item = event.data.item;
    if (!item || !/^https?:/i.test(item.url || "") || typeof item.text !== "string"
      || item.text.length > 1024 * 1024 || !/^\s*#EXTM3U\b/.test(item.text)) return;
    try {
      chrome.runtime.sendMessage({ type: "observedPlaylist", item }, () => { void chrome.runtime.lastError; });
    } catch { /* An old isolated world can survive an extension reload. */ }
  }, true);
})();
