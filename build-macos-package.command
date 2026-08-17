#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd)"
TOOLS_DIR="${DARREN_MACOS_TOOLS_DIR:-$PROJECT_ROOT/native/bin}"
OUTPUT_DIR="${DARREN_BUILD_OUTPUT_DIR:-$PROJECT_ROOT/dist}"
VERSION_NAME="$(cd "$PROJECT_ROOT" && /usr/bin/python3 -c 'import json, pathlib; print(json.loads(pathlib.Path("extension/manifest.json").read_text())["version_name"])')"
PACKAGE_BASENAME="DarrenVideoHelper-macOS-$VERSION_NAME"
TEMP_PARENT="$(mktemp -d)"
STAGE_DIR="$TEMP_PARENT/$PACKAGE_BASENAME"
ARCHIVE_PATH="$OUTPUT_DIR/$PACKAGE_BASENAME.zip"

cleanup() {
  case "$TEMP_PARENT" in
    /private/var/folders/*/T/tmp.*|/var/folders/*/T/tmp.*|/tmp/tmp.*)
      rm -rf "$TEMP_PARENT"
      ;;
    *)
      echo "Refusing to remove unexpected temporary path: $TEMP_PARENT" >&2
      ;;
  esac
}
trap cleanup EXIT

cd "$PROJECT_ROOT"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "The macOS package must be built on macOS." >&2
  exit 1
fi

if [[ "$VERSION_NAME" != "1.2.0-beta.3" ]]; then
  echo "Refusing to build unexpected version: $VERSION_NAME" >&2
  exit 1
fi

for tool in ffmpeg ffprobe; do
  if [[ ! -x "$TOOLS_DIR/$tool" ]]; then
    echo "Missing executable $tool in $TOOLS_DIR" >&2
    echo "Set DARREN_MACOS_TOOLS_DIR to the directory containing the bundled macOS tools." >&2
    exit 1
  fi
done

mkdir -p "$STAGE_DIR/native/bin" "$OUTPUT_DIR"
cp -R "$PROJECT_ROOT/extension" "$STAGE_DIR/extension"
install -m 0644 "$PROJECT_ROOT/native/host.py" "$STAGE_DIR/native/host.py"
install -m 0755 "$TOOLS_DIR/ffmpeg" "$STAGE_DIR/native/bin/ffmpeg"
install -m 0755 "$TOOLS_DIR/ffprobe" "$STAGE_DIR/native/bin/ffprobe"

for file in install.command uninstall.command README.md VALIDATION.md LICENSE; do
  cp "$PROJECT_ROOT/$file" "$STAGE_DIR/$file"
done
chmod 0755 "$STAGE_DIR/install.command" "$STAGE_DIR/uninstall.command"

if [[ -e "$STAGE_DIR/native/host" || -e "$STAGE_DIR/native/bin/yt-dlp" ]]; then
  echo "Refusing to package a PyInstaller macOS host or bundled yt-dlp." >&2
  exit 1
fi

/usr/bin/xattr -cr "$STAGE_DIR"

echo "Running staged source-host self-test..."
SELF_TEST_OUTPUT="$(PATH="$STAGE_DIR/native/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" /usr/bin/python3 "$STAGE_DIR/native/host.py" --self-test)"
printf '%s\n' "$SELF_TEST_OUTPUT"
printf '%s' "$SELF_TEST_OUTPUT" | /usr/bin/python3 -c '
import json
import pathlib
import sys

data = json.load(sys.stdin)
if data.get("ok") is not True or data.get("version") != "1.2.0-beta.3":
    raise SystemExit("Staged native-host self-test failed or reported the wrong version")
native_root = pathlib.Path(sys.argv[1]).resolve()
for tool in ("ffmpeg", "ffprobe"):
    if pathlib.Path(data.get(tool, "")).resolve() != native_root / "bin" / tool:
        raise SystemExit(f"Staged {tool} did not resolve from the package")
' "$STAGE_DIR/native"

rm -f "$ARCHIVE_PATH"
(cd "$TEMP_PARENT" && /usr/bin/zip -X -q -r "$ARCHIVE_PATH" "$PACKAGE_BASENAME")

echo "Built: $ARCHIVE_PATH"
