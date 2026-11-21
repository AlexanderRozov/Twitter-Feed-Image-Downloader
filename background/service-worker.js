const QUEUE_KEY="xdl_download_queue",STATE_KEY="xdl_booru_job",PAUSED_KEY="xdl_queue_paused",MAX_PARALLEL=3;
let pumpRunning=false,pumpRequested=false;
chrome.runtime.onInstalled.addListener(()=>{chrome.alarms.create("xdl_queue_pump",{periodInMinutes:1});recoverQueue().catch(console.error);});
chrome.runtime.onStartup.addListener(()=>recoverQueue().catch(console.error));
chrome.alarms.onAlarm.addListener(a=>{if(a.name==="xdl_queue_pump")pumpQueue();});
chrome.runtime.onMessage.addListener((m,s,reply)=>{
 const run=async()=>{switch(m.type){
 case "DOWNLOAD_IMAGE": await enqueue([{url:m.url,source:"x",postId:m.tweetId,tags:[]}]);return {ok:true};
 case "X_SCAN_INIT": await initializeXScan(m.options||{});return {ok:true};
 case "X_SCAN_BATCH": return await addXScanBatch(m.items||[]);
 case "X_SCAN_PROGRESS": await updateXScanProgress(m.stats||{});return {ok:true};
 case "X_SCAN_FINISH": {const result=await finishXScan(m.reason||"completed");if(s.tab?.id!=null)await detachXBackground(s.tab.id);return result;}
 case "X_SCAN_BACKGROUND_ATTACH": return await attachXBackground(m.tabId);
 case "X_SCAN_BACKGROUND_DETACH": return await detachXBackground(m.tabId);
 case "START_BOORU_SEARCH": await startBooruSearch(m.options);return {ok:true};
 case "STOP_BOORU_SEARCH": await stopBooruSearch();return {ok:true};
 case "QUEUE_GET": return {queue:await getQueue(),paused:(await chrome.storage.local.get(PAUSED_KEY))[PAUSED_KEY]===true};
 case "QUEUE_PAUSE": await chrome.storage.local.set({[PAUSED_KEY]:true});return {ok:true};
 case "QUEUE_RESUME": await chrome.storage.local.set({[PAUSED_KEY]:false});pumpQueue();return {ok:true};
 case "QUEUE_RETRY_FAILED": {const q=await getQueue();for(const x of q)if(x.state==="failed"){x.state="pending";x.attempts=0;x.error=null;x.nextAttemptAt=0;}await setQueue(q);pumpQueue();return {ok:true};}
 case "QUEUE_RETRY_ONE": {const q=await getQueue(),x=q.find(y=>y.url===m.url);if(x&&x.state!=="downloading"){x.state="pending";x.attempts=0;x.error=null;x.nextAttemptAt=0;await setQueue(q);pumpQueue();}return {ok:true};}
 case "QUEUE_REMOVE": {const q=await getQueue(),x=q.find(y=>y.url===m.url);if(x&&x.state!=="downloading"){await setQueue(q.filter(y=>y.url!==m.url));}return {ok:true};}
 case "QUEUE_CLEAR_COMPLETED": await setQueue((await getQueue()).filter(x=>x.state!=="complete"));return {ok:true};
 default:return {ok:false,error:"Unknown command"};
 }};
 run().then(reply).catch(e=>reply({ok:false,error:e.message}));return true;
});
chrome.downloads.onChanged.addListener(d=>{if(d.state)settleDownload(d.id,d.state.current,d.error?.current).catch(console.error);});
async function recoverQueue(){
 const q=await getQueue();let changed=false;
 for(const item of q){
  if(item.state!=="downloading")continue;
  if(!Number.isInteger(item.downloadId)){item.state="pending";item.nextAttemptAt=0;item.error="Recovered after browser restart";changed=true;continue;}
  const matches=await chrome.downloads.search({id:item.downloadId});const download=matches[0];
  if(download?.state==="complete"){item.state="complete";item.completedAt=Date.now();changed=true;}
  else if(download?.state==="interrupted"){item.error=download.error||"Download interrupted";item.state=item.attempts<4?"pending":"failed";item.nextAttemptAt=Date.now()+Math.min(60000,2000*Math.pow(2,item.attempts));changed=true;}
  else if(!download){item.state="pending";item.downloadId=null;item.nextAttemptAt=0;item.error="Download was not found after browser restart";changed=true;}
 }
 if(changed)await setQueue(q);pumpQueue();
}
const X_DEBUGGER_TABS_KEY="xdl_debugger_tab_ids";
async function attachXBackground(tabId){
 if(!Number.isInteger(tabId))return {ok:false,error:"Invalid X tab ID"};
 try{
  const targets=await chrome.debugger.getTargets();
  const attached=targets.some(t=>t.tabId===tabId&&t.attached);
  if(!attached)await chrome.debugger.attach({tabId},"1.3");
  await chrome.debugger.sendCommand({tabId},"Page.setWebLifecycleState",{state:"active"}).catch(()=>{});
  await chrome.debugger.sendCommand({tabId},"Emulation.setFocusEmulationEnabled",{enabled:true}).catch(()=>{});
  const data=await chrome.storage.local.get(X_DEBUGGER_TABS_KEY),ids=new Set(data[X_DEBUGGER_TABS_KEY]||[]);ids.add(tabId);
  await chrome.storage.local.set({[X_DEBUGGER_TABS_KEY]:[...ids]});
  return {ok:true,experimental:true};
 }catch(e){return {ok:false,error:e.message};}
}
async function detachXBackground(tabId){
 if(!Number.isInteger(tabId))return {ok:true};
 try{await chrome.debugger.sendCommand({tabId},"Emulation.setFocusEmulationEnabled",{enabled:false}).catch(()=>{});await chrome.debugger.detach({tabId}).catch(()=>{});}catch{}
 const data=await chrome.storage.local.get(X_DEBUGGER_TABS_KEY),ids=(data[X_DEBUGGER_TABS_KEY]||[]).filter(id=>id!==tabId);
 await chrome.storage.local.set({[X_DEBUGGER_TABS_KEY]:ids});
 return {ok:true};
}
chrome.tabs.onRemoved.addListener(tabId=>{detachXBackground(tabId).catch(()=>{});});
chrome.debugger.onDetach.addListener(source=>{
 if(source.tabId!=null)detachXBackground(source.tabId).catch(()=>{});
});
const X_SCAN_KEY="xdl_x_scan_manifest";
async function initializeXScan(options){
 const manifest={id:Date.now().toString(),status:"discovering",targetPosts:Math.max(1,Math.min(10000,Number(options.maxTweets)||500)),includeQuoted:options.includeQuoted===true,startedAt:Date.now(),updatedAt:Date.now(),tweets:[],items:{},progress:{tweetsScanned:0,imagesFound:0}};
 await chrome.storage.local.set({[X_SCAN_KEY]:manifest,xdl_stats:{found:0,downloaded:0,failed:0,queued:0}});
 await setStatus("Collecting posts and image URLs...");
}
async function addXScanBatch(items){
 const data=await chrome.storage.local.get(X_SCAN_KEY),m=data[X_SCAN_KEY];
 if(!m||m.status!=="discovering")return {ok:false,error:"No active X discovery session"};
 const tweets=new Set(m.tweets||[]),known=m.items||{},discovered=[];let added=0;
 for(const item of items){
  if(!item||!item.url||!item.tweetId)continue;
  tweets.add(String(item.tweetId));
  const normalized=normalizeXMediaUrl(item.url),key=xMediaKey(normalized);if(!key||known[key])continue;
  const entry={url:normalized,source:"x",postId:String(item.tweetId),tweetId:String(item.tweetId),mediaKey:key,tags:[]};
  known[key]=entry;discovered.push(entry);added++;
 }
 m.tweets=[...tweets];m.items=known;m.updatedAt=Date.now();
 await chrome.storage.local.set({[X_SCAN_KEY]:m});
 // Enqueue each discovered batch immediately; don't wait for the full feed scan to finish.
 const queued=discovered.length?await enqueue(discovered):{added:0,retried:0,total:(await getQueue()).length};
 const statsData=await chrome.storage.local.get("xdl_stats"),previous=statsData.xdl_stats||{};
 await chrome.storage.local.set({xdl_stats:{...previous,found:Object.keys(known).length}});
 await updateStats();
 return {ok:true,added,total:Object.keys(known).length,tweets:tweets.size,queued:queued.added||0,queueTotal:queued.total||0};
}
function normalizeXMediaUrl(raw){
 try{const u=new URL(raw);const format=u.searchParams.get("format");u.search="";if(format)u.searchParams.set("format",format);u.searchParams.set("name","orig");return u.href;}catch{return raw;}
}
function xMediaKey(raw){
 try{const u=new URL(raw),match=u.pathname.match(/\/media\/([^/.?]+)/);if(!match)return null;return match[1]+":"+(u.searchParams.get("format")||"");}catch{return null;}
}
async function updateXScanProgress(progress){
 const data=await chrome.storage.local.get(X_SCAN_KEY),m=data[X_SCAN_KEY];if(!m||m.status!=="discovering")return;
 m.progress={...m.progress,...progress};m.updatedAt=Date.now();await chrome.storage.local.set({[X_SCAN_KEY]:m});
 const count=Object.keys(m.items||{}).length;
 await setStatus("Collecting: "+(m.progress.tweetsScanned||0)+" posts, "+count+" unique images...");
}
async function finishXScan(reason){
 const data=await chrome.storage.local.get(X_SCAN_KEY),m=data[X_SCAN_KEY];
 if(!m||m.status!=="discovering")return {ok:false,error:"No active X discovery session"};
 const items=Object.values(m.items||{});m.status=reason==="stopped"?"stopped":"discovered";m.finishedAt=Date.now();m.updatedAt=Date.now();
 await chrome.storage.local.set({[X_SCAN_KEY]:m,xdl_stats:{found:items.length,downloaded:0,failed:0,queued:items.length}});
 if(items.length){await enqueue(items);await setStatus("Discovery "+(reason==="stopped"?"stopped":"complete")+": "+(m.tweets||[]).length+" posts, "+items.length+" unique images. Downloads started.");}
 else await setStatus("Discovery finished: no downloadable images were found.");
 return {ok:true,tweets:(m.tweets||[]).length,images:items.length,status:m.status};
}
async function getQueue(){const x=await chrome.storage.local.get(QUEUE_KEY);return Array.isArray(x[QUEUE_KEY])?x[QUEUE_KEY]:[];}
async function setQueue(q){await chrome.storage.local.set({[QUEUE_KEY]:q});await updateStats();}
async function enqueue(items){
 const q=await getQueue(),byKey=new Map(q.map(item=>[item.key||dedupeKey(item.url),item]));
 let added=0,retried=0;
 for(const item of items){
  if(!item?.url)continue;
  const key=dedupeKey(item.url),existing=byKey.get(key);
  if(existing){
   if(existing.state==="failed"){
    Object.assign(existing,item,{key,state:"pending",attempts:0,error:null,nextAttemptAt:0,downloadId:null,addedAt:Date.now()});
    retried++;
   }
   continue;
  }
  const queued={...item,key,state:"pending",attempts:0,error:null,nextAttemptAt:0,addedAt:Date.now()};
  q.push(queued);byKey.set(key,queued);added++;
 }
 await setQueue(q);
 if(added||retried)pumpQueue();
 return {ok:true,added,retried,total:q.length};
}
function dedupeKey(raw){try{const u=new URL(raw);u.hash="";return u.origin+u.pathname+u.search;}catch{return raw;}}
async function updateStats(){const q=await getQueue(),d=await chrome.storage.local.get("xdl_stats"),p=d.xdl_stats||{};const stats={found:p.found||0,downloaded:q.filter(x=>x.state==="complete").length,failed:q.filter(x=>x.state==="failed").length,queued:q.filter(x=>["pending","downloading"].includes(x.state)).length};await chrome.storage.local.set({xdl_stats:stats});chrome.runtime.sendMessage({type:"DOWNLOAD_STATUS",status:"Queue: "+stats.queued,stats}).catch(()=>{});}
async function setStatus(status){await chrome.storage.local.set({xdl_status:status});const d=await chrome.storage.local.get("xdl_stats");chrome.runtime.sendMessage({type:"DOWNLOAD_STATUS",status,stats:d.xdl_stats||{}}).catch(()=>{});}
function allowed(raw,source){try{const u=new URL(raw),h=u.hostname.toLowerCase();if(!/^https?:$/.test(u.protocol))return false;if(source==="x")return h==="pbs.twimg.com"&&u.pathname.includes("/media/");if(source==="danbooru")return h==="danbooru.donmai.us"||h.endsWith(".donmai.us");if(source==="gelbooru")return h==="gelbooru.com"||h.endsWith(".gelbooru.com");if(source==="rule34")return h==="rule34.xxx"||h.endsWith(".rule34.xxx");return false;}catch{return false;}}
function ext(raw){try{const u=new URL(raw),e=u.pathname.match(/\.(jpe?g|png|webp|gif|avif)$/i)?.[1]?.toLowerCase();return e==="jpeg"?"jpg":e||"jpg";}catch{return "jpg";}}
function safe(v){return String(v||"image").replace(/[^a-zA-Z0-9_-]/g,"_").slice(0,80);}
async function pumpQueue(){
 if(pumpRunning){pumpRequested=true;return;}
 pumpRunning=true;
 try{
  const settings=await chrome.storage.local.get(PAUSED_KEY);if(settings[PAUSED_KEY])return;
  const q=await getQueue();
  let slots=Math.max(0,MAX_PARALLEL-q.filter(x=>x.state==="downloading").length);
  const toStart=[];
  for(const item of q){
   if(!slots)break;
   if(item.state!=="pending"||(item.nextAttemptAt&&item.nextAttemptAt>Date.now()))continue;
   if(!allowed(item.url,item.source)){item.state="failed";item.error="URL host not allowed";continue;}
   item.state="downloading";item.attempts++;toStart.push({...item});slots--;
  }
  // Persist before starting downloads; never overwrite later download IDs with this snapshot.
  await setQueue(q);
  // Serialize creation and ID persistence to prevent lost IDs from concurrent storage writes.
  for(const item of toStart){
   try{await startDownload(item);}
   catch(e){
    const latest=await getQueue(),x=latest.find(y=>(y.key||dedupeKey(y.url))===item.key);
    if(x){
     x.error=e.message;x.state=x.attempts<4?"pending":"failed";
     x.nextAttemptAt=Date.now()+Math.min(60000,2000*Math.pow(2,x.attempts));
     await setQueue(latest);
     if(x.state==="pending")chrome.alarms.create("xdl_queue_pump",{when:x.nextAttemptAt});
    }
   }
  }
 }finally{
  pumpRunning=false;
  if(pumpRequested){pumpRequested=false;queueMicrotask(()=>pumpQueue());}
 }
}
async function startDownload(item){const organize=(await chrome.storage.local.get("xdl_organize_folders")).xdl_organize_folders===true;const sourceFolder=item.source==="x"?"X_Feed":item.source[0].toUpperCase()+item.source.slice(1);const tagFolder=safe(item.folderTag||"");const folder=organize?(item.source==="x"?sourceFolder:sourceFolder+(tagFolder?"/"+tagFolder:"")):"";const filename=(folder?folder+"/":"")+safe(item.postId||item.id||Date.now())+"."+ext(item.url);const id=await new Promise((resolve,reject)=>chrome.downloads.download({url:item.url,filename,conflictAction:"uniquify",saveAs:false},n=>{if(chrome.runtime.lastError)reject(new Error(chrome.runtime.lastError.message));else if(n==null)reject(new Error("Download was not created"));else resolve(n);}));const q=await getQueue(),x=q.find(y=>(y.key||dedupeKey(y.url))===(item.key||dedupeKey(item.url)));if(x){x.downloadId=id;await setQueue(q);}const [d]=await chrome.downloads.search({id});if(d?.state==="complete")await settleDownload(id,"complete");else if(d?.state==="interrupted")await settleDownload(id,"interrupted",d.error);}
async function settleDownload(id,state,error){const q=await getQueue(),x=q.find(y=>y.downloadId===id);if(!x)return;if(state==="complete"){x.state="complete";x.completedAt=Date.now();}else if(state==="interrupted"){x.error=error||"Download interrupted";if(x.attempts<4){x.state="pending";x.nextAttemptAt=Date.now()+Math.min(60000,2000*Math.pow(2,x.attempts));}else x.state="failed";}else return;await setQueue(q);chrome.alarms.create("xdl_queue_pump",{when:Date.now()+Math.max(1000,(x.nextAttemptAt||Date.now())-Date.now())});}
function splitTags(s){return String(s||"").trim().split(/[\s,]+/).map(x=>x.trim().toLowerCase()).filter(Boolean);}
function postTags(p){const raw=p.tag_string||p.tags||p.tag_string_general||"";return new Set((Array.isArray(raw)?raw:String(raw).split(/\s+/)).map(x=>String(x).toLowerCase()));}
function isBlacklisted(p,blacklist){const tags=postTags(p);return blacklist.some(t=>tags.has(t));}
async function startBooruSearch(o){const site=o?.site,tags=String(o?.tags||"").trim(),blacklist=splitTags(o?.blacklistTags),gelbooruUserId=String(o?.gelbooruUserId||"").trim(),gelbooruApiKey=String(o?.gelbooruApiKey||"").trim(),max=Math.max(1,Math.min(5000,Number(o?.maxPosts)||200));if(!tags)throw Error("At least one tag is required");if(!["danbooru","gelbooru","rule34"].includes(site))throw Error("Unsupported gallery");const folderTag=tags.split(/\s+/).find(t=>t&&!t.startsWith("-"))||"";await chrome.storage.local.set({[STATE_KEY]:{site,tags,max,blacklist,cancelled:false,startedAt:Date.now()},xdl_organize_folders:o.organizeFolders===true,xdl_stats:{found:0,downloaded:0,failed:0,queued:0}});await setStatus("Searching "+site+" for: "+tags);const posts=await fetchPosts(site,tags,max,blacklist,{gelbooruUserId,gelbooruApiKey}),items=posts.filter(p=>p.file_url&&!p.is_deleted&&!p.is_pending).map(p=>({url:p.file_url,source:site,postId:p.id,tags:[...postTags(p)],folderTag}));if(!items.length)throw Error("No original files matched. Check tags, blacklist, site access, or API availability.");await chrome.storage.local.set({xdl_stats:{found:items.length,downloaded:0,failed:0,queued:items.length}});await enqueue(items);await setStatus("Found "+items.length+" matching originals; downloads continue in background.");}
async function stopBooruSearch(){const d=await chrome.storage.local.get(STATE_KEY);if(d[STATE_KEY])await chrome.storage.local.set({[STATE_KEY]:{...d[STATE_KEY],cancelled:true}});await setStatus("Search stopped; queued downloads remain active.");}
async function searchCancelled(){const d=await chrome.storage.local.get(STATE_KEY);return d[STATE_KEY]?.cancelled===true;}
async function fetchPosts(site,tags,max,blacklist,credentials={}){if(site==="gelbooru")return fetchGelbooruPosts(tags,max,blacklist,credentials);const out=[],size=100,searchTags=[tags,...blacklist.map(t=>"-"+t)].join(" ");for(let page=0;out.length<max&&page<Math.ceil(max/size)+4;page++){if(await searchCancelled())break;let u;if(site==="danbooru"){u=new URL("https://danbooru.donmai.us/posts.json");u.searchParams.set("tags",searchTags);u.searchParams.set("limit",String(Math.min(size,max-out.length)));u.searchParams.set("page",String(page+1));}else{u=new URL("https://api.rule34.xxx/index.php");for(const [k,v] of Object.entries({page:"dapi",s:"post",q:"index",json:"1",limit:String(Math.min(size,max-out.length)),pid:String(page),tags:searchTags}))u.searchParams.set(k,v);}const r=await fetch(u,{headers:{Accept:"application/json"}});if(!r.ok)throw Error(site+" API returned HTTP "+r.status);const data=await r.json(),posts=Array.isArray(data)?data:(Array.isArray(data?.post)?data.post:[]);if(!posts.length)break;out.push(...posts.filter(p=>!isBlacklisted(p,blacklist)));if(posts.length<size)break;}return out.slice(0,max);}
async function fetchGelbooruPosts(tags,max,blacklist,credentials={}){let apiError=null;try{return await fetchGelbooruApi(tags,max,blacklist,credentials);}catch(e){apiError=e;}await setStatus("Gelbooru API unavailable ("+apiError.message+"); trying public HTML search...");try{const posts=await fetchGelbooruHtml(tags,max,blacklist);if(posts.length)return posts.slice(0,max);throw Error("The public HTML search returned no posts with resolvable original URLs.");}catch(htmlError){throw Error("Gelbooru DAPI failed: "+apiError.message+". HTML fallback failed: "+htmlError.message);}}
async function fetchGelbooruApi(tags,max,blacklist,credentials){const out=[],size=100,searchTags=[tags,...blacklist.map(t=>"-"+t)].join(" ");for(let pid=0;out.length<max&&pid<Math.ceil(max/size)+4;pid++){if(await searchCancelled())break;const u=new URL("https://gelbooru.com/index.php");for(const [k,v] of Object.entries({page:"dapi",s:"post",q:"index",json:"1",limit:String(Math.min(size,max-out.length)),pid:String(pid),tags:searchTags}))u.searchParams.set(k,v);if(credentials.gelbooruApiKey&&credentials.gelbooruUserId){u.searchParams.set("api_key",credentials.gelbooruApiKey);u.searchParams.set("user_id",credentials.gelbooruUserId);}const r=await fetch(u,{headers:{Accept:"application/json"}});if(!r.ok)throw Error("HTTP "+r.status);const body=await r.text();let data;try{data=JSON.parse(body);}catch{throw Error("DAPI returned non-JSON content");}const posts=Array.isArray(data)?data:(Array.isArray(data?.post)?data.post:null);if(!posts)throw Error("DAPI response did not contain a post array");if(!posts.length)break;const normalized=posts.map(resolveGelbooruOriginal).filter(Boolean);out.push(...normalized.filter(p=>!isBlacklisted(p,blacklist)));if(posts.length<size)break;}return out.slice(0,max);}
async function fetchGelbooruHtml(tags,max,blacklist){const out=[],pageSize=20,searchTags=[tags,...blacklist.map(t=>"-"+t)].join(" ");for(let page=0;out.length<max&&page<Math.ceil(max/pageSize)+2;page++){if(await searchCancelled())break;const u=new URL("https://gelbooru.com/index.php");u.searchParams.set("page","post");u.searchParams.set("s","list");u.searchParams.set("tags",searchTags);u.searchParams.set("pid",String(page*pageSize));const r=await fetch(u,{headers:{Accept:"text/html,application/xhtml+xml"}});if(!r.ok)throw Error("HTML search returned HTTP "+r.status);const html=await r.text();if(!/class=["'][^"']*thumb/i.test(html)&&!/<a\b[^>]*id=["']p\d+/i.test(html))throw Error("response did not look like a Gelbooru post listing");const posts=parseGelbooruHtmlPosts(html);out.push(...posts.filter(p=>!isBlacklisted(p,blacklist)));if(posts.length<pageSize)break;}return out.slice(0,max);}
function parseGelbooruHtmlPosts(html){const posts=[],anchorRe=/<a\b[^>]*\bid=["']p(\d+)["'][^>]*>([\s\S]*?)<\/a>/gi;let match;while((match=anchorRe.exec(html))!==null){const imgMatch=match[2].match(/<img\b[^>]*>/i);if(!imgMatch)continue;const img=imgMatch[0],preview=getHtmlAttribute(img,"src");if(!preview)continue;const title=decodeHtml(getHtmlAttribute(img,"title")||getHtmlAttribute(img,"alt")||"");const tagText=title.replace(/\s+(?:score|rating|user|id|posted|parent):.*$/i,"").trim();const tags=tagText?tagText.split(/\s+/).filter(Boolean):[];const fileUrl=gelbooruOriginalFromPreview(preview);if(!fileUrl)continue;posts.push({id:match[1],file_url:fileUrl,tag_string:tags.join(" "),preview_url:preview});}return posts;}
function getHtmlAttribute(tag,name){const re=new RegExp("\\b"+name+"\\s*=\\s*([\"'])(.*?)\\1","i"),m=tag.match(re);return m?m[2]:null;}
function decodeHtml(value){return String(value||"").replace(/&amp;/g,"&").replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&nbsp;/g," ");}
function gelbooruOriginalFromPreview(raw){try{const u=new URL(raw,"https://gelbooru.com"),before=u.pathname;u.pathname=u.pathname.replace("/thumbnails/","/images/").replace("/thumbnail_","/");if(u.pathname===before||!before.includes("/thumbnails/")||!before.includes("/thumbnail_"))return null;return u.href;}catch{return null;}}
function resolveGelbooruOriginal(post){if(post?.file_url&&/^https?:\/\//i.test(post.file_url))return post;const preview=post?.preview_url;if(!preview)return null;const original=gelbooruOriginalFromPreview(preview);return original?{...post,file_url:original}:null;}
