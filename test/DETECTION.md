# Detection regression checks

Run the unit suites:

```sh
node --test test/background.test.js test/content_navigation.test.js test/page_navigation.test.js
python3 -m unittest discover -s test -p 'test_*.py'
```

The real-browser test requires Playwright, its full Chromium/Chrome for Testing build, and ffmpeg with libx264:

```sh
npx playwright install chromium
DARREN_TEST_FFMPEG=/path/to/ffmpeg node test/detection_browser_smoke.js
```

It creates a temporary profile and local six-second HLS/fMP4 fixture under `dist/`, loads the actual extension, plays through MediaSource with only a blob currentSrc, opens the actual popup script with the video tabId, and clicks its refresh button after clearing in-memory stream candidates. It stops the MV3 worker through Chrome's service-worker debugging API, verifies a global probe has disappeared after restart while the detection session survives, then switches to an extensionless HLS playlist through history.pushState. The already-open popup must automatically follow the new video and contain one logical HLS card. The profile/server/fixture are removed afterward.

The test uses a separate browser profile. Results do not assert production playback for arbitrary sites, DRM support, or extension reload persistence. Session storage survives worker suspension/restart within the existing extension/browser session; page timing recovery covers suffixed resources still present in the document's timing buffer.
