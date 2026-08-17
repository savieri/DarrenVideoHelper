# Darren Video Helper

Universal Web Video Downloader for Chrome.

Darren Video Helper detects browser-playable non-DRM HLS/MP4 video streams, sends the selected item to a local Native Messaging host, downloads with `yt-dlp`, merges/remuxes with `ffmpeg`, and accepts the result only after `ffprobe` confirms a real video stream in an MP4 file.

It does not decrypt DRM, bypass paywalls, bypass login, or defeat site access controls. Use it only for videos your browser can already play and that you are allowed to download.

## Current Release Status

`v1.2.0-beta.3` is a prerelease. It replaces the macOS PyInstaller Python host with the verified source-host chain, validates an MP4 before interpreting yt-dlp's final exit code, prevents a late error from overwriting a verified completion, fixes popup width expansion, and adds a bounded hover video preview. Automated regressions, isolated installation, framed direct-MP4/HLS/YouTube downloads, and headless popup layout/preview checks pass. The full real-Chrome matrix in [VALIDATION.md](VALIDATION.md) still requires manual completion, so this is not a stable release.

The version is `1.2.0` rather than `1.1.2` because it changes both session lifecycle behavior and the popup's media model/UI. The beta suffix records that real A/B file-content verification is still open.

## Release Packages

```text
DarrenVideoHelper-macOS-1.2.0-beta.3.zip
DarrenVideoHelper-Windows.zip
```

Both packages are designed for Chrome Developer Mode loading:

1. Install the native host with the included install script.
2. Open `chrome://extensions/`.
3. Enable `Developer mode`.
4. Click `Load unpacked`.
5. Select the included `extension` folder.

## What Is Included

```text
extension/
  manifest.json
  background.js
  content.js
  page-navigation.js
  popup.html
  popup.js
  style.css
  options.html
  options.js
  options.css
  icons/
native/
  host.py
  host.exe
  bin/
    yt-dlp.exe
    ffmpeg
    ffmpeg.exe
    ffprobe
    ffprobe.exe
install.command
uninstall.command
install.bat
uninstall.bat
README.md
```

The macOS package does not contain a PyInstaller Python host or a bundled yt-dlp. `install.command` copies `native/host.py` plus bundled `ffmpeg`/`ffprobe` into `~/Library/Application Support/DarrenVideoHelper/native`, creates the executable `host-source` launcher, and registers that launcher with Chrome. The launcher executes `/usr/bin/python3 host.py`; the host resolves Homebrew yt-dlp and its own bundled media tools.

Windows native host needs to be built on Windows.

The Windows native host must be built on Windows with PyInstaller as `native/host.exe`. PyInstaller does not cross-compile Windows executables from macOS.

## macOS Install

Double-click:

```text
install.command
```

The script:

- checks `/usr/bin/python3`, Homebrew yt-dlp, and bundled `ffmpeg`/`ffprobe`
- installs the source host under `~/Library/Application Support/DarrenVideoHelper/native`
- renames any legacy bundled `native/bin/yt-dlp` to a timestamped `.disabled-*` backup so Homebrew yt-dlp is authoritative
- registers the Chrome Native Messaging Host
- points Chrome to the installed `host-source` launcher
- runs a mandatory self-test and stops installation if it fails
- opens `chrome://extensions/`
- prints the `extension` folder to load

The source host deliberately uses Apple's `/usr/bin/python3` path that was verified on the target Mac. Homebrew yt-dlp is required. `ffmpeg` and `ffprobe` remain bundled with the package.

## Build the macOS package

Stage executable arm64 `ffmpeg` and `ffprobe` under `native/bin`, or point the builder at a verified tools directory:

```bash
DARREN_MACOS_TOOLS_DIR="/path/to/macos/tools" ./build-macos-package.command
```

The builder refuses an unexpected version, a PyInstaller `native/host`, or a bundled macOS yt-dlp. It runs `host.py --self-test` from the staged package before creating `dist/DarrenVideoHelper-macOS-1.2.0-beta.3.zip`.

## macOS Uninstall

Double-click:

```text
uninstall.command
```

This removes the Native Messaging Host registration. Remove the Chrome extension from `chrome://extensions/` if desired.

## Windows Install

Double-click:

```text
install.bat
```

