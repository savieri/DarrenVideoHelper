## 1.2.1-beta.15

- Recover media scans after same-tab navigation using the committed top-level frame when events arrive late or are missed.
- Ignore redundant history notifications and keep previous-video resources out of the new scan.
- Use the exact resource card title for new download jobs and MP4 filenames. Treat percent signs in titles as literal characters.

## 1.2.1-beta.14

- Use the beta.12 popup layout and align resource controls. Keep current results visible while scanning, serialize refreshes and invalidate old cards on video switches.
- Retry timed-out decode samples without redownloading. The installer can recover earlier, verified MP4s incorrectly rejected by the old decode timeout and clean only their temporary files.
- Keep resumable download files in a hidden, job-scoped folder. Clean them after validation succeeds.

## 1.2.1-beta.13

- Align resource cards and their actions. Show duration, resolution and file size on a dedicated row.
- Add new light and dark themes, a download queue shortcut and new extension icons.

## 1.2.1-beta.12

- List observed HLS manifests and renditions, MP4 and WebM separately with sorting, status, playback association, copy and download actions.
- Recommend only resources supported by matching duration and player evidence. Preserve other candidates for inspection and selection.
- Calculate HLS size from measured response bytes, declared byte ranges or declared bitrate.
- Keep the selected rendition URL fixed, pair declared audio where applicable and verify the MP4 output before completion.

## 1.2.1-beta.11

- Verify unbound HLS candidates against the long-form player, including master variants. Prevent a short autoplay clip from replacing the main player or its download.
- Keep a mismatched final MP4 out of Completed when the task carries a verified main-player duration.

## 1.2.1-beta.10

- Direct HLS and MP4 downloads use the selected request context without requiring access to Chrome's Cookie database.
- Download tasks export separate stdout and stderr records, exit codes and tool versions. Failure cards surface the underlying error.
- HLS candidates retain their active-video association across rescans. A refreshed URL must match the original video.
- The host stops interrupted or idle yt-dlp processes and cleans task-owned fragments. An expired HLS URL clears its old resume files.
- Final MP4 validation checks the container, a readable video packet, and duration before the task completes.

# 1.2.1-beta.9 — 2026-10-07

- 为同一标签页内的每个 video/source 建立独立 mediaId；同一 DOM 元素更换 source 会产生新媒体身份。
- active media 改为动态评分：时间正在推进、最近 play/playing、最近 HLS 请求、可见面积和用户交互依次参与；不再把第一个或最大视频永久锁为主视频。
- popup 打开/刷新会触发实时重扫；下载按钮冻结当前 activeMediaId、标题、frame、source 和时长快照，切换视频不会串改已开始的任务。
- Native Host 以最终 MP4 存在、大小、容器、视频流和 ffprobe 时长为成功核心；网页元数据时长偏差降级为 warning，不再否定有效成品。
- Completed 在扩展和 Native Host 磁盘账本中保持不可逆；attemptId/port generation 拒绝旧回调，并记录 ACTIVE_MEDIA_CHANGED、JOB_TERMINAL 与 IGNORED_STALE_TERMINAL_UPDATE。
- 成功后按固定 job basename 清理自身 `.part`、`.ytdl` 和 `part-Frag`；真实失败保留可续传主 `.part/.ytdl`，孤立 fragment 会被清理。

# 1.2.1-beta.7 — 2026-10-03

- 移除 HLS 过期恢复的默认整页 reload；等待播放器实时请求并持久化恢复同一个下载任务。
- 统一 network / fetch / XHR / performance / player hints，识别无 m3u8 后缀的 index-*，加入近期请求缓冲和 expiry 筛选。
- 对旧候选校验 manifest 内容；失败 URL 不重复派发，保留单次恢复限制。
- Native Host 对 yt-dlp 输出额外脱敏；UI 布局和权限不变。
- 72 项 JavaScript、23 项 Python 检查通过。真实 MissAV/phncdn 验收被浏览器站点安全策略阻止，未完成。详见 VALIDATION-beta7.md。

# 1.2.1-beta.6 — 2026-10-03

- Fix a lost download after HLS refresh: create and persist the original job before any URL check or page reload; a closed popup no longer owns the operation.
- Persist job ID, tab/page/video identity, original candidate/master context, format, quality, one-refresh budget, deadline and lifecycle state in chrome.storage.session.
- Add DOWNLOAD_START → URL_STALE → REFRESH_REQUESTED → PAGE_RELOADING → CONTENT_READY → RESNIFFING → FRESH_CANDIDATE_FOUND → RESUME_DOWNLOAD → DONE/FAILED checkpoints. Restore pending refresh jobs after a service-worker restart.
- New content scripts announce CONTENT_READY; background resniffs player, performance and network evidence, then dispatches the same job to Native Host automatically.
- Prefer an already refreshed matching candidate without reloading. If reload is necessary, wait up to 15 seconds; a persisted deadline plus Chrome alarm ensures an explicit failure after worker suspension.
- Limit automatic refresh to once across preflight, Native Host errors and worker restarts. Verify page/title/video IDs, CDN asset path, duration, quality and master relationships to exclude unrelated streams.
- Persist lifecycle diagnostics with job ID, reload/READY events, candidate counts, selected URL hashes and native results. Popup layout and controls are unchanged.

