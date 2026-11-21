(() => {
  // This script is injected after a page reload so no stale scanner listener survives.
  if (window.__xdlScannerInstalled) return;
  window.__xdlScannerInstalled = true;

  let running = false, stopRequested = false, options = {};
  let stats = { tweetsScanned: 0, imagesFound: 0, skipped: 0 };
  const seenTweets = new Set(), seenMedia = new Set(), noMediaRetries = new Map();
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  function normalizeImageUrl(src) {
    if (!src) return null;
    try {
      const url = new URL(src, location.href);
      if (url.hostname !== "pbs.twimg.com" || !url.pathname.includes("/media/")) return null;
      const format = url.searchParams.get("format");
      url.search = "";
      if (format) url.searchParams.set("format", format);
      url.searchParams.set("name", "orig");
      return url.href;
    } catch { return null; }
  }

  function mediaKey(url) {
    try {
      const parsed = new URL(url), match = parsed.pathname.match(/\/media\/([^/.?]+)/);
      return match ? match[1] + ":" + (parsed.searchParams.get("format") || "") : null;
    } catch { return null; }
  }

  function getArticles() {
    let articles = [...document.querySelectorAll("article")];
    if (!articles.length) {
      articles = [...document.querySelectorAll('[data-testid="tweet"]')]
        .map(node => node.closest("article") || node);
    }
    return [...new Set(articles)];
  }

  function isNestedTweet(article) {
    return !!article.parentElement?.closest("article");
  }

  function getTweetId(article) {
    for (const link of article.querySelectorAll("a[href*='/status/']")) {
      const match = (link.href || link.getAttribute("href") || "").match(/\/status\/(\d+)/);
      if (match) return match[1];
    }
    const dataId = article.getAttribute("data-tweet-id") || article.dataset?.tweetId;
    return dataId && /^\d+$/.test(dataId) ? dataId : null;
  }

  function collectImages(article) {
    const result = new Set();
    for (const img of article.querySelectorAll("img")) {
      for (const candidate of [img.currentSrc, img.src, img.getAttribute("src"), img.getAttribute("data-src")]) {
        const normalized = normalizeImageUrl(candidate);
        if (normalized) result.add(normalized);
      }
      const srcset = img.getAttribute("srcset") || "";
      for (const entry of srcset.split(",")) {
        const normalized = normalizeImageUrl(entry.trim().split(/\s+/)[0]);
        if (normalized) result.add(normalized);
      }
    }
    return [...result];
  }

  function findFeedScroller() {
    const first = getArticles()[0];
    for (let node = first?.parentElement; node && node !== document.body; node = node.parentElement) {
      const style = getComputedStyle(node);
      const overflow = style.overflowY;
      if ((overflow === "auto" || overflow === "scroll" || overflow === "overlay") &&
          node.scrollHeight > node.clientHeight + 80) return node;
    }
    return document.scrollingElement || document.documentElement;
  }

  function scrollFeed() {
    const scroller = findFeedScroller();
    const amount = Math.max(650, Math.floor((scroller === document.scrollingElement
      ? window.innerHeight : scroller.clientHeight) * options.scrollStep));
    const windowBefore = window.scrollY;
    const before = scroller === document.scrollingElement ? window.scrollY : scroller.scrollTop;
    if (scroller === document.scrollingElement) {
      window.scrollBy({ top: amount, left: 0, behavior: "auto" });
    } else {
      scroller.scrollTop = Math.min(scroller.scrollTop + amount, scroller.scrollHeight);
    }
    let after = scroller === document.scrollingElement ? window.scrollY : scroller.scrollTop;
    if (Math.abs(after - before) < 2 && scroller !== document.scrollingElement) {
      window.scrollBy({ top: amount, left: 0, behavior: "auto" });
      after = scroller.scrollTop;
    }
    const windowMoved = Math.abs(window.scrollY - windowBefore) > 2;
    return { moved: Math.abs(after - before) > 2 || windowMoved, before, after, scrollHeight: scroller.scrollHeight };
  }

  function waitForFeedUpdate(timeoutMs) {
    return new Promise(resolve => {
      let done = false;
      const observer = new MutationObserver(() => {
        if (getArticles().some(article => {
          const id = getTweetId(article);
          return id && !seenTweets.has(id);
        })) finish();
      });
      const finish = () => {
        if (done) return;
        done = true;
        observer.disconnect();
        clearTimeout(timer);
        resolve();
      };
      observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
      const timer = setTimeout(finish, timeoutMs);
    });
  }

  function sendStatus(status) {
    chrome.runtime.sendMessage({ type: "SCAN_STATUS", status, stats }).catch(() => {});
  }

  async function processTweet(article, batch) {
    const id = getTweetId(article);
    if (!id || seenTweets.has(id)) return;
    let target = article;
    if (!options.includeQuoted) {
      target = article.cloneNode(true);
      for (const nested of target.querySelectorAll("article")) nested.remove();
    }
    const images = collectImages(target);
    if (!images.length) {
      const attempts = (noMediaRetries.get(id) || 0) + 1;
      noMediaRetries.set(id, attempts);
      if (attempts < 20) return;
      seenTweets.add(id);
      stats.tweetsScanned++;
      return;
    }
    seenTweets.add(id);
    stats.tweetsScanned++;
    for (const url of images) {
      const key = mediaKey(url);
      if (!key || seenMedia.has(key)) { stats.skipped++; continue; }
      seenMedia.add(key);
      batch.push({ tweetId: id, url });
      stats.imagesFound++;
    }
  }

  async function scanVisibleTweets() {
    const batch = [];
    for (const article of getArticles()) {
      if (stopRequested) break;
      if (!options.includeQuoted && isNestedTweet(article)) continue;
      await processTweet(article, batch);
    }
    if (batch.length) {
      const result = await chrome.runtime.sendMessage({ type: "X_SCAN_BATCH", items: batch });
      if (!result?.ok) throw new Error(result?.error || "Could not add discovered images to the download queue");
      sendStatus("Found " + stats.imagesFound + " images; " + (result.queued ?? result.total ?? 0) + " queued. Scanned " + stats.tweetsScanned + " posts.");
    }
    await chrome.runtime.sendMessage({
      type: "X_SCAN_PROGRESS",
      stats: { tweetsScanned: stats.tweetsScanned, imagesFound: stats.imagesFound }
    }).catch(() => {});
  }

  async function finish(reason) {
    running = false;
    const result = await chrome.runtime.sendMessage({ type: "X_SCAN_FINISH", reason }).catch(error => ({ ok: false, error: error.message }));
    if (!result?.ok) sendStatus("Scan finished, but queue finalization failed: " + (result?.error || "unknown error"));
    else sendStatus("Collection " + (reason === "stopped" ? "stopped" : "complete") +
      ": " + result.tweets + " posts, " + result.images + " images. Downloads are in the queue.");
  }

  async function scanLoop() {
    sendStatus("Scanner started. Looking for posts and images...");
    let stagnantRounds = 0, lastUniqueCount = 0, lastScrollY = window.scrollY;
    let scrollAttempts = 0;
    while (running && !stopRequested) {
      await scanVisibleTweets();
      if (stats.tweetsScanned >= options.maxTweets) break;

      const scroll = scrollFeed();
      scrollAttempts++;
      await waitForFeedUpdate(options.waitForFeedMs);
      await sleep(options.settleDelay);
      await scanVisibleTweets();

      const count = seenTweets.size;
      const currentY = window.scrollY;
      const madeProgress = count !== lastUniqueCount;
      const moved = scroll.moved || Math.abs(currentY - lastScrollY) > 20;
      if (madeProgress) stagnantRounds = 0;
      else if (!moved) stagnantRounds++;
      else stagnantRounds = 0; // Keep scanning while the feed is still moving/loading.
      lastUniqueCount = count;
      lastScrollY = currentY;

      sendStatus("Scrolling feed... posts: " + stats.tweetsScanned + "/" + options.maxTweets +
        ", images: " + stats.imagesFound + ", scroll attempts: " + scrollAttempts);
      if (stagnantRounds >= 12) break;
    }
    await scanVisibleTweets();
    await finish(stopRequested ? "stopped" : "completed");
    stopRequested = false;
  }

  chrome.runtime.onMessage.addListener(message => {
    if (message.type === "START_SCAN") {
      if (running) return;
      options = {
        includeQuoted: message.options?.includeQuoted === true,
        maxTweets: Math.max(1, Math.min(10000, Number(message.options?.maxTweets) || 500)),
        scrollStep: Math.max(0.7, Math.min(1.5, Number(message.options?.scrollStep) || 1.05)),
        waitForFeedMs: Math.max(150, Math.min(2500, Number(message.options?.waitForFeedMs) || 500)),
        settleDelay: Math.max(50, Math.min(1200, Number(message.options?.settleDelay) || 200))
      };
      stats = { tweetsScanned: 0, imagesFound: 0, skipped: 0 };
      seenTweets.clear(); seenMedia.clear(); noMediaRetries.clear();
      running = true; stopRequested = false;
      scanLoop().catch(async error => {
        running = false;
        await chrome.runtime.sendMessage({ type: "X_SCAN_FINISH", reason: "stopped" }).catch(() => {});
        sendStatus("Scan error: " + error.message);
      });
    }
    if (message.type === "STOP_SCAN") {
      stopRequested = true;
      sendStatus("Stopping collection...");
    }
  });
})();