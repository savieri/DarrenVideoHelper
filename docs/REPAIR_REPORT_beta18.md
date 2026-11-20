# beta.18 — 实际加载故障修复

2026-11-20。基于已发布的 beta.17，保留 beta.15 来源与完整 Git 历史。此版为公开测试版。

## 截图所示问题与证据

| 现象 | 根因 / 判断 | 修改与验证 |
| --- | --- | --- |
| `Service worker registration failed. Status code: 15` | beta.16 已移除 Manifest 的 commands 声明，但 background.js 仍无条件访问 chrome.commands.onCommand。Chromium 的 commands API 依赖 manifest:commands，因此实际加载时该 API 不可用。按 Manifest 提供 API 的测试在修复前准确复现 TypeError。原测试无条件提供 commands，漏掉此错误。 | 删除无效的 reload_extension 监听；测试使用真实 Manifest 决定 API 可用性，覆盖 Chrome / Full 两种发行模式。不能把 inactive 本身当作故障，MV3 worker 正常也会休眠。 |
| `Session storage quota bytes exceeded` | 检测快照与完整任务、日志、原始 Payload 重复写入 session，只有数量上限，没有总容量预算或全局淘汰。长 URL、多标签和多个任务会放大占用。 | 检测每标签约 96 KiB、全局缓存约 1 MiB 的保守估计预算；淘汰最旧检测缓存；合并密集写入，不积压旧快照。缓存裁剪不删除当前内存里的资源列表；重启后必要时重新检测。Chrome 实际按内存计量，因此仍捕获真实 quota 拒绝。 |
| `Job persistence failed` | 旧代码先写 session，失败会使后续 local 持久化根本不执行。 | 先保存去除 Cookie/Authorization 的 durable jobs，再尽力缓存仅含授权上下文的数据。缓存失败不阻止任务持久化，不重新派发下载。保留活跃任务、压缩已保存的诊断尾部；本机 Native 诊断仍可独立导出。 |
| 旧版任务迁移 | 不能先清空 session 再发现 local 写不进去。 | 旧任务读入并成功写入 local 后才移除 downloadJobsV6。注入 local 写失败时，原 session 任务保持存在。配额治理只影响本扩展的已知缓存键，不清空无关设置。 |
| file:// postMessage 与 null origin 不匹配 | 文件文档是 opaque origin，不能将 file:// 用作目标 origin。 | content.js / page-navigation.js 仅为 HTTP(S) 使用明确 origin，opaque 文档使用同窗口消息的 `*` 目标；接收方仍检查消息来源与结构。分别增加回归。 |
| `Connecting to data: violates Content Security Policy` | 截图不足以确定该请求的调用来源，不能据此认定为 worker 注册失败的原因。 | 未放宽网站 CSP，也未添加 data: 网络访问或绕过 Cloudflare。资源探测已有 HTTP(S) 检查。若新版本仍出现，应查看具体错误的来源与调用栈，另行定位。 |
| macOS `install.command Not Opened` | 发行脚本尚未 Developer ID 签名 / Apple 公证。Internet 下载后，系统不能核验开发者与恶意软件检查状态。隔离安装测试没有复现真实 Internet 下载后的 Gatekeeper 界面。 | 中英文安装文档补充官方流程与未签名事实，不删除 quarantine，不关闭 Gatekeeper。此修复不冒充已经完成签名或公证。 |

## 安装与升级

优先下载 beta.18，保留原下载视频与 Native 恢复目录。Chrome 中重新加载新目录；切换 Chrome 独立版与 Full 时，两者共享 ID，只加载其中一个。

- Chrome 独立版：ZIP 解压后在 chrome://extensions 加载直接含 manifest.json 的目录；MP4/WebM 无本地软件依赖，不下载 HLS。
- Full：依赖 Python 3.11+ 与 FFmpeg/ffprobe。安装器建立固定 yt-dlp 私有环境。若 macOS 阻止打开，先点 Done；确认文件来自本仓库 Release 后，可在系统设置 → 隐私与安全性查看该文件并选择 Open Anyway。这是用户针对该脚本的明确例外，不是已经通过 Apple 检查的证明。
- 安装后加载 Full/extension/，而不是 Full 根目录或另一个 Chrome 独立包。进入视频网页，刷新页面使旧 content script 换成新版；无需清空浏览器或下载目录。

## 验证与限制

60 项 JavaScript + 53 项 Python，113 / 113 通过。新增覆盖真实 Manifest 的 API 门控、配额拒绝下 durable 状态、旧任务安全迁移、24 个大标签缓存预算、200 次写入合并、日志压缩、授权缓存恢复、local 失败前阻止派发、文件 origin，以及不删除无关设置。

beta.18 重新运行真实 Native 协议测试：MP4、WebM、HLS、SIGKILL 后续传、并行隔离、重复派发和取消。HLS 引擎文件与 beta.17 一致；2482 分片 / 2.2 GiB 压力结果属于 beta.17 的实测证据，没有伪称本版重新运行压力测试。

本轮仍未完成真实 chrome://extensions 自动加载与 Chrome Downloads API 实下载：自动化入口限制仍在。Manifest 门控回归是 VM / API 模拟，不冒充 Chrome 实测。安装器仅在隔离注册目录验证，不修改用户当前 Native 注册；真实 Internet 下载后的 Gatekeeper 放行未自动执行。目标站点 403、Intel / Windows / Linux、全新无依赖电脑仍未验证。

参考：
- https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/common/extensions/api/_api_features.json （commands 依赖 manifest:commands）
- https://developer.chrome.com/docs/extensions/reference/api/storage （session 配额与拒绝行为）
- https://developer.chrome.com/docs/extensions/get-started/tutorial/debug （注册失败 15 属于初始化失败摘要）
- https://support.apple.com/en-us/102445 （Gatekeeper 与 Open Anyway 官方说明）

HLS 详细技术报告：[beta.17 修复报告](REPAIR_REPORT_beta17.md)。原始私人截图、诊断、Cookie 和下载记录未提交。
