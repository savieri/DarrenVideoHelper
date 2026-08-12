# Changelog

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
