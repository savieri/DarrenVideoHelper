#!/usr/bin/env python3
import base64
import hashlib
import json
import re
import zipfile
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]

def check_extension(files, native):
    m=json.loads(files['manifest.json'])
    assert m['manifest_version']==3
    assert m['version_name']=='1.2.1-beta.17'
    assert m['version']=='1.2.1.17'
    assert ('nativeMessaging' in m['permissions']) is native
    assert 'downloads' in m['permissions']
    h=hashlib.sha256(base64.b64decode(m['key'])).hexdigest()[:32]
    assert ''.join(chr(97+int(c,16)) for c in h)=='mabnjnddplpelefjgohbjcoajnimpgna'
    references=[m['background']['service_worker'],m['action']['default_popup'],m['options_page']]
    references+=list(m['icons'].values())+list(m['action']['default_icon'].values())
    for cs in m['content_scripts']: references+=cs['js']+cs.get('css',[])
    for name,data in files.items():
        if name.endswith('.html'):
            references+=re.findall(r'(?:src|href)="([^"#]+)"',data.decode())
    for name in references:
        assert name in files, 'Missing reference: '+name
    return m

def main():
    source={p.relative_to(ROOT/'extension').as_posix():p.read_bytes() for p in (ROOT/'extension').rglob('*') if p.is_file()}
    check_extension(source,True)
    for name,native in [('DarrenVideoHelper-Chrome-Extension.zip',False),('DarrenVideoHelper-macOS-Full.zip',True)]:
        with zipfile.ZipFile(ROOT/'dist'/name) as z:
            assert z.testzip() is None
            for entry in z.infolist():
                assert not entry.filename.startswith('/') and '..' not in entry.filename.split('/')
                assert not re.search(r'(?i)(\.DS_Store|__MACOSX|\.pyc$|\.pem$|\.part$|\.log$)',entry.filename)
                assert not entry.filename.endswith(('/ffmpeg','/ffprobe','/yt-dlp'))
            prefix='extension/' if native else ''
            files={n.removeprefix(prefix):z.read(n) for n in z.namelist() if n.startswith(prefix)}
            check_extension(files,native)
            for path,data in source.items():
                if path!='manifest.json': assert files[path]==data,path+' differs from checkout'
            if native:
                for path in ('native/host.py','native/hls_engine.py','native/requirements.txt'):
                    assert z.read(path)==(ROOT/path).read_bytes(),path+' differs from checkout'
                assert z.getinfo('install.command').external_attr>>16 & 0o111
            print(name+': structure, references, ID, source parity, and binary exclusions passed')
    print('All package checks passed')

if __name__=='__main__': main()