Validation: 64 JavaScript regressions and 22 Python tests passed. Real MV3 popup click → close popup → native 410 → page reload → forcibly stop worker → content READY → restore same job → yt-dlp/ffmpeg MP4 passed on a controlled HLS server. Also verified no-reload refresh, preflight refresh, timeout shown after reopening popup, second-error termination, and ordinary MP4/HLS outputs. The original external CDN video was not re-downloaded in this validation.

# 1.2.1-beta.5 — 2026-09-20

- Track signed HLS URL detection time, expiry, page/frame context and master playlists. Preserve raw query bytes through Native Messaging.
- Re-read current page media and probe HLS on enqueue and queue dispatch; reload the original page when its signed link has expired.
- Native HTTP 410/403 requests one page-side URL refresh and one automatic retry; repeated expiration fails explicitly.
- Log detection/start time, host, expiry and before/after SHA-256 URL hashes without Cookie headers.
- Update both extension and source Native Host; existing MP4 and site extractor paths remain supported.

# Changelog

## Unreleased - beta.3 video detection fix

- Restores HLS/MP4 candidates and request headers from bounded `chrome.storage.session` snapshots before processing worker-startup events. Closed tabs and mismatched page/document identities are discarded; segment samples are never persisted.
- Actively scans MAIN-world resource timing on every popup open/refresh, including playlists loaded before the popup and videos exposing only a `blob:` source. Playlists take priority over newer segments; recovery respects SPA navigation timestamps and excludes the previous video's URLs.
- Detects extensionless HLS/MP4 from response MIME types and parses extensionless playlists to distinguish master/media candidates.
- Confirms origin-only extensionless SPA candidates against post-boundary MAIN-world resource timing, including after a worker restart; new media capture refreshes an already-open popup.
- Buffers navigation-time requests for up to 30 seconds and 40 candidates, preserving playlists over segment floods. Only candidates with matching new document/page context are merged after commit; lightweight media candidates survive a worker restart during navigation.
- Enables the existing history navigation bridge for ordinary HLS pages and retains the original MAIN-world boundary timestamp. Failed document navigation reactivates the old session.
- Keeps HLS playlists in memory when segment samples fill the tab limit, and excludes conventional MP4 initialization fragments from whole-video recommendations.
- Adds detection regressions and a real MV3 Chrome smoke test with playable local HLS/MSE, an actual stopped/restarted worker, extensionless MIME capture, and automatic popup updates across SPA video switches.

## 1.2.0-beta.3 - 2026-08-17

Prerelease only. Built and tagged from `codex/v1.2.0-beta.3`; `main` is unchanged.

### Fixed

- Replaces the macOS PyInstaller Python host with `host-source` → `/usr/bin/python3 host.py` → Homebrew yt-dlp plus bundled ffmpeg/ffprobe.
- Makes native-host self-test mandatory during installation and validates the exact resolved tool chain.
- Disables a leftover bundled macOS yt-dlp by recoverable timestamped rename so it cannot shadow Homebrew yt-dlp.
- Checks this job's MP4 with ffprobe after yt-dlp exits even when the exit code is nonzero; a valid video stream, duration, and file size now produce `complete`.
- Recovers only the exact final job filename; yt-dlp `*.f137.mp4`-style DASH single-track intermediates cannot be reported as complete.
- Preserves ffprobe-valid MP4 files when page duration metadata differs and prevents a later native error from overwriting a completed popup job.
- Locks the popup document and long job/error content to 390px without horizontal expansion.
- Presents YouTube as `YouTube · DASH → MP4`, HLS as `HLS → MP4`, and keeps PAGE/SEG/single-track DASH evidence out of the main card.
- Keeps YouTube SPA navigation pending until the matching finish is delivered, then reconciles delayed player metadata by videoId without allowing an older generation to refill the session.
- Adds a Bilibili playinfo/fetch/XHR bridge that pairs the current DASH video and audio as one `Bilibili · DASH → MP4` candidate at the highest quality actually returned for the current login state.
- Refreshes signed Bilibili resources at download time and lets the Native Host merge the selected video/audio URLs with current Referer/User-Agent/Cookie headers, backup CDN retry, page-extractor fallback, and mandatory audio validation.

### Added

- Adds one-at-a-time muted hover preview with `playsInline`, `preload=none`, a short start delay, an eight-second cap, immediate teardown on leave, and poster fallback on unsupported/CORS-limited sources.
- Adds a macOS package builder that rejects PyInstaller host and bundled macOS yt-dlp regressions, then self-tests the staged source host.
- Adds framed Native Messaging smoke coverage for direct MP4, HLS, invalid URL, and an optional live YouTube page URL, plus a headless Chrome width/preview smoke test.
- Adds live YouTube three-transition SPA coverage and Bilibili bridge, stale-playinfo, quality-tier, paired-download, header, and audio regressions.

