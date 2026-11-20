const $ = id => document.getElementById(id);
async function loadState(){
 const s=await chrome.storage.local.get(["xdl_profileUrl","xdl_includeQuoted","xdl_maxTweets","xdl_scrollDelay","xdl_sourceMode","xdl_booruSite","xdl_tags","xdl_maxPosts","xdl_stats","xdl_status"]);
 $("profileUrl").value=s.xdl_profileUrl||"";$("includeQuoted").checked=s.xdl_includeQuoted??false;$("maxTweets").value=s.xdl_maxTweets??500;$("scrollDelay").value=s.xdl_scrollDelay??1500;
 $("sourceMode").value=s.xdl_sourceMode||"x";$("booruSite").value=s.xdl_booruSite||"danbooru";$("tags").value=s.xdl_tags||"";$("maxPosts").value=s.xdl_maxPosts??200;toggleSource();updateStats(s.xdl_stats);setStatus(s.xdl_status||"Ready");
}
function toggleSource(){const b=$("sourceMode").value==="booru";$("xOptions").hidden=b;$("booruOptions").hidden=!b;}
function setStatus(v){$("status").textContent=v||"Ready";}
function updateStats(s){if(!s)return;$("found").textContent=s.found??0;$("downloaded").textContent=s.downloaded??0;$("skipped").textContent=s.failed??0;$("queued").textContent=s.queued??0;}
$("sourceMode").addEventListener("change",toggleSource);
$("start").addEventListener("click",async()=>{
 if($("sourceMode").value==="booru"){
  const tags=$("tags").value.trim();if(!tags){setStatus("Enter at least one tag.");return;}
  const maxPosts=Math.max(1,Math.min(5000,Number($("maxPosts").value)||200));
  await chrome.storage.local.set({xdl_sourceMode:"booru",xdl_booruSite:$("booruSite").value,xdl_tags:tags,xdl_maxPosts:maxPosts});
  setStatus("Starting tag search...");
  try{const r=await chrome.runtime.sendMessage({type:"START_BOORU_SEARCH",options:{site:$("booruSite").value,tags,maxPosts}});setStatus(r?.ok?"Search started. You can close this popup.":r?.error||"Could not start search.");}catch(e){setStatus("Start failed: "+e.message);}return;
 }
 const profileUrl=$("profileUrl").value.trim();
 if(!/^https?:\/\/(www\.)?(x\.com|twitter\.com)\//i.test(profileUrl)){setStatus("Enter a valid X/Twitter profile URL.");return;}
 const maxTweets=Math.max(1,Math.min(10000,Number($("maxTweets").value)||500)),scrollDelay=Math.max(500,Math.min(10000,Number($("scrollDelay").value)||1500));
 await chrome.storage.local.set({xdl_sourceMode:"x",xdl_profileUrl:profileUrl,xdl_includeQuoted:$("includeQuoted").checked,xdl_maxTweets:maxTweets,xdl_scrollDelay:scrollDelay});
 const target=new URL(profileUrl);target.search="";target.hash="";
 const tab=(await chrome.tabs.query({active:true,currentWindow:true}))[0];let tabId=tab?.id;
 if(!tab?.url||!/^https?:\/\/(www\.)?(x\.com|twitter\.com)\//i.test(tab.url)||!sameProfile(tab.url,target.href)){
  if(tabId==null){const created=await chrome.tabs.create({url:target.href,active:false});tabId=created.id;}else await chrome.tabs.update(tabId,{url:target.href});
  await waitForTabComplete(tabId);
 }
 try{await chrome.scripting.executeScript({target:{tabId},files:["content/twitter-scanner.js"]});await chrome.tabs.sendMessage(tabId,{type:"START_SCAN",options:{includeQuoted:$("includeQuoted").checked,maxTweets,scrollDelay}});setStatus("Scanning X feed. Keep the tab open.");}catch(e){setStatus("Cannot start scanner: "+e.message);}
});
$("stop").addEventListener("click",async()=>{
 try{await chrome.runtime.sendMessage({type:"STOP_BOORU_SEARCH"});const tabs=await chrome.tabs.query({url:["https://x.com/*","https://twitter.com/*"]});for(const t of tabs){try{await chrome.tabs.sendMessage(t.id,{type:"STOP_SCAN"});}catch{}}setStatus("Stop requested.");}catch(e){setStatus("Stop failed: "+e.message);}
});
chrome.runtime.onMessage.addListener(m=>{if(m.type==="SCAN_STATUS"||m.type==="DOWNLOAD_STATUS"){setStatus(m.status);updateStats(m.stats);}});
chrome.storage.onChanged.addListener((c,a)=>{if(a!=="local")return;if(c.xdl_stats)updateStats(c.xdl_stats.newValue);if(c.xdl_status)setStatus(c.xdl_status.newValue);});
function sameProfile(a,b){try{const x=new URL(a),y=new URL(b);return x.hostname.replace("www.","")===y.hostname.replace("www.","")&&x.pathname.replace(/\/+$/,"")===y.pathname.replace(/\/+$/,"");}catch{return false;}}
function waitForTabComplete(id){return new Promise(resolve=>{const timeout=setTimeout(()=>{chrome.tabs.onUpdated.removeListener(listener);resolve();},20000);function listener(tabId,info){if(tabId===id&&info.status==="complete"){clearTimeout(timeout);chrome.tabs.onUpdated.removeListener(listener);setTimeout(resolve,1000);}}chrome.tabs.onUpdated.addListener(listener);});}
loadState();