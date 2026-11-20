#!/usr/bin/env python3
"""End-to-end native protocol smoke against generated local media. Needs pinned yt-dlp + FFmpeg."""
import hashlib
import json
import os
import queue
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'test'));from test_hls_engine import Fixture,generate

class Client:
    def __init__(self,env,log):
        self.log=log.open('wb')
        self.process=subprocess.Popen([sys.executable,str(ROOT/'native/host.py')],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=self.log,env=env)
        self.messages=queue.Queue()
        def read():
            try:
                while True:
                    header=self.process.stdout.read(4)
                    if not header:break
                    length=struct.unpack('<I',header)[0];self.messages.put(json.loads(self.process.stdout.read(length)))
            finally:self.messages.put(None)
        threading.Thread(target=read,daemon=True).start()
    def send(self,value):
        data=json.dumps(value).encode();self.process.stdin.write(struct.pack('<I',len(data))+data);self.process.stdin.flush()
    def terminal(self):
        events=[]
        for _ in range(2000):
            message=self.messages.get(timeout=45)
            if message is None:raise AssertionError('Native process exited before a terminal response')
            events.append(message.get('type'))
            if message.get('type') in ('complete','failed','error','attention','incomplete','cancelled','job_busy','job_status','pong','cancel_ack'):
                return message,events
        raise AssertionError('No terminal event')
    def close(self):
        if self.process.poll() is None:
            try:self.process.stdin.close();self.process.wait(timeout=5)
            except (BrokenPipeError,subprocess.TimeoutExpired):self.process.kill();self.process.wait()
        self.log.close()

