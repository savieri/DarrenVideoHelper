"""Real HTTP/FFmpeg integration with generated, authorized local media only."""
import collections
import functools
import hashlib
import http.server
import importlib.util
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock
from urllib.parse import urlsplit,parse_qs
from urllib.request import build_opener,ProxyHandler

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'native'))
from hls_engine import Engine,HlsError,Cancelled,parse_playlist,compatible,SafeRedirect,safe_title


def generate(root,seconds=6,segment_type='mpegts',encrypted=False,single=False,audio=True,height=90,segment_seconds=1):
    root.mkdir(exist_ok=True,parents=True)
    command=['ffmpeg','-v','error','-y','-f','lavfi','-i',f'testsrc2=size=160x{height}:rate=4']
    if audio:command+=['-f','lavfi','-i','sine=frequency=440:sample_rate=16000']
    command+=['-t',str(seconds),'-c:v','libx264','-preset','ultrafast','-g',str(4*segment_seconds),'-sc_threshold','0']
    if audio:command+=['-c:a','aac','-b:a','32k']
    command+=['-f','hls','-hls_time',str(segment_seconds),'-hls_list_size','0','-hls_segment_type',segment_type,'-start_number','1']
    if encrypted:
        (root/'key.bin').write_bytes(bytes(range(16)))
        (root/'keyinfo.txt').write_text('key.bin\n'+str(root/'key.bin')+'\n')
        command+=['-hls_key_info_file',str(root/'keyinfo.txt')]
    command+=['-hls_segment_filename',str(root/('stream.ts' if single else 'seg%06d.'+('m4s' if segment_type=='fmp4' else 'ts')))]
    if single:command+=['-hls_flags','single_file']
    command+=[str(root/'index.m3u8')]
    subprocess.run(command,check=True,timeout=45)


