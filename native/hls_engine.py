"""Checkpointed VOD HLS transfer. Standard library only; FFmpeg muxes local media.

No access-control bypass: authorization errors get one manifest diagnosis, not an
unbounded request loop. Checkpoints never authorize reusing incompatible media.
"""
import email.utils
import hashlib
import json
import math
import os
import re
import shutil
import socket
import subprocess
import time
import uuid
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qsl, urlencode, urljoin, urlsplit, urlunsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler

SCHEMA = 1
VOLATILE = re.compile(r'^(?:token|auth|authorization|signature|sig|expires?|expiry|exp|e|policy|key-pair-id|hdnts|hdnea|st)$', re.I)
ATTR = re.compile(r'([A-Z0-9-]+)=((?:"[^"]*")|[^,]*)')
TRANSIENT = {408, 429, 500, 502, 503, 504}
AUTH = {401, 403}
MISSING = {404, 410}
STATES = {'waiting','downloading','interrupted','diagnosing','recovering','resuming',
          'verifying','completed','attention','failed','cancelled'}

class HlsError(RuntimeError):
    def __init__(self, code, message, status=None, refresh=False):
        super().__init__(message)
        self.code, self.status, self.refresh = code, status, refresh

class Cancelled(HlsError):
    def __init__(self, keep=True, disconnected=False):
        super().__init__('DISCONNECTED' if disconnected else 'CANCELLED', '下载连接中断，数据已保留。' if disconnected else '任务已取消。')
        self.keep, self.disconnected = keep, disconnected


def attrs(value):
    return {m[1]:m[2].strip('"') for m in ATTR.finditer(value)}


def remote_url(value):
    if not isinstance(value, str) or len(value)>16384 or re.search(r'[\x00-\x20\x7f]', value):
        raise HlsError('INVALID_URL','媒体地址无效。')
    p=urlsplit(value)
    if p.scheme not in ('http','https') or not p.hostname or p.username or p.password:
        raise HlsError('INVALID_URL','仅支持不含嵌入凭据的 HTTP(S) 媒体地址。')
    return value


def canonical(url):
    p=urlsplit(remote_url(url))
    query=urlencode(sorted((k,v) for k,v in parse_qsl(p.query,keep_blank_values=True) if not VOLATILE.fullmatch(k)))
    return urlunsplit((p.scheme,p.netloc.lower(),p.path,query,''))


def digest_json(value):
    return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':')).encode()).hexdigest()


def sha_file(path):
    h=hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda:stream.read(1024*1024),b''): h.update(block)
    return h.hexdigest()


def atomic_json(path, value):
    tmp=path.with_name('.'+path.name+'.'+uuid.uuid4().hex+'.tmp')
    fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    try:
        with os.fdopen(fd,'w') as stream:
            json.dump(value,stream,ensure_ascii=False,separators=(',',':'))
            stream.flush();os.fsync(stream.fileno())
        os.replace(tmp,path)
        try:
            directory=os.open(path.parent,os.O_RDONLY);os.fsync(directory);os.close(directory)
        except OSError: pass
    finally:
        if tmp.exists(): tmp.unlink()


def safe_directory(path):
    path=Path(path).absolute()
    for ancestor in (path,*path.parents):
        if ancestor.is_symlink() and str(ancestor) not in ('/var','/tmp'): raise HlsError('UNSAFE_PATH','输出目录包含符号链接，已停止。')
    path.mkdir(parents=True,exist_ok=True,mode=0o700)
    return path


def safe_title(value):
    # IDs and paths stay internal; final names contain a title and optional collision count.
    name=re.sub(r'[\x00-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2060-\u206f<>:"/\\|?*]', ' ',str(value or 'video'))
    name=re.sub(r'\s+',' ',name).strip(' .')
    name=re.sub(r'\.(?:mp4|webm|mkv|ts)$','',name,flags=re.I)
    name=name.encode('utf-8')[:160].decode('utf-8','ignore').rstrip(' .') or 'video'
    if re.match(r'^(con|prn|aux|nul|com\d|lpt\d)(?:\.|$)',name,re.I): name='video-'+name
    return name


def byte_range(value, previous=None):
    try:
        parts=value.split('@');length=int(parts[0]);offset=int(parts[1]) if len(parts)==2 else previous
        if length<=0 or offset is None or offset<0: raise ValueError()
        return [offset,length]
    except (ValueError,TypeError): raise HlsError('PLAYLIST_INVALID','HLS 字节范围缺少有效偏移或长度。')


