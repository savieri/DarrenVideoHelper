# Release validation

## Automated checks recorded on 2026-08-12

| Area | Result | Scope |
| --- | --- | --- |
| Background/session/media tests | PASS (18/18) | Session rotation, navigation invalidation, same-video stability, stale metadata/selection rejection, YouTube DASH grouping, LogicalVideo aggregation, HLS ranking, immutable payloads, history fingerprinting |
| Native-host tests | PASS (7/7) | Retry bounds, headers, per-card quality override, output size/duration validation, HLS fallback restriction |
| JavaScript syntax | PASS | background, content, page navigation, popup |
| Chrome/Browser installation diagnostics | PASS | Chrome running; Browser extension installed and enabled; its native-host manifest valid |

These checks are regression coverage, not end-to-end acceptance.

## Real Chrome status

The automation session could list the user's real Chrome tabs and detected the open YouTube page. Browser security policy blocked opening or inspecting the extension popup directly. Attempts to control the YouTube tab timed out even though installation diagnostics passed. No stable-release claim is made from this run.

## Required manual release gate

- [ ] YouTube A appears in the popup with one logical MP4 card.
- [ ] Click YouTube B without refreshing: A is disabled immediately, then the popup changes to B.
- [ ] Browser Back: popup changes to A automatically.
- [ ] Browser Forward: popup changes to B automatically.
- [ ] Download A and B; `ffprobe` confirms both a video stream and an audio stream, and manual playback confirms each file matches its own page.
- [ ] Normal HLS site A → B keeps the two sessions/files separate.
- [ ] A preroll/ad page recommends the main program rather than the ad.
- [ ] Delete a completed file and force re-download; the replacement completes and validates.
- [ ] Switch pages while a download is active; the queued job keeps its immutable original resource while the popup follows the new page.

Promote to stable `v1.2.0` only after every item above is checked and recorded with tested URLs, output filenames, durations, and audio/video probe results.
