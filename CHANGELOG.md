# Changelog

## 1.2.0-beta.3 - 2026-08-17

Prerelease only. Built and tagged from `codex/v1.2.0-beta.3`; `main` is unchanged.

### Fixed

- Replaces the macOS PyInstaller Python host with `host-source` → `/usr/bin/python3 host.py` → Homebrew yt-dlp plus bundled ffmpeg/ffprobe.
- Makes native-host self-test mandatory during installation and validates the exact resolved tool chain.
- Disables a leftover bundled macOS yt-dlp by recoverable timestamped rename so it cannot shadow Homebrew yt-dlp.
- Checks this job's MP4 with ffprobe after yt-dlp exits even when the exit code is nonzero; a valid video stream, duration, and file size now produce `complete`.
- Recovers only the exact final job filename; yt-dlp `*.f137.mp4`-style DASH single-track intermediates cannot be reported as complete.
- Preserves ffprobe-valid MP4 files when page duration metadata differs and prevents a later native error from overwriting a completed popup job.
- Locks the popup document and long job/error content to 390px without horizontal expansion.
- Presents YouTube as `YouTube · DASH → MP4`, HLS as `HLS → MP4`, and keeps PAGE/SEG/single-track DASH evidence out of the main card.
- Keeps YouTube SPA navigation pending until the matching finish is delivered, then reconciles delayed player metadata by videoId without allowing an older generation to refill the session.
- Adds a Bilibili playinfo/fetch/XHR bridge that pairs the current DASH video and audio as one `Bilibili · DASH → MP4` candidate at the highest quality actually returned for the current login state.
- Refreshes signed Bilibili resources at download time and lets the Native Host merge the selected video/audio URLs with current Referer/User-Agent/Cookie headers, backup CDN retry, page-extractor fallback, and mandatory audio validation.

### Added

- Adds one-at-a-time muted hover preview with `playsInline`, `preload=none`, a short start delay, an eight-second cap, immediate teardown on leave, and poster fallback on unsupported/CORS-limited sources.
- Adds a macOS package builder that rejects PyInstaller host and bundled macOS yt-dlp regressions, then self-tests the staged source host.
- Adds framed Native Messaging smoke coverage for direct MP4, HLS, invalid URL, and an optional live YouTube page URL, plus a headless Chrome width/preview smoke test.
- Adds live YouTube three-transition SPA coverage and Bilibili bridge, stale-playinfo, quality-tier, paired-download, header, and audio regressions.

### Validation

- JavaScript background/content/bridge tests: 29 passed.
- Native-host and macOS release-policy tests: 20 passed.
- Isolated package installation and mandatory source-host self-test passed.
- Framed direct MP4, HLS, invalid URL, and live YouTube `jNQXAC9IVRw` cases returned the expected terminal states.
- Headless Chrome held 390px with long expanded diagnostics; local HTTP MP4 hover playback and leave teardown passed.
- Real YouTube content-script smoke completed three recommendation transitions from `jNQXAC9IVRw` without a document reload; all four settled URLs and metadata videoIds matched.
- Public Bilibili `BV1GJ411x7h7` paired separate format `30016` video and `30280` audio URLs; the Native Host completed a 14,767,134-byte, 212.309s, 640×360 MP4 with one video and one audio stream.

### Known limitations

- The user's live Chrome extension was intentionally not replaced. Real installed-popup acceptance for YouTube, third-party HLS/CORS behavior, and ad/main multi-candidate pages remains in `VALIDATION.md`.
- Hover preview depends on the browser being able to reuse the observed media URL without custom request headers. Failure safely remains a poster and does not affect downloadability.

## 1.2.0-beta.2 - 2026-08-12

Prerelease only. Beta.1 remains available as the historical build that exposed the real Native Messaging failure.

### Fixed

- Keeps the Native Messaging host reading framed messages until Chrome closes stdin instead of unconditionally ending after the first message.
- Returns a framed `pong` for transport diagnostics and records host start, received job, redacted command, yt-dlp PID/exit code, traceback, completion, and exit reason in a rotating log.
- Converts `Native host has exited` into a readable popup error with the native log path.
- Adds a 20-second first-response timeout so disconnected jobs cannot remain permanently at `Starting native download...`.
- Reuses the existing job when a matching fingerprint or session/resource binding is already queued, downloading, or merging, including when a second click requested a forced re-download.

### Validation

- Background/session/media/queue tests: 21 passed.
- Native-host tests: 8 passed, including multi-frame lifecycle coverage.
- Registered packaged host: arm64, executable, ad-hoc signed, no quarantine, self-test passed.
- Registered manifest path and extension allowed origin validated against ID `mabnjnddplpelefjgohbjcoajnimpgna`.
- Two `ping` messages on one real packaged-host stdio port returned two framed responses before clean EOF exit.
- Framed packaged-host E2E downloaded YouTube `YXUhLbV8Nrg` to a 121,966,560-byte MP4 with H.264 video, AAC stereo audio, 4373.316-second duration, and a successful five-second mid-file decode.

### Known limitations

- Chrome control can list the real YouTube and extensions tabs, but controlling the YouTube tab and inspecting the extension popup still times out. The framed host E2E uses the exact registered manifest and packaged binary; the final popup click-through remains a user acceptance step.
- The full A/B/back/forward, normal HLS, preroll, deletion/retry, and switch-during-download matrix is not yet complete. Do not promote this prerelease to stable.

## 1.2.0-beta.1 - 2026-08-12

Prerelease only. This build is not marked stable because real Chrome A/B download and file-content verification is incomplete.

### Fixed

- Invalidates the current YouTube logical video at SPA navigation start, before the next video finishes loading.
- Creates a fresh session when the YouTube videoId changes across A → B, back to A, or forward to B.
- Prevents stale title, thumbnail, duration, streams, and popup selections from crossing into the new video session.
- Rejects download clicks from invalidated or replaced sessions.
- Keeps `blob:` currentSrc and poster changes from rotating a YouTube session.
- Captures extensionless `googlevideo.com/videoplayback` DASH audio/video requests as internal evidence.

### Changed

- Aggregates YouTube resolver, DASH tracks, HLS masters/variants, and direct media into one `LogicalVideo` card.
- Hides standalone DASH audio/video tracks from the normal download list; advanced mode shows them only as source details.
- Replaces the internal `YT` label with user-facing MP4 output and quality selection.
- Adds a thumbnail preview area with duration/format overlay; the overlay fades out on hover.
- Passes each card's selected quality to the native host while preserving the saved default as fallback.

### Validation

- Automated background/session/media tests: 18 passed.
- Automated native-host tests: 7 passed.
- JavaScript syntax checks: passed.
- Real Chrome, installed Browser extension, and native-host registrations were detected successfully.
- Real popup inspection was blocked by browser security policy and YouTube tab control timed out; the manual matrix in `VALIDATION.md` remains required.

### Known limitations

- Preview is a stable poster/player thumbnail, not live video playback.
- YouTube A/B final files, normal HLS A/B, preroll filtering, retry after deletion, and switching during an active download are not yet signed off in real Chrome.
- `v1.1.0` was a development regression state and is not treated as a stable Release.

## 1.1.1 - development baseline

- Restored the YouTube page resolver after the `v1.1.0` candidate-filtering regression.
- Added YouTube DASH request evidence and native output validation.
- Not published as a stable Release.

## 1.0.0 - 2026-07-22

- Initial public macOS release.
