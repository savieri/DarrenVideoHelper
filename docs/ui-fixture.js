// UI-only fixture: no network media download or extension APIs are executed.
const sample = {
  ok:true,tabId:1,mode:'full',pageTitle:'Video Helper · UI sample',sessionId:'sample',pageUrl:'https://example.test/video',
  detectedStreamCount:1,warning:'',queuePaused:false,jobs:[{id:'ui-attention',status:'attention',kind:'hls_media',canResume:true,
    title:'SAFE-001 Generated video with a long descriptive title for layout verification',message:'模拟 HTTP 403：分片被服务器拒绝。数据已保留，请重新检测或在原页面授权。',
    percent:'33.3',fragmentsDone:827,fragmentsTotal:2482,downloadedBytes:1234567890,httpStatus:403,errorCode:'HTTP_403',createdAt:1},
    {id:'ui-verifying',status:'verifying',kind:'hls_media',canResume:true,title:'SAFE-002 Generated video',message:'正在核对时长、音轨和视频末尾…',percent:'100',fragmentsDone:2482,fragmentsTotal:2482,createdAt:0}],captureGaps:[],
  streams:[{id:'sample',resourceId:'sample',kind:'mp4',resourceUrl:'https://example.test/sample.mp4',
    sourceTitle:'Sample video · 界面演示',group:'recommended',recommended:true,canDownloadWholeVideo:true,
    formatLabel:'MP4',durationLabel:'0:08',host:'example.test',quality:360,qualityLabel:'360p',sizeLabel:'约 640 KB',
    previewStrategy:'poster',sources:['network','DOM'],frameId:0,playerTitle:'Sample player',
    availability:'Chrome 直接下载',sizeBasis:'示例测试数据',recommendationReason:'UI fixture — not a live download'}]
};
window.chrome={runtime:{lastError:null,getManifest:()=>({version_name:'1.2.1-beta.17 · UI sample'}),
  onMessage:{addListener(){}},openOptionsPage(){},
  sendMessage(message,callback){callback(message.type==='getStreams'?structuredClone(sample)
    :message.type==='getJobs'?{ok:true,jobs:structuredClone(sample.jobs),queuePaused:false}:{ok:false,error:'UI sample only; no download started.'});}},
  tabs:{query:async()=>[{id:1,title:sample.pageTitle,url:sample.pageUrl}]}};