class Fixture:
    def __init__(self,root):
        self.root=root;self.faults={};self.retry_after='0';self.calls=collections.Counter();self.requests=[];self.transform=None;self.lock=threading.Lock()
        fixture=self
        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self,*args):pass
            def do_GET(self):
                parsed=urlsplit(self.path);name=parsed.path.lstrip('/')
                with fixture.lock:
                    fixture.calls[name]+=1;fixture.requests.append((name,dict(self.headers),time.monotonic(),parsed.query))
                    faults=fixture.faults.get(name,[])
                    fault=faults.pop(0) if isinstance(faults,list) and faults else faults if not isinstance(faults,list) else None
                if callable(fault):fault=fault(self)
                if isinstance(fault,int):
                    self.send_response(fault);self.send_header('Retry-After',fixture.retry_after);self.send_header('Content-Length','0');self.end_headers();return
                path=(fixture.root/name).resolve()
                if not path.is_relative_to(fixture.root.resolve()) or not path.is_file():
                    self.send_error(404);return
                body=path.read_bytes()
                if name.endswith('.m3u8') and fixture.transform:body=fixture.transform(name,body,self).encode()
                start=0;end=len(body)-1
                if self.headers.get('Range'):
                    match=re.fullmatch(r'bytes=(\d+)-(\d+)',self.headers['Range'])
                    if not match:self.send_error(416);return
                    start,end=map(int,match.groups());body=body[start:end+1];self.send_response(206)
                    self.send_header('Content-Range',f'bytes {start}-{end}/{path.stat().st_size}')
                else:self.send_response(200)
                mime='application/vnd.apple.mpegurl' if name.endswith('.m3u8') else 'application/octet-stream'
                self.send_header('Content-Type',mime);self.send_header('Content-Length',str(len(body)));self.end_headers()
                try:
                    if fault=='disconnect':
                        self.wfile.write(body[:len(body)//2]);self.wfile.flush();self.connection.shutdown(socket.SHUT_RDWR);self.connection.close()
                    else:self.wfile.write(body)
                except (BrokenPipeError,ConnectionResetError):pass
        self.server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler)
        self.server.daemon_threads=True
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
        self.url=f'http://127.0.0.1:{self.server.server_port}'
    def close(self):self.server.shutdown();self.server.server_close();self.thread.join(timeout=2)


@unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'),'FFmpeg integration tools required')
class HlsEngineTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.media=tempfile.TemporaryDirectory(prefix='dvh-authorized-media-');cls.media_root=Path(cls.media.name)
        generate(cls.media_root/'ts');generate(cls.media_root/'fmp4',segment_type='fmp4')
        generate(cls.media_root/'aes',encrypted=True);generate(cls.media_root/'range',single=True)
        # 1000 real seconds / 1000 valid, independent HLS segments; low bitrate keeps regression fast.
        generate(cls.media_root/'long',seconds=1000)
        generate(cls.media_root/'split/video',audio=False)
        subprocess.run(['ffmpeg','-v','error','-y','-f','lavfi','-i','sine=frequency=880:sample_rate=16000','-t','6',
                        '-c:a','aac','-b:a','32k','-f','hls','-hls_segment_type','fmp4','-hls_time','1','-hls_list_size','0',
                        str(cls.media_root/'split/audio.m3u8')],check=True,timeout=20)
        (cls.media_root/'split/index.m3u8').write_text('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",DEFAULT=YES,URI="audio.m3u8"\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",DEFAULT=NO,URI="unused-audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=160000,RESOLUTION=160x90,AUDIO="a"\nvideo/index.m3u8\n')
    @classmethod
    def tearDownClass(cls):cls.media.cleanup()
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix='dvh-hls-test-');self.addCleanup(self.tmp.cleanup)
        self.fixture=Fixture(self.media_root);self.addCleanup(self.fixture.close)
        self.output=Path(self.tmp.name)/'output';self.events=[]
    def engine(self,folder='ts',job='job:test',**extra):
        message={'jobId':job,'pageUrl':self.fixture.url+'/watch?id=fixture','url':self.fixture.url+'/'+folder+'/index.m3u8',
                 'sourceTitle':'SAFE-001 Current test video','selectedHeight':90,
                 'settings':{'networkRetries':2,'retryBase':0.05,'networkTimeout':2},**extra}
        engine=Engine(message,self.output,shutil.which,lambda **kw:self.events.append(kw))
        engine.opener=build_opener(ProxyHandler({}),SafeRedirect())
        return engine
    def verify_complete(self,engine):
        try:path,probe=engine.execute()
        except HlsError as error:
            log=engine.root/'ffmpeg-stage.log'
            if log.is_file():raise AssertionError(str(error)+'\n'+log.read_text()[-4000:]) from error
            raise
        self.assertTrue(path.is_file());self.assertTrue(probe['integrityVerified'])
        self.assertEqual(path.name,'SAFE-001 Current test video.mp4');self.assertTrue(probe['hasAudio'])
        leftovers=[p.name for p in engine.root.iterdir() if p.name!='checkpoint.json']
        self.assertEqual(leftovers,[])
        return path,probe
    def test_ts_complete_and_idempotent_retry(self):
        engine=self.engine();path,probe=self.verify_complete(engine)
        calls=sum(self.fixture.calls.values());path2,_=self.engine().execute()
        self.assertEqual(path,path2);self.assertEqual(calls,sum(self.fixture.calls.values()))
    def test_wrong_selected_duration_stops_before_media_transfer(self):
        with self.assertRaises(HlsError) as raised:self.engine(expectedDuration=600,enforceDuration=True).execute()
        self.assertEqual(raised.exception.code,'DURATION_MISMATCH');self.assertEqual(self.fixture.calls['ts/seg000001.ts'],0)
    def test_fmp4_map_complete(self):self.verify_complete(self.engine('fmp4'))
    def test_aes128_authorized_key_complete(self):self.verify_complete(self.engine('aes'))
    def test_byterange_complete(self):self.verify_complete(self.engine('range'))
    def test_fragment_828_temporary_503_recovers(self):
        self.fixture.faults['long/seg000828.ts']=[503,503]
        _,probe=self.verify_complete(self.engine('long'))
        self.assertEqual(probe['fragmentsDone'],1000);self.assertEqual(self.fixture.calls['long/seg000828.ts'],3)
        self.assertGreater(probe['duration'],999);self.assertTrue(any(e['stage']=='recovering' for e in self.events))
    def test_fragment_828_permanent_403_is_bounded_and_resumable(self):
        self.fixture.faults['long/seg000828.ts']=403
        engine=self.engine('long')
        with self.assertRaises(HlsError) as raised:engine.execute()
        self.assertEqual(raised.exception.status,403);self.assertLessEqual(self.fixture.calls['long/seg000828.ts'],2)
        self.assertTrue(engine.data['canResume']);self.assertFalse(list(self.output.glob('*.mp4')))
        receipts=len(engine.data['completed']);self.assertGreaterEqual(receipts,827)
        self.fixture.faults.clear();before=self.fixture.calls['long/seg000100.ts']
        resumed=self.engine('long');self.verify_complete(resumed)
        self.assertEqual(before,self.fixture.calls['long/seg000100.ts'])
    def test_legitimate_manifest_refresh_reuses_verified_segments(self):
        authorized={'fresh':False}
        def reject_old(handler):
            if parse_qs(urlsplit(handler.path).query).get('token')==['old']:
                authorized['fresh']=True;return 403
        self.fixture.faults['long/seg000828.ts']=reject_old
        def transform(name,body,handler):
            token='new' if authorized['fresh'] else 'old'
            return re.sub(r'(seg\d+\.ts)',r'\1?token='+token,body.decode())
        self.fixture.transform=transform
        self.verify_complete(self.engine('long'))
        self.assertEqual(self.fixture.calls['long/seg000100.ts'],1)
        self.assertEqual(self.fixture.calls['long/seg000828.ts'],2)
    def test_permanent_404_never_publishes_partial_output(self):
        self.fixture.faults['ts/seg000004.ts']=404;engine=self.engine()
        with self.assertRaises(HlsError) as raised:engine.execute()
        self.assertEqual(raised.exception.status,404);self.assertFalse(list(self.output.glob('*.mp4')))
        self.assertTrue(engine.data['canResume'])
    def test_network_disconnect_retries_only_incomplete_segment(self):
        self.fixture.faults['ts/seg000004.ts']=['disconnect'];self.verify_complete(self.engine())
        self.assertEqual(self.fixture.calls['ts/seg000004.ts'],2)
        self.assertEqual(self.fixture.calls['ts/seg000001.ts'],1)
    def test_process_interruption_preserves_and_resumes(self):
        engine=self.engine();checks={'raised':False}
        def cancel():
            if len(engine.data['completed'])>=3 and not checks['raised']:
                checks['raised']=True;raise Cancelled(True,True)
        engine.cancelled=cancel
        with self.assertRaises(Cancelled):engine.execute()
        self.assertTrue(engine.path.exists());self.assertTrue(engine.data['canResume'])
        self.verify_complete(self.engine())
    def test_changed_sequence_blocks_splicing(self):
        engine=self.engine();self.fixture.faults['ts/seg000004.ts']=403
        with self.assertRaises(HlsError):engine.execute()
        self.fixture.faults.clear()
        self.fixture.transform=lambda name,body,handler:body.decode().replace('#EXT-X-MEDIA-SEQUENCE:1','#EXT-X-MEDIA-SEQUENCE:2')
        resumed=self.engine()
        with self.assertRaises(HlsError) as raised:resumed.execute()
        self.assertEqual(raised.exception.code,'PLAYLIST_CHANGED');self.assertFalse(resumed.data['canResume'])
        self.assertFalse(list(self.output.glob('*.mp4')))
    def test_corrupt_local_segment_is_not_reused(self):
        engine=self.engine();self.fixture.faults['ts/seg000004.ts']=403
        with self.assertRaises(HlsError):engine.execute()
        self.fixture.faults.clear();engine.entry_path('0:0').write_bytes(b'bad')
        before=self.fixture.calls['ts/seg000001.ts'];self.verify_complete(self.engine())
        self.assertGreater(self.fixture.calls['ts/seg000001.ts'],before)
    def test_mux_failure_preserves_inputs_and_retry_skips_network_transfer(self):
        engine=self.engine();original=engine.run_process
        engine.run_process=lambda *args:(_ for _ in ()).throw(HlsError('MUX_FAILED','test mux failure'))
        with self.assertRaises(HlsError):engine.execute()
        self.assertTrue(engine.data['muxReady']);self.assertTrue(engine.data['canResume'])
        before=self.fixture.calls['ts/seg000002.ts'];self.verify_complete(self.engine())
        # Resume byte samples may include segment 2; the nonsampled segment 3 must not redownload.
        self.assertLessEqual(self.fixture.calls['ts/seg000002.ts']-before,1)
    def test_cancel_and_discard_removes_only_this_job_data(self):
        engine=self.engine();other=self.output/'unrelated.part';other.write_bytes(b'keep')
        def cancel():
            if engine.data['completed']:raise Cancelled(False)
        engine.cancelled=cancel
        with self.assertRaises(Cancelled):engine.execute()
        self.assertTrue(other.exists());self.assertFalse(list(engine.root.glob('segment-*')));self.assertFalse(engine.data['canResume'])
    def test_disk_space_failure_is_explicit(self):
        engine=self.engine()
        with mock.patch('hls_engine.shutil.disk_usage',return_value=collections.namedtuple('Usage','total used free')(100,99,1)):
            with self.assertRaises(HlsError) as raised:engine.execute()
        self.assertEqual(raised.exception.code,'DISK_FULL');self.assertFalse(list(self.output.glob('*.mp4')))
    def test_retry_after_429_is_honored(self):
        self.fixture.faults['ts/seg000004.ts']=[429];self.fixture.retry_after='1'
        self.verify_complete(self.engine())
        calls=[r[2] for r in self.fixture.requests if r[0]=='ts/seg000004.ts']
        self.assertGreaterEqual(calls[1]-calls[0],1)
    def test_retry_after_survives_restart_without_an_early_request(self):
        self.fixture.faults['ts/seg000004.ts']=[429];self.fixture.retry_after='60'
        engine=self.engine();engine.max_wait=0.1
        with self.assertRaises(HlsError) as raised:engine.execute()
        self.assertEqual(raised.exception.code,'RETRY_LATER')
        before=sum(self.fixture.calls.values());resumed=self.engine();resumed.max_wait=0.1
        with self.assertRaises(HlsError):resumed.execute()
        self.assertEqual(sum(self.fixture.calls.values()),before)
    def test_duplicate_titles_never_overwrite_other_jobs(self):
        first,_=self.engine(job='job:first').execute();second,_=self.engine(job='job:second').execute()
        self.assertNotEqual(first,second);self.assertEqual(second.name,'SAFE-001 Current test video (2).mp4')
    def test_master_separate_default_audio_is_merged(self):
        self.verify_complete(self.engine('split'))
        self.assertGreater(self.fixture.calls['split/audio.m3u8'],0)
        self.assertEqual(self.fixture.calls['split/unused-audio.m3u8'],0)
    def test_captured_request_headers_reach_authorized_segment_requests(self):
        def verify_headers(handler):
            required={'Cookie':'fixture=authorized','Authorization':'Bearer fixture-only','Referer':self.fixture.url+'/watch','Origin':self.fixture.url,'User-Agent':'DarrenTest/1'}
            return None if all(handler.headers.get(k)==v for k,v in required.items()) else 403
        self.fixture.faults['ts/seg000004.ts']=verify_headers
        self.verify_complete(self.engine(headers={'cookie':'fixture=authorized','authorization':'Bearer fixture-only','referer':self.fixture.url+'/watch','origin':self.fixture.url,'user-agent':'DarrenTest/1'}))
    def test_corrupt_remote_segment_cannot_be_published_as_complete(self):
        target=self.media_root/'ts/seg000004.ts';original=target.read_bytes()
        try:
            target.write_bytes(b'not valid MPEG-TS media'*50)
            with self.assertRaises(HlsError):self.engine().execute()
            self.assertFalse(list(self.output.glob('*.mp4')))
        finally:target.write_bytes(original)
    def test_atomic_publication_crash_reuses_one_verified_final(self):
        engine=self.engine();real_link=os.link
        def fail_after_link(source,destination,*args,**kwargs):
            real_link(source,destination,*args,**kwargs)
            if Path(destination).parent==engine.output:raise OSError('simulated process loss after atomic publication')
        with mock.patch('hls_engine.os.link',side_effect=fail_after_link):
            with self.assertRaises(OSError):engine.execute()
        before=sum(self.fixture.calls.values());self.verify_complete(self.engine())
        self.assertEqual(sum(self.fixture.calls.values()),before);self.assertEqual(len(list(self.output.glob('*.mp4'))),1)
    def test_output_symlink_is_rejected(self):
        external=Path(self.tmp.name)/'external';external.mkdir();self.output.symlink_to(external,target_is_directory=True)
        with self.assertRaises(HlsError) as raised:self.engine()
        self.assertEqual(raised.exception.code,'UNSAFE_PATH');self.assertEqual(list(external.iterdir()),[])

    def test_invalid_headers_and_drm_are_rejected(self):
        with self.assertRaises(HlsError):self.engine(headers={'cookie':'bad\r\nInjected: yes'}).execute()
        text='#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="key"\n#EXTINF:1,\na.ts\n#EXT-X-ENDLIST'
        with self.assertRaises(HlsError) as raised:parse_playlist(text,self.fixture.url+'/index.m3u8')
        self.assertEqual(raised.exception.code,'UNSUPPORTED_ENCRYPTION')
    def test_same_manifest_metadata_with_changed_bytes_blocks_resume(self):
        engine=self.engine();self.fixture.faults['ts/seg000004.ts']=403
        with self.assertRaises(HlsError):engine.execute()
        self.fixture.faults.clear();original=self.media_root/'ts/seg000001.ts';saved=original.read_bytes()
        try:
            original.write_bytes(saved[:-1]+bytes([saved[-1]^1]));resumed=self.engine()
            with self.assertRaises(HlsError) as raised:resumed.execute()
            self.assertEqual(raised.exception.code,'CONTENT_CHANGED');self.assertFalse(resumed.data['canResume'])
        finally:original.write_bytes(saved)

