(() => {
  if (window.__xdlScannerInstalled) return;
  window.__xdlScannerInstalled = true;

  let running = false;
  let stopRequested = false;
  let options = {};
  let stats = {
    tweetsScanned: 0,
    imagesFound: 0,
    downloaded: 0,
    skipped: 0
  };

  const seenTweets = new Set();
  const seenImages = new Set();

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  function sendStatus(status) {
    chrome.runtime.sendMessage({
      type: "SCAN_STATUS",
      status,
      stats
    }).catch(() => {});
  }

  function normalizeImageUrl(src) {
    if (!src) return null;

    try {
      const url = new URL(src);

      if (url.hostname !== "pbs.twimg.com") return null;

      if (!url.pathname.includes("/media/")) return null;


      const format = url.searchParams.get("format");

      url.search = "";

      if (format) {
        url.searchParams.set("format", format);
      }

      url.searchParams.set("name", "orig");

      return url.href;
    } catch {
      return null;
    }
  }

  function isNestedTweet(article) {
    return !!article.parentElement?.closest("article");
  }

  function getTweetId(article) {
    const links = [...article.querySelectorAll("a[href*='/status/']")];

    for (const link of links) {
      const match = link.href.match(/\/status\/(\d+)/);
      if (match) return match[1];
    }

    return null;
  }

  function collectImages(article) {
    const result = new Set();

    // Primary method: media images inside this tweet.
    for (const img of article.querySelectorAll("img")) {
      const normalized = normalizeImageUrl(img.currentSrc || img.src);
      if (normalized) result.add(normalized);
    }

    // Some X layouts expose the media through the photo link.
    for (const link of article.querySelectorAll("a[href*='/photo/']")) {
      for (const img of link.querySelectorAll("img")) {
        const normalized = normalizeImageUrl(img.currentSrc || img.src);
        if (normalized) result.add(normalized);
      }
    }

    return [...result];
  }

  async function processTweet(article) {
    const id = getTweetId(article);
    if (!id || seenTweets.has(id)) return;

    seenTweets.add(id);
    stats.tweetsScanned++;

    let target = article;

    if (!options.includeQuoted) {
      // Remove nested quoted-tweet articles from consideration.
      target = article.cloneNode(true);
      for (const nested of target.querySelectorAll("article")) {
        nested.remove();
      }
    }

    const images = collectImages(target);

    for (const url of images) {
      if (seenImages.has(url)) {
        stats.skipped++;
        continue;
      }

      stats.imagesFound++;
      try {
        const result = await chrome.runtime.sendMessage({
          type: "DOWNLOAD_IMAGE",
          url,
          tweetId: id
        });
        if (result?.ok) {
          seenImages.add(url);
          stats.downloaded++;
        } else {
          stats.skipped++;
        }
      } catch {
        stats.skipped++;
      }
      sendStatus(`Queued/downloaded: ${stats.downloaded}/${stats.imagesFound}`);
    }
  }

  async function scanVisibleTweets() {
    const articles = [...document.querySelectorAll("article")];

    for (const article of articles) {
      if (!options.includeQuoted && isNestedTweet(article)) continue;
      await processTweet(article);
    }
  }

  async function scanLoop() {
    sendStatus("Scanning feed...");

    let unchangedRounds = 0;
    let lastHeight = 0;

    while (running && !stopRequested) {
      await scanVisibleTweets();

      if (stats.tweetsScanned >= options.maxTweets) {
        sendStatus("Maximum tweet count reached.");
        break;
      }

      const before = document.documentElement.scrollHeight;

      window.scrollBy({
        top: Math.max(window.innerHeight * 0.85, 700),
        behavior: "smooth"
      });

      await sleep(options.scrollDelay);

      const after = document.documentElement.scrollHeight;

      if (after === before && after === lastHeight) {
        unchangedRounds++;
      } else {
        unchangedRounds = 0;
      }

      lastHeight = after;

      if (unchangedRounds >= 5) {
        sendStatus("End of currently available feed reached.");
        break;
      }

      sendStatus(
        `Scanning... tweets: ${stats.tweetsScanned}, images: ${stats.imagesFound}`
      );
    }

    running = false;
    stopRequested = false;
    sendStatus(`Finished. Downloaded: ${stats.downloaded}`);
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "START_SCAN") {
      if (running) return;

      options = {
        includeQuoted: !!message.options?.includeQuoted,
        maxTweets: Math.max(1, Number(message.options?.maxTweets || 500)),
        scrollDelay: Math.max(500, Number(message.options?.scrollDelay || 1500))
      };

      stats = {
        tweetsScanned: 0,
        imagesFound: 0,
        downloaded: 0,
        skipped: 0
      };

      seenTweets.clear();
      seenImages.clear();

      running = true;
      stopRequested = false;

      scanLoop().catch(error => {
        running = false;
        sendStatus(`Error: ${error.message}`);
      });
    }

    if (message.type === "STOP_SCAN") {
      stopRequested = true;
      sendStatus("Stop requested...");
    }
  });
})();