### Validation

- JavaScript background/content/bridge tests: 29 passed.
- Native-host and macOS release-policy tests: 20 passed.
- Isolated package installation and mandatory source-host self-test passed.
- Framed direct MP4, HLS, invalid URL, and live YouTube `jNQXAC9IVRw` cases returned the expected terminal states.
- Headless Chrome held 390px with long expanded diagnostics; local HTTP MP4 hover playback and leave teardown passed.
- Real YouTube content-script smoke completed three recommendation transitions from `jNQXAC9IVRw` without a document reload; all four settled URLs and metadata videoIds matched.
- Public Bilibili `BV1GJ411x7h7` paired separate format `30016` video and `30280` audio URLs; the Native Host completed a 14,767,134-byte, 212.309s, 640×360 MP4 with one video and one audio stream.

### Known limitations

- The user's live Chrome extension was intentionally not replaced. Real installed-popup acceptance for YouTube, third-party HLS/CORS behavior, and ad/main multi-candidate pages remains in `VALIDATION.md`.
- Hover preview depends on the browser being able to reuse the observed media URL without custom request headers. Failure safely remains a poster and does not affect downloadability.

## 1.2.0-beta.2 - 2026-08-12

Prerelease only. Beta.1 remains available as the historical build that exposed the real Native Messaging failure.

### Fixed

- Keeps the Native Messaging host reading framed messages until Chrome closes stdin instead of unconditionally ending after the first message.
- Returns a framed `pong` for transport diagnostics and records host start, received job, redacted command, yt-dlp PID/exit code, traceback, completion, and exit reason in a rotating log.
- Converts `Native host has exited` into a readable popup error with the native log path.
- Adds a 20-second first-response timeout so disconnected jobs cannot remain permanently at `Starting native download...`.
- Reuses the existing job when a matching fingerprint or session/resource binding is already queued, downloading, or merging, including when a second click requested a forced re-download.

### Validation

- Background/session/media/queue tests: 21 passed.
- Native-host tests: 8 passed, including multi-frame lifecycle coverage.
- Registered packaged host: arm64, executable, ad-hoc signed, no quarantine, self-test passed.
- Registered manifest path and extension allowed origin validated against ID `mabnjnddplpelefjgohbjcoajnimpgna`.
- Two `ping` messages on one real packaged-host stdio port returned two framed responses before clean EOF exit.
- Framed packaged-host E2E downloaded YouTube `YXUhLbV8Nrg` to a 121,966,560-byte MP4 with H.264 video, AAC stereo audio, 4373.316-second duration, and a successful five-second mid-file decode.

### Known limitations

- Chrome control can list the real YouTube and extensions tabs, but controlling the YouTube tab and inspecting the extension popup still times out. The framed host E2E uses the exact registered manifest and packaged binary; the final popup click-through remains a user acceptance step.
- The full A/B/back/forward, normal HLS, preroll, deletion/retry, and switch-during-download matrix is not yet complete. Do not promote this prerelease to stable.

## 1.2.0-beta.1 - 2026-08-12

Prerelease only. This build is not marked stable because real Chrome A/B download and file-content verification is incomplete.

### Fixed

- Invalidates the current YouTube logical video at SPA navigation start, before the next video finishes loading.
- Creates a fresh session when the YouTube videoId changes across A → B, back to A, or forward to B.
- Prevents stale title, thumbnail, duration, streams, and popup selections from crossing into the new video session.
- Rejects download clicks from invalidated or replaced sessions.
- Keeps `blob:` currentSrc and poster changes from rotating a YouTube session.
- Captures extensionless `googlevideo.com/videoplayback` DASH audio/video requests as internal evidence.

### Changed

- Aggregates YouTube resolver, DASH tracks, HLS masters/variants, and direct media into one `LogicalVideo` card.
- Hides standalone DASH audio/video tracks from the normal download list; advanced mode shows them only as source details.
- Replaces the internal `YT` label with user-facing MP4 output and quality selection.
- Adds a thumbnail preview area with duration/format overlay; the overlay fades out on hover.
- Passes each card's selected quality to the native host while preserving the saved default as fallback.

### Validation

- Automated background/session/media tests: 18 passed.
- Automated native-host tests: 7 passed.
- JavaScript syntax checks: passed.
- Real Chrome, installed Browser extension, and native-host registrations were detected successfully.
- Real popup inspection was blocked by browser security policy and YouTube tab control timed out; the manual matrix in `VALIDATION.md` remains required.

### Known limitations

- Preview is a stable poster/player thumbnail, not live video playback.
- YouTube A/B final files, normal HLS A/B, preroll filtering, retry after deletion, and switching during an active download are not yet signed off in real Chrome.
- `v1.1.0` was a development regression state and is not treated as a stable Release.

## 1.1.1 - development baseline

- Restored the YouTube page resolver after the `v1.1.0` candidate-filtering regression.
- Added YouTube DASH request evidence and native output validation.
- Not published as a stable Release.

## 1.0.0 - 2026-07-22

- Initial public macOS release.
