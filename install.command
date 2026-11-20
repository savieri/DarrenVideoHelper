#!/bin/bash
set -euo pipefail
PACKAGE_ROOT="$(cd "$(dirname "$0")" && pwd)"
HOST_NAME="com.darren.videohelper"
INSTALL_ROOT="${DARREN_INSTALL_ROOT:-$HOME/Library/Application Support/DarrenVideoHelper}"
MANIFEST_DIR="${DARREN_CHROME_MANIFEST_DIR:-$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts}"
NATIVE_INSTALL_DIR="$INSTALL_ROOT/native"
HOST_PATH="$NATIVE_INSTALL_DIR/host-source"
EXTENSION_DIR="$PACKAGE_ROOT/extension"
NO_OPEN=0; NON_INTERACTIVE=0; CHECK_ONLY=0
finish() {
  result=$?
  if [[ "$result" -ne 0 ]]; then echo "Installation failed. See docs/INSTALL.md for help. No download was started." >&2; fi
  if [[ "$NON_INTERACTIVE" -eq 0 && -t 0 ]]; then read -r -p "Press Enter to close..." || true; fi
}
trap finish EXIT
for arg in "$@"; do
  case "$arg" in
    --no-open) NO_OPEN=1;;
    --non-interactive) NON_INTERACTIVE=1;;
    --check) CHECK_ONLY=1;;
    *) echo "Unknown option: $arg" >&2; exit 2;;
  esac
done
[[ "$(uname -s)" == Darwin ]] || { echo 'macOS only. Windows/Linux Full is unsupported.' >&2; exit 1; }
echo 'DarrenVideoHelper Full v1.2.1-beta.17 — dependency check'
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
PYTHON="$(command -v python3 || true)"
[[ -n "$PYTHON" ]] && "$PYTHON" -c 'import sys; assert sys.version_info >= (3,11)' || {
 echo 'Python 3.11+ is required. Install dependencies: brew install python ffmpeg' >&2; exit 1;
}
"$PYTHON" - "$INSTALL_ROOT" "$MANIFEST_DIR" <<'PYTHON'
import pathlib,sys
for raw in sys.argv[1:]:
 p=pathlib.Path(raw).expanduser().absolute()
 if p in (pathlib.Path('/'),pathlib.Path.home()):raise SystemExit('Unsafe installation directory')
 for parent in (p,*p.parents):
  if parent.is_symlink() and str(parent) not in ('/var','/tmp'):raise SystemExit('Installation directories cannot contain symlinks')
PYTHON
for tool in ffmpeg ffprobe; do
  command -v "$tool" >/dev/null || { echo "Missing $tool. Install dependencies: brew install python ffmpeg" >&2; exit 1; }
done
export VIDEO_HELPER_EXTERNAL_TOOLS=1
RUNTIME_DIR="$INSTALL_ROOT/runtime"
if [[ "$CHECK_ONLY" -eq 0 ]]; then
  echo 'Installing the project-local, hash-verified yt-dlp 2026.10.26 runtime (Internet required).'
  "$PYTHON" -m venv "$RUNTIME_DIR"
  "$RUNTIME_DIR/bin/python3" -m pip --isolated install --disable-pip-version-check --require-hashes -r "$PACKAGE_ROOT/native/requirements.txt"
fi
export VIDEO_HELPER_YTDLP_PATH="${VIDEO_HELPER_YTDLP_PATH:-$RUNTIME_DIR/bin/yt-dlp}"
[[ -x "$VIDEO_HELPER_YTDLP_PATH" ]] || { echo 'Pinned runtime missing. Run install.command once without --check.' >&2; exit 1; }
[[ "$("$VIDEO_HELPER_YTDLP_PATH" --version)" == 2026.10.26 ]] || { echo 'Expected yt-dlp 2026.10.26.' >&2; exit 1; }
"$PYTHON" "$PACKAGE_ROOT/native/host.py" --self-test
EXTENSION_ID="$("$PYTHON" - "$PACKAGE_ROOT/extension/manifest.json" <<'PY'
import base64,hashlib,json,sys
m=json.load(open(sys.argv[1])); h=hashlib.sha256(base64.b64decode(m['key'])).hexdigest()[:32]
print(''.join(chr(97+int(c,16)) for c in h))
PY
)"
[[ "$EXTENSION_ID" == mabnjnddplpelefjgohbjcoajnimpgna ]] || { echo 'Unexpected extension ID.' >&2; exit 1; }
[[ "$CHECK_ONLY" -eq 0 ]] || { echo 'Dependency and extension-ID checks passed; nothing installed.'; exit 0; }
mkdir -p "$NATIVE_INSTALL_DIR" "$MANIFEST_DIR"
chmod 700 "$INSTALL_ROOT" "$NATIVE_INSTALL_DIR"
for source in host.py hls_engine.py requirements.txt; do
 install -m 0644 "$PACKAGE_ROOT/native/$source" "$NATIVE_INSTALL_DIR/$source"
done
# Quote the interpreter path safely; never interpolate it into Python code.
{ printf '#!/bin/bash\nset -euo pipefail\nexport PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin\nexport VIDEO_HELPER_EXTERNAL_TOOLS=1\n';
  printf 'NATIVE_ROOT="$(cd "$(dirname "$0")" && pwd)"\nexport VIDEO_HELPER_YTDLP_PATH=%q\nexec %q "$NATIVE_ROOT/host.py" "$@"\n' "$VIDEO_HELPER_YTDLP_PATH" "$PYTHON";
} > "$HOST_PATH.tmp"
chmod 0755 "$HOST_PATH.tmp"; mv "$HOST_PATH.tmp" "$HOST_PATH"
"$HOST_PATH" --self-test
"$PYTHON" - "$MANIFEST_DIR/$HOST_NAME.json" "$HOST_PATH" "$EXTENSION_ID" <<'PY'
import json,os,pathlib,sys
path=pathlib.Path(sys.argv[1]); tmp=path.with_suffix('.tmp')
tmp.write_text(json.dumps({'name':'com.darren.videohelper','description':'DarrenVideoHelper Native Host',
 'path':sys.argv[2],'type':'stdio','allowed_origins':['chrome-extension://'+sys.argv[3]+'/']},indent=2)+'\n')
tmp.chmod(0o600);os.replace(tmp,path)
PY
echo 'Native Host registered; self-test passed.'
echo "Chrome extension directory: $EXTENSION_DIR"
echo 'In chrome://extensions enable Developer mode, Load unpacked, then select extension/.'
echo 'Chrome requires this final manual step for unpacked extensions.'
if [[ "$NO_OPEN" -eq 0 ]]; then
 open -a 'Google Chrome' 'chrome://extensions/' || true
 open "$EXTENSION_DIR" || true
fi
