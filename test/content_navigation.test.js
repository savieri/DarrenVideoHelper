const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadContent(initialHref) {
  const documentListeners = new Map();
  const windowListeners = new Map();
  const sent = [];
  const posted = [];
  const runtimeListeners = [];
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
        onMessage: { addListener(listener) { runtimeListeners.push(listener); } },
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
    postMessage(message, target) { posted.push({ message, target }); }
  };
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  const source = fs.readFileSync(path.join(__dirname, "../extension/content.js"), "utf8");
  vm.runInContext(source, context, { filename: "content.js" });
  return {
    context,
    sent,
    posted,
    runtimeListeners,
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
        listener({ source: context.window, data });
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

test('content requests on opaque file pages never use file:// as postMessage target', () => {
  const harness=loadContent('file:///tmp/generated-fixture.html');
  harness.context.location.origin='file://';
  for(const listener of harness.runtimeListeners) listener({type:'refreshSiteMedia'},{},()=>{});
  assert.equal(harness.posted.length,1);assert.equal(harness.posted[0].target,'*');
});
