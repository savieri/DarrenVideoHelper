# Start here / 先看这里 — v1.2.1-beta.18

For the simplest setup, download DarrenVideoHelper-Chrome-Extension.zip from the
GitHub Release. Unzip → chrome://extensions → Developer mode → Load unpacked →
select the folder directly containing manifest.json. Direct MP4/WebM requires no
extra software. Chrome requires this final manual step.

最简单安装：下载 Chrome 独立包 → 解压 → chrome://extensions → 开发者模式 →
加载已解压的扩展程序 → 选择含 manifest.json 的目录。视频网页播放后点击插件。

macOS Full requires Python 3.11+, FFmpeg and ffprobe. Its installer downloads hash-pinned yt-dlp 2026.10.26 into a project-local venv (Internet required).
Run install.command, then load extension/. Full is not a zero-dependency installer.
HLS/DASH/site extraction uses the native pipeline. Both editions use Chrome for direct files.

Read README.md / README.zh-CN.md for downloads, limitations and troubleshooting.

macOS may block the unsigned, unnotarized install.command. Click Done; if you trust the Release source, see README.zh-CN.md for Apple’s per-file Open Anyway process. Chrome-only does not run this script.
