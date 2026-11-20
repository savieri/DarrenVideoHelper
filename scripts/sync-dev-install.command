#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
python3 "$ROOT/scripts/build_release.py"
echo 'Load extension/ from this checkout to test Full mode; extract the Chrome ZIP for standalone mode.'
