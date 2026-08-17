const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright");


async function main() {
  const root = path.resolve(__dirname, "..");
  const ffmpeg = process.env.DARREN_TEST_FFMPEG;
  if (!ffmpeg) throw new Error("DARREN_TEST_FFMPEG is required");

  const videoPath = path.join(root, "dist", "page-preview-smoke.mp4");
  fs.mkdirSync(path.dirname(videoPath), { recursive: true });
  const generated = childProcess.spawnSync(ffmpeg, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=duration=5:size=320x180:rate=24",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-an", videoPath,
  ], { encoding: "utf8" });
  if (generated.status !== 0) throw new Error(generated.stderr || "Could not generate preview video");

  const server = http.createServer((request, response) => {
    if (request.url === "/watch") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end('<video muted loop playsinline src="/video.mp4" style="width:640px;height:360px"></video>');
      return;
    }
    if (request.url === "/video.mp4") {
      const size = fs.statSync(videoPath).size;
      const range = request.headers.range?.match(/bytes=(\d+)-(\d*)/);
      const start = range ? Number(range[1]) : 0;
      const end = range && range[2] ? Number(range[2]) : size - 1;
      const headers = {
        "Accept-Ranges": "bytes",
        "Content-Length": end - start + 1,
        "Content-Type": "video/mp4",
      };
      if (range) headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
      response.writeHead(range ? 206 : 200, headers);
      fs.createReadStream(videoPath, { start, end }).pipe(response);
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const systemChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const browser = await chromium.launch({
    headless: true,
    executablePath: fs.existsSync(systemChrome) ? systemChrome : undefined,
  });
  const page = await browser.newPage();
  try {
    const port = server.address().port;
    await page.goto(`http://127.0.0.1:${port}/watch`);
    await page.evaluate(async () => {
      window.__nativeMessages = [];
      window.__nativeListeners = [];
      window.chrome = {
        runtime: {
          lastError: null,
          onMessage: {
            addListener(listener) { window.__nativeListeners.push(listener); },
          },
          sendMessage(message, callback) {
            window.__nativeMessages.push(message);
            if (callback) callback({ ok: true });
          },
        },
      };
      await document.querySelector("video").play();
    });
    await page.addScriptTag({ path: path.join(root, "extension", "content.js") });
    await page.waitForTimeout(300);

    const before = await page.locator("video").evaluate((video) => ({
      paused: video.paused,
      currentSrc: video.currentSrc,
      currentTime: video.currentTime,
    }));
    const started = await page.evaluate(() => new Promise((resolve) => {
      window.__nativeListeners[0](
        { type: "startPagePreview", token: "preview:one", maxDurationMs: 2500 },
        {},
        resolve,
      );
    }));
    assert.equal(started.ok, true);
    await page.waitForTimeout(1100);

    const result = await page.evaluate(() => {
      const video = document.querySelector("video");
      const frames = window.__nativeMessages.filter((message) => message.type === "pagePreviewFrame");
      return {
        frames: frames.length,
        tokens: Array.from(new Set(frames.map((message) => message.token))),
        jpeg: frames.every((message) => /^data:image\/jpeg;base64,/.test(message.frame)),
        paused: video.paused,
        currentSrc: video.currentSrc,
        currentTime: video.currentTime,
      };
    });
    assert.ok(result.frames >= 2, `Expected continuous frames, got ${result.frames}`);
    assert.deepEqual(result.tokens, ["preview:one"]);
    assert.equal(result.jpeg, true);
    assert.equal(before.paused, false);
    assert.equal(result.paused, false);
    assert.equal(result.currentSrc, before.currentSrc);
    assert.ok(result.currentTime > before.currentTime);

    await page.evaluate(() => new Promise((resolve) => {
      window.__nativeListeners[0]({ type: "stopPagePreview", token: "preview:one" }, {}, resolve);
    }));
    const frameCountAtStop = result.frames;
    await page.waitForTimeout(700);
    const afterStop = await page.evaluate(() => ({
      frames: window.__nativeMessages.filter((message) => message.type === "pagePreviewFrame").length,
      paused: document.querySelector("video").paused,
    }));
    assert.equal(afterStop.frames, frameCountAtStop);
    assert.equal(afterStop.paused, false);

    console.log(JSON.stringify({ ok: true, ...result, afterStop }));
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}


main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
