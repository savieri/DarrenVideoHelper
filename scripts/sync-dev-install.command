#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEV_INSTALL_ROOT="${DARREN_DEV_INSTALL_DIR:-$HOME/Downloads/DarrenVideoHelper-beta3}"
INSTALLED_NATIVE_BIN="$HOME/Library/Application Support/DarrenVideoHelper/native/bin"
TOOLS_DIR="${DARREN_MACOS_TOOLS_DIR:-$PROJECT_ROOT/native/bin}"
BUILD_PACKAGE=0
INSTALL_NATIVE=0

for argument in "$@"; do
  case "$argument" in
    --package) BUILD_PACKAGE=1 ;;
    --install-native) INSTALL_NATIVE=1 ;;
    *)
      echo "Unknown option: $argument" >&2
      exit 2
      ;;
  esac
done

case "$DEV_INSTALL_ROOT" in
  ""|"/"|"$HOME"|"$HOME/Downloads")
    echo "Refusing unsafe development install path: $DEV_INSTALL_ROOT" >&2
    exit 1
    ;;
esac

if [[ ! -x "$TOOLS_DIR/ffmpeg" || ! -x "$TOOLS_DIR/ffprobe" ]]; then
  if [[ -x "$INSTALLED_NATIVE_BIN/ffmpeg" && -x "$INSTALLED_NATIVE_BIN/ffprobe" ]]; then
    TOOLS_DIR="$INSTALLED_NATIVE_BIN"
  else
    echo "Missing ffmpeg/ffprobe. Set DARREN_MACOS_TOOLS_DIR to the packaged tools directory." >&2
    exit 1
  fi
fi

mkdir -p "$DEV_INSTALL_ROOT/extension" "$DEV_INSTALL_ROOT/native/bin" "$DEV_INSTALL_ROOT/scripts"
/usr/bin/rsync -a --delete "$PROJECT_ROOT/extension/" "$DEV_INSTALL_ROOT/extension/"
install -m 0644 "$PROJECT_ROOT/native/host.py" "$DEV_INSTALL_ROOT/native/host.py"
install -m 0755 "$TOOLS_DIR/ffmpeg" "$DEV_INSTALL_ROOT/native/bin/ffmpeg"
install -m 0755 "$TOOLS_DIR/ffprobe" "$DEV_INSTALL_ROOT/native/bin/ffprobe"

for file in install.command uninstall.command README-FIRST.md README.md CHANGELOG.md VALIDATION.md LICENSE; do
  install -m 0644 "$PROJECT_ROOT/$file" "$DEV_INSTALL_ROOT/$file"
done
chmod 0755 "$DEV_INSTALL_ROOT/install.command" "$DEV_INSTALL_ROOT/uninstall.command"
install -m 0755 "$PROJECT_ROOT/scripts/sync-dev-install.command" "$DEV_INSTALL_ROOT/scripts/sync-dev-install.command"

if [[ "$INSTALL_NATIVE" -eq 1 ]]; then
  "$DEV_INSTALL_ROOT/install.command" --no-open --non-interactive
fi

if [[ "$BUILD_PACKAGE" -eq 1 ]]; then
  DARREN_MACOS_TOOLS_DIR="$TOOLS_DIR" \
    DARREN_BUILD_OUTPUT_DIR="$DEV_INSTALL_ROOT" \
    "$PROJECT_ROOT/build-macos-package.command"
  cp -f \
    "$DEV_INSTALL_ROOT/DarrenVideoHelper-macOS-v1.2.0-beta.3.zip" \
    "$HOME/Downloads/DarrenVideoHelper-macOS-v1.2.0-beta.3.zip"
fi

echo
echo "Development extension synced to:"
echo "$DEV_INSTALL_ROOT/extension"
if [[ "$BUILD_PACKAGE" -eq 1 ]]; then
  echo "Installer package copied to:"
  echo "$HOME/Downloads/DarrenVideoHelper-macOS-v1.2.0-beta.3.zip"
fi
