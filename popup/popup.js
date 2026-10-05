const $ = (id) => document.getElementById(id);

async function getActiveTab() {
  const tabs = await chrome.tabs.query({active: true, currentWindow: true});
  return tabs[0];
}

async function loadState() {
  const state = await chrome.storage.local.get([
    "xdl_profileUrl",
    "xdl_includeQuoted",
    "xdl_maxTweets",
    "xdl_scrollDelay"
  ]);

  if (state.xdl_profileUrl) $("profileUrl").value = state.xdl_profileUrl;
  $("includeQuoted").checked = state.xdl_includeQuoted ?? false;
  $("maxTweets").value = state.xdl_maxTweets ?? 500;
  $("scrollDelay").value = state.xdl_scrollDelay ?? 1500;
}

async function saveSettings() {
  await chrome.storage.local.set({
    xdl_profileUrl: $("profileUrl").value.trim(),
    xdl_includeQuoted: $("includeQuoted").checked,
    xdl_maxTweets: Number($("maxTweets").value),
    xdl_scrollDelay: Number($("scrollDelay").value)
  });
}

function setStatus(text) {
  $("status").textContent = text;
}

function updateStats(s) {
  if (!s) return;
  $("tweets").textContent = s.tweetsScanned ?? 0;
  $("found").textContent = s.imagesFound ?? 0;
  $("downloaded").textContent = s.downloaded ?? 0;
  $("skipped").textContent = s.skipped ?? 0;
}

$("start").addEventListener("click", async () => {
  await saveSettings();

  const tab = await getActiveTab();
  const url = $("profileUrl").value.trim();

  if (!/^https?:\/\/(www\.)?(x\.com|twitter\.com)\//i.test(url)) {
    setStatus("Enter a valid X/Twitter profile URL.");
    return;
  }

  setStatus("Opening profile...");

  const targetUrl = new URL(url);
  targetUrl.search = "";
  targetUrl.hash = "";

  if (!tab?.url || !/^https?:\/\/(www\.)?(x\.com|twitter\.com)\//i.test(tab.url) ||
      !sameProfile(tab.url, targetUrl.href)) {
    await chrome.tabs.update(tab.id, {url: targetUrl.href});
    await waitForTabComplete(tab.id);
  }

  try {
    await chrome.scripting.executeScript({
      target: {tabId: tab.id},
      files: ["content/twitter-scanner.js"]
    });

    await chrome.tabs.sendMessage(tab.id, {
      type: "START_SCAN",
      options: {
        includeQuoted: $("includeQuoted").checked,
        maxTweets: Number($("maxTweets").value),
        scrollDelay: Number($("scrollDelay").value)
      }
    });

    setStatus("Scanning...");
  } catch (e) {
    setStatus("Cannot start scanner: " + e.message);
  }
});

$("stop").addEventListener("click", async () => {
  const tab = await getActiveTab();
  if (!tab?.id) return;

  try {
    await chrome.tabs.sendMessage(tab.id, {type: "STOP_SCAN"});
    setStatus("Stopping...");
  } catch {
    setStatus("Scanner is not running.");
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "SCAN_STATUS") {
    setStatus(message.status || "Running...");
    updateStats(message.stats);
  }
});

function sameProfile(a, b) {
  try {
    const x = new URL(a);
    const y = new URL(b);
    return x.hostname.replace("www.", "") === y.hostname.replace("www.", "")
      && x.pathname.replace(/\/+$/, "") === y.pathname.replace(/\/+$/, "");
  } catch {
    return false;
  }
}

function waitForTabComplete(tabId) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 15000);

    function listener(id, info) {
      if (id === tabId && info.status === "complete") {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(resolve, 1200);
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
  });
}

loadState();