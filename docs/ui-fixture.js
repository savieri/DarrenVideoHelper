// UI-only fixture: no network media download or extension APIs are executed.
const sample = {
  ok:true,tabId:1,mode:'chrome',pageTitle:'Video Helper · UI sample',sessionId:'sample',pageUrl:'https://example.test/video',
  detectedStreamCount:1,warning:'',queuePaused:false,jobs:[],captureGaps:[],
  streams:[{id:'sample',resourceId:'sample',kind:'mp4',resourceUrl:'https://example.test/sample.mp4',
    sourceTitle:'Sample video · 界面演示',group:'recommended',recommended:true,canDownloadWholeVideo:true,
    formatLabel:'MP4',durationLabel:'0:08',host:'example.test',quality:360,qualityLabel:'360p',sizeLabel:'约 640 KB',
    previewStrategy:'poster',sources:['network','DOM'],frameId:0,playerTitle:'Sample player',
    availability:'Chrome 直接下载',sizeBasis:'示例测试数据',recommendationReason:'UI fixture — not a live download'}]
};
window.chrome={runtime:{lastError:null,getManifest:()=>({version_name:'1.2.1-beta.16 · UI sample'}),
  onMessage:{addListener(){}},openOptionsPage(){},
  sendMessage(message,callback){callback(message.type==='getStreams'?structuredClone(sample)
    :message.type==='getJobs'?{ok:true,jobs:[],queuePaused:false}:{ok:false,error:'UI sample only; no download started.'});}},
  tabs:{query:async()=>[{id:1,title:sample.pageTitle,url:sample.pageUrl}]}};