def main():
    with tempfile.TemporaryDirectory(prefix='dvh-protocol-smoke-') as directory:
        root=Path(directory);media=root/'media';generate(media/'hls')
        subprocess.run(['ffmpeg','-v','error','-y','-i',str(media/'hls/index.m3u8'),'-c','copy',str(media/'direct.mp4')],check=True,timeout=20)
        subprocess.run(['ffmpeg','-v','error','-y','-i',str(media/'direct.mp4'),'-c:v','libvpx-vp9','-deadline','realtime','-cpu-used','8','-c:a','libopus',str(media/'direct.webm')],check=True,timeout=20)
        fixture=Fixture(media);out=root/'output';summary={}
        env={**{k:v for k,v in os.environ.items() if k.lower() not in ('http_proxy','https_proxy','all_proxy')},
             'NO_PROXY':'127.0.0.1,localhost','no_proxy':'127.0.0.1,localhost',
             'VIDEO_HELPER_STATE_DIR':str(root/'state'),'VIDEO_HELPER_LOG_PATH':str(root/'native.log'),'VIDEO_HELPER_EXTERNAL_TOOLS':'1'}
        if not env.get('VIDEO_HELPER_YTDLP_PATH'):raise RuntimeError('Set VIDEO_HELPER_YTDLP_PATH to the pinned 2026.10.26 runtime')
        def payload(job,kind='hls_media',name='Native HLS current',suffix='/hls/index.m3u8'):
            return {'action':'download','jobId':job,'attemptId':job+'-attempt','kind':kind,'url':fixture.url+suffix,'resourceUrl':fixture.url+suffix,
                    'pageUrl':fixture.url+'/watch?id=generated','sourceTitle':name,'exactSelection':True,'selectedHeight':90,'expectedHeight':90,
                    'expectedDuration':6,'enforceDuration':True,'settings':{'outputDir':str(out),'autoCookies':False,'networkRetries':2,'networkTimeout':2,'retryBase':0.05}}
        def execute(data):
            client=Client(env,root/(data['jobId'].replace(':','-')+'.log'))
            try:
                client.send(data);result,events=client.terminal()
                assert result['type']=='complete',result
                assert result['hasAudio'] and result['integrityVerified'],result
                assert Path(result['outputPath']).is_file(),result
                return result,events
            finally:client.close()
        try:
            client=Client(env,root/'pings.log')
            try:
                for i in range(2):
                    client.send({'action':'ping','jobId':f'ping-{i}'});result,_=client.terminal();assert result['type']=='pong'
                summary['framedPings']=2
            finally:client.close()
            for kind,suffix,name in [('mp4','/direct.mp4','Native MP4'),('webm','/direct.webm','Native WebM')]:
                result,_=execute(payload('job:'+kind,kind,name,suffix))
                summary[kind]={'completed':True,'duration':result['duration'],'hasAudio':result['hasAudio']}
            # Same resource / same job is idempotent even across fresh native processes.
            result,_=execute(payload('job:hls'));before=sum(fixture.calls.values());again,_=execute(payload('job:hls'))
            assert result['outputPath']==again['outputPath'] and sum(fixture.calls.values())==before
            summary['hls']={'completed':True,'idempotentReplay':True,'fragments':result['fragmentsTotal']}
            # Kill a real host while its fifth segment is being served. Kernel releases the job lock.
            fixture.faults['hls/seg000005.ts']=lambda handler:(time.sleep(0.5) or None)
            data=payload('job:crash','hls_media','Native recovered');client=Client(env,root/'crash.log');client.send(data)
            key='hls/seg000005.ts';baseline=fixture.calls[key]
            deadline=time.monotonic()+10
            while fixture.calls[key]<=baseline and time.monotonic()<deadline:time.sleep(0.01)
            assert fixture.calls[key]>baseline
            client.process.kill();client.process.wait();client.close();fixture.faults.clear()
            status_client=Client(env,root/'crash-status.log')
            try:
                status_client.send({'action':'status','jobId':'job:crash'});status,_=status_client.terminal()
                assert status['state']['canResume'] and status['state']['fragmentsDone']>=4,status
            finally:status_client.close()
            before=fixture.calls['hls/seg000002.ts'];result,_=execute(data)
            assert fixture.calls['hls/seg000002.ts']==before,'A verified nonsampled segment was downloaded again'
            summary['killedHostResume']={'completed':True,'verifiedFragmentsBeforeResume':status['state']['fragmentsDone'],'reusedNonsampledBytes':True}
            # Two writers with the same title get isolated data and atomic, nonclobbering names.
            with ThreadPoolExecutor(max_workers=2) as pool:
                results=list(pool.map(execute,[payload('job:parallel1',name='Parallel'),payload('job:parallel2',name='Parallel')]))
            paths=[r[0]['outputPath'] for r in results];assert len(set(paths))==2
            summary['parallelIsolation']=True
            # A second native dispatch for an in-flight Job ID returns busy, then cancellation keeps data.
            fixture.faults['hls/seg000005.ts']=lambda handler:(time.sleep(0.5) or None)
            key='hls/seg000005.ts';baseline=fixture.calls[key];data=payload('job:busy',name='Busy')
            first=Client(env,root/'busy-one.log');first.send(data)
            deadline=time.monotonic()+10
            while fixture.calls[key]<=baseline and time.monotonic()<deadline:time.sleep(0.01)
            second=Client(env,root/'busy-two.log')
            try:
                second.send(data);busy,_=second.terminal();assert busy['type']=='job_busy',busy
                second.send({'action':'cancel','jobId':'job:busy','keepData':True});ack,_=second.terminal();assert ack['type']=='cancel_ack'
                result,_=first.terminal();assert result['type']=='cancelled' and result['canResume'],result
            finally:first.close();second.close();fixture.faults.clear()
            summary['duplicateDispatchBlocked']=True;summary['cancelPreservesVerifiedData']=True
            leftovers=[p for p in out.glob('*.mp4') if not p.is_file()]
            assert not leftovers
            summary['ok']=True
            print(json.dumps(summary,indent=2))
        finally:fixture.close()

if __name__=='__main__':main()
