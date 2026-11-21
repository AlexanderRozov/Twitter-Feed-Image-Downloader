const $ = id => document.getElementById(id);
async function loadState(){
 const keys=["xdl_profileUrl","xdl_includeQuoted","xdl_maxTweets","xdl_scrollDelay","xdl_backgroundMode","xdl_sourceMode","xdl_booruSite","xdl_tags","xdl_maxPosts","xdl_blacklist_tags","xdl_organize_folders","xdl_gelbooru_user_id","xdl_gelbooru_api_key","xdl_start_mode","xdl_start_post_number","xdl_start_date","xdl_stats","xdl_status"];
 const s=await chrome.storage.local.get(keys);
 $("profileUrl").value=s.xdl_profileUrl||"";$("includeQuoted").checked=s.xdl_includeQuoted??false;$("maxTweets").value=s.xdl_maxTweets??500;$("scrollDelay").value=s.xdl_scrollDelay??250;$("backgroundMode").checked=s.xdl_backgroundMode??true;
 $("startMode").value=s.xdl_start_mode||"first";$("startPostNumber").value=s.xdl_start_post_number??1;$("startDate").value=s.xdl_start_date||"";
 $("sourceMode").value=s.xdl_sourceMode||"x";$("booruSite").value=s.xdl_booruSite||"danbooru";$("tags").value=s.xdl_tags||"";$("maxPosts").value=s.xdl_maxPosts??200;$("blacklistTags").value=s.xdl_blacklist_tags||"";$("gelbooruUserId").value=s.xdl_gelbooru_user_id||"";$("gelbooruApiKey").value=s.xdl_gelbooru_api_key||"";$("organizeFolders").checked=s.xdl_organize_folders===true;toggleSource();toggleStartOptions();updateStats(s.xdl_stats);setStatus(s.xdl_status||"Ready");
}
function toggleSource(){const b=$("sourceMode").value==="booru";$("xOptions").hidden=b;$("booruOptions").hidden=!b;toggleGelbooruCredentials();}
function toggleGelbooruCredentials(){$("gelbooruCredentials").hidden=!($("sourceMode").value==="booru"&&$("booruSite").value==="gelbooru");}
function toggleStartOptions(){const mode=$("startMode").value;$("startNumberOptions").hidden=mode!=="number";$("startDateOptions").hidden=mode!=="date";}
$("booruSite").addEventListener("change",toggleGelbooruCredentials);
$("startMode").addEventListener("change",toggleStartOptions);
function setStatus(v){$("status").textContent=v||"Ready";}
function updateStats(s){if(!s)return;$("found").textContent=s.found??0;$("downloaded").textContent=s.downloaded??0;$("skipped").textContent=s.failed??0;$("queued").textContent=s.queued??0;}
$("sourceMode").addEventListener("change",toggleSource);
$("openQueue").addEventListener("click",()=>chrome.tabs.create({url:chrome.runtime.getURL("queue/queue.html")}));
$("start").addEventListener("click",async()=>{
 if($("sourceMode").value==="booru"){
  const tags=$("tags").value.trim();if(!tags){setStatus("Enter at least one tag.");return;}
  const maxPosts=Math.max(1,Math.min(5000,Number($("maxPosts").value)||200));
  await chrome.storage.local.set({xdl_sourceMode:"booru",xdl_booruSite:$("booruSite").value,xdl_tags:tags,xdl_maxPosts:maxPosts,xdl_blacklist_tags:$("blacklistTags").value.trim(),xdl_organize_folders:$("organizeFolders").checked,xdl_gelbooru_user_id:$("gelbooruUserId").value.trim(),xdl_gelbooru_api_key:$("gelbooruApiKey").value.trim()});
  setStatus("Starting tag search...");
  try{const r=await chrome.runtime.sendMessage({type:"START_BOORU_SEARCH",options:{site:$("booruSite").value,tags,maxPosts,blacklistTags:$("blacklistTags").value,organizeFolders:$("organizeFolders").checked,gelbooruUserId:$("gelbooruUserId").value.trim(),gelbooruApiKey:$("gelbooruApiKey").value.trim()}});setStatus(r?.ok?"Search started. You can close this popup.":r?.error||"Could not start search.");}catch(e){setStatus("Start failed: "+e.message);}return;
 }
 const profileUrl=$("profileUrl").value.trim();
 if(!/^https?:\/\/(www\.)?(x\.com|twitter\.com)\//i.test(profileUrl)){setStatus("Enter a valid X/Twitter profile URL.");return;}
 const startMode=$("startMode").value;
 const startPostNumber=Math.max(1,Math.min(100000,Number($("startPostNumber").value)||1));
 const startDateDisplay=$("startDate").value.trim();
 let startDate="";
 if(startMode==="date"){
  const match=startDateDisplay.match(/^(\\d{2})\\.(\\d{2})\\.(\\d{4})$/);
  if(!match){setStatus("Enter the date in DD.MM.YYYY format.");return;}
  const day=Number(match[1]),month=Number(match[2]),year=Number(match[3]);
  const check=new Date(year,month-1,day);
  if(check.getFullYear()!==year||check.getMonth()!==month-1||check.getDate()!==day){setStatus("The entered date does not exist.");return;}
  startDate=year+"-"+String(month).padStart(2,"0")+"-"+String(day).padStart(2,"0");
 }
 const maxTweets=Math.max(1,Math.min(10000,Number($("maxTweets").value)||500)),scrollDelay=Math.max(100,Math.min(5000,Number($("scrollDelay").value)||250)),backgroundMode=$("backgroundMode").checked;
 let debuggerGranted=false,debuggerAttached=false,backgroundNotice="";
 if(backgroundMode){try{debuggerGranted=await chrome.permissions.request({permissions:["debugger"]});if(!debuggerGranted)backgroundNotice="Background optimization was not granted; Chromium may throttle minimized tabs.";}catch(e){backgroundNotice="Background optimization unavailable ("+e.message+"); using normal scanning.";}}
 await chrome.storage.local.set({xdl_sourceMode:"x",xdl_profileUrl:profileUrl,xdl_includeQuoted:$("includeQuoted").checked,xdl_maxTweets:maxTweets,xdl_scrollDelay:scrollDelay,xdl_backgroundMode:backgroundMode,xdl_organize_folders:$("organizeFolders").checked,xdl_start_mode:startMode,xdl_start_post_number:startPostNumber,xdl_start_date:startDateDisplay});
 const target=new URL(profileUrl);target.search="";target.hash="";
 const tab=(await chrome.tabs.query({active:true,currentWindow:true}))[0];let tabId=tab?.id;
 if(tabId==null){const created=await chrome.tabs.create({url:target.href,active:false});tabId=created.id;await waitForTabComplete(tabId);}
 else if(!tab?.url||!/^https?:\/\/(www\.)?(x\.com|twitter\.com)\//i.test(tab.url)||!sameProfile(tab.url,target.href)){
  await chrome.tabs.update(tabId,{url:target.href});
  await waitForTabComplete(tabId);
 }else{
  // Reload the profile to discard any old injected scanner instance after an extension update.
  await reloadTabAndWait(tabId);
 }
 try{
   if(debuggerGranted){const keep=await chrome.runtime.sendMessage({type:"X_SCAN_BACKGROUND_ATTACH",tabId});debuggerAttached=keep?.ok===true;if(!debuggerAttached)backgroundNotice="Background optimization unavailable ("+(keep?.error||"unknown error")+"); using normal scanning.";}
   const init=await chrome.runtime.sendMessage({type:"X_SCAN_INIT",options:{includeQuoted:$("includeQuoted").checked,maxTweets}});
   if(!init?.ok)throw new Error(init?.error||"Could not initialize scan");
   await chrome.scripting.executeScript({target:{tabId},files:["content/twitter-scanner.js"]});
   await chrome.tabs.sendMessage(tabId,{type:"START_SCAN",options:{includeQuoted:$("includeQuoted").checked,maxTweets,scrollDelay,scrollStep:1.05,waitForFeedMs:scrollDelay,settleDelay:75,startMode,startPostNumber,startDate,startDateDisplay}});
   const startLabel=startMode==="number"?"post #"+startPostNumber:startMode==="date"?"date "+startDateDisplay:"the first post";
   setStatus("Collection from "+startLabel+" started. Downloads are added to the queue as images are found."+(backgroundNotice?" "+backgroundNotice:""));
  }catch(e){if(debuggerAttached&&tabId!=null)await chrome.runtime.sendMessage({type:"X_SCAN_BACKGROUND_DETACH",tabId}).catch(()=>{});setStatus("Cannot start scanner: "+e.message);}
});
$("stop").addEventListener("click",async()=>{
 try{await chrome.runtime.sendMessage({type:"STOP_BOORU_SEARCH"});const tabs=await chrome.tabs.query({url:["https://x.com/*","https://twitter.com/*"]});for(const t of tabs){try{await chrome.tabs.sendMessage(t.id,{type:"STOP_SCAN"});}catch{}}setStatus("Stop requested.");}catch(e){setStatus("Stop failed: "+e.message);}
});
chrome.runtime.onMessage.addListener(m=>{if(m.type==="SCAN_STATUS"||m.type==="DOWNLOAD_STATUS"){setStatus(m.status);updateStats(m.stats);}});
chrome.storage.onChanged.addListener((c,a)=>{if(a!=="local")return;if(c.xdl_stats)updateStats(c.xdl_stats.newValue);if(c.xdl_status)setStatus(c.xdl_status.newValue);});
function sameProfile(a,b){try{const x=new URL(a),y=new URL(b);return x.hostname.replace("www.","")===y.hostname.replace("www.","")&&x.pathname.replace(/\/+$/,"")===y.pathname.replace(/\/+$/,"");}catch{return false;}}
async function waitForTabComplete(id){const current=await chrome.tabs.get(id);if(current.status==="complete"){await new Promise(resolve=>setTimeout(resolve,800));return;}return waitForNextComplete(id);}
async function waitForNextComplete(id){return new Promise(resolve=>{let done=false;const finish=()=>{if(done)return;done=true;clearTimeout(timeout);chrome.tabs.onUpdated.removeListener(listener);setTimeout(resolve,700);};const timeout=setTimeout(finish,30000);function listener(tabId,info){if(tabId===id&&info.status==="complete")finish();}chrome.tabs.onUpdated.addListener(listener);});}
async function reloadTabAndWait(id){const loaded=waitForNextComplete(id);await chrome.tabs.reload(id);await loaded;}
loadState();
