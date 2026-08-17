import json
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class MacOSReleasePolicyTests(unittest.TestCase):
    def test_installer_registers_source_launcher_and_does_not_swallow_self_test(self):
        installer = (ROOT / "install.command").read_text(encoding="utf-8")
        self.assertIn('HOST_PATH="$NATIVE_INSTALL_DIR/host-source"', installer)
        self.assertIn('exec /usr/bin/python3 "$NATIVE_ROOT/host.py"', installer)
        self.assertNotRegex(installer, re.compile(r"--self-test[^\n]*\|\|\s*true"))
        self.assertIn("Expected Homebrew yt-dlp", installer)
        self.assertIn("yt-dlp.disabled-", installer)

    def test_macos_package_excludes_pyinstaller_host_and_bundled_ytdlp(self):
        builder = (ROOT / "build-macos-package.command").read_text(encoding="utf-8")
        self.assertIn('native/host.py', builder)
        self.assertIn('native/bin/yt-dlp', builder)
        self.assertIn("Refusing to package a PyInstaller macOS host", builder)
        self.assertNotIn("PyInstaller --clean", builder)
        self.assertIn('PACKAGE_BASENAME="DarrenVideoHelper-macOS-v$VERSION_NAME"', builder)
        self.assertIn("scripts/sync-dev-install.command", builder)

    def test_visible_development_install_syncs_extension_and_native_files(self):
        sync = (ROOT / "scripts" / "sync-dev-install.command").read_text(encoding="utf-8")
        self.assertIn("Downloads/DarrenVideoHelper-beta3", sync)
        self.assertIn('rsync -a --delete "$PROJECT_ROOT/extension/"', sync)
        self.assertIn('native/host.py', sync)
        self.assertIn('DarrenVideoHelper-macOS-v1.2.0-beta.3.zip', sync)

    def test_beta3_versions_match(self):
        manifest = json.loads((ROOT / "extension" / "manifest.json").read_text(encoding="utf-8"))
        host = (ROOT / "native" / "host.py").read_text(encoding="utf-8")
        self.assertEqual(manifest["version_name"], "1.2.0-beta.3")
        self.assertIn('HOST_VERSION = "1.2.0-beta.3"', host)


if __name__ == "__main__":
    unittest.main()
