const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadContent(initialHref) {
  const documentListeners = new Map();
  const windowListeners = new Map();
  const sent = [];
  const location = { href: initialHref, origin: new URL(initialHref).origin };
  const document = {
    title: "Video A",
    hidden: false,
    documentElement: {},
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener(name, listener) {
      const listeners = documentListeners.get(name) || [];
      listeners.push(listener);
      documentListeners.set(name, listeners);
    }
  };
  const sandbox = {
    URL,
    location,
    document,
    chrome: {
      runtime: {
        lastError: null,
        onMessage: { addListener() {} },
        sendMessage(message, callback) {
          sent.push(message);
          callback?.();
        }
      }
    },
    MutationObserver: class {
      observe() {}
    },
    setTimeout: () => 1,
    clearTimeout() {},
    setInterval: () => 1,
    addEventListener(name, listener) {
      const listeners = windowListeners.get(name) || [];
      listeners.push(listener);
      windowListeners.set(name, listeners);
    },
    postMessage() {}
  };
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  const source = fs.readFileSync(path.join(__dirname, "../extension/content.js"), "utf8");
  vm.runInContext(source, context, { filename: "content.js" });
  return {
    context,
    sent,
    documentListeners,
    windowListeners,
    dispatchDocument(name) {
      for (const listener of documentListeners.get(name) || []) listener({ type: name });
    },
    dispatchWindow(name) {
      for (const listener of windowListeners.get(name) || []) listener({ type: name });
    },
    dispatchWindowMessage(data) {
      for (const listener of windowListeners.get("message") || []) {
        context.__messageListener = listener;
        context.__messageData = data;
        vm.runInContext("__messageListener({ source: window, data: __messageData })", context);
      }
    }
  };
}

test("YouTube finish is delivered after a post-commit duplicate start for the same video", () => {
  const harness = loadContent("https://www.youtube.com/watch?v=videoA");
  harness.sent.length = 0;
  harness.context.location.href = "https://www.youtube.com/watch?v=videoB";
  harness.dispatchWindow("popstate");
  harness.dispatchDocument("yt-navigate-start");
  harness.dispatchDocument("yt-navigate-finish");

  const navigations = harness.sent.filter((message) => message.type === "videoNavigation");
  assert.deepEqual(navigations.map((message) => message.navigation.phase), ["commit", "start", "finish"]);
  assert.equal(navigations.at(-1).navigation.pageIdentity, "youtube:videoB");
});

test("generic HLS navigation preserves the MAIN-world boundary timestamp", () => {
  const harness = loadContent("https://missav.ws/ch/a");
  harness.sent.length = 0;
  harness.dispatchWindowMessage({
    source: "darren-video-helper-navigation", type: "navigation", phase: "start",
    href: "https://missav.ws/ch/a", previousHref: "https://missav.ws/ch/a", reason: "history.pushState", at: 123456
  });
  harness.context.location.href = "https://missav.ws/ch/b";
  harness.dispatchWindowMessage({
    source: "darren-video-helper-navigation", type: "navigation", phase: "commit",
    href: "https://missav.ws/ch/b", previousHref: "https://missav.ws/ch/a", reason: "history.pushState", at: 123457
  });
  const messages = harness.sent.filter(message => message.type === "videoNavigation");
  assert.equal(messages[0].navigation.observedAt, 123456);
  assert.equal(messages[1].navigation.pageIdentity, "https://missav.ws/ch/b");
  assert.equal(messages[1].navigation.observedAt, 123457);
});
