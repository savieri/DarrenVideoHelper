`v1.2.0-beta.3` is a prerelease. This build has been validated on macOS only.

## New

- YouTube recommendations can be opened through SPA navigation and are detected again without a page refresh.
- YouTube is presented as one `YouTube · DASH → MP4` download instead of separate low-level tracks.
- Bilibili DASH video and audio are detected as one logical video and merged into an MP4.
- Ordinary HLS and direct MP4 downloads remain supported.
- The popup is fixed at 390px and provides a bounded hover preview with a silent, safe poster fallback.

## Fixed

- Replaced the macOS PyInstaller/Python.framework Native Host with `host-source` running `/usr/bin/python3`.
- The macOS tool chain now uses Homebrew `yt-dlp` with bundled `ffmpeg` and `ffprobe`.
- A verified downloaded MP4 now stays `Completed`; a late warning or error can no longer overwrite it as `Failed`.
- PAGE, SEG, and single-track DASH evidence no longer appear as downloadable main-video candidates.
- Bilibili signed DASH resources are refreshed at download time, retried through backup URLs, merged with audio, and validated before completion.

## Known limitations

- This is a beta prerelease, not the stable channel. `main` remains unchanged.
- Chrome still requires Developer mode and a one-time manual **Load unpacked** step for the included `extension` folder. This is a Chrome security restriction, not an installer bug.
- Hover preview availability depends on the source and browser request restrictions. Unsupported or CORS-limited media safely remains a poster and can still be downloadable.
- DRM, paywalls, and site access controls are not bypassed. Download only media you are allowed to save.

## Install

1. Download and unzip `DarrenVideoHelper-macOS-v1.2.0-beta.3.zip`.
2. Install Homebrew `yt-dlp` if needed: `brew install yt-dlp`.
3. Double-click `install.command` and wait for the Native Host self-test to pass.
4. In `chrome://extensions/`, enable Developer mode, choose **Load unpacked**, and select the included `extension` folder.

