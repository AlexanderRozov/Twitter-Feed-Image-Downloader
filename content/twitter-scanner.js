(() => {
  // This script is injected after a page reload so no stale scanner listener survives.
  if (window.__xdlScannerInstalled) return;
  window.__xdlScannerInstalled = true;

  let running = false, stopRequested = false, options = {};
  let stats = { tweetsScanned: 0, imagesFound: 0, skipped: 0 };
  const seenTweets = new Set(), seenMedia = new Set(), noMediaRetries = new Map();
  const encounteredTweets = new Set();
  let startReached = false;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  function normalizeImageUrl(src) {
    if (!src) return null;
    try {
      const url = new URL(src, location.href);
      if (url.hostname !== "pbs.twimg.com" || !url.pathname.includes("/media/")) return null;
      const pathFormat = url.pathname.match(/\\.(jpe?g|png|webp|gif|avif)$/i)?.[1];
      const format = (url.searchParams.get("format") || pathFormat || "").toLowerCase();
      if (format && !url.searchParams.has("format")) url.searchParams.set("format", format === "jpeg" ? "jpg" : format);
      // Preserve X media parameters (for example tag) and request the original rendition.
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

  function getTweetDateKey(article) {
    const raw = article.querySelector("time[datetime]")?.getAttribute("datetime");
    if (!raw) return null;
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) return null;
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return year + "-" + month + "-" + day;
  }

  function shouldProcessFromStart(article, id) {
    if (startReached) {
      if (options.startMode === "date") {
        const postDate = getTweetDateKey(article);
        return !!postDate && postDate <= options.startDate;
      }
      return true;
    }
    if (!id || encounteredTweets.has(id)) return false;

    if (options.startMode === "number") {
      encounteredTweets.add(id);
      if (encounteredTweets.size >= options.startPostNumber) {
        startReached = true;
        sendStatus("Start position reached at post #" + options.startPostNumber + ". Collecting images...");
        return true;
      }
      return false;
    }

    if (options.startMode === "date") {
      const postDate = getTweetDateKey(article);
      if (!postDate) return false;
      encounteredTweets.add(id);
      if (postDate <= options.startDate) {
        startReached = true;
        sendStatus("Date reached (" + options.startDateDisplay + "). Collecting images from this post and older posts...");
        return true;
      }
      return false;
    }

    startReached = true;
    return true;
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
      const id = getTweetId(article);
      if (!shouldProcessFromStart(article, id)) continue;
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
    else if (!startReached && reason !== "stopped") {
      sendStatus("Start position was not found in the loaded feed. Try an earlier date or a smaller post number.");
    } else {
      sendStatus("Collection " + (reason === "stopped" ? "stopped" : "complete") +
        ": " + result.tweets + " posts, " + result.images + " images. Downloads are in the queue.");
    }
  }

  async function scanLoop() {
    const startDescription = options.startMode === "number"
      ? "post #" + options.startPostNumber
      : options.startMode === "date" ? "date " + options.startDateDisplay : "the first post";
    sendStatus("Scanner started. Searching for " + startDescription + "...");
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
      const madeProgress = count !== lastUniqueCount || encounteredTweets.size > lastUniqueCount;
      const moved = scroll.moved || Math.abs(currentY - lastScrollY) > 20;
      if (madeProgress) stagnantRounds = 0;
      else if (!moved) stagnantRounds++;
      else stagnantRounds = 0;
      lastUniqueCount = Math.max(count, encounteredTweets.size);
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
        settleDelay: Math.max(50, Math.min(1200, Number(message.options?.settleDelay) || 200)),
        startMode: ["number", "date"].includes(message.options?.startMode) ? message.options.startMode : "first",
        startPostNumber: Math.max(1, Math.min(100000, Number(message.options?.startPostNumber) || 1)),
        startDate: String(message.options?.startDate || ""),
        startDateDisplay: String(message.options?.startDateDisplay || "")
      };
      if (options.startMode === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(options.startDate)) {
        throw new Error("Invalid start date. Expected DD.MM.YYYY.");
      }
      stats = { tweetsScanned: 0, imagesFound: 0, skipped: 0 };
      seenTweets.clear(); seenMedia.clear(); noMediaRetries.clear(); encounteredTweets.clear();
      startReached = options.startMode === "first";
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
