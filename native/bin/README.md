No third-party executables are distributed in this directory.

The two arm64 Homebrew FFmpeg executables in the beta.15 input have absolute
Homebrew dylib dependencies and are not portable runtimes. Their exact build
source and redistribution notices were not included. Install Python 3.9+,
yt-dlp, FFmpeg, and ffprobe locally; install.command checks them before registration.
Existing local binary search remains available to developers, but the installed
launcher explicitly uses external tools rather than stale bundled binaries.
