const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const startUrl = "https://www.youtube.com/watch?v=jNQXAC9IVRw";
const contentSource = fs.readFileSync(path.resolve(__dirname, "../extension/content.js"), "utf8");

function videoId(url) {
  try {
    return new URL(url, "https://www.youtube.com").searchParams.get("v") || "";
  } catch {
    return "";
  }
}

async function waitForCurrentContext(page, expectedVideoId, timeoutMs = 20000) {
  try {
    await page.waitForFunction((videoIdValue) => {
      const messages = window.__darrenVideoHelperLiveMessages || [];
      const currentIdentity = `youtube:${videoIdValue}`;
      const navigation = [...messages].reverse().find((item) => item.type === "videoNavigation");
      const context = [...messages].reverse().find((item) => (
        item.type === "videoContext"
        && item.context?.pageIdentity === currentIdentity
        && item.context?.metadataMatchesPage !== false
        && item.context?.pageTitle
      ));
      return navigation?.navigation?.pageIdentity === currentIdentity
        && navigation.navigation.phase !== "start"
        && Boolean(context);
    }, expectedVideoId, { timeout: timeoutMs });
  } catch (error) {
    const diagnostics = await page.evaluate(() => ({
      href: location.href,
      title: document.title,
      metadataVideoId: document.querySelector("ytd-watch-flexy[video-id]")?.getAttribute("video-id") || "",
      messages: (window.__darrenVideoHelperLiveMessages || []).slice(-12)
    }));
    throw new Error(`${error.message}; diagnostics=${JSON.stringify(diagnostics)}`);
  }

  return page.evaluate((videoIdValue) => {
    const messages = window.__darrenVideoHelperLiveMessages || [];
    const identity = `youtube:${videoIdValue}`;
    const navigation = [...messages].reverse().find((item) => (
      item.type === "videoNavigation" && item.navigation?.pageIdentity === identity
    ));
    const context = [...messages].reverse().find((item) => (
      item.type === "videoContext" && item.context?.pageIdentity === identity
    ));
    return { navigation, context };
  }, expectedVideoId);
}

async function clickNextRecommendation(page, previousVideoId) {
  const links = page.locator("a[href*='/watch?v=']:visible");
  await links.first().waitFor({ state: "visible", timeout: 20000 });
  const count = await links.count();
  for (let index = 0; index < Math.min(count, 12); index += 1) {
    const link = links.nth(index);
    const href = await link.getAttribute("href");
    const nextId = videoId(href);
    if (!nextId || nextId === previousVideoId) continue;
    await link.click();
    await page.waitForURL((url) => videoId(url.href) === nextId, { timeout: 20000 });
    return nextId;
  }
  throw new Error("No distinct YouTube recommendation was available.");
}

(async () => {
  const browser = await chromium.launch({ executablePath: chromePath, headless: false });
  try {
    const context = await browser.newContext();
    await context.addInitScript(`
      (() => {
        window.__darrenVideoHelperLiveMessages = [];
        const runtime = {
          lastError: null,
          onMessage: { addListener() {} },
          sendMessage(message, callback) {
            window.__darrenVideoHelperLiveMessages.push(message);
            if (typeof callback === "function") callback({ ok: true });
          }
        };
        try {
          if (!window.chrome) window.chrome = {};
          Object.defineProperty(window.chrome, "runtime", { configurable: true, value: runtime });
        } catch {
          window.chrome.runtime = runtime;
        }
      })();
      ${contentSource}
    `);
    const page = await context.newPage();
    await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.evaluate(() => {
      window.__darrenVideoHelperDocumentToken = `${Date.now()}:${Math.random()}`;
    });
    const documentToken = await page.evaluate(() => window.__darrenVideoHelperDocumentToken);

    const results = [];
    let currentId = videoId(page.url());
    let settled = await waitForCurrentContext(page, currentId);
    results.push({
      videoId: currentId,
      phase: settled.navigation.navigation.phase,
      title: settled.context.context.pageTitle,
      metadataVideoId: settled.context.context.metadataVideoId
    });

    for (let index = 0; index < 3; index += 1) {
      currentId = await clickNextRecommendation(page, currentId);
      settled = await waitForCurrentContext(page, currentId);
      const currentToken = await page.evaluate(() => window.__darrenVideoHelperDocumentToken);
      if (currentToken !== documentToken) throw new Error("YouTube performed a full document reload.");
      if (settled.context.context.metadataVideoId !== currentId) {
        throw new Error(`Stale YouTube metadata crossed into ${currentId}.`);
      }
      results.push({
        videoId: currentId,
        phase: settled.navigation.navigation.phase,
        title: settled.context.context.pageTitle,
        metadataVideoId: settled.context.context.metadataVideoId
      });
    }

    console.log(JSON.stringify({
      ok: true,
      fullReloads: 0,
      transitions: 3,
      uniqueVideoIds: new Set(results.map((item) => item.videoId)).size,
      results
    }, null, 2));
    await context.close();
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error.message || String(error) }, null, 2));
  process.exitCode = 1;
});
