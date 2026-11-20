# Video Helper 1.2.1-beta.7：变更与验收边界

日期：2026-10-03。状态：代码和自动化回归通过，真实站点验收未完成。不能将本报告理解为 MissAV/phncdn 已成功下载。

## 已确认的 beta.6 代码问题

- continueRefresh 在第一次 sniffJobCandidate 返回空时立即调用 chrome.tabs.reload，没有等待当前播放器的后续媒体请求。
- 首次检测有 response MIME、page-response playlist body 等数据源，而 performance 恢复扫描主要匹配 m3u8/mp4/m4s/ts 后缀，漏掉无后缀 index-v1-a1 路径。
- detectedAt/lastSeen 混用了检测、播放器快照、分片活动；没有独立记录 manifest 请求的状态与真实请求时间。读取旧配置并不代表获得了新的签名 URL。
- beta.6 的持久化任务和 READY 恢复解决了任务丢失，但无法让 reload 后尚未播放的页面产生新的 manifest。
- beta.6 已有 webRequest、all_urls 和 MAIN/isolated document_start hook。本次不新增权限，不使用 devtools API。

## beta.7 策略

1. webRequest 在 popup 未打开时持续捕获；按扩展名、index-* / manifest 路径和响应 MIME 识别 HLS，记录失败状态。每个视频 session 保存最多 80 个 URL 的近期请求缓冲，保留 90 秒，与检测状态一起写入 chrome.storage.session。
2. MAIN hook 提供 fetch/XHR URL、响应状态和 PerformanceObserver；XHR 即使使用二进制 responseType 也能报告 URL。保留原有 playlist body 检测，不消耗页面自己的响应流。
3. 点击下载与等待恢复共用 collectMediaHints / captureNetworkStream / upsertStream，收集资源时序、hook 缓冲、video currentSrc/source、绑定的 Hls.js 对象和内联脚本 URL 字面量。blob 不会发送给 Native Host；脚本文本只读，不执行。
4. 同页面、CDN asset path/视频标识、master/variant、质量、时长仍用于过滤；phncdn 子域变化可按相同 asset path 匹配。优先最近请求，已知 expiry 少于 60 秒即排除。支持秒/毫秒时间戳和 Akamai token 内的 exp；不猜测不透明 token 的期限。
5. 30 秒内成功的请求可直接使用。较旧但未过期的同视频候选必须通过无页面刷新的 GET 校验，并确认 #EXTM3U 前缀；HTTP 200 的 HTML/challenge 不算有效。校验无法完成时等待页面网络证据，不盲目交给 native。
6. 410/403 URL 加入当前 job 的拒绝列表，不再次派发。进入 WAITING_FOR_FRESH_MEDIA_REQUEST；捕获匹配新 URL 后恢复同一 job，仅自动恢复一次。任务和绝对 deadline 持久化，popup 关闭不影响任务。
7. 已绑定且正在播放的 Hls.js 实例可调用 startLoad(currentTime) 一次；不调用 video.load，不改 currentTime/暂停状态，不强制切换质量。其他播放器继续被动等待并提示播放。该操作不保证站点签发新 token。
8. 此版本不自动 reload 页面。没有真实站点证据证明必须导航，故不启用 speculative reload fallback。等待上限为 120 秒，事件到达可提前恢复；这不是“reload 后等 15 秒”。升级前遗留状态仍可读。
9. flowLog 记录 jobId、来源、请求年龄、expiry remaining、URL hash、native 完成/错误。Native Host 额外脱敏 yt-dlp 原始输出，下载协议与媒体下载流程不变。

## 测试与真实证据

- JavaScript：72 项通过，包含既有 MP4、YouTube/Bilibili 检测/导航和新增 index-path、请求状态、ring 恢复、expiry、410 后同 job 无 reload 恢复、HTML 200 拒绝、fetch/XHR/PerformanceObserver 测试。
- Python：23 项通过，包含 host、过期分类、不重复旧 URL、原始签名 URL 保持及新增输出脱敏。
- 这些是自动化单元/回归测试；新增恢复用例使用模拟 Chrome 事件与 native dispatch，不是实际站点或浏览器下载验收。
- 已读取 ~/Library/Logs/DarrenVideoHelper/native-host.log 及 .1/.2/.3；这四份日志没有 phncdn 记录。最近能确认的 media_url_expired 410 来自 beta.6 的 127.0.0.1 测试。没有把历史本地 MP4 当作 beta.7 真实成功。
- 用户提供 [private user-supplied test URL omitted] 后，浏览器工具明确拒绝访问该地址，理由为站点安全策略，并禁止通过其他浏览器接口绕过。因此没有取得该页面的实时网络/background 日志，也没有执行实际点击下载。
- 未完成：真实播放 → 点击下载 → 不导航 → 新 HLS → yt-dlp/MP4；真实旧链接 410 → 当前播放器新请求 → 自动恢复。MissAV 与原 phncdn 页面不是同一已验证来源。

## 修改的文件

- extension/background.js：请求缓冲、匹配、expiry、无 reload 状态机、来源恢复、日志。
- extension/media-observer.js、media-bridge.js：实时 URL/状态、PerformanceObserver 和消息桥。
- extension/manifest.json：1.2.1.7 / 1.2.1-beta.7；权限不变。
- native/host.py：版本及 yt-dlp 输出脱敏。
- test/background.test.js、media_observer.test.js、test_hls_expiry.py、test_macos_release.py。
- CHANGELOG.md、README-FIRST.md、VALIDATION.md、本报告、build-macos-package.command、scripts/sync-dev-install.command。

## 本机更新

扩展同步至 ~/Downloads/DarrenVideoHelper-beta3/extension（保留原加载路径）。Native Host 源码同步至 ~/Library/Application Support/DarrenVideoHelper/native/host.py，启动器不变；两处原文件保存在 beta.7 项目 backups/before-beta7-install。

在 chrome://extensions 重新加载 Video Helper；为了让新的 document_start hook 生效，已打开的视频页升级后需手动刷新一次。这个一次性升级操作与点击下载时自动 reload 无关。没有替用户刷新任何视频页。新的 native 进程自动使用 beta.7，无需重新运行安装器。已有 native 进程不受源码替换影响。
