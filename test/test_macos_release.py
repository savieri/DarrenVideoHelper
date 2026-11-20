import base64
import hashlib
import json
import unittest
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]

class MacOSReleaseTests(unittest.TestCase):
    def test_versions_and_stable_public_key_id(self):
        m=json.loads((ROOT/'extension/manifest.json').read_text())
        digest=hashlib.sha256(base64.b64decode(m['key'])).hexdigest()[:32]
        extension_id=''.join(chr(97+int(c,16)) for c in digest)
        self.assertEqual(extension_id,'mabnjnddplpelefjgohbjcoajnimpgna')
        self.assertIn(extension_id,(ROOT/'install.command').read_text())
        self.assertIn('HOST_VERSION = "'+m['version_name']+'"',(ROOT/'native/host.py').read_text())
    def test_release_has_no_unreviewed_native_runtime(self):
        files={p.relative_to(ROOT/'native').as_posix() for p in (ROOT/'native').rglob('*') if p.is_file() and '__pycache__' not in p.parts}
        self.assertEqual(files,{'host.py','hls_engine.py','requirements.txt','bin/README.md'})
    def test_documentation_distinguishes_external_dependencies_and_modes(self):
        for name in ['README.md','README.zh-CN.md']:
            s=(ROOT/name).read_text()
            for item in ['manifest.json','chrome://extensions','Python','yt-dlp','FFmpeg','WebM','HLS','VALIDATION.md']:
                self.assertIn(item,s)
    def test_installer_does_not_remove_quarantine_or_install_dependencies_silently(self):
        s=(ROOT/'install.command').read_text()
        self.assertNotIn('xattr -',s)
        self.assertNotIn('sudo ',s)
        self.assertNotIn('curl ',s)
        self.assertIn('--check',s)
        self.assertIn('VIDEO_HELPER_EXTERNAL_TOOLS=1',s)
        self.assertNotIn('--self-test || true',s)

if __name__=='__main__': unittest.main()
