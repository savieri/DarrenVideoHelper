#!/usr/bin/env python3
"""Build both editions from this checkout, without third-party binary redistribution."""
import hashlib
import json
import subprocess
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'dist'

def entries():
    for folder in ('extension', 'native', 'scripts', 'docs', 'test'):
        for p in sorted((ROOT / folder).rglob('*')):
            if p.is_file() and '__pycache__' not in p.parts and p.suffix != '.pyc':
                if folder == 'native' and p.relative_to(ROOT/'native').as_posix() not in {'host.py','hls_engine.py','requirements.txt','bin/README.md'}:
                    raise RuntimeError('Unreviewed native runtime file: ' + str(p))
                yield p.relative_to(ROOT).as_posix(), p.read_bytes()
    for name in ('install.command', 'uninstall.command', 'README-FIRST.md', 'README.md', 'README.zh-CN.md',
                 'CHANGELOG.md', 'LICENSE', 'VALIDATION.md', 'THIRD_PARTY_NOTICES.md', 'package.json'):
        yield name, (ROOT / name).read_bytes()

def write_zip(path, files):
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, data in files:
            info = zipfile.ZipInfo(name, (2026, 11, 20, 0, 0, 0))
            executable = name.endswith('.command')
            info.external_attr = (0o100755 if executable else 0o100644) << 16
            info.create_system = 3
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, data)

def main():
    OUT.mkdir(exist_ok=True)
    files = list(entries())
    manifest = json.loads((ROOT / 'extension/manifest.json').read_text())
    manifest['permissions'] = [p for p in manifest['permissions'] if p != 'nativeMessaging']
    extension = [(name.removeprefix('extension/'), data) for name,data in files if name.startswith('extension/')]
    extension = [(name, (json.dumps(manifest, indent=2)+'\n').encode() if name == 'manifest.json' else data) for name,data in extension]
    extension += [('LICENSE', (ROOT/'LICENSE').read_bytes()), ('INSTALL.md', (ROOT/'docs/INSTALL.md').read_bytes())]
    write_zip(OUT/'DarrenVideoHelper-Chrome-Extension.zip', extension)
    write_zip(OUT/'DarrenVideoHelper-macOS-Full.zip', files)
    sums = ''.join(hashlib.sha256(p.read_bytes()).hexdigest()+'  '+p.name+'\n' for p in sorted(OUT.glob('DarrenVideoHelper-*.zip')))
    (OUT/'SHA256SUMS.txt').write_text(sums)
    print(sums, end='')

if __name__ == '__main__':
    main()
