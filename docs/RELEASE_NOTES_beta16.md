# DarrenVideoHelper v1.2.1-beta.16

Public prerelease built from the supplied beta.15 source. Existing repository and release history are preserved.

## Download / 下载

- **[Chrome Extension ZIP](https://github.com/savieri/DarrenVideoHelper/releases/download/v1.2.1-beta.16/DarrenVideoHelper-Chrome-Extension.zip)** — unzip, open `chrome://extensions`, enable Developer mode, Load unpacked, select the folder directly containing manifest.json. Direct MP4/WebM downloads need no Python, Homebrew, yt-dlp or Terminal.
- **[macOS Full ZIP](https://github.com/savieri/DarrenVideoHelper/releases/download/v1.2.1-beta.16/DarrenVideoHelper-macOS-Full.zip)** — extension, Native Host source and installer. **Requires locally installed Python 3.9+, yt-dlp, FFmpeg and ffprobe.** Double-click install.command, then load extension/ in Chrome.
- Verify downloaded ZIPs against **SHA256SUMS.txt** attached below. GitHub Source code downloads refer to this tag.

[English README](https://github.com/savieri/DarrenVideoHelper/blob/v1.2.1-beta.16/README.md) · [中文说明](https://github.com/savieri/DarrenVideoHelper/blob/v1.2.1-beta.16/README.zh-CN.md)

## Changed

- Chrome Downloads API for the exact validated MP4/WebM resource, detected filenames, original file format, progress, persistent download IDs, completion/failure, cancellation and restart guards.
- Full retains an Options switch to use the original native direct-file pipeline for captured headers or MP4 conversion.
- Standalone manifest omits nativeMessaging; HLS/DASH/site extraction clearly requires macOS Full. Browser HLS-to-MP4 is not shipped.
- Beta.15 network/DOM/iframe detection, HLS variants, SPA/current-player binding, all-resource inventory and main-video recommendations retained.
- Fix inventory controls and headings hidden behind the glass backdrop; preserve bounded popup rendering.
- Stronger redacted diagnostics and safe filenames. No private key, Cookie, user download or private test URL is published.
- Portable source installer checks dependencies and the public-key-derived extension ID before registration. Nonportable arm64 Homebrew FFmpeg binaries are excluded; no third-party runtimes are redistributed.
- Bilingual documentation, screenshot labeled as a sample-data UI rendering, license audit, repeatable packaging and regression scripts.

## Validation / 验证范围

- **42 JavaScript + 19 Python regression tests passed.** JS and shell syntax, Python compilation, Manifest V3 asset references, extension ID and ZIP source parity passed.
- Real Native Messaging integration: two framed pings, locally generated HLS download, FFmpeg/ffprobe verification; completed MP4 is 4.040272 seconds with audio, 351361 bytes.
- Isolated installer registration with Chinese/spaced paths and two launcher pings passed. Actual ZIP extraction and extracted installer's dependency-only check passed.
- Actual Chrome rendering of popup source with sample test data, sorting and refresh checked.

**Not validated:** loading the new extension through chrome://extensions, a live Chrome Downloads API transfer from beta.16, a clean-machine installation, external-site content A/B checks, Intel Mac, Windows or Linux. Browser automation policy blocks Chrome's internal extension page, so this remains a prerelease. See [VALIDATION.md](https://github.com/savieri/DarrenVideoHelper/blob/v1.2.1-beta.16/VALIDATION.md).

## Limits / 限制

Chrome-only supports direct files and HLS detection, not HLS merging. Full is macOS only and still requires dependency installation; with Homebrew already installed: `brew install python yt-dlp ffmpeg`. Direct Chrome completion confirms transfer, not native media validation. Some servers reject direct requests or require fresh signed URLs. Site extraction depends on yt-dlp and the website. DRM and access-control bypass are not supported. Native interrupted downloads may retain resumable data.
