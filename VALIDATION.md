# Release validation

## Automated checks recorded on 2026-08-12

| Area | Result | Scope |
| --- | --- | --- |
| Background/session/media/queue tests | PASS (21/21) | Session rotation, navigation invalidation, same-video stability, stale metadata/selection rejection, YouTube DASH grouping, LogicalVideo aggregation, HLS ranking, immutable payloads, active-job reuse, disconnect cleanup |
| Native-host tests | PASS (8/8) | Multi-message port lifecycle, retry bounds, headers, per-card quality override, output size/duration validation, HLS fallback restriction |
| JavaScript syntax | PASS | background, content, page navigation, popup |
| Packaged native host registration | PASS | Manifest path points to beta.2; extension ID/allowed origin match; arm64 executable; no quarantine; self-test and two-frame ping pass |
| YouTube framed host E2E | PASS | `YXUhLbV8Nrg`; continuous progress then complete; H.264 + AAC stereo; 4373.316s; 121,966,560 bytes; mid-file decode passed |

These checks are regression coverage, not end-to-end acceptance.

## Real Chrome status

The installed extension path and native manifest were located automatically. The loaded extension directory was updated to beta.2, and the native manifest now targets the packaged beta.2 host. Chrome control could list the real YouTube and extensions tabs, but controlling the YouTube tab and inspecting the extension popup timed out. The E2E therefore used the exact registered manifest and packaged binary with Chrome-compatible stdio framing and the real URL from the open YouTube tab. No stable-release claim is made from this run.

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
