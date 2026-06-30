# Darren Video Helper

Universal Web Video Downloader for Chrome.

Darren Video Helper detects browser-playable non-DRM HLS/MP4 video streams, sends the selected item to a local Native Messaging host, downloads with `yt-dlp`, merges/remuxes with `ffmpeg`, and accepts the result only after `ffprobe` confirms a real video stream in an MP4 file.

It does not decrypt DRM, bypass paywalls, bypass login, or defeat site access controls. Use it only for videos your browser can already play and that you are allowed to download.

## Release Packages

```text
DarrenVideoHelper-macOS.zip
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
  popup.html
  popup.js
  style.css
  options.html
  options.js
  options.css
  icons/
native/
  host
  host.exe
  bin/
    yt-dlp
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

The macOS native host is built with PyInstaller as `native/host`.

Windows native host needs to be built on Windows.

The Windows native host must be built on Windows with PyInstaller as `native/host.exe`. PyInstaller does not cross-compile Windows executables from macOS.

## macOS Install

Double-click:

```text
install.command
```

The script:

- registers the Chrome Native Messaging Host
- points Chrome to `native/host`
- opens `chrome://extensions/`
- prints the `extension` folder to load

No Python installation is required for users.

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

- Detects `.m3u8`, `.mp4`, `.m4s`, and `.ts` media requests.
- Recommends the most likely main video first.
- Shows thumbnail, source/title, quality, format, estimated size, and duration.
- Downloads only final MP4 output.
- Does not save page screenshots as results.
- Does not write thumbnails, info JSON, descriptions, subtitles, or sidecar files.
- Shows progress percentage, speed, ETA, final file size, and output path.
- Supports queue download, pause, resume, cancel, and imported URL lists.
- Includes an Options page for output directory, quality, concurrency, cookies, skip history, MP4-only mode, and advanced candidates.

## Native Host Command Shape

The native host runs a command equivalent to:

```bash
yt-dlp --cookies-from-browser chrome --referer "<current page URL>" \
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

If a site or URL produces an image, JSON, text, or a non-video file, the native host deletes that output and reports `Failed`.
