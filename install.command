#!/usr/bin/env bash
set -euo pipefail

EXTENSION_ID="mabnjnddplpelefjgohbjcoajnimpgna"
HOST_NAME="com.darren.videohelper"
PACKAGE_ROOT="$(cd "$(dirname "$0")" && pwd)"
EXTENSION_DIR="$PACKAGE_ROOT/extension"
SOURCE_HOST="$PACKAGE_ROOT/native/host.py"
SOURCE_BIN_DIR="$PACKAGE_ROOT/native/bin"
INSTALL_ROOT="${DARREN_INSTALL_ROOT:-$HOME/Library/Application Support/DarrenVideoHelper}"
NATIVE_INSTALL_DIR="$INSTALL_ROOT/native"
HOST_PATH="$NATIVE_INSTALL_DIR/host-source"
MANIFEST_DIR="${DARREN_CHROME_MANIFEST_DIR:-$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts}"
MANIFEST_PATH="$MANIFEST_DIR/$HOST_NAME.json"
NO_OPEN=0
NON_INTERACTIVE=0

for argument in "$@"; do
  case "$argument" in
    --no-open) NO_OPEN=1 ;;
    --non-interactive) NON_INTERACTIVE=1 ;;
    *)
      echo "Unknown option: $argument" >&2
      exit 2
      ;;
  esac
done

echo "Darren Video Helper"
echo "Universal Web Video Downloader"
echo

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "install.command is only for macOS." >&2
  exit 1
fi

if [[ ! -x /usr/bin/python3 ]]; then
  echo "Missing /usr/bin/python3. Install the Apple Command Line Tools, then run this installer again." >&2
  exit 1
fi

if [[ ! -f "$SOURCE_HOST" ]]; then
  echo "Missing source native host: $SOURCE_HOST" >&2
  echo "This package is incomplete. Re-download the macOS beta package." >&2
  exit 1
fi

for tool in ffmpeg ffprobe; do
  if [[ ! -x "$SOURCE_BIN_DIR/$tool" ]]; then
    echo "Missing bundled $tool: $SOURCE_BIN_DIR/$tool" >&2
    echo "This package is incomplete. Re-download the macOS beta package." >&2
    exit 1
  fi
done

if [[ ! -x /opt/homebrew/bin/yt-dlp && ! -x /usr/local/bin/yt-dlp ]]; then
  echo "Homebrew yt-dlp was not found." >&2
  echo "Install it with: brew install yt-dlp" >&2
  exit 1
fi

mkdir -p "$NATIVE_INSTALL_DIR/bin" "$MANIFEST_DIR"

if [[ -f "$NATIVE_INSTALL_DIR/host.py" ]]; then
  BACKUP_PATH="$NATIVE_INSTALL_DIR/host.py.backup-$(date +%Y%m%d-%H%M%S)"
  cp -p "$NATIVE_INSTALL_DIR/host.py" "$BACKUP_PATH"
  echo "Backed up previous source host: $BACKUP_PATH"
fi

if [[ -e "$NATIVE_INSTALL_DIR/bin/yt-dlp" ]]; then
  LEGACY_YTDLP_BACKUP="$NATIVE_INSTALL_DIR/bin/yt-dlp.disabled-$(date +%Y%m%d-%H%M%S)"
  mv "$NATIVE_INSTALL_DIR/bin/yt-dlp" "$LEGACY_YTDLP_BACKUP"
  echo "Disabled legacy bundled yt-dlp: $LEGACY_YTDLP_BACKUP"
fi

install -m 0644 "$SOURCE_HOST" "$NATIVE_INSTALL_DIR/host.py"
install -m 0755 "$SOURCE_BIN_DIR/ffmpeg" "$NATIVE_INSTALL_DIR/bin/ffmpeg"
install -m 0755 "$SOURCE_BIN_DIR/ffprobe" "$NATIVE_INSTALL_DIR/bin/ffprobe"

HOST_TEMP="$HOST_PATH.tmp"
cat > "$HOST_TEMP" <<'HOST'
#!/bin/bash
set -euo pipefail

NATIVE_ROOT="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="$HOME/Library/Logs/DarrenVideoHelper"
LOG_PATH="$LOG_DIR/native-host.log"

mkdir -p "$LOG_DIR"
export PATH="$NATIVE_ROOT/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
exec /usr/bin/python3 "$NATIVE_ROOT/host.py" "$@" 2>> "$LOG_PATH"
HOST
chmod 0755 "$HOST_TEMP"
mv "$HOST_TEMP" "$HOST_PATH"

if [[ -x /usr/bin/xattr ]]; then
  /usr/bin/xattr -dr com.apple.quarantine "$NATIVE_INSTALL_DIR"
fi

HOST_PATH_JSON=${HOST_PATH//\\/\\\\}
HOST_PATH_JSON=${HOST_PATH_JSON//\"/\\\"}
cat > "$MANIFEST_PATH" <<JSON
{
  "name": "$HOST_NAME",
  "description": "Darren Video Helper Native Host",
  "path": "$HOST_PATH_JSON",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXTENSION_ID/"
  ]
}
JSON

echo "Registered Native Messaging Host:"
echo "$MANIFEST_PATH"
echo
echo "Running mandatory native-host self-test..."
SELF_TEST_OUTPUT="$("$HOST_PATH" --self-test)"
printf '%s\n' "$SELF_TEST_OUTPUT"
printf '%s' "$SELF_TEST_OUTPUT" | /usr/bin/python3 -c '
import json
import pathlib
import sys

data = json.load(sys.stdin)
if data.get("ok") is not True:
    raise SystemExit("Native host self-test did not return ok=true")

yt_dlp = pathlib.Path(data.get("yt-dlp", "")).resolve()
allowed_ytdlp = {
    pathlib.Path("/opt/homebrew/bin/yt-dlp").resolve(),
    pathlib.Path("/usr/local/bin/yt-dlp").resolve(),
}
if yt_dlp not in allowed_ytdlp:
    raise SystemExit(f"Expected Homebrew yt-dlp, got: {yt_dlp}")

native_root = pathlib.Path(sys.argv[1]).resolve()
for tool in ("ffmpeg", "ffprobe"):
    actual = pathlib.Path(data.get(tool, "")).resolve()
    expected = native_root / "bin" / tool
    if actual != expected:
        raise SystemExit(f"Expected bundled {tool} at {expected}, got: {actual}")
' "$NATIVE_INSTALL_DIR"
echo "Native-host self-test passed."
echo

if [[ "$NO_OPEN" -eq 0 ]]; then
  if ! open -a "Google Chrome" "chrome://extensions/" >/dev/null 2>&1; then
    echo "Could not open Chrome automatically. Open chrome://extensions/ manually."
  fi
fi

echo "Chrome extension folder to load:"
echo "$EXTENSION_DIR"
echo
echo "In Chrome:"
echo "1. Enable Developer mode"
echo "2. Click Load unpacked"
echo "3. Select the extension folder above"
echo

if [[ "$NON_INTERACTIVE" -eq 0 && -t 0 ]]; then
  read -r -p "Press Enter to close..."
fi
