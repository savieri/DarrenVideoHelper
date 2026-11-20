# DarrenVideoHelper v1.2.1-beta.18 — Startup & storage hotfix

Public prerelease. Fixes installation blockers found after beta.17; retains its checkpointed HLS engine and the beta.15 source lineage.

- Fix Service Worker initialization: remove a stale commands listener after its Manifest declaration was removed. The old mock exposed an API unavailable in real Chrome; tests now honor the actual Manifest.
- Bound and coalesce session detection caches; save durable jobs before optional credential caching. Session quota failure no longer prevents durable persistence. Migrate old jobs before eviction and preserve unrelated settings.
- Bound saved diagnostic tails; retain live resource lists and Native recovery files.
- Correct file-document postMessage targets; do not weaken website CSP.
- Explain unsigned/unnotarized install.command and Apple's per-file Open Anyway flow. Signing/notarization is still not supplied.

**113/113 regressions passed: 60 JavaScript + 53 Python.** Real Native protocol smoke rerun passed. Both ZIPs are built from this tag. The prior 2482-segment / 2.2 GiB HLS stress result is beta.17 evidence; its engine is unchanged.

## Download / 安装

- [Chrome Extension ZIP](https://github.com/savieri/DarrenVideoHelper/releases/download/v1.2.1-beta.18/DarrenVideoHelper-Chrome-Extension.zip): unzip → chrome://extensions → Developer mode → Load unpacked → folder directly containing manifest.json. Direct MP4/WebM only; no Python required.
- [macOS Full ZIP](https://github.com/savieri/DarrenVideoHelper/releases/download/v1.2.1-beta.18/DarrenVideoHelper-macOS-Full.zip): Python 3.11+ and FFmpeg/ffprobe required; install.command provisions pinned yt-dlp. Load extension/. If macOS blocks the script, see the README's Gatekeeper instructions. Both editions share an ID; load one edition.

[中文指南](https://github.com/savieri/DarrenVideoHelper/blob/v1.2.1-beta.18/README.zh-CN.md) · [故障修复报告](https://github.com/savieri/DarrenVideoHelper/blob/v1.2.1-beta.18/docs/REPAIR_REPORT_beta18.md) · [测试范围](https://github.com/savieri/DarrenVideoHelper/blob/v1.2.1-beta.18/VALIDATION.md)

Live Chrome extension loading, Downloads API transfers, real Chrome restart, clean-machine acceptance and original-CDN 403 recovery remain unverified. API regressions are simulations, not Chrome runs. Intel/Windows/Linux are untested. Full is not self-contained; scripts are not notarized. Persistent access refusal is not bypassed.
