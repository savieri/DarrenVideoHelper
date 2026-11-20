# Third-party runtime audit — 2026-11-20

DarrenVideoHelper's source remains under the repository's MIT license. No new
third-party JS library, Python package, Python runtime, yt-dlp or FFmpeg executable
is included in either release ZIP. Native Host uses Python's standard library and
invokes user-installed programs as separate processes.

## Input FFmpeg executables: excluded

The beta.15 archive contains native/bin/ffmpeg (426,512 bytes) and ffprobe
(253,488 bytes). `file` reports Mach-O 64-bit arm64. `otool -L` reports absolute
Homebrew paths including /opt/homebrew/Cellar/ffmpeg/9.0.2/lib and multiple
/opt/homebrew/opt libraries. They are not portable, standalone runtimes and cannot
run on an Intel Mac as native binaries. The input did not include corresponding
source, build recipe, complete dylibs or notices establishing redistribution
compliance for that exact build. Their original SHA-256 values are recorded in
docs/beta15-input-sha256.json; the bytes are not committed or redistributed here.

FFmpeg is LGPL 2.1 or later by default; optional GPL components can change the
license of the build. Exact corresponding source and build information matter.
This release avoids distributing that unverified build rather than assigning it
a blanket MIT license. See https://ffmpeg.org/legal.html and https://ffmpeg.org/download.html.

## External dependencies for Full

| Tool | Upstream | Handling in this release |
| --- | --- | --- |
| Python | https://www.python.org/ | User-installed interpreter; no runtime redistributed |
| yt-dlp | https://github.com/yt-dlp/yt-dlp#license | User-installed executable; source and bundled-executable license terms differ |
| FFmpeg / ffprobe | https://ffmpeg.org/legal.html | User-installed; build license depends on configuration |
| Homebrew | https://brew.sh | Optional dependency installation route, not bundled or installed automatically |

The installer verifies that selected programs execute successfully before host
registration. It does not download and execute arbitrary binaries, remove
quarantine, request administrator rights, or distribute private signing keys.
The manifest key is public material used to derive the stable extension ID.
Future self-contained Full packages must record exact sources/builds, platform
architecture, dylib closure, notices, source distribution obligations and clean
machine execution results before inclusion.
