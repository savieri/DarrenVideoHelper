# DarrenVideoHelper

检测当前网页的视频资源，直接在 Chrome 下载 MP4/WebM。macOS Full 保留 beta.15 的 Native Messaging + yt-dlp + FFmpeg 下载链路，处理 HLS、分离音视频和支持的站点解析。

[English](README.md) · **v1.2.1-beta.16，公开预发布版**

![由真实插件 HTML、CSS、JS 在 Chrome 渲染的界面，使用示例测试数据](docs/images/popup.png)

*截图展示真实界面代码配合示例数据的渲染结果，不代表已完成真实扩展加载及下载测试。*

## 下载与安装

**[Chrome 独立版 ZIP（普通用户优先下载）](https://github.com/savieri/DarrenVideoHelper/releases/download/v1.2.1-beta.16/DarrenVideoHelper-Chrome-Extension.zip)** · [macOS Full ZIP](https://github.com/savieri/DarrenVideoHelper/releases/download/v1.2.1-beta.16/DarrenVideoHelper-macOS-Full.zip) · [版本说明及校验值](https://github.com/savieri/DarrenVideoHelper/releases/tag/v1.2.1-beta.16)

Chrome 独立版下载直接 MP4/WebM 时，不需要 Python、Homebrew、yt-dlp 或 Terminal。

1. 下载 Chrome 独立版 ZIP。
2. 解压，保留解压后的文件夹。
3. 在 Chrome 地址栏输入 `chrome://extensions`。
4. 打开 **Developer mode / 开发者模式**。
5. 点击 **Load unpacked / 加载已解压的扩展程序**。
6. 选择**直接包含 manifest.json 的文件夹**。
7. 打开视频网页，播放几秒，点击插件图标，选择 MP4/WebM 资源并点击下载。

直接下载保存到 Chrome 默认下载目录下的 `DarrenVideoHelper/`，按检测到的名称命名，保留原始 MP4/WebM 格式。`chrome://downloads` 可查看真实下载状态。Native Host 的下载目录设置不会改变 Chrome 下载目录。

Chrome 安全机制要求手动加载；ZIP 不能点击后自动装入 Chrome。本项目尚未上架 Chrome Web Store。

## macOS Full 完整版

**Full 包含扩展、Python Host 源码和安装脚本，仍需要预先安装 Python 3.9+、yt-dlp、FFmpeg 和 ffprobe。发行包不包含这些运行环境。**

1. 下载 Full ZIP 并解压。
2. 如已有 [Homebrew](https://brew.sh)，在 Terminal 一次安装依赖：
   ```sh
   brew install python yt-dlp ffmpeg
   ```
   不希望配置环境时，先使用 Chrome 独立版下载直接文件。
3. 双击 `install.command`。脚本检查依赖、运行自检，再为当前用户注册 Native Host；不会自动安装 Homebrew、移除隔离标记或更改 Chrome 安全设置。
4. 按上面的 Chrome 步骤加载 Full 包内的 **extension/** 文件夹。
5. 视频网页播放几秒后打开插件。MP4/WebM 默认用 Chrome 下载；HLS/DASH/站点解析调用本地 Host。直接文件需要特殊请求头或转 MP4 时，在设置勾选“Full：直接 MP4/WebM 使用 Native Host 下载”，然后重新选择资源下载；旧任务的重试保持原来的下载方式。

可运行 `install.command --check --non-interactive` 仅检查依赖，不注册 Host。`uninstall.command` 仅移除注册，保留下载及已安装源码。两个版本共用同一个扩展 ID；切换版本时，在 Chrome 移除旧条目，再加载新文件夹。请保留扩展所在文件夹。

## 功能和系统范围

| 功能 | Chrome 独立版 | macOS Full |
| --- | --- | --- |
| 网络、DOM、iframe 多渠道检测 | 支持 | 支持 |
| 当前播放器绑定、SPA 跳转重新检测 | 保留 | 保留 |
| 所有资源、主视频推荐、广告/预览分组 | 保留 | 保留 |
| 时长、清晰度、大小及其依据 | 有证据时展示，可能未知/估算 | 同左 |
| 直接 MP4 / WebM | 原始文件下载 | 默认 Chrome；可选 Native |
| HLS 主清单、清晰度变体 | 识别和展示；下载需 Full | 本地下载并合并 |
| DASH 分离音视频、YouTube/Bilibili 解析 | 需要 Full | 保留原有链路；取决于站点和依赖 |
| 队列、进度、完成/失败、脱敏诊断 | 支持 | 支持 |
| 额外软件 | 直接下载无需 | Python、yt-dlp、FFmpeg/ffprobe |

需要 Chrome 119+。本次验证环境为 Apple Silicon macOS；**Intel macOS、Windows、Linux 未实际完成测试，不宣称支持。** 完整版仅面向 Google Chrome on macOS。历史 Windows 脚本仍留在源码/历史中，不包含在发行 ZIP。

## 已知限制

- Chrome 独立版**没有实现浏览器端 HLS 转 MP4**。不会把 m3u8 清单伪装成视频。MSE 主要服务播放，简单拼接分片不能保证完整 MP4；大型视频、加密分片、分离音频、时间戳跳变和过期链接等仍交给 Full。[技术说明](docs/BROWSER_DOWNLOADS.md)
- 直接下载保留原始格式，不转码、不补音轨、不保证所有带鉴权/特殊请求头的 CDN 都可下载。Chrome 的 Completed 表示传输完成，不代表经 ffprobe 验证。
- 不处理 DRM，也不绕过付费或访问控制。站点更新可能使 yt-dlp 解析失效。
- Native 下载中断后可能保留可续传的数据；不会把尚未验证的文件标成完成。不能承诺所有中断场景完全不留下临时数据。
- 本轮没有完成真实扩展加载、全新电脑安装和多站点实下载：自动化浏览器禁止访问 Chrome 内部扩展管理页。已完成与未完成测试详见 [VALIDATION.md](VALIDATION.md)。

## 常见问题

| 问题 | 处理 |
| --- | --- |
| 找不到 manifest.json | 先解压，再选择直接含该文件的文件夹。 |
| 检测不到资源 | 首次装好后刷新视频网页，播放 3–5 秒，再刷新插件。Chrome 内部页面不支持检测。 |
| 显示“需要 macOS Full” | 当前资源是 HLS/DASH/站点解析；安装 Full 及依赖，或选择直接 MP4/WebM。 |
| Native Host not found / forbidden | 重跑安装脚本，确认使用 Google Chrome，扩展 ID 为 `mabnjnddplpelefjgohbjcoajnimpgna`。 |
| 缺少 Python/yt-dlp/FFmpeg | 安装依赖后重新双击 install.command。 |
| macOS 阻止脚本打开 | 查看系统提示和安全设置；不希望运行脚本可用 Chrome 独立版。本包未公证签名。 |
| 403 / 链接过期 / SERVER_FORBIDDEN | 重新播放并刷新资源；检查 Chrome 下载记录。部分来源需要 Full 或不允许直接下载。 |
| 切换了视频 | 刷新插件，重新选择新资源；旧 session 的选择会被拒绝。 |
| 下载目录不对 | 直接下载跟随 Chrome 默认目录，Host 目录只影响本地下载链路。 |

## 隐私、许可与开发

没有遥测和远程可执行 JS。网页/iframe 检测需要 `<all_urls>`、tabs、scripting、webRequest；直接下载使用 downloads 权限。只有 Full 请求 nativeMessaging。Host 可按设置使用本地 Cookie；不要公开 Cookie、日志或用户下载内容。导出诊断会移除凭据、标题、URL 路径/查询及本地用户路径，分享前仍请自行复核。

manifest 中是保持固定 ID 的**公钥**，不包含签名私钥。项目源码采用 MIT；第三方工具保留其自身许可。本次没有重新分发原包中仅适用于开发机的 FFmpeg 二进制。[第三方检查记录](THIRD_PARTY_NOTICES.md)

开发者安装 Node.js、Python 3.9+ 后执行 `bash scripts/test.sh`，可运行回归测试、打包和结构检查。直接运行 `python3 scripts/build_release.py` 会生成两个 ZIP 和 SHA256SUMS。JS 和资源在两个版本之间一致；Chrome 包仅移除 nativeMessaging 权限。GitHub 自动 Source code 对应发布 Tag，beta.15 的导入和校验清单保留在 Git 历史中。
