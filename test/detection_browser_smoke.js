const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { spawnSync } = require("node:child_process");
const { chromium } = require("playwright");

// Real MV3 extension + a playable local MSE/HLS fixture. No existing Chrome profile is used.
async function main() {
  const root = path.resolve(__dirname, "..");
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  const scratch = fs.mkdtempSync(path.join(root, "dist/detection-smoke-"));
  const ffmpeg = process.env.DARREN_TEST_FFMPEG;
  assert.ok(ffmpeg, "DARREN_TEST_FFMPEG is required");
  const generated = spawnSync(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=duration=6:size=320x180:rate=24",
    "-an", "-c:v", "libx264", "-profile:v", "baseline", "-level", "3.0", "-pix_fmt", "yuv420p",
    "-g", "24", "-sc_threshold", "0", "-hls_time", "1", "-hls_playlist_type", "vod",
    "-hls_segment_type", "fmp4", "-hls_fmp4_init_filename", "init.mp4",
    "-hls_segment_filename", path.join(scratch, "part%d.m4s"), path.join(scratch, "media.m3u8")
  ], { encoding: "utf8" });
  assert.equal(generated.status, 0, generated.stderr);
  const mediaPlaylist = fs.readFileSync(path.join(scratch, "media.m3u8"), "utf8");
  const fixture = `<!doctype html><title>Current HLS</title><video muted loop playsinline width="640" height="360"></video>
    <script>
    window.loadVideo = async (id) => {
      const masterUrl = '/' + id + '/' + (id === 'a' ? 'master.m3u8' : 'playlist');
      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest(); xhr.open("GET", masterUrl);
        xhr.onload = resolve; xhr.onerror = reject; xhr.send();
      });
      await fetch('/' + id + '/media').then(r => r.text());
      const source = new MediaSource();
      const video = document.querySelector('video');
      video.src = URL.createObjectURL(source);
      await new Promise(resolve => source.addEventListener('sourceopen', resolve, { once: true }));
      const buffer = source.addSourceBuffer('video/mp4; codecs="avc1.42C01E"');
      for (const name of ['init.mp4', ${JSON.stringify(mediaPlaylist.split(/\r?\n/).filter(line => line.endsWith('.m4s'))).slice(1, -1)}]) {
        const bytes = await fetch('/' + id + '/' + name).then(r => r.arrayBuffer());
        const appended = new Promise(resolve => buffer.addEventListener('updateend', resolve, { once: true }));
        buffer.appendBuffer(bytes);
        await appended;
      }
      source.endOfStream();
      await video.play();
      document.title = 'HLS ' + id;
      window.loadedVideo = id;
    };
    loadVideo('a').catch(error => window.fixtureError = error.message);
    </script>`;
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    response.setHeader("Cache-Control", "no-store");
    if (url.pathname.startsWith("/watch/")) {
      response.writeHead(200, { "Content-Type": "text/html" }).end(fixture);
    } else if (/\/(master\.m3u8|playlist)$/.test(url.pathname)) {
      response.writeHead(200, { "Content-Type": url.pathname.endsWith("/playlist") ? "text/plain" : "application/vnd.apple.mpegurl" })
        .end("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=320x180\nmedia\n");
    } else if (url.pathname.endsWith("/media")) {
      response.writeHead(200, { "Content-Type": "application/x-mpegURL; charset=utf-8" }).end(mediaPlaylist);
    } else {
      const name = path.basename(url.pathname);
      const file = path.join(scratch, name);
      if (!/^(init\.mp4|part\d+\.m4s)$/.test(name) || !fs.existsSync(file)) {
        response.writeHead(404).end();
      } else {
        response.writeHead(200, { "Content-Type": "video/mp4" });
        fs.createReadStream(file).pipe(response);
      }
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  let browser;
  try {
    const extension = path.join(root, "extension");
    browser = await chromium.launchPersistentContext(path.join(scratch, "profile"), {
      channel: "chromium", headless: true,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
    });
    let worker = browser.serviceWorkers()[0] || await browser.waitForEvent("serviceworker");
    const extensionId = new URL(worker.url()).host;
    const origin = `http://127.0.0.1:${server.address().port}`;
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${origin}/watch/a`);
    await page.waitForFunction(() => window.loadedVideo === "a" || window.fixtureError, null, { timeout: 15000 });
    assert.equal(await page.evaluate(() => window.fixtureError || ""), "");
    assert.match(await page.locator("video").evaluate(video => video.currentSrc), /^blob:/);
    const tabId = await worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url).id, page.url());
    let popup;
    const openPopup = async () => {
      popup = await browser.newPage();
      await popup.goto(`chrome-extension://${extensionId}/popup.html`);
      return popup.evaluate(async id => { currentTabId = id; await loadStreams(); return currentState; }, tabId);
    };
    const preloaded = await openPopup();
    assert.equal(preloaded.recommended.resourceUrl, `${origin}/a/master.m3u8`);
    assert.equal(preloaded.streams.length, 1);
    await worker.evaluate(id => tabState.get(id).streams.clear(), tabId);
    await popup.locator("#refreshButton").click();
    await popup.waitForFunction(() => currentState?.recommended?.resourceUrl.endsWith("/a/master.m3u8"));
    const recovered = await popup.evaluate(() => currentState);
    assert.equal(recovered.recommended.resourceUrl, preloaded.recommended.resourceUrl);
    const persisted = await worker.evaluate(async id => {
      await persistDetectionState(id);
      return (await chrome.storage.session.get(`activeDetection:${id}`))[`activeDetection:${id}`];
    }, tabId);
    assert.equal(persisted.streams.some(stream => stream.kind === "segment"), false);
    assert.ok(persisted.streams.every(stream => stream.headers.referer), JSON.stringify(persisted.streams));
    await popup.close();
    const control = await browser.newPage();
    await control.goto(`chrome-extension://${extensionId}/icons/icon16.png`);
    const cdp = await browser.newCDPSession(control);
    let versions = [];
    const discovered = new Promise(resolve => cdp.on("ServiceWorker.workerVersionUpdated", event => {
      versions = event.versions;
      if (versions.some(version => version.scriptURL === worker.url())) resolve();
    }));
    await cdp.send("ServiceWorker.enable");
    await Promise.race([discovered, new Promise((_, reject) => setTimeout(() => reject(new Error("No extension service worker version")), 5000))]);
    const target = versions.find(version => version.scriptURL === worker.url());
    await worker.evaluate(() => { self.detectionRestartProbe = "original-worker"; });
    const stopped = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Service worker did not stop: ${JSON.stringify(versions)}`)), 10000);
      cdp.on("ServiceWorker.workerVersionUpdated", event => {
        const version = event.versions.find(item => item.versionId === target.versionId);
        if (version?.runningStatus === "stopped") { clearTimeout(timer); resolve(); }
      });
    });
    await cdp.send("ServiceWorker.stopWorker", { versionId: target.versionId });
    await stopped;
    const restartedPopup = await openPopup();
    worker = browser.serviceWorkers().find(item => item.url() === worker.url()) || worker;
    assert.equal(await worker.evaluate(() => self.detectionRestartProbe), undefined);
    assert.equal(restartedPopup.sessionId, persisted.sessionId);
    assert.equal(restartedPopup.recommended.resourceUrl, `${origin}/a/master.m3u8`);
    await page.evaluate(async () => {
      history.pushState({}, "", "/watch/b");
      await window.loadVideo("b");
    });
    await popup.waitForFunction(() => currentState?.recommended?.resourceUrl.endsWith("/b/playlist"), null, { timeout: 10000 });
    const switched = await popup.evaluate(() => currentState);
    assert.notEqual(switched.sessionId, restartedPopup.sessionId);
    assert.equal(switched.recommended.resourceUrl, `${origin}/b/playlist`);
    assert.equal(switched.recommended.pipelineLabel, "HLS → MP4");
    assert.equal(await worker.evaluate(async id => {
      const state = tabState.get(id);
      const stream = Array.from(state.streams.values()).find(item => item.url.endsWith("/b/playlist"));
      return (await enrichStreamForPopup(snapshotVideoSession(state), stream)).kind;
    }, tabId), "hls_master");
    assert.equal(switched.streams.length, 1);
    assert.equal(await worker.evaluate(id => Array.from(tabState.get(id).streams.values()).some(stream => stream.url.includes("/a/")), tabId), false);
    assert.equal(await page.locator("video").evaluate(video => video.paused), false);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ ok: true, browser: browser.browser().version(),
      playableHls: true, blobOnly: true, popupOpen: true, refreshRecovery: true,
      workerStoppedAndRestarted: true, sessionRestored: true, extensionlessHlsTextBody: true, xhrObserved: true,
      spaAutomaticPopupRefresh: true, oldVideoExcluded: true, segmentPersistence: false
    }, null, 2));
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
