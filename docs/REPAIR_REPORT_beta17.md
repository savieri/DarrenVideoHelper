# beta.17 技术审计与修复报告

日期：2026-11-20。基于用户提供的 beta.15 真实源码，沿用 beta.16 的双发行包及 Git 历史，新增检查点 HLS 引擎。版本为 **1.2.1-beta.17 公开测试版**，不标注 stable。

## 1. 真实故障证据与结论

已完整读取提供的 beta.15 诊断文件和包含两项失败任务的截图。为保护隐私，本仓库不包含原诊断、截图、视频标题、来源页面、CDN 资源路径、个人目录或原任务 ID。以下仅保留排障所需的聚合事实：

- 第一项任务有 2,482 个分片，在第 828 分片遇到 HTTP 403，两次分片重试后退出，退出码 1；约运行 561.64 秒。
- 原诊断共有 10,169 条 Native 事件，仅有 **一次 process_start、一个 attempt、一次 process_exit**。重复 DOWNLOAD_START / RESUME_DOWNLOAD 文本来自不同调用层，不能据此认定该次实际启动了多个下载进程。
- 实际命令使用 yt-dlp 2026.07.04，HLS 参数被覆盖为 `--retries 0`、`--fragment-retries 2`。超过 90 天的提示是版本维护警告，不是 HTTP 403 的根因证明。
- beta.15 对精确选中的 HLS 遇到 403/410 时执行 `cleanup_sidecars(..., discard_resume=True)`，然后报告 incomplete；Popup 又把所有 incomplete 写成“可续传”。这会删除恢复数据并错误承诺续传。
- 对原任务记录路径进行了只读检查：指定临时目录、计划成品及同名前缀恢复文件均未找到。该路径下没有可验证的原进度可迁移。检查没有修改原任务或用户下载目录。
- 第二项截图证实另一个任务在第 897 分片附近失败；没有第二份完整诊断，不能把它的 HTTP 原因写成已独立确认。
- 日志中的 `~ GiB` 为 yt-dlp 估算，随分片码率变化并不异常；它不是最终文件大小证据。

| 候选原因 | 证据判断 |
| --- | --- |
| CDN 授权 / 签名 / 会话过期 | 可能；原日志没有失败时清单响应、签名期限或浏览器对照请求，未证实 |
| 单个分片失效或被删除 | 可能；旧版未对比新旧完整清单和失败分片状态 |
| Cookie / Referer / Origin / UA 不匹配 | 可能；日志包含 UA/Referer，但敏感 Header 已脱敏，无法证明与当时播放请求完全相同 |
| 限流 / 访问策略 / IP / 区域变化 | 未证实；无 Retry-After、响应策略或 IP 变化证据 |
| 清单变化 / 内容版本变化 | 未证实；旧版没有可比较的初始清单检查点 |
| yt-dlp 兼容性问题 | 未排除；已更新并实测固定版本，但不能宣称升级必然消除服务器 403 |
| 使用旧缓存 | 属于需要防守的风险；保留 session/资源选择校验，并增加 Native 清单及字节复核 |
| 本次重复进程 | 诊断不支持该判断；仍修复异步并发入队及派发竞争的潜在窗口 |

**已确认并修复的是恢复数据治理、错误分类、幂等性、验证和状态表达；没有证据宣称已修复目标 CDN 的授权策略。**

## 2. 修改与对应验证

