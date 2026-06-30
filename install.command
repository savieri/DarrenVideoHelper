#!/usr/bin/env bash
set -euo pipefail

EXTENSION_ID="mabnjnddplpelefjgohbjcoajnimpgna"
HOST_NAME="com.darren.videohelper"
ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXTENSION_DIR="$ROOT_DIR/extension"
HOST_PATH="$ROOT_DIR/native/host"
MANIFEST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
MANIFEST_PATH="$MANIFEST_DIR/$HOST_NAME.json"

echo "Darren Video Helper"
echo "Universal Web Video Downloader"
echo

if [[ ! -x "$HOST_PATH" ]]; then
  echo "Missing native host executable:"
  echo "$HOST_PATH"
  echo
  echo "This package is incomplete. Re-download DarrenVideoHelper-macOS.zip."
  read -r -p "Press Enter to close..."
  exit 1
fi

mkdir -p "$MANIFEST_DIR"

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
"$HOST_PATH" --self-test || true
echo

open -a "Google Chrome" "chrome://extensions/" >/dev/null 2>&1 || open "chrome://extensions/" >/dev/null 2>&1 || true

echo "Chrome extension folder to load:"
echo "$EXTENSION_DIR"
echo
echo "In Chrome:"
echo "1. Enable Developer mode"
echo "2. Click Load unpacked"
echo "3. Select the extension folder above"
echo
read -r -p "Press Enter to close..."
