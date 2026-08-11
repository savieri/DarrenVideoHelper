(() => {
  if (window.__darrenVideoNavigationBridgeInstalled) return;
  window.__darrenVideoNavigationBridgeInstalled = true;

  const SOURCE = "darren-video-helper-navigation";
  let lastHref = location.href;
  let finishTimer = 0;

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
