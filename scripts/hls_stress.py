#!/usr/bin/env python3
"""Opt-in >2 GiB transfer stress using generated video + valid MPEG-TS null padding."""
import json
import math
import resource
import shutil
import sys
import tempfile
import time
from pathlib import Path
from urllib.request import build_opener,ProxyHandler
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'test'));sys.path.insert(0,str(ROOT/'native'))
from test_hls_engine import generate,Fixture
from hls_engine import Engine,SafeRedirect

def main():
    start=time.monotonic();count=2482;seconds=count*3
    with tempfile.TemporaryDirectory(prefix='dvh-stress-generated-') as directory:
        root=Path(directory);media=root/'media'
        print('Generating 7446 seconds / 2482 real HLS segments.',flush=True)
        generate(media,seconds=seconds,segment_seconds=3)
        segments=sorted(media.glob('*.ts'));assert len(segments)==count
        per_segment=math.ceil((2.2*1024**3/count)/188)*188
        null_packet=bytes([0x47,0x1f,0xff,0x10])+b'\xff'*184
        for p in segments:
            padding=math.ceil(max(0,per_segment-p.stat().st_size)/188)
            with p.open('ab') as f:f.write(null_packet*padding)
        source_bytes=sum(p.stat().st_size for p in segments)
        print(json.dumps({'sourceBytes':source_bytes,'segments':len(segments)}),flush=True)
        fixture=Fixture(media);fixture.faults['seg000828.ts']=[503,503]
        progress={'last':-1}
        def notify(**event):
            n=event.get('fragmentsDone',0)
            if n//250!=progress['last']:
                progress['last']=n//250;print(json.dumps({'stage':event['stage'],'fragmentsDone':n}),flush=True)
        engine=Engine({'jobId':'stress:generated','url':fixture.url+'/index.m3u8','pageUrl':fixture.url+'/watch?id=generated',
          'sourceTitle':'Generated long-video stress','selectedHeight':90,'settings':{'networkRetries':3,'retryBase':0.05}},
          root/'output',shutil.which,notify)
        engine.opener=build_opener(ProxyHandler({}),SafeRedirect())
        try:
            output,probe=engine.execute()
            assert probe['integrityVerified'] and probe['hasAudio'] and probe['fragmentsDone']==count
            assert source_bytes>2*1024**3 and abs(probe['duration']-seconds)<3
            assert fixture.calls['seg000828.ts']==3
            rss=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
            if sys.platform!='darwin':rss*=1024
            print(json.dumps({'ok':True,'generatedMedia':True,'mpegTsNullPadding':True,'sourceBytes':source_bytes,
              'receivedBytes':engine.transferred,'fragments':count,'durationSeconds':probe['duration'],
              'outputBytes':output.stat().st_size,'hasAudio':probe['hasAudio'],'fragment828Requests':fixture.calls['seg000828.ts'],
              'pythonPeakRssBytes':rss,'elapsedSeconds':round(time.monotonic()-start,2),
              'remainingWorkFiles':[p.name for p in engine.root.iterdir()]},indent=2),flush=True)
        finally:fixture.close()

if __name__=='__main__':main()
