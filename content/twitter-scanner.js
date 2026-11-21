(() => {
  if (window.__xdlScannerInstalled) return;
  window.__xdlScannerInstalled = true;
  let running = false, stopRequested = false, options = {};
  let stats = { tweetsScanned: 0, imagesFound: 0, skipped: 0 };
  const seenTweets = new Set(), seenMedia = new Set(), noMediaRetries = new Map();
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  function sendStatus(status) { chrome.runtime.sendMessage({ type: "SCAN_STATUS", status, stats }).catch(() => {}); }
  function normalizeImageUrl(src) {
    if (!src) return null;
    try {
      const url = new URL(src);
      if (url.hostname !== "pbs.twimg.com" || !url.pathname.includes("/media/")) return null;
      const format = url.searchParams.get("format"); url.search = "";
      if (format) url.searchParams.set("format", format);
      url.searchParams.set("name", "orig"); return url.href;
    } catch { return null; }
  }
  function mediaKey(url) {
    try { const p = new URL(url), m = p.pathname.match(/\/media\/([^/.?]+)/); return m ? m[1] + ":" + (p.searchParams.get("format") || "") : null; }
    catch { return null; }
  }
  function isNestedTweet(article) { return !!article.parentElement?.closest("article"); }
  function getTweetId(article) {
    for (const link of article.querySelectorAll("a[href*='/status/']")) {
      const match = link.href.match(/\/status\/(\d+)/); if (match) return match[1];
    }
    return null;
  }
  function collectImages(article) {
    const result = new Set();
    for (const img of article.querySelectorAll("img")) {
      const url = normalizeImageUrl(img.currentSrc || img.src); if (url) result.add(url);
    }
    return [...result];
  }
  async function processTweet(article, batch) {
    const id = getTweetId(article); if (!id || seenTweets.has(id)) return;
    let target = article;
    if (!options.includeQuoted) {
      target = article.cloneNode(true);
      for (const nested of target.querySelectorAll("article")) nested.remove();
    }
    const images = collectImages(target);
    if (!images.length) {
      const attempts = (noMediaRetries.get(id) || 0) + 1; noMediaRetries.set(id, attempts);
      if (attempts < 3) return;
      seenTweets.add(id); stats.tweetsScanned++; return;
    }
    seenTweets.add(id); stats.tweetsScanned++;
    for (const url of images) {
      const key = mediaKey(url);
      if (!key || seenMedia.has(key)) { stats.skipped++; continue; }
      seenMedia.add(key); batch.push({ tweetId: id, url }); stats.imagesFound++;
    }
  }
  async function scanVisibleTweets() {
    const batch = [], articles = [...document.querySelectorAll("article")];
    for (const article of articles) {
      if (stopRequested) break;
      if (!options.includeQuoted && isNestedTweet(article)) continue;
      await processTweet(article, batch);
    }
    if (batch.length) {
      const result = await chrome.runtime.sendMessage({ type: "X_SCAN_BATCH", items: batch });
      if (!result?.ok) throw new Error(result?.error || "Could not persist discovered images");
    }
    await chrome.runtime.sendMessage({ type: "X_SCAN_PROGRESS", stats: { tweetsScanned: stats.tweetsScanned, imagesFound: stats.imagesFound } }).catch(() => {});
  }
  async function finish(reason) {
    running = false;
    await chrome.runtime.sendMessage({ type: "X_SCAN_FINISH", reason }).catch(() => {});
    sendStatus(reason === "stopped" ? "Collection stopped. Starting downloads for collected images..." : "Collection complete. Starting downloads...");
  }
  async function scanLoop() {
    sendStatus("Collecting posts before downloading...");
    let stagnantRounds = 0, lastUniqueCount = 0, lastScrollY = window.scrollY;
    while (running && !stopRequested) {
      await scanVisibleTweets();
      if (stats.tweetsScanned >= options.maxTweets) break;
      window.scrollBy({ top: Math.max(450, Math.floor(window.innerHeight * 0.65)), behavior: "auto" });
      await sleep(options.scrollDelay);
      await sleep(Math.min(700, Math.max(250, options.scrollDelay / 3)));
      await scanVisibleTweets();
      const moved = Math.abs(window.scrollY - lastScrollY) > 20, count = seenTweets.size;
      if (count === lastUniqueCount) stagnantRounds++; else stagnantRounds = 0;
      if (count === lastUniqueCount && moved) stagnantRounds++;
      lastUniqueCount = count; lastScrollY = window.scrollY;
      if (stagnantRounds >= 10) break;
      sendStatus("Collecting... posts: " + stats.tweetsScanned + "/" + options.maxTweets + ", images: " + stats.imagesFound);
    }
    await scanVisibleTweets();
    await finish(stopRequested ? "stopped" : "completed");
    stopRequested = false;
  }
  chrome.runtime.onMessage.addListener(message => {
    if (message.type === "START_SCAN") {
      if (running) return;
      options = { includeQuoted: message.options?.includeQuoted === true, maxTweets: Math.max(1, Math.min(10000, Number(message.options?.maxTweets) || 500)), scrollDelay: Math.max(350, Math.min(10000, Number(message.options?.scrollDelay) || 700)) };
      stats = { tweetsScanned: 0, imagesFound: 0, skipped: 0 };
      seenTweets.clear(); seenMedia.clear(); noMediaRetries.clear();
      running = true; stopRequested = false;
      scanLoop().catch(async error => {
        running = false;
        await chrome.runtime.sendMessage({ type: "X_SCAN_FINISH", reason: "stopped" }).catch(() => {});
        sendStatus("Scan error: " + error.message);
      });
    }
    if (message.type === "STOP_SCAN") { stopRequested = true; sendStatus("Stopping collection..."); }
  });
})();