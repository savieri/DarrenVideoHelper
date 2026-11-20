# DarrenVideoHelper v1.2.1-beta.17 — HLS recovery test release

Based on the supplied beta.15 source and beta.16's dual editions. **Public prerelease, not stable.**

## Download / 下载

- **[Chrome Extension ZIP](https://github.com/savieri/DarrenVideoHelper/releases/download/v1.2.1-beta.17/DarrenVideoHelper-Chrome-Extension.zip)** — unzip → chrome://extensions → Developer mode → Load unpacked → select the directory directly containing manifest.json. Direct MP4/WebM downloads need no local runtime.
- **[macOS Full ZIP](https://github.com/savieri/DarrenVideoHelper/releases/download/v1.2.1-beta.17/DarrenVideoHelper-macOS-Full.zip)** — Python 3.11+ and FFmpeg/ffprobe required. Double-click install.command; it installs hash-pinned yt-dlp 2026.10.26 into a private venv (Internet required), self-tests and registers the Native Host. Then load extension/ in Chrome.
- **SHA256SUMS.txt** accompanies the ZIPs. GitHub Source code downloads correspond to this tag.

[中文安装说明](https://github.com/savieri/DarrenVideoHelper/blob/v1.2.1-beta.17/README.zh-CN.md) · [完整修复报告](https://github.com/savieri/DarrenVideoHelper/blob/v1.2.1-beta.17/docs/REPAIR_REPORT_beta17.md) · [测试范围](https://github.com/savieri/DarrenVideoHelper/blob/v1.2.1-beta.17/VALIDATION.md)

## Repairs

- Checkpointed VOD HLS transfer: durable per-fragment hashes/receipts, bounded HTTP recovery, persistent Retry-After, manifest and byte validation before reuse. No silent missing-fragment success.
- TS, fMP4/MAP, byte ranges, authorized AES-128 and default separate audio tested locally. Unsupported live/delta/DRM or incompatible media stops with data preserved.
- Per-job hidden work directories, independent merge retries, short filenames, nonclobbering atomic final publication and scoped cancellation/data cleanup.
- Serialized enqueue, native dispatch guards and file locks, persisted-state reconciliation, accurate Recovering / Requires attention / Verifying labels and verified Resume eligibility.
- Pinned project-local yt-dlp 2026.10.26; no unverified FFmpeg binary redistribution. Existing page/DASH/native-file functions and Chrome standalone edition retained.
- Bilingual docs, troubleshooting, safe diagnostics, regression scripts and generated-media stress reproduction.

## Validation

**100/100 regressions passed (47 JavaScript + 53 Python).** Real Native protocol tests passed for MP4/WebM/HLS, idempotent replay, actual host SIGKILL + resume, two concurrent isolated jobs, duplicate Job ID rejection and cancellation.

Stress: **2482 segments, 7446.08 seconds, 2.2 GiB input**, with two 503 responses at fragment 828 before recovery. Verified output contains audio and full duration. Python peak RSS about 40 MiB; the test uses generated MPEG-TS with valid null-packet padding, not private or real-site media.

Isolated macOS installation with Chinese/spaced paths, dependency provisioning/self-tests, stable extension ID, ZIP extraction/source parity and sample-data Chrome UI checks completed. Source, packages and checksums match this release tag.

## Limits / 仍需说明

The original CDN's 403 root cause is unproven; local fixture success is not a claim that the website is fixed. The supplied old task's recorded recovery paths contained no matching files; deleted progress cannot be rebuilt from a diagnostic JSON. Arbitrary old .part files without compatible checkpoints are not called resumable.

Live loading of beta.17 through chrome://extensions, a real Chrome Downloads API transfer, actual Chrome restart/fresh-machine acceptance and Intel/Windows/Linux remain unverified. The automation browser blocks internal Chrome pages; these restrictions were not bypassed. Full still needs Python/FFmpeg; Chrome-only does not merge HLS. Persistent server refusals are surfaced and not bypassed.