def parse_playlist(text, base):
    remote_url(base)
    if len(text.encode())>4*1024*1024 or not text.lstrip('\ufeff').startswith('#EXTM3U'):
        raise HlsError('PLAYLIST_INVALID','服务器没有返回有效 HLS 播放清单。')
    lines=[x.strip() for x in text.lstrip('\ufeff').splitlines() if x.strip()]
    variants=[];audio=[];segments=[];variant=None;seq=0;disc=0;duration=None;key=None;init=None
    br=None;previous_end=None;previous_uri=None;clock=None;gap=False;ended=False;map_end={};target=0
    for line in lines:
        if line.startswith('#EXT-X-STREAM-INF:'): variant=attrs(line.split(':',1)[1]);continue
        if line.startswith('#EXT-X-MEDIA:'):
            a=attrs(line.split(':',1)[1]);
            if a.get('TYPE')=='AUDIO' and a.get('URI'): audio.append({**a,'url':remote_url(urljoin(base,a['URI']))})
        elif line.startswith('#EXT-X-MEDIA-SEQUENCE:'): seq=int(line.split(':',1)[1])
        elif line.startswith('#EXT-X-DISCONTINUITY-SEQUENCE:'): disc=int(line.split(':',1)[1])
        elif line=='#EXT-X-DISCONTINUITY': disc+=1
        elif line.startswith('#EXT-X-TARGETDURATION:'): target=float(line.split(':',1)[1])
        elif line.startswith('#EXTINF:'):
            duration=float(line.split(':',1)[1].split(',',1)[0])
            if not math.isfinite(duration) or duration<=0: raise HlsError('PLAYLIST_INVALID','分片时长无效。')
        elif line.startswith('#EXT-X-KEY:'):
            a=attrs(line.split(':',1)[1]);method=a.get('METHOD')
            if method=='NONE': key=None
            elif method!='AES-128' or a.get('KEYFORMAT','identity')!='identity':
                raise HlsError('UNSUPPORTED_ENCRYPTION','不支持该加密或 DRM 格式，不会尝试解密或绕过访问控制。')
            else:
                if not a.get('URI'): raise HlsError('PLAYLIST_INVALID','AES-128 缺少密钥地址。')
                iv=a.get('IV','')
                if iv and not re.fullmatch(r'0[xX][0-9a-fA-F]{1,32}',iv): raise HlsError('PLAYLIST_INVALID','AES-128 IV 无效。')
                key={'method':method,'url':remote_url(urljoin(base,a['URI'])),'iv':iv}
        elif line.startswith('#EXT-X-MAP:'):
            a=attrs(line.split(':',1)[1]);url=remote_url(urljoin(base,a.get('URI','')))
            map_range=byte_range(a['BYTERANGE'],map_end.get(url)) if a.get('BYTERANGE') else None
            if map_range: map_end[url]=sum(map_range)
            if key and not key.get('iv'): raise HlsError('PLAYLIST_INVALID','加密初始化片段需要显式 IV。')
            init={'url':url,'range':map_range,'key':dict(key) if key else None}
        elif line.startswith('#EXT-X-BYTERANGE:'): br=line.split(':',1)[1]
        elif line.startswith('#EXT-X-PROGRAM-DATE-TIME:'): clock=line.split(':',1)[1]
        elif line=='#EXT-X-GAP': gap=True
        elif line=='#EXT-X-ENDLIST': ended=True
        elif line.startswith(('#EXT-X-SKIP:','#EXT-X-PART:','#EXT-X-SESSION-KEY:')):
            raise HlsError('UNSUPPORTED_PLAYLIST','不支持增量/低延迟或会话密钥清单；未开始拼接。')
        elif not line.startswith('#'):
            url=remote_url(urljoin(base,line))
            if variant is not None:
                resolution=variant.get('RESOLUTION','0x0').split('x')
                variants.append({**variant,'url':url,'height':int(resolution[-1]),'bandwidth':int(variant.get('BANDWIDTH',0))})
                variant=None;continue
            if duration is None: raise HlsError('PLAYLIST_INVALID','分片缺少 EXTINF。')
            if gap: raise HlsError('MISSING_SEGMENT','播放清单声明缺失分片；不会生成看似完整的视频。')
            span=byte_range(br,previous_end if previous_uri==url else None) if br else None
            segments.append({'url':url,'duration':round(duration,6),'sequence':seq+len(segments),
                'discontinuity':disc,'clock':clock,'range':span,'key':dict(key) if key else None,'map':init})
            previous_end=sum(span) if span else None;previous_uri=url;duration=None;br=None;clock=None;gap=False
    if variants: return {'variants':variants,'audio':audio,'master':True,'url':base}
    if not segments or len(segments)>100000: raise HlsError('PLAYLIST_INVALID','清单分片数量无效。')
    if not ended: raise HlsError('LIVE_UNSUPPORTED','该清单仍在动态更新；检查点引擎仅接受完整 VOD 清单。请等待视频结束或使用站点解析器。')
    return {'master':False,'segments':segments,'url':base,'sequence':seq,'target':target,
            'duration':sum(s['duration'] for s in segments)}


def identity_resource(resource):
    if resource is None: return None
    return {k:(canonical(v) if k=='url' else identity_resource(v) if isinstance(v,dict) else v) for k,v in resource.items()}