The script:

- registers the Chrome Native Messaging Host under `HKCU`
- points Chrome to `native\host.exe`
- opens `chrome://extensions/`
- prints the `extension` folder to load

No Python installation is required for users when `native\host.exe` is present.

## Windows Uninstall

Double-click:

```text
uninstall.bat
```

This removes the Native Messaging Host registration. Remove the Chrome extension from `chrome://extensions/` if desired.

## Features

- Detects `.m3u8`, `.mp4`, `.m4s`, `.ts`, and YouTube `googlevideo/videoplayback` DASH evidence.
- Tracks YouTube navigation start/finish events, History API changes, `popstate`, tab/webNavigation updates, and a videoId/location polling fallback.
- Invalidates the previous selection as soon as navigation starts and creates a new `VideoSession` only when page/video identity really changes.
- Keeps YouTube MSE `blob:` and poster churn inside the current session.
- Aggregates resolver, DASH, HLS master/variant, and direct-file evidence into one main `LogicalVideo` card.
- Shows one main logical-video card with user-facing pipelines such as `YouTube · DASH → MP4`, `HLS → MP4`, or `Direct MP4`; PAGE/SEG/DASH tracks remain internal evidence.
- Shows a poster by default; after a short hover delay, one muted `playsInline` preview may play for at most eight seconds with `preload=none`. Leaving stops it, clears its media URL, and restores the poster. Unsupported/CORS-limited streams safely remain posters.
- Keeps low-level DASH/HLS evidence inside optional advanced details instead of exposing it as extra downloadable videos.
- Creates an immutable resource snapshot before queueing a native download.
- Downloads only final MP4 output.
- Does not save page screenshots as results.
- Does not write thumbnails, info JSON, descriptions, subtitles, or sidecar files.
- Shows progress percentage, speed, ETA, final file size, and output path.
- Supports queue download, pause, resume, cancel, and imported URL lists.
- Download history uses a resource fingerprint and asks before a forced re-download instead of silently skipping.
- Reuses an existing queued/downloading/merging job when the same resource is clicked again.
- Fails a native job after a bounded startup timeout or disconnect instead of leaving it at `Starting native download...`.
- Writes native host startup, job, command, process, traceback, completion, and exit diagnostics to `~/Library/Logs/DarrenVideoHelper/native-host.log`.
- Includes an Options page for output directory, quality, concurrency, cookies, download-history prompts, MP4-only mode, and advanced source details.

Preview playback reuses an already observed MP4, HLS, or YouTube DASH video URL. It never invokes the download command, never controls the page player, and never plays more than one preview at a time.

## Rollback

To return to the last published stable build, download `DarrenVideoHelper-macOS.zip` from the GitHub `v1.0.0` Release, replace the unpacked extension folder, rerun `install.command`, and reload the extension in Chrome. Do not use the unvalidated `v1.1.0` development state as a stable rollback target.

## Native Host Command Shape

The native host runs a command equivalent to:

```bash
yt-dlp --cookies-from-browser chrome --referer "<current page URL>" \
  --continue --retries 5 --fragment-retries 8 \
  -f "bv*+ba/best" \
  --merge-output-format mp4 \
  --remux-video mp4 \
  --no-write-thumbnail \
  --no-write-info-json \
  --no-write-playlist-metafiles \
  --no-embed-thumbnail \
  --no-write-description \
  --no-write-comments \
  --no-write-subs \
  --no-embed-metadata \
  -P "<download directory>" \
  -o "<clean title timestamp>.mp4" \
  "<video URL or page URL>"
```

## Output Directory

Default:

```text
~/Downloads/video_downloads
```

On Windows this maps to the user's Downloads folder.

## Safety Checks

Downloads are marked `Done` only when:

- the final file is `.mp4`
- `ffprobe` detects at least one video stream
- file size and duration are valid

The native host performs these checks even when yt-dlp exits nonzero. A verified MP4 is reported as `Done` and is never deleted or overwritten by a trailing SSL EOF, timeout, 403, or late native error. Page-duration metadata is retained as diagnostics only because it can be stale or describe an ad/player state. If no MP4 passes ffprobe, the job reports `Failed`; invalid partial MP4 files and image/sidecar outputs from the current job are cleaned up.