| 问题 / 风险 | 修改文件与行为 | 对应验证 |
| --- | --- | --- |
| HLS 403 清空进度；incomplete 一律“可续传” | `native/hls_engine.py`、`native/host.py`：逐分片 SHA-256 收据，保留已验证数据；只有真实检查点才可续传；旧任务缺失检查点时明确提示创建新任务 | 828 持续 403、恢复后的分片复用、旧任务无检查点测试 |
| 重试仅靠 yt-dlp 参数，无清单身份核验 | 新 HLS 引擎流式下载，按 HTTP 类型处理，最多一次清单诊断；扩展至多一次自动捕获新播放上下文 | 503、403、合法 token 刷新、404、断线、429 测试 |
| Retry-After 在重启后失效 | 等待期限写入检查点；超过单次等待预算时停止，立即重试也不会提前请求 | Retry-After 实际等待与跨实例期限测试 |
| 新旧地址直接拼接 | 比较来源、清晰度、完整分片序列、时长、discontinuity、时间标记、范围、MAP、密钥/IV；缓存全量校验，远端首/中/末已完成分片与密钥/初始化数据复核 | 序列变化、同路径内容变化、损坏本地片段、选中时长错误测试 |
| 任务重复 / 输出冲突 | `extension/background.js`：串行原子入队与派发占位；保留 Native 文件锁；输出用原子、无覆盖发布 | 20 次并行点击、重复恢复回调、真实重复 Native 派发和两任务并行测试 |
| 下载 100% 即被误判成功 | 新增 recovering / attention / verifying；下载字节、分片、合并与验证阶段分开；非零 yt-dlp 退出不再凭文件存在改成功 | 100% 仍 Verifying、晚到错误不可覆盖 Completed、可读取文件但非零退出测试 |
| 成品提前暴露 / 文件名过长随机尾缀 | 每任务独立隐藏目录；成品验证后原子发布；用户文件名与内部 Job ID 分离；同名使用 `(2)` | MP4/WebM/HLS 成品、同名冲突、Unicode 长标题、原子发布中断恢复测试 |
| FFmpeg 失败后丢失输入 | 已完成分片保留；重试独立合并；错误输出或损坏媒体不发布成品 | 注入合并失败、损坏分片 200 响应、真实音视频验证 |
| 取消后仍运行 / 旧取消误伤新 attempt | 带 attempt 的取消控制、读超时和分片循环中的取消检查；可选保留或清理；清理仅限该 Job 的隐藏目录 | 真进程取消、取消前派发竞争、清理保留无关文件测试 |
| Native Host 崩溃 / 浏览器端状态恢复 | 检查点与分片收据落盘；Native 状态查询核对真实文件；不通过丢失连接来猜测完成或盲目重派 | 真实 SIGKILL 后状态查询及续传；Service Worker 存储恢复为 API 模拟测试 |
| stdout / stderr 堵塞与内存膨胀 | 旧引擎使用有界双管道读队列；新 HLS 流式读取、受限磁盘工具日志、可中止的子进程轮询 | 2.2 GiB 流式压力、Native 子进程退出 / 并行测试 |
| Header / 参数 / 路径安全 | 校验 Native 消息及 URL、禁用嵌入凭据/换行 Header、限制帧大小；跨主机重定向移除 Cookie/Authorization；本地 FFmpeg 仅 file/crypto/data | Native 输入验证、Header 到达、符号链接与目录穿越检查 |
| Popup 排版和英文原始错误 | `extension/popup.js`、`style.css`：短中文原因、明确阶段、标题截断及 tooltip、实际能力驱动按钮；真实后端控制与错误响应 | Chrome 中样例状态渲染，390px 宽度、排序/刷新；Native 操作另有协议实测 |
| 依赖老旧且全局路径不稳定 | `native/requirements.txt`、`install.command`：项目私有 venv 安装哈希固定的 yt-dlp 2026.10.26，Python 3.11+，不修改全局 yt-dlp | 独立安装目录、中文/空格路径、自检、真实 MP4/WebM / HLS |

Cookie 隐私：本机 Chrome Cookie 数据库读取改为新安装默认关闭、显式启用；无关页面/API 的 Cookie 不进入请求上下文缓存。已识别媒体的播放授权仍可在本机使用。新增自动化回归覆盖默认值和媒体/非媒体隔离。

## 3. HLS 引擎边界

- 检查点目录：`video_downloads/.darren-video-helper/<Job-ID 的稳定哈希>/`。分片写入 `.part` 后校验长度、范围和哈希，再原子提交；小型分片收据逐条 fsync，元数据定期压实。
- HTTP 401/403：不猜测 token 过期，不切换身份或绕过限制。检查当前清单，验证兼容性后最多恢复一次；仍拒绝时交给原页面播放 / 授权与明确提示。
- HTTP 404/410：重新检查清单，不静默跳过缺失分片。408、429、5xx、断线和超时有限重试；429 降速，遵守并持久化 Retry-After。
- VOD TS、fMP4/MAP、BYTERANGE、普通 AES-128、Master 的默认独立音轨经过实际本地合并测试。默认音轨以外的其他音轨与字幕不导出。
- 保留 discontinuity、序列、时间与加密元数据，并纳入兼容性判断；不是所有跨站点时间戳变体都经过实测。FFmpeg 报媒体错误或时间戳不可兼容时保留输入并失败，不伪造时间轴。
- 动态 / Live、低延迟 / delta 清单、SAMPLE-AES、DRM 和未知密钥格式明确拒绝，不冒充完整 VOD。
- 验证要求包括：每个分片均有有效本地收据、FFmpeg 处理无错误、MP4 容器、视频 / 必要音轨、所选高度、清单时长、头尾解码。没有进行逐帧全片解码，也没有重新下载所有远端旧分片；远端内容复核为抽样，不能对服务端任意内容替换作绝对保证。
- 完成后删除分片、密钥、MAP、工具临时文件，保留任务检查点；中断保留有效输入。磁盘不足、文件系统不支持原子链接、目录不可写均停止，不覆盖现有文件。
- 旧站点 / DASH / Native MP4/WebM 引擎继续保留在隔离的 attempt 目录；无法证明版本兼容时重新尝试，不承诺分片续传。

