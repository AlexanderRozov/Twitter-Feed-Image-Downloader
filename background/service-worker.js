const activeDownloads = new Map();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== "DOWNLOAD_IMAGE") {
    return;
  }

  downloadImage(message.url, message.tweetId)
    .then(() => sendResponse({ok: true}))
    .catch(error => {
      console.warn("Download failed:", error);
      sendResponse({ok: false, error: error.message});
    });

  return true;
});

async function downloadImage(url, tweetId) {
  if (!url) throw new Error("Empty image URL.");

  const parsed = new URL(url);

  if (parsed.hostname !== "pbs.twimg.com") {
    throw new Error("Blocked non-X media host.");
  }

  if (!parsed.pathname.includes("/media/")) {
    throw new Error("URL is not X media.");
  }

  const originalName = parsed.pathname.split("/").pop() || `image-${tweetId}.jpg`;

  // Keep the extension from the original media path.
  let extension = "";
  const pathMatch = originalName.match(/\.(jpg|jpeg|png|webp|gif)$/i);

  if (pathMatch) {
    extension = "." + pathMatch[1].toLowerCase();
  } else {
    const format = (parsed.searchParams.get("format") || "jpg").toLowerCase();
    extension = ["jpg", "jpeg", "png", "webp", "gif"].includes(format)
      ? "." + format
      : ".jpg";
  }

  const safeTweetId = String(tweetId).replace(/[^0-9]/g, "");
  const filename = `X_Feed/${safeTweetId}_${hashUrl(url)}${extension}`;

  if (activeDownloads.has(url)) {
    return activeDownloads.get(url);
  }

  const promise = new Promise((resolve, reject) => {
    console.log("[XDL] Downloading:", url, "->", filename);

    chrome.downloads.download(
      {
        url,
        filename,
        conflictAction: "uniquify",
        saveAs: false
      },
      downloadId => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        if (downloadId == null) {
          reject(new Error("Chrome did not create a download."));
          return;
        }

        const listener = (delta) => {
          if (delta.id !== downloadId || !delta.state) return;

          if (delta.state.current === "complete") {
            chrome.downloads.onChanged.removeListener(listener);
            resolve();
          } else if (delta.state.current === "interrupted") {
            chrome.downloads.onChanged.removeListener(listener);
            reject(new Error("Download interrupted."));
          }
        };

        chrome.downloads.onChanged.addListener(listener);
      }
    );
  });

  activeDownloads.set(url, promise);

  try {
    await promise;
  } finally {
    activeDownloads.delete(url);
  }
}

function hashUrl(value) {
  let hash = 2166136261;

  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(16);
}