# Start here / 先看这里 — v1.2.1-beta.16

For the simplest setup, download DarrenVideoHelper-Chrome-Extension.zip from the
GitHub Release. Unzip → chrome://extensions → Developer mode → Load unpacked →
select the folder directly containing manifest.json. Direct MP4/WebM requires no
extra software. Chrome requires this final manual step.

最简单安装：下载 Chrome 独立包 → 解压 → chrome://extensions → 开发者模式 →
加载已解压的扩展程序 → 选择含 manifest.json 的目录。视频网页播放后点击插件。

macOS Full requires Python 3.9+, yt-dlp, FFmpeg and ffprobe already installed.
Run install.command, then load extension/. Full is not a zero-dependency installer.
HLS/DASH/site extraction uses the native pipeline. Both editions use Chrome for direct files.

Read README.md / README.zh-CN.md for downloads, limitations and troubleshooting.
