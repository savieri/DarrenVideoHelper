# v1.2.1-beta.16 — validation record

Date: 2026-11-20. Public prerelease based on the supplied beta.15 ZIP.
Environment: Apple Silicon macOS, Node.js, Python 3.14, locally installed yt-dlp,
FFmpeg/ffprobe 9.0.2. Dependency versions vary by the user's selected installation.

## Completed

- 42 JavaScript regression tests: session rotation, stale selections, YouTube/Bilibili
  SPA context, HLS variants and ranking, immutable selection snapshots, completion
  guards, Chrome filenames/exact URL/progress/interruption, restart reconciliation,
  cancellation during dispatch and diagnostic redaction. API-level tests use mocks.
- 19 Python tests: Native Host framing, request context/quality, paired DASH,
  audio requirements, output validation, terminal guards, partial preservation,
  stable public-key ID, matching versions, packaging/runtime policy and documentation.
- All extension JS syntax checked with node --check. Installer shell syntax and
  Python compilation checked.
- Both Manifest V3 packages: referenced assets exist, key-derived ID is
  mabnjnddplpelefjgohbjcoajnimpgna, version 1.2.1.16 / 1.2.1-beta.16.
- Chrome ZIP: manifest.json at root; nativeMessaging removed; all JS/assets match
  source. Full ZIP: extension/ and host source match source; command files retain
  executable bits. Archive CRC, traversal, metadata, private-key and binary exclusions checked.
- Real native integration with locally generated test media: two framed pings on
  one host, HLS download from a local HTTP server, FFmpeg muxing and ffprobe validation.
  Result: complete, duration 4.040272 seconds, audio present, 351361 bytes; detected
  source-title prefix preserved. Test data was generated with lavfi; no user media used.
  The fixture bypasses proxy settings only for its local loopback test server.
- Installer executed against isolated registration/install directories, including
  a Unicode/spaced path. Dependency checks, host self-tests, exact allowed_origins,
  executable launcher path and two framed pings from that launcher passed.
  The user's live Native Messaging registration was not modified.
- Real Chrome rendering of actual popup HTML/CSS/JS using clearly labeled sample
  data on a local HTTP page. Checked 390px body/card layout, resource grouping,
  sorting and refresh. Fixed inventory controls/group headings behind the backdrop.
  docs/images/popup.png records this UI fixture; it is not a live-extension proof.
- Actual ZIP extraction checked: Chrome manifest at extraction root; Full installer executable bits retained.
  The extracted Full installer passed --check with no Native Messaging registration created.
- Repeatable package builder, ZIP source-parity validator and SHA256SUMS included.

## Not completed / not claimed

- Loading the new unpacked extension through chrome://extensions: the automation
  browser's URL policy rejects the chrome: protocol. Native screen capture also
  failed. These restrictions were not bypassed.
- Consequently there was no real Chrome Downloads API transfer initiated by the
  installed beta.16 extension, no extension service-worker suspension exercise in
  live Chrome, and no fresh-machine end-to-end acceptance test.
- No real external-site HLS/YouTube/Bilibili download or content A/B comparison was
  performed this session. The local HLS fixture verifies the native path only.
- No clean Mac without Python/Homebrew/tools, Intel Mac, Windows or Linux execution.
- No browser-only HLS remux implementation, DRM handling, universal site coverage,
  signed/notarized native runtime or Chrome Web Store installation.

## Manual acceptance checklist for a new machine

1. Extract Chrome ZIP, load its root directory with Developer mode, reload a
   permitted MP4/WebM test page and play. Verify title/format, progress and completed
   file in Chrome's Downloads page; play the result.
2. Navigate A → B within a SPA, back and forward; ensure old selections are rejected
   and the downloaded video's content, audio and filename belong to B.
3. Test nested iframe detection and HLS master/variants; verify Chrome-only shows
   the Full requirement rather than saving a playlist or starting a native job.
4. Close/reopen popup during a long download, suspend worker/restart Chrome, cancel,
   retry an interrupted download and confirm no silent duplicate jobs.
5. Install Full dependencies, double-click installer, load extension/, download a
   permitted HLS and supported split-audio source, check output duration/audio/content.
6. Test missing dependencies, expired URLs, server refusals, empty metadata and
   large videos. Review exported reports for sensitive data before sharing them.
7. Compare downloaded Release ZIPs against SHA256SUMS.txt.
