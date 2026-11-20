#!/usr/bin/env python3
"""Optional real native smoke: needs ffmpeg, ffprobe, yt-dlp. No third-party media."""
import functools
import http.server
import json
import os
import queue
import struct
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]

def main():
    with tempfile.TemporaryDirectory(prefix='dvh-native-smoke-') as directory:
        root=Path(directory); media=root/'media';media.mkdir()
        subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i','testsrc2=size=640x360:rate=24',
            '-f','lavfi','-i','sine=frequency=440:sample_rate=44100','-t','4','-c:v','libx264',
            '-preset','veryfast','-b:v','600k','-c:a','aac','-g','24','-f','hls','-hls_time','1',
            '-hls_list_size','0',str(media/'index.m3u8')],check=True,timeout=30)
        class Handler(http.server.SimpleHTTPRequestHandler):
            def log_message(self,*args): pass
        server=http.server.ThreadingHTTPServer(('127.0.0.1',0),functools.partial(Handler,directory=str(media)))
        threading.Thread(target=server.serve_forever,daemon=True).start()
        env={**{k:v for k,v in os.environ.items() if k.lower() not in ('http_proxy','https_proxy','all_proxy')},
             'NO_PROXY':'127.0.0.1,localhost','no_proxy':'127.0.0.1,localhost','VIDEO_HELPER_STATE_DIR':str(root/'state'),'VIDEO_HELPER_LOG_PATH':str(root/'host.log'),
             'VIDEO_HELPER_EXTERNAL_TOOLS':'1'}
        with (root/'stderr.log').open('w') as err:
            process=subprocess.Popen([sys.executable,str(ROOT/'native/host.py')],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=err,env=env)
            messages=queue.Queue()
            def reader():
                try:
                    while True:
                        header=process.stdout.read(4)
                        if not header: break
                        size=struct.unpack('<I',header)[0]
                        messages.put(json.loads(process.stdout.read(size)))
                finally: messages.put(None)
            threading.Thread(target=reader,daemon=True).start()
            def send(value):
                b=json.dumps(value).encode();process.stdin.write(struct.pack('<I',len(b))+b);process.stdin.flush()
            try:
                for i in range(2):
                    send({'action':'ping','jobId':f'ping-{i}'})
                    result=messages.get(timeout=15)
                    assert result['type']=='pong' and result['jobId']==f'ping-{i}',result
                url=f'http://127.0.0.1:{server.server_port}/index.m3u8'
                send({'action':'download','jobId':'smoke-hls','attemptId':'smoke-attempt','url':url,'resourceUrl':url,
                    'kind':'hls_media','pageUrl':url,'sourceTitle':'Native smoke current video','exactSelection':True,
                    'expectedDuration':4,'expectedHeight':360,'enforceDuration':True,
                    'settings':{'outputDir':str(root/'output'),'autoCookies':False,'defaultQuality':'best'}})
                events=[]
                for _ in range(100):
                    result=messages.get(timeout=45)
                    assert result is not None,'Native host exited'
                    events.append(result['type'])
                    if result['type'] in ('error','failed','incomplete'): raise AssertionError(result)
                    if result['type']=='complete':
                        output=Path(result['outputPath']);assert output.is_file()
                        assert result['hasAudio'] and result['duration']>=3.9,result
                        assert output.name.startswith('Native smoke current video'),output.name
                        print(json.dumps({'ok':True,'framedPings':2,'hlsDownload':True,'duration':result['duration'],
                            'hasAudio':result['hasAudio'],'fileSize':output.stat().st_size,'events':events}))
                        break
                else: raise AssertionError('No terminal completion')
            finally:
                process.stdin.close()
                try: process.wait(timeout=10)
                except subprocess.TimeoutExpired: process.kill();process.wait()
                server.shutdown()

if __name__=='__main__': main()
