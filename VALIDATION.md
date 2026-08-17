# Release validation

## Automated checks recorded on 2026-08-17

| Area | Result | Scope |
| --- | --- | --- |
| JavaScript background/content/bridge tests | PASS (29/29) | Existing session/navigation/ranking coverage plus YouTube finish/reconciliation, Bilibili paired-DASH bridge, quality-tier truthfulness, stale-playinfo rejection, selection snapshot, pipeline labels, preview policy, and terminal completion protection |
| Native-host and macOS release tests | PASS (20/20) | Existing lifecycle/retry/header coverage plus Bilibili two-input ffmpeg headers, mandatory audio validation, legacy-host/page fallback, nonzero yt-dlp recovery, single-track rejection, source launcher policy, package exclusions, first-run instructions, and beta.3 version agreement |
| JavaScript syntax | PASS | background, content, page navigation, popup |
| macOS package and isolated install | PASS | Staged source host reports beta.3; Homebrew yt-dlp plus packaged arm64 ffmpeg/ffprobe resolve correctly; isolated manifest points to `host-source`; no PyInstaller host or bundled yt-dlp exists |
| Framed Native Messaging E2E | PASS | Direct MP4: 2.000s, 165,799 bytes; HLS→MP4: 2.043s, 166,343 bytes; invalid URL returns error; all in one persistent current-worktree source-host process |
| YouTube page-extractor E2E | PASS | Public `jNQXAC9IVRw` page URL → MP4 → complete; 320×240, 19.014s, 475,990 bytes |
| Headless popup layout and preview | PASS | 390px client/scroll width with long URL/path/error details expanded; no overflow offenders; local MP4 hover plays muted with `preload=none`, then leave pauses, clears `src`, and restores poster |
| Page-player frame mirror smoke | PASS | Four JPEG frames captured from a playing page video; original `currentSrc` and play state unchanged; mouseleave-equivalent stop produced no further frames |
| YouTube real SPA content smoke | PASS | `jNQXAC9IVRw → 0PT5c1z3LL8 → a0W2FtaoHC0 → fTIjOvwQ-hw`; three recommendation clicks, no document reload, and every finish/metadata videoId matched the current URL |
| Bilibili public DASH + Native Host E2E | PASS | Public `BV1GJ411x7h7`; paired separate AVC format `30016` and audio format `30280` URLs with page headers and no page fallback, then completed a 14,767,134-byte, 212.309s, 640×360 MP4 containing one video and one audio stream |

These checks are regression coverage, not end-to-end acceptance.

## Real Chrome status

The user's currently working old extension and Native Host were deliberately not replaced. Beta.3 was packaged and installed only into an isolated temporary application-support/manifest directory. The popup was rendered in a separate headless Chrome process with real long-content layout and a local HTTP MP4 preview. The real YouTube URL was exercised through Chrome-compatible Native Messaging framing, not by replacing the live Chrome extension. No stable-release claim is made from this run.

## Required manual release gate

- [ ] YouTube A appears in the popup with one logical MP4 card.
- [ ] The card says `YouTube · DASH → MP4`; PAGE is not shown as the user-facing format.
- [ ] Hover the YouTube poster: page-player frames appear without attempting to play the remote DASH URL; leaving restores the poster; the original player's play/pause state is unchanged.
- [ ] Click YouTube B without refreshing: A is disabled immediately, then the popup changes to B.
- [ ] Browser Back: popup changes to A automatically.
- [ ] Browser Forward: popup changes to B automatically.
- [ ] Download A and B; `ffprobe` confirms both a video stream and an audio stream, and manual playback confirms each file matches its own page.
- [ ] Normal HLS site A → B keeps the two sessions/files separate.
- [ ] HLS cards use page-player frames; direct-MP4 cards use popup playback and fall back to page frames; unavailable previews silently retain the poster.
- [ ] A preroll/ad page recommends the main program rather than the ad.
- [ ] On an ad/main page, hover preview makes the selected candidate recognizable without starting a download or controlling the page player.
- [ ] Start, progress, completion, failure, expanded details, and very long output paths never change the popup's 390px width.
- [ ] Delete a completed file and force re-download; the replacement completes and validates.
- [ ] Switch pages while a download is active; the queued job keeps its immutable original resource while the popup follows the new page.

Promote to stable `v1.2.0` only after every item above is checked and recorded with tested URLs, output filenames, durations, and audio/video probe results.
