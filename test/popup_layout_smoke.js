const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright");


async function main() {
  const root = path.resolve(__dirname, "..");
  const popupHtml = fs.readFileSync(path.join(root, "extension/popup.html"), "utf8")
    .replace(/<link[^>]+style\.css[^>]*>/i, "")
    .replace(/<script[^>]+popup\.js[^>]*><\/script>/i, "");
  const veryLongText = `${"https://cdn.example.test/really-long-signed-path/".repeat(10)}?token=${"x".repeat(600)}`;
  const failedJob = {
    id: "layout-job",
    status: "failed",
    title: veryLongText,
    message: "下载失败，但任何详情都不能撑宽 popup。",
    error: "Expected failure",
    details: veryLongText,
    logs: [veryLongText],
    percent: "100",
    createdAt: Date.now(),
  };
  const state = {
    ok: true,
    tabId: 1,
    pageTitle: "Popup beta.3 layout smoke",
    pageUrl: "https://site.test/watch",
    detectedStreamCount: 1,
    warning: "",
    queuePaused: false,
    jobs: [failedJob],
    streams: [{
      id: "logical:test",
      resourceId: "resource:test",
      resourceUrl: "https://cdn.test/master.m3u8",
      sessionId: "session:test",
      fingerprint: "fp:test",
      recommended: true,
      canDownloadWholeVideo: true,
      sourceTitle: "Main video",
      providerLabel: "YouTube",
      pipelineLabel: "DASH → MP4",
      formatLabel: "DASH → MP4",
      sizeLabel: "~2.4 GB",
      durationLabel: "1:02:03",
      thumbnailUrl: "",
      qualityOptions: [{ value: "best", label: "最佳可用" }, { value: "1080p", label: "1080p" }],
      defaultQuality: "best",
      advancedSources: [{ typeTag: "YT", qualityLabel: "1080p", label: veryLongText }],
      evidenceCount: 1,
    }],
  };

  let previewServer = null;
  let previewPlayback = { skipped: true };
  const ffmpeg = process.env.DARREN_TEST_FFMPEG;
  if (ffmpeg) {
    const previewPath = path.join(root, "dist", "popup-preview-smoke.mp4");
    fs.mkdirSync(path.dirname(previewPath), { recursive: true });
    const generated = childProcess.spawnSync(ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "testsrc2=duration=3:size=320x180:rate=24",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
      "-an", previewPath,
    ], { encoding: "utf8" });
    if (generated.status !== 0) throw new Error(generated.stderr || "Could not generate preview video");
    previewServer = http.createServer((request, response) => {
      const size = fs.statSync(previewPath).size;
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
      fs.createReadStream(previewPath, { start, end }).pipe(response);
    });
    await new Promise((resolve) => previewServer.listen(0, "127.0.0.1", resolve));
    const address = previewServer.address();
    state.streams[0].previewUrl = `http://127.0.0.1:${address.port}/preview.mp4`;
  }

  const systemChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const browser = await chromium.launch({
    headless: true,
    executablePath: fs.existsSync(systemChrome) ? systemChrome : undefined,
  });
  const page = await browser.newPage({ viewport: { width: 390, height: 600 } });
  await page.setContent(popupHtml, { waitUntil: "domcontentloaded" });
  await page.evaluate(({ popupState, job }) => {
    const listeners = [];
    window.chrome = {
      tabs: {
        async query() { return [{ id: 1 }]; },
      },
      runtime: {
        lastError: null,
        onMessage: { addListener(listener) { listeners.push(listener); } },
        openOptionsPage() {},
        sendMessage(message, callback) {
          const response = message.type === "getStreams"
            ? popupState
            : message.type === "getJobs"
              ? { ok: true, jobs: [job], queuePaused: false }
              : { ok: true };
          queueMicrotask(() => callback(response));
        },
      },
    };
  }, { popupState: state, job: failedJob });
  await page.addStyleTag({ path: path.join(root, "extension/style.css") });
  await page.addScriptTag({ path: path.join(root, "extension/popup.js") });
  await page.evaluate(() => document.dispatchEvent(new Event("DOMContentLoaded")));
  await page.waitForSelector(".stream-card");
  await page.waitForSelector(".job.failed");
  await page.locator(".source-details summary").click();
  await page.locator(".job.failed details summary").click();

  if (ffmpeg) {
    await page.locator(".media-preview").hover();
    await page.waitForSelector(".media-preview.preview-playing", { timeout: 5000 });
    const playing = await page.locator(".preview-video").evaluate((video) => ({
      muted: video.muted,
      playsInline: video.playsInline,
      preload: video.preload,
      paused: video.paused,
      hasSource: Boolean(video.getAttribute("src")),
    }));
    assert.deepEqual(playing, {
      muted: true,
      playsInline: true,
      preload: "none",
      paused: false,
      hasSource: true,
    });
    await page.locator(".topbar").hover();
    await page.waitForTimeout(100);
    const stopped = await page.locator(".preview-video").evaluate((video) => ({
      paused: video.paused,
      hasSource: Boolean(video.getAttribute("src")),
      mode: video.parentElement.dataset.previewMode,
    }));
    assert.deepEqual(stopped, { paused: true, hasSource: false, mode: "poster" });
    previewPlayback = { skipped: false, playing, stopped };
  }

  const measurements = await page.evaluate(() => {
    const html = document.documentElement;
    const body = document.body;
    const offenders = Array.from(document.querySelectorAll("body *"))
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          name: element.className || element.tagName,
          left: rect.left,
          right: rect.right,
          width: rect.width,
        };
      })
      .filter((item) => item.left < -0.5 || item.right > 390.5);
    const pre = document.querySelector(".job.failed pre");
    return {
      htmlClientWidth: html.clientWidth,
      htmlScrollWidth: html.scrollWidth,
      bodyWidth: body.getBoundingClientRect().width,
      bodyScrollWidth: body.scrollWidth,
      preClientWidth: pre.clientWidth,
      preScrollWidth: pre.scrollWidth,
      overflowX: getComputedStyle(html).overflowX,
      offenders,
    };
  });

  assert.equal(measurements.htmlClientWidth, 390);
  assert.equal(measurements.htmlScrollWidth, 390);
  assert.equal(measurements.bodyWidth, 390);
  assert.equal(measurements.bodyScrollWidth, 390);
  assert.ok(measurements.preScrollWidth <= measurements.preClientWidth);
  assert.equal(measurements.overflowX, "hidden");
  assert.deepEqual(measurements.offenders, []);

  const screenshotPath = path.join(root, "dist", "popup-beta3-layout.png");
  fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await browser.close();
  if (previewServer) await new Promise((resolve) => previewServer.close(resolve));
  console.log(JSON.stringify({ ok: true, screenshotPath, previewPlayback, ...measurements }));
}


main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
