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
- Isolates candidates by page/player `VideoSession`; navigation or main `currentSrc` changes invalidate old candidates.
- Recommends direct MP4 or current-session HLS media; generic PAGE URLs are never treated as media, while YouTube uses an explicit site extractor that merges DASH video and audio.
- Creates an immutable resource snapshot before queueing a native download.
- Shows thumbnail, source/title, quality, format, estimated size, and duration.
- Downloads only final MP4 output.
- Does not save page screenshots as results.
- Does not write thumbnails, info JSON, descriptions, subtitles, or sidecar files.
- Shows progress percentage, speed, ETA, final file size, and output path.
- Supports queue download, pause, resume, cancel, and imported URL lists.
- Download history uses a resource fingerprint and asks before a forced re-download instead of silently skipping.
- Includes an Options page for output directory, quality, concurrency, cookies, download-history prompts, MP4-only mode, and advanced candidates.

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
- when the page supplied a reliable duration, the final duration is reasonably close

If a site or URL produces an image, JSON, text, or a non-video file, the native host deletes that output and reports `Failed`.


### 1.1.2：过期链接恢复

- 原生助手将 HTTP 401/403、ExpiredToken、RequestExpired 和明确的签名过期错误报告为 `URL_EXPIRED`，停止对旧地址的重复请求。
- 扩展保留任务和并发名额，按 1/2/4 秒退避，最多自动恢复 3 次。页面解析任务重新运行解析；捕获的媒体任务优先使用新捕获链接，否则刷新原页面并尝试静音播放，最多等待 15 秒。
- 新媒体链接必须属于原页面、相同媒体类型和相同源/路径，且非签名查询参数一致。不猜测已改变路径或不同 CDN 上的资源身份；此类网站可能仍需手动重新选择视频。页面关闭、登录过期或自动播放受限时会保留失败详情。
- 排队媒体快照超过 5 分钟或已进入显式到期时间前 30 秒时，先更新链接再启动下载。恢复过程可取消，达到次数上限后停止。
- 安全优先：当前版本使用 `--no-continue`，所有重试重新下载，避免新签名、清晰度或分片列表变化导致旧数据拼接。暂不做跨 URL 断点续传，也不依赖服务器 Range 支持。失败分片必须中止，不能跳过后输出残缺文件。
- 修改同时涉及扩展和 `native/host.py`，需更新扩展并使用更新后的本地助手。仓库中的旧发布 ZIP 不包含此修复。

验证：`node --test test/background.test.js`；`python3 -m unittest discover -s test -p 'test_*.py'`。
测试覆盖三个任务的过期恢复、原生错误/断开连接生命周期、媒体身份保护、TTL、取消及重试上限；使用模拟浏览器/下载器，不代表目标站点实测。
