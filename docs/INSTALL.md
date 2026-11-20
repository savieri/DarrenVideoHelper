# Installation / 安装

Chrome standalone: download DarrenVideoHelper-Chrome-Extension.zip → unzip → enter
`chrome://extensions` → Developer mode → Load unpacked → choose the folder directly
containing manifest.json → play a video webpage → click the extension icon.
Direct MP4/WebM downloads need no Python, Terminal, Homebrew, or Native Host.
HLS/DASH/site extraction requires macOS Full.

Chrome 独立版：下载 → 解压 → `chrome://extensions` → 开发者模式 →
加载已解压的扩展程序 → 选择直接包含 manifest.json 的文件夹 → 视频网页播放几秒 → 点击插件。
HLS/DASH 只能检测，下载需要 Full。直接下载到 Chrome 默认下载目录的 DarrenVideoHelper/。

macOS Full: install Python 3.9+, yt-dlp, FFmpeg and ffprobe first
(`brew install python yt-dlp ffmpeg` for existing Homebrew users). Double-click
install.command; then manually load extension/. Full is not a self-contained
runtime. No Windows/Linux release is supported. Intel Mac is untested.

完整说明、常见错误及测试限制见仓库 README.zh-CN.md / README.md。
Keep the extracted extension directory after loading. Both editions share extension ID
mabnjnddplpelefjgohbjcoajnimpgna; remove the old unpacked entry before switching editions.
The installer is not notarized. It does not disable security protections or remove quarantine.
