#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
for js in extension/*.js; do node --check "$js"; done
for command in install.command uninstall.command scripts/*.command; do bash -n "$command"; done
python3 -m py_compile native/*.py scripts/*.py
node --test test/background.test.js test/content_navigation.test.js test/page_navigation.test.js
python3 -m unittest discover -s test -p 'test_*.py'
python3 scripts/build_release.py
python3 scripts/check_release.py
