#!/usr/bin/env bash
set -euo pipefail

HOST_NAME="com.darren.videohelper"
MANIFEST_PATH="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/$HOST_NAME.json"

echo "Darren Video Helper uninstall"
echo

if [[ -f "$MANIFEST_PATH" ]]; then
  rm -f "$MANIFEST_PATH"
  echo "Removed Native Messaging Host:"
  echo "$MANIFEST_PATH"
else
  echo "Native Messaging Host was not registered."
fi

echo
echo "You can remove the Chrome extension from chrome://extensions/."
read -r -p "Press Enter to close..."