## 4. 测试结果

完整自动化回归：**100 / 100 通过（100%）**，其中 47 项 JavaScript，53 项 Python。另完成真实 Native 协议、安装及压力运行；结果见 `test-results-beta17.json` 与 `VALIDATION.md`。

压力数据完全由测试程序生成，不使用用户视频。有效 MPEG-TS 数据追加合法 null packet，使传输达到 2.2 GiB；成品不会保留这些填充包。这验证流式传输 / 内存 / 多分片处理，不等同于所有 4K 编码、高码率或目标网站场景。

| 压力指标 | 实测 |
| --- | --- |
| 视频时长 | 7,446.08 秒（约 2 小时 4 分钟） |
| 分片 | 2,482 |
| 分片输入字节 | 2,362,476,808 |
| 实际接收字节，含清单等 | 2,362,553,838 |
| 成品大小 | 116,399,789 字节，含音频 |
| 第 828 分片 | 注入两次 503，第三次恢复 |
| Python 峰值 RSS | 41,484,288 字节（约 40 MiB） |
| 本机总运行时间 | 18.35 秒；低复杂度合成素材，不代表网站下载速度 |
| 完成后工作目录 | 仅剩 checkpoint.json |

真实 Native 运行通过：两次同端口 ping、正常 MP4、WebM 转 MP4、HLS、已完成 Job 重放不重新下载、SIGKILL 后复用已验证分片、两视频并行输出隔离、重复 Job ID 返回 busy、取消保留数据。

## 5. 未完成 / 未宣称解决

1. 未完成目标 CDN 的实下载复现，不能宣称其 403 已根治或必然可恢复。原始服务器原因仍需失败时的有效请求对照。
2. 原失败任务在已检查路径下没有恢复数据；诊断 JSON 不能重建被删除的视频分片。
3. 自动化浏览器不允许访问 Chrome 内部扩展管理页；真实 beta.17 扩展加载、Chrome Downloads API 实下载、Chrome 退出重开和全新无依赖电脑验收未完成。浏览器端存储重启测试是模拟；Native SIGKILL 是真进程测试。
4. Apple Silicon macOS 完成源码、协议、安装、媒体测试；Intel Mac / Windows / Linux 不宣称完成验证。
5. 不提供浏览器内 HLS 合并，不绕过 DRM、账号、付费或服务器拒绝。
6. Full 仍需 Python 3.11+ 和 FFmpeg/ffprobe；安装器联网建立项目私有 yt-dlp 环境。没有把 Homebrew 动态库二进制当成便携运行时分发。

## 6. 安装与复现

Chrome 基础版：下载 ZIP、解压、进入 `chrome://extensions`，打开 Developer mode、Load unpacked，选择直接包含 manifest.json 的目录。MP4/WebM 直接下载无需本地依赖。

Full：先安装 Python 3.11+、FFmpeg/ffprobe；已有 Homebrew 时执行 `brew install python ffmpeg`。双击 `install.command`，等待固定 yt-dlp 安装及自检通过，再加载 `extension/`。长 HLS 使用 Full。恢复提示需要授权时，回原页面正常播放 / 登录，再点“重新检测并恢复”；服务器持续拒绝则停止。

开发复现：

```sh
python3 -m venv .runtime
.runtime/bin/python3 -m pip --isolated install --require-hashes -r native/requirements.txt
export VIDEO_HELPER_YTDLP_PATH="$PWD/.runtime/bin/yt-dlp"
bash scripts/test.sh
.runtime/bin/python3 scripts/stability_native_smoke.py
python3 scripts/hls_stress.py
```

压力脚本临时占用约 5 GiB 磁盘并在结束后删除测试数据。源码与两个发行 ZIP 由同一发布 Tag 构建，附 SHA256SUMS；不上传用户诊断、Cookie、Token、个人路径或视频内容。
