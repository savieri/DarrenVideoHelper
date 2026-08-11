# Changelog

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
