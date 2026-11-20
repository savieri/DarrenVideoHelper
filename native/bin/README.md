No third-party executables are distributed in this directory.

The two arm64 Homebrew FFmpeg executables in the beta.15 input have absolute
Homebrew dylib dependencies and are not portable runtimes. Their exact build
source and redistribution notices were not included. Install Python 3.11+, FFmpeg, and ffprobe locally; the installer provisions hash-pinned yt-dlp 2026.10.26 in a private venv; install.command checks them before registration.
Existing local binary search remains available to developers, but the installed
launcher explicitly uses external tools rather than stale bundled binaries.
