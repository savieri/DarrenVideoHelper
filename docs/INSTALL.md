# Installation / 安装

Chrome standalone: download DarrenVideoHelper-Chrome-Extension.zip → unzip → enter
`chrome://extensions` → Developer mode → Load unpacked → choose the folder directly
containing manifest.json → play a video webpage → click the extension icon.
Direct MP4/WebM downloads need no Python, Terminal, Homebrew, or Native Host.
HLS/DASH/site extraction requires macOS Full.

Chrome 独立版：下载 → 解压 → `chrome://extensions` → 开发者模式 →
加载已解压的扩展程序 → 选择直接包含 manifest.json 的文件夹 → 视频网页播放几秒 → 点击插件。
HLS/DASH 只能检测，下载需要 Full。直接下载到 Chrome 默认下载目录的 DarrenVideoHelper/。

macOS Full: install Python 3.11+, FFmpeg and ffprobe first
(`brew install python ffmpeg` for existing Homebrew users). Double-click
install.command; it installs hash-pinned yt-dlp 2026.10.26 into a private venv (Internet required), then manually load extension/. Full is not a self-contained
runtime. No Windows/Linux release is supported. Intel Mac is untested.

完整说明、常见错误及测试限制见仓库 README.zh-CN.md / README.md。
Keep the extracted extension directory after loading. Both editions share extension ID
mabnjnddplpelefjgohbjcoajnimpgna; remove the old unpacked entry before switching editions.
The installer is not notarized. It does not disable security protections or remove quarantine.

## macOS blocks install.command / macOS 阻止打开

This installer is unsigned and not notarized. Click Done. If you trust the file from this repository Release, you may allow this specific script in System Settings → Privacy & Security → Open Anyway, following https://support.apple.com/en-us/102445. This is not Apple verification. Do not disable Gatekeeper or remove quarantine globally. The Chrome edition does not require this script.

安装脚本尚未签名、公证。先点 Done；确认来自本仓库 Release 后，可在系统设置 → 隐私与安全性查看该文件并选择 Open Anyway。安装成功后加载 Full/extension/。两个发行版共享 ID，只加载一个；升级后刷新视频网页。
