# Release validation

## Automated checks recorded on 2026-08-17

| Area | Result | Scope |
| --- | --- | --- |
| Background/session/media/queue tests | PASS (24/24) | Existing session/navigation/ranking coverage plus YouTube/HLS pipeline labels and preview source selection, terminal completion protection, 390px CSS containment, and low-cost preview policy |
| Native-host and macOS release tests | PASS (14/14) | Existing lifecycle/retry/header coverage plus nonzero yt-dlp recovery, DASH single-track rejection, invalid-MP4 rejection, valid-MP4 preservation, source launcher policy, package exclusions, and beta.3 version agreement |
| JavaScript syntax | PASS | background, content, page navigation, popup |
| macOS package and isolated install | PASS | Staged source host reports beta.3; Homebrew yt-dlp plus packaged arm64 ffmpeg/ffprobe resolve correctly; isolated manifest points to `host-source`; no PyInstaller host or bundled yt-dlp exists |
| Framed Native Messaging E2E | PASS | Direct MP4: 2.000s, 165,799 bytes; HLS→MP4: 2.043s, 166,343 bytes; invalid URL returns error; all in one persistent source-host process |
| YouTube page-extractor E2E | PASS | Public `jNQXAC9IVRw` page URL → MP4 → complete; 320×240, 19.014s, 475,990 bytes |
| Headless popup layout and preview | PASS | 390px client/scroll width with long URL/path/error details expanded; no overflow offenders; local MP4 hover plays muted with `preload=none`, then leave pauses, clears `src`, and restores poster |

These checks are regression coverage, not end-to-end acceptance.

## Real Chrome status

The user's currently working old extension and Native Host were deliberately not replaced. Beta.3 was packaged and installed only into an isolated temporary application-support/manifest directory. The popup was rendered in a separate headless Chrome process with real long-content layout and a local HTTP MP4 preview. The real YouTube URL was exercised through Chrome-compatible Native Messaging framing, not by replacing the live Chrome extension. No stable-release claim is made from this run.

## Required manual release gate

- [ ] YouTube A appears in the popup with one logical MP4 card.
- [ ] The card says `YouTube · DASH → MP4`; PAGE is not shown as the user-facing format.
- [ ] Hover the YouTube poster: muted preview starts when a reusable DASH URL is available; leaving restores the poster; unsupported URLs remain static without repeated requests.
- [ ] Click YouTube B without refreshing: A is disabled immediately, then the popup changes to B.
- [ ] Browser Back: popup changes to A automatically.
- [ ] Browser Forward: popup changes to B automatically.
- [ ] Download A and B; `ffprobe` confirms both a video stream and an audio stream, and manual playback confirms each file matches its own page.
- [ ] Normal HLS site A → B keeps the two sessions/files separate.
- [ ] HLS and direct-MP4 cards preview when the browser supports their observed URL, otherwise safely retain the poster.
- [ ] A preroll/ad page recommends the main program rather than the ad.
- [ ] On an ad/main page, hover preview makes the selected candidate recognizable without starting a download or controlling the page player.
- [ ] Start, progress, completion, failure, expanded details, and very long output paths never change the popup's 390px width.
- [ ] Delete a completed file and force re-download; the replacement completes and validates.
- [ ] Switch pages while a download is active; the queued job keeps its immutable original resource while the popup follows the new page.

Promote to stable `v1.2.0` only after every item above is checked and recorded with tested URLs, output filenames, durations, and audio/video probe results.
