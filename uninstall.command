#!/bin/bash
set -euo pipefail
HOST_NAME=com.darren.videohelper
MANIFEST_DIR="${DARREN_CHROME_MANIFEST_DIR:-$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts}"
rm -f "$MANIFEST_DIR/$HOST_NAME.json"
echo 'Native Host registration removed. Downloads and installed source were preserved.'
echo 'Remove the extension in chrome://extensions if desired.'
if [[ -t 0 && "${1:-}" != --non-interactive ]]; then read -r -p 'Press Enter to close...' || true; fi