def track_identity(track):
    return {'height':track.get('height',0),'role':track['role'],
            'segments':[identity_resource(s) for s in track['segments']]}


def compatible(old,new):
    return digest_json([track_identity(t) for t in old])==digest_json([track_identity(t) for t in new])


class SafeRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        remote_url(newurl)
        redirected=super().redirect_request(req,fp,code,msg,headers,newurl)
        if redirected and urlsplit(req.full_url).netloc!=urlsplit(newurl).netloc:
            for name in ('Cookie','Authorization'):
                redirected.remove_header(name)
        return redirected


class Engine:
    def __init__(self, message, output, tools, notify=lambda **kw:None, cancelled=lambda:None, sleep=None):
        self.message=message;self.tools=tools;self.notify=notify;self.cancelled=cancelled
        self.output=safe_directory(output)
        self.job_id=message['jobId'];self.root=safe_directory(self.output/'.darren-video-helper'/hashlib.sha256(self.job_id.encode()).hexdigest()[:32])
        self.path=self.root/'checkpoint.json'
        self.options=message.get('settings') or {}
        def number(key,default,lo,hi):
            try:return max(lo,min(hi,float(self.options.get(key,default))))
            except (ValueError,TypeError):return default
        self.timeout=number('networkTimeout',20,2,60);self.retries=int(number('networkRetries',4,0,8))
        self.delay=number('retryBase',1,0.05,10);self.max_wait=number('maxRetryAfter',120,0,600)
        self.rate_delay=0;self.sleep=sleep or self.wait
        self.opener=build_opener(SafeRedirect())
        self.data={'schema':SCHEMA,'jobId':self.job_id,'state':'waiting','completed':{},'assets':{},'tracks':[],
                   'sourceIdentity':self.source_identity(),'createdAt':time.time(),'canResume':False}
        if self.path.exists():
            if self.path.is_symlink():raise HlsError('UNSAFE_PATH','检查点不能是符号链接。')
            try:self.data=json.loads(self.path.read_text())
            except (ValueError,OSError):raise HlsError('CHECKPOINT_INVALID','检查点损坏，数据保留；不会猜测续传位置。')
            if self.data.get('schema')!=SCHEMA or self.data.get('jobId')!=self.job_id or self.data.get('sourceIdentity')!=self.source_identity():
                raise HlsError('IDENTITY_CHANGED','任务或视频身份发生变化，禁止复用旧分片。')
        self.journal=self.root/'receipts.jsonl'
        if self.journal.exists():
            if self.journal.is_symlink() or self.journal.stat().st_size>64*1024*1024:raise HlsError('CHECKPOINT_INVALID','分片收据无效。')
            with self.journal.open() as stream:
                for line in stream:
                    try:
                        item=json.loads(line);key=item['key']
                        if re.fullmatch(r'\d+:\d+',key):self.data['completed'][key]=item['record']
                    except (ValueError,KeyError,TypeError):continue
        self.transferred=0;self.started=time.monotonic();self.tracks=[];self.last_notify=0

    def source_identity(self):
        return digest_json({'page':canonical(self.message.get('pageUrl') or self.message['url']),
          'video':str(self.message.get('videoIdentity') or ''),
          'resource':canonical(self.message.get('masterUrl') or self.message.get('renditionMasterUrl') or self.message['url']),'height':int(self.message.get('expectedHeight') or self.message.get('selectedHeight') or 0)})

    def wait(self,seconds):
        end=time.monotonic()+seconds
        while time.monotonic()<end:
            self.cancelled();time.sleep(min(0.2,max(0,end-time.monotonic())))

    def save(self,state=None,**extra):
        if state:
            if state not in STATES:raise ValueError(state)
            self.data['state']=state
        self.data.update(extra);self.data['updatedAt']=time.time()
        self.data['canResume']=bool(self.data.get('completed')) and self.data['state']!='completed'
        atomic_json(self.path,self.data)

    def record_segment(self,key,record):
        fd=os.open(self.journal,os.O_WRONLY|os.O_CREAT|os.O_APPEND|getattr(os,'O_NOFOLLOW',0),0o600)
        with os.fdopen(fd,'a') as stream:
            stream.write(json.dumps({'key':key,'record':record},separators=(',',':'))+'\n');stream.flush();os.fsync(stream.fileno())
        self.data['completed'][key]=record;self.data['canResume']=True
        # Each receipt is durable; compact metadata snapshots need not rewrite N tracks N times.
        if self.data['state']!='downloading' or len(self.data['completed'])%50==0:self.save('downloading')

    def event(self,stage,message,force=False,**fields):
        now=time.monotonic()
        if force or stage!='downloading' or now-self.last_notify>=0.3:
            self.notify(stage=stage,message=message,canResume=self.data.get('canResume',False),**fields);self.last_notify=now

    def headers(self,url,span=None):
        result={}
        supplied=self.message.get('headers') or {}
        base=urlsplit(self.message['url']).netloc
        for key,value in supplied.items():
            lower=key.lower()
            if lower not in ('user-agent','cookie','authorization','origin','referer','accept','accept-language'):continue
            if lower in ('cookie','authorization') and urlsplit(url).netloc!=base:continue
            if not isinstance(value,str) or re.search(r'[\r\n\x00]',value) or len(value)>16384:
                raise HlsError('INVALID_HEADER','请求头无效。')
            result[lower]=value
        if 'referer' not in result and self.message.get('pageUrl'):result['referer']=remote_url(self.message['pageUrl'])
        result['Accept-Encoding']='identity'
        if span:result['Range']=f'bytes={span[0]}-{sum(span)-1}'
        return result

    def retry_after(self,value):
        try:return max(0,float(value))
        except (ValueError,TypeError):
            try:return max(0,email.utils.parsedate_to_datetime(value).timestamp()-time.time())
            except (ValueError,TypeError,OverflowError):return None

    def request(self,url,destination=None,span=None,limit=256*1024*1024):
        remote_url(url)
        for attempt in range(self.retries+1):
            self.cancelled()
            remaining=max(0,self.data.get('retryNotBefore',0)-time.time())
            if remaining:
                if remaining>self.max_wait:raise HlsError('RETRY_LATER',f'服务器要求继续等待 {math.ceil(remaining)} 秒；未发起新请求。',status=429)
                self.sleep(remaining)
                self.save(retryNotBefore=0)
            try:
                if self.rate_delay:self.sleep(self.rate_delay)
                with self.opener.open(Request(url,headers=self.headers(url,span)),timeout=self.timeout) as response:
                    final_url=remote_url(response.geturl())
                    if span:
                        expected=f'bytes {span[0]}-{sum(span)-1}/'
                        if response.status!=206 or not response.headers.get('Content-Range','').startswith(expected):
                            raise HlsError('RANGE_MISMATCH','服务器未按请求返回字节范围，禁止错误拼接。')
                    length=int(response.headers.get('Content-Length') or 0)
                    if length>limit:raise HlsError('RESPONSE_TOO_LARGE','资源超过单次安全限制。')
                    if destination and response.headers.get_content_type() in ('text/html','application/json'):
                        raise HlsError('BAD_MEDIA_RESPONSE','分片服务器返回了网页或错误信息。')
                    tmp=destination.with_suffix(destination.suffix+'.part') if destination else None
                    if tmp and tmp.is_symlink():raise HlsError('UNSAFE_PATH','临时文件不能是符号链接。')
                    body=bytearray();total=0;sha=hashlib.sha256();stream=None
                    try:
                        if tmp:
                            fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_TRUNC|getattr(os,'O_NOFOLLOW',0),0o600);stream=os.fdopen(fd,'wb')
                        while True:
                            self.cancelled();block=response.read(64*1024)
                            if not block:break
                            total+=len(block)
                            if total>limit:raise HlsError('RESPONSE_TOO_LARGE','资源超过单次安全限制。')
                            sha.update(block)
                            if stream:stream.write(block)
                            else:body.extend(block)
                        if (length and total!=length) or (span and total!=span[1]) or total==0:
                            raise HlsError('TRUNCATED_RESPONSE','分片传输不完整，未记录为已完成。')
                        if stream:stream.flush();os.fsync(stream.fileno());stream.close();stream=None;os.replace(tmp,destination)
                        self.transferred+=total
                        return {'bytes':total,'sha256':sha.hexdigest(),'body':bytes(body),'url':final_url}
                    finally:
                        if stream:stream.close()
                        if tmp and tmp.exists():tmp.unlink()
            except HTTPError as error:
                code=error.code;retry=self.retry_after(error.headers.get('Retry-After'));error.close()
                if code not in TRANSIENT:
                    raise HlsError('HTTP_'+str(code),f'HTTP {code}：服务器拒绝或无法提供该资源。',status=code,refresh=code in AUTH|MISSING)
                failure=HlsError('HTTP_'+str(code),f'HTTP {code}：暂时无法下载，已保留已校验分片。',status=code)
                if retry is not None and retry>0:self.save(retryNotBefore=time.time()+retry)
                if code==429:self.rate_delay=min(5,max(self.rate_delay*2,0.1))
                if retry is not None and retry>self.max_wait:
                    raise HlsError('RETRY_LATER',f'服务器要求等待 {math.ceil(retry)} 秒；已暂停，请稍后继续。',status=code)
            except (URLError,socket.timeout,TimeoutError,ConnectionError,OSError) as error:
                if isinstance(error,OSError) and error.errno in (28,122):raise HlsError('DISK_FULL','磁盘空间不足，已保留已校验分片。')
                failure=HlsError('NETWORK_INTERRUPTED','网络连接中断或超时，已保留已校验分片。');retry=None
            except HlsError as error:
                if error.code!='TRUNCATED_RESPONSE':raise
                failure=error;retry=None
            if attempt>=self.retries:raise failure
            delay=max(self.delay*2**attempt,retry or 0)
            self.save('recovering',lastError=failure.code)
            self.event('recovering',f'网络恢复 {attempt+1}/{self.retries}，等待 {delay:.1f} 秒后重试。',force=True,httpStatus=failure.status)
            self.sleep(delay)
        raise failure

    def playlist(self,url):
        response=self.request(url,limit=4*1024*1024)
        try:text=response['body'].decode('utf-8-sig')
        except UnicodeError:raise HlsError('PLAYLIST_INVALID','清单编码无效。')
        return parse_playlist(text,response['url'])

    def resolve(self):
        url=self.message.get('renditionUrl') or self.message['url'];selected_height=int(self.message.get('expectedHeight') or self.message.get('selectedHeight') or 0)
        audio_url=self.message.get('renditionAudioUrl');height=selected_height
        visited=set()
        for _ in range(4):
            if url in visited:raise HlsError('PLAYLIST_INVALID','主清单存在循环引用。')
            visited.add(url);playlist=self.playlist(url)
            if not playlist['master']:break
            variants=playlist['variants']
            match=re.search(r'(\d{3,4})',str(self.message.get('qualityPreference') or self.options.get('defaultQuality','best')))
            if selected_height:variants=[v for v in variants if v['height']==selected_height]
            elif match:variants=[v for v in variants if not v['height'] or v['height']<=int(match[1])]
            if not variants:raise HlsError('QUALITY_UNAVAILABLE','所选清晰度不存在，未改下载其他版本。')
            chosen=max(variants,key=lambda v:(v['height'],v['bandwidth']));url=chosen['url'];height=chosen['height']
            group=chosen.get('AUDIO')
            choices=[a for a in playlist['audio'] if a.get('GROUP-ID')==group]
            if choices and not audio_url:audio_url=max(choices,key=lambda a:(a.get('DEFAULT')=='YES',a.get('AUTOSELECT')=='YES'))['url']
        else:raise HlsError('PLAYLIST_INVALID','主清单嵌套过深。')
        tracks=[{**playlist,'role':'video','height':height}]
        if audio_url:
            audio=self.playlist(audio_url)
            if audio['master']:raise HlsError('UNSUPPORTED_PLAYLIST','音频清单不能再次引用主清单。')
            tracks.append({**audio,'role':'audio','height':0})
        return tracks

    def entry_path(self,key):
        # Checkpoint paths are never trusted as filesystem paths.
        return self.root/('segment-'+key.replace(':','-')+'.bin')

    def verify_entries(self):
        valid={}
        for key,record in self.data.get('completed',{}).items():
            if not re.fullmatch(r'\d+:\d+',key):continue
            path=self.entry_path(key)
            if path.is_file() and not path.is_symlink() and path.stat().st_size==record.get('bytes') and sha_file(path)==record.get('sha256'):valid[key]=record
        self.data['completed']=valid
        return valid

    def check_space(self,additional=0):
        free=shutil.disk_usage(self.output).free
        minimum=max(16*1024*1024,additional)
        if free<minimum:raise HlsError('DISK_FULL','磁盘空间不足，下载/合并已停止，数据已保留。')

    def ensure_asset(self,resource,kind,revalidate=False):
        identity=identity_resource(resource);key=digest_json({'kind':kind,'resource':identity})
        path=self.root/('asset-'+key[:24]+('.key' if kind=='key' else '.mp4'));record=self.data['assets'].get(key)
        if record and path.is_file() and not path.is_symlink() and sha_file(path)==record.get('sha256'):
            if revalidate:
                result=self.request(resource['url'],span=resource.get('range'),limit=32 if kind=='key' else 64*1024*1024)
                if result['sha256']!=record['sha256']:raise HlsError('CONTENT_CHANGED','初始化片段或密钥发生变化，禁止复用旧内容。')
            return path
        result=self.request(resource['url'],path,resource.get('range'),limit=32 if kind=='key' else 64*1024*1024)
        if kind=='key' and result['bytes']!=16:path.unlink();raise HlsError('INVALID_KEY','AES-128 密钥长度无效。')
        self.data['assets'][key]={'sha256':result['sha256'],'bytes':result['bytes']}
        self.save();return path

    def validate_resume(self,new_tracks):
        old=self.data.get('tracks')
        valid=self.verify_entries()
        if old and not compatible(old,new_tracks):raise HlsError('PLAYLIST_CHANGED','新旧分片序列、时长、清晰度或格式不兼容；旧数据已保留，禁止拼接。')
        # Path/timing compatibility is necessary but insufficient. Recheck known bytes.
        for ti,track in enumerate(new_tracks):
            indices=sorted(int(k.split(':')[1]) for k in valid if k.startswith(str(ti)+':'))
            for index in sorted({indices[0],indices[len(indices)//2],indices[-1]} if indices else set()):
                if index>=len(track['segments']):raise HlsError('PLAYLIST_CHANGED','恢复分片超出新清单范围。')
                segment=track['segments'][index];sample=self.request(segment['url'],span=segment.get('range'))
                if sample['sha256']!=valid[f'{ti}:{index}']['sha256']:raise HlsError('CONTENT_CHANGED','同一分片的内容发生变化，禁止复用。')
        self.data['tracks']=new_tracks;self.tracks=new_tracks
        seen=set()
        for track in new_tracks:
            for segment in track['segments']:
                for resource,kind in ((segment.get('key'),'key'),(segment.get('map'),'map')):
                    if resource:
                        token=digest_json(identity_resource(resource))
                        if token not in seen:
                            if kind=='map' and resource.get('key'):self.ensure_asset(resource['key'],'key',bool(old))
                            self.ensure_asset(resource,kind,bool(old));seen.add(token)
        self.save('resuming' if valid else 'downloading')
        return len(valid)

    def diagnose(self,error):
        self.save('diagnosing',lastError=error.code,httpStatus=error.status)
        self.event('diagnosing','正在区分分片拒绝与播放清单失效；最多重新验证一次清单。',force=True,httpStatus=error.status)
        try:
            tracks=self.resolve();self.validate_resume(tracks)
        except HlsError as problem:
            if problem.status in AUTH:raise HlsError(problem.code,'当前播放清单也被拒绝。请在原视频页面重新授权或播放，再重新检测；不会绕过服务器限制。',problem.status,True)
            raise
        self.save('recovering')
        self.event('recovering','清单身份验证通过，尝试恢复被中断的分片。',force=True)

    def download(self):
        self.check_space();old=bool(self.data.get('tracks'));self.save('diagnosing')
        tracks=self.resolve()
        expected=float(self.message.get('expectedDuration') or 0)
        if self.message.get('enforceDuration') and expected>0 and abs(tracks[0]['duration']-expected)>max(2,min(8,expected*0.01)):
            raise HlsError('DURATION_MISMATCH','清单时长与用户选中的资源不一致，下载前已停止。')
        reused=self.validate_resume(tracks)
        self.event('resuming' if reused else 'downloading',f'已验证 {reused} 个可复用分片。',force=True)
        if not reused and sum(len(t['segments']) for t in self.tracks)>200:
            self.event('diagnosing','正在抽样检查长视频的起点、中点与末尾；这不能保证后续服务器一直可用。',force=True)
            for ti,track in enumerate(self.tracks):
                for index in sorted({0,len(track['segments'])//2,len(track['segments'])-1}):
                    segment=track['segments'][index];key=f'{ti}:{index}'
                    result=self.request(segment['url'],self.entry_path(key),segment.get('range'))
                    self.record_segment(key,{'sha256':result['sha256'],'bytes':result['bytes']})
        refresh_used=False
        for ti in range(len(self.tracks)):
            index=0
            while index<len(self.tracks[ti]['segments']):
                self.cancelled();key=f'{ti}:{index}';segment=self.tracks[ti]['segments'][index]
                if key not in self.data['completed']:
                    self.check_space(1024*1024*max(16,1))
                    try:
                        result=self.request(segment['url'],self.entry_path(key),segment.get('range'))
                    except HlsError as error:
                        if error.status in AUTH|MISSING and not refresh_used:
                            refresh_used=True;self.diagnose(error);continue
                        raise
                    self.record_segment(key,{'sha256':result['sha256'],'bytes':result['bytes']})
                completed=len(self.data['completed']);count=sum(len(t['segments']) for t in self.tracks)
                total_bytes=sum(x['bytes'] for x in self.data['completed'].values())
                elapsed=max(0.001,time.monotonic()-self.started);speed=self.transferred/elapsed
                self.event('downloading',f'已校验分片 {completed}/{count}；下载字节为实际接收量。',
                    percent=str(round(completed/count*100,2)),fragmentsDone=completed,fragmentsTotal=count,
                    downloadedBytes=total_bytes,byteTotalEstimated=True,speed=f'{speed/1024/1024:.2f} MiB/s',
                    eta=f'{int((count-completed)*(elapsed/max(1,completed-reused)))}s' if completed>reused else '')
                index+=1
        count=sum(len(t['segments']) for t in self.tracks)
        if len(self.verify_entries())!=count:raise HlsError('CHECKPOINT_INCOMPLETE','分片校验不完整，未开始合并。')
        self.save('verifying',muxReady=True,fragmentsTotal=count,fragmentsDone=count)
        return self.mux()

    def local_playlist(self,ti,track):
        lines=['#EXTM3U','#EXT-X-VERSION:7',f'#EXT-X-TARGETDURATION:{math.ceil(max(s["duration"] for s in track["segments"]))}',
               f'#EXT-X-MEDIA-SEQUENCE:{track["segments"][0]["sequence"]}']
        last_disc=track['segments'][0]['discontinuity'];last_key=None;last_map=None
        def key_line(key):
            if not key:return '#EXT-X-KEY:METHOD=NONE'
            path=self.ensure_asset(key,'key')
            return f'#EXT-X-KEY:METHOD=AES-128,URI="{path.name}"'+(',IV='+key['iv'] if key.get('iv') else '')
        for i,segment in enumerate(track['segments']):
            if segment['discontinuity']!=last_disc:lines.append('#EXT-X-DISCONTINUITY');last_disc=segment['discontinuity']
            init=segment.get('map');key=segment.get('key')
            if init and init!=last_map:
                if init.get('key')!=last_key:lines.append(key_line(init.get('key')));last_key=init.get('key')
                lines.append(f'#EXT-X-MAP:URI="{self.ensure_asset(init,"map").name}"');last_map=init
            if key!=last_key:lines.append(key_line(key));last_key=key
            original=self.entry_path(f'{ti}:{i}')
            alias=self.root/(f'media-{ti}-{i}'+('.m4s' if segment.get('map') else '.ts'))
            if alias.exists() or alias.is_symlink():
                if alias.is_symlink() or not os.path.samefile(alias,original):raise HlsError('UNSAFE_PATH','本地分片别名发生冲突。')
            else:os.link(original,alias)
            lines += [f'#EXTINF:{segment["duration"]:.6f},',alias.name]
        lines.append('#EXT-X-ENDLIST');path=self.root/f'local-{ti}.m3u8';
        if path.is_symlink():raise HlsError('UNSAFE_PATH','本地清单不能是符号链接。')
        path.write_text('\n'.join(lines)+'\n');path.chmod(0o600)
        return path

    def run_process(self,command,timeout):
        # A disk-backed bounded log avoids stdout/stderr pipe deadlocks and RAM growth.
        log=self.root/'ffmpeg-stage.log'
        if log.is_symlink():raise HlsError('UNSAFE_PATH','工具日志不能是符号链接。')
        with log.open('wb') as stream:
            process=subprocess.Popen(command,stdin=subprocess.DEVNULL,stdout=stream,stderr=stream,start_new_session=True)
            start=time.monotonic()
            try:
                while process.poll() is None:
                    self.cancelled()
                    if log.stat().st_size>8*1024*1024:raise HlsError('MEDIA_ERROR','媒体工具持续报告错误，已停止并保留输入。')
                    if time.monotonic()-start>timeout:raise HlsError('MEDIA_TOOL_TIMEOUT','媒体合并或验证超时，输入已保留，可独立重试。')
                    self.wait(0.1)
                if process.returncode:raise HlsError('MUX_FAILED','FFmpeg 合并/验证失败，所有已校验输入已保留。')
            finally:
                if process.poll() is None:
                    process.terminate()
                    try:process.wait(timeout=3)
                    except subprocess.TimeoutExpired:process.kill();process.wait()
        if log.stat().st_size and log.read_bytes()[:4096].strip():
            raise HlsError('MEDIA_ERROR','FFmpeg 报告媒体读取错误，未发布成品，输入已保留。')
        return log

    def mux(self):
        self.check_space(sum(r['bytes'] for r in self.data['completed'].values())+32*1024*1024)
        self.event('merging','所有分片已校验，正在合并本地输入…',force=True,percent='100',mergeProgress=None)
        command=[self.tools('ffmpeg'),'-hide_banner','-nostdin','-y','-v','error','-xerror']
        for ti,track in enumerate(self.tracks):
            command+=['-protocol_whitelist','file,crypto,data','-allowed_extensions','ALL','-i',str(self.local_playlist(ti,track))]
        candidate=self.root/'candidate.mp4'
        if candidate.is_symlink():raise HlsError('UNSAFE_PATH','候选输出不能是符号链接。')
        command+=['-map','0:v:0','-map','1:a:0' if len(self.tracks)>1 else '0:a:0?',
                  '-c','copy','-movflags','+faststart',str(candidate)]
        self.save('verifying')
        self.run_process(command,max(60,min(3600,sum(r['bytes'] for r in self.data['completed'].values())/1024/1024*2)))
        self.event('verifying','正在验证 MP4 容器、音视频、时长及视频末尾…',force=True,percent='100',verificationProgress=None)
        probe=self.verify(candidate)
        self.data['candidateSha256']=sha_file(candidate)
        title=safe_title(self.message.get('sourceTitle') or self.message.get('pageTitle'))
        for n in range(1,10000):
            final=self.output/(title+(f' ({n})' if n>1 else '')+'.mp4')
            self.save('verifying',publishingPath=str(final))
            try:os.link(candidate,final)
            except FileExistsError:continue
            break
        else:raise HlsError('NAME_CONFLICT','同名文件过多，未覆盖任何文件。')
        self.save('completed',outputPath=str(final),probe=probe,canResume=False)
        self.cleanup(completed=True)
        return final,probe

    def verify(self,path):
        result=subprocess.run([self.tools('ffprobe'),'-v','error','-show_format','-show_streams','-of','json',str(path)],
                              capture_output=True,text=True,timeout=60)
        if result.returncode or result.stderr.strip():raise HlsError('VERIFY_FAILED','MP4 容器无法完整读取，数据已保留。')
        try:data=json.loads(result.stdout)
        except ValueError:raise HlsError('VERIFY_FAILED','FFprobe 没有返回有效结果。')
        videos=[s for s in data.get('streams',[]) if s.get('codec_type')=='video' and not s.get('disposition',{}).get('attached_pic')]
        audios=[s for s in data.get('streams',[]) if s.get('codec_type')=='audio']
        fmt=data.get('format') or {};duration=float(fmt.get('duration') or 0);expected=self.tracks[0]['duration']
        if not videos or not any(x in fmt.get('format_name','').split(',') for x in ('mov','mp4')):
            raise HlsError('VERIFY_FAILED','输出缺少有效视频流或 MP4 容器。')
        if len(self.tracks)>1 and not audios:raise HlsError('VERIFY_FAILED','独立音轨没有出现在成品中。')
        if abs(duration-expected)>max(0.75,min(3,expected*0.001)):
            raise HlsError('DURATION_MISMATCH','输出时长与完整 HLS 清单不符，禁止标记完成。')
        height=self.tracks[0].get('height')
        if height and videos[0].get('height')!=height:raise HlsError('QUALITY_MISMATCH','输出清晰度与所选版本不符。')
        for position in sorted({0,max(0,duration-1)}):
            self.run_process([self.tools('ffmpeg'),'-v','error','-nostdin','-xerror','-ss',str(position),'-i',str(path),
                '-t','1','-map','0:v:0','-map','0:a:0?','-f','null','-'],60)
        return {'duration':duration,'fileSize':path.stat().st_size,'height':videos[0].get('height',0),
                'width':videos[0].get('width',0),'hasAudio':bool(audios),'videoStreams':len(videos),'audioStreams':len(audios),
                'videoCodec':videos[0].get('codec_name',''),'audioCodec':audios[0].get('codec_name','') if audios else '',
                'fragmentsDone':len(self.data['completed']),'fragmentsTotal':self.data.get('fragmentsTotal',0),
                'warningCount':0,'warnings':[],'integrityVerified':True}

    def cleanup(self,completed=False):
        # Never sweep the user's Downloads folder, follow symlinks, or delete other jobs.
        for path in self.root.iterdir():
            if path.name=='checkpoint.json':continue
            if path.is_file() and not path.is_symlink() and re.fullmatch(r'(?:segment-\d+-\d+\.bin|asset-[0-9a-f]{24}\.(?:bin|key|mp4)|media-\d+-\d+\.(?:ts|m4s)|local-\d+\.m3u8|candidate\.mp4|ffmpeg-stage\.log|receipts\.jsonl|.*\.part)',path.name):path.unlink()
        if not completed:self.data['completed']={};self.data['assets']={};self.data['muxReady']=False;self.save('cancelled')

    def execute(self):
        try:
            if self.data.get('state')=='completed':
                output=Path(self.data.get('outputPath',''))
                if output.parent!=self.output or output.is_symlink() or not output.is_file() or sha_file(output)!=self.data.get('candidateSha256'):
                    raise HlsError('OUTPUT_CHANGED','已完成文件已移除或发生变化，未自动覆盖或重新下载。')
                return output,self.data['probe']
            # Repair a crash between atomic link publication and checkpoint commit.
            published=Path(self.data.get('publishingPath',''))
            if published.parent==self.output and published.is_file() and not published.is_symlink() and self.data.get('candidateSha256') and sha_file(published)==self.data['candidateSha256']:
                self.tracks=self.data['tracks'];probe=self.verify(published)
                self.save('completed',outputPath=str(published),probe=probe);self.cleanup(completed=True);return published,probe
            return self.download()
        except Cancelled as error:
            self.verify_entries();self.save('interrupted' if error.disconnected else 'cancelled',lastError=error.code)
            if not error.keep:self.cleanup()
            raise
        except HlsError as error:
            self.verify_entries()
            if error.code in ('PLAYLIST_CHANGED','CONTENT_CHANGED','IDENTITY_CHANGED','CHECKPOINT_INVALID'):
                self.save('attention',lastError=error.code,canResume=False,resumeBlocked=True)
                self.data['canResume']=False;atomic_json(self.path,self.data)
            else:self.save('attention' if error.refresh else 'failed',lastError=error.code,httpStatus=error.status)
            self.event(self.data['state'],str(error),force=True,errorCode=error.code,httpStatus=error.status,
                       fragmentsDone=len(self.data['completed']),fragmentsTotal=sum(len(t['segments']) for t in self.data.get('tracks',[])))
            raise
