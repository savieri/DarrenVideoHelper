const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function runBridge({ href, initial, playinfo }) {
  const posted = [];
  const documentListeners = new Map();
  const windowListeners = new Map();
  const location = { href, origin: new URL(href).origin };
  const sandbox = {
    URL,
    location,
    document: {
      title: initial?.videoData?.title || "Bilibili video",
      addEventListener(name, listener) {
        documentListeners.set(name, listener);
      }
    },
    history: {
      pushState() {},
      replaceState() {}
    },
    __INITIAL_STATE__: initial,
    __playinfo__: playinfo,
    setTimeout: () => 1,
    clearTimeout() {},
    setInterval: () => 1,
    addEventListener(name, listener) {
      windowListeners.set(name, listener);
    },
    postMessage(message) {
      posted.push(message);
    }
  };
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  const source = fs.readFileSync(path.join(__dirname, "../extension/page-navigation.js"), "utf8");
  vm.runInContext(source, context, { filename: "page-navigation.js" });
  return posted;
}

test("Bilibili MAIN-world bridge publishes real paired DASH resources and quality tier", () => {
  const posted = runBridge({
    href: "https://www.bilibili.com/video/BV1GJ411x7h7/",
    initial: {
      bvid: "BV1GJ411x7h7",
      videoData: {
        bvid: "BV1GJ411x7h7",
        aid: 80433022,
        cid: 137649199,
        title: "Public video",
        pic: "https://i1.hdslb.com/test.jpg"
      }
    },
    playinfo: {
      data: {
        cid: 137649199,
        dash: {
          duration: 213,
          video: [{
            id: 32,
            height: 384,
            width: 512,
            codecid: 7,
            bandwidth: 155817,
            baseUrl: "https://v.example/video.m4s",
            backupUrl: ["https://v-backup.example/video.m4s"]
          }],
          audio: [{
            id: 30232,
            bandwidth: 134695,
            baseUrl: "https://a.example/audio.m4s",
            backupUrl: ["https://a-backup.example/audio.m4s"]
          }]
        }
      }
    }
  });
  const message = posted.find((item) => item.type === "bilibili-media");
  assert.ok(message);
  assert.equal(message.media.pageIdentity, "bilibili:bv1gj411x7h7:p1");
  assert.equal(message.media.cid, 137649199);
  assert.equal(message.media.quality, 480);
  assert.deepEqual(Array.from(message.media.qualities), [480]);
  assert.equal(message.media.videos[0].height, 384);
  assert.equal(message.media.videos[0].quality, 480);
  assert.equal(message.media.videos[0].baseUrl, "https://v.example/video.m4s");
  assert.equal(message.media.audios[0].baseUrl, "https://a.example/audio.m4s");
});

test("stale Bilibili globals are not labeled as the current BV", () => {
  const posted = runBridge({
    href: "https://www.bilibili.com/video/BVnew123/",
    initial: { bvid: "BVold123", videoData: { bvid: "BVold123", aid: 1, cid: 2 } },
    playinfo: {
      data: {
        cid: 2,
        dash: {
          video: [{ id: 32, height: 480, baseUrl: "https://v.example/old.m4s" }],
          audio: [{ id: 30232, baseUrl: "https://a.example/old.m4s" }]
        }
      }
    }
  });
  assert.equal(posted.some((item) => item.type === "bilibili-media"), false);
});