class PlaylistUnitTests(unittest.TestCase):
    def test_discontinuity_key_and_range_are_part_of_resume_identity(self):
        text='#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:20\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\n#EXT-X-BYTERANGE:188@0\nstream.ts\n#EXT-X-DISCONTINUITY\n#EXTINF:2,\n#EXT-X-BYTERANGE:188\nstream.ts\n#EXT-X-ENDLIST'
        p=parse_playlist(text,'https://example.test/index.m3u8')
        self.assertEqual(p['segments'][1]['range'],[188,188]);self.assertEqual(p['segments'][1]['sequence'],21)
        self.assertEqual(p['segments'][1]['discontinuity'],1)
        self.assertFalse(compatible([{**p,'role':'video'}],[{**parse_playlist(text.replace('188@0','188@188'),'https://example.test/index.m3u8'),'role':'video'}]))
    def test_unknown_live_and_gap_are_not_silently_muxed(self):
        for addition in ('','#EXT-X-GAP\n'):
            text='#EXTM3U\n#EXTINF:2,\n'+addition+'a.ts\n'
            with self.assertRaises(HlsError):parse_playlist(text,'https://example.test/index.m3u8')
    def test_native_title_is_short_and_has_no_id_suffix(self):
        name=safe_title('VID-123 '+('\u202e test / 🎥'*100)+'.webm')
        self.assertLessEqual(len(name.encode()),160);self.assertTrue(name.startswith('VID-123'));self.assertNotIn('/',name);self.assertNotIn('\u202e',name)

if __name__=='__main__':unittest.main()
