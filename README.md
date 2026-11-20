# Image Feed Downloader

Chrome / Chromium Manifest V3 extension for collecting original-size images from X/Twitter feeds and tag-based Booru galleries.

## Sources
- X / Twitter profile feed (DOM-based scan; source tab must remain open while collecting new posts).
- Danbooru
- Gelbooru
- Rule34

Booru searches use the gallery JSON/DAPI endpoints and enqueue the post's `file_url` (original file), not preview/sample/thumbnail URLs. Availability and file access depend on each site's API, rate limits, permissions, and content rules.

## Install
1. Download or clone this repository.
2. Open `chrome://extensions` (or the equivalent Chromium extensions page).
3. Enable Developer mode.
4. Choose **Load unpacked** and select the repository folder.
5. Open the extension popup and choose a source.

## Tag search
Choose **Booru gallery**, select Danbooru, Gelbooru, or Rule34, enter space-separated tags and start. Most Booru engines support negative tags with a leading minus, e.g. `1girl blue_hair -comic`. The extension requests up to the configured maximum number of posts.

## Background downloads
The download queue and job metadata are stored in `chrome.storage.local`. Download tasks use the browser Downloads API, so closing the popup or source page does not cancel already queued downloads. Interrupted downloads are retried a limited number of times. Chrome may suspend the Manifest V3 worker; alarms and download events wake it to resume queue processing.

**X limitation:** discovering additional feed posts requires the X page's DOM and scrolling. Keep the X tab open until scanning finishes. Images already enqueued continue downloading if that tab or popup is closed.

## Known limitations / next steps
- Site APIs can change, impose rate limits, require authentication, or return XML instead of JSON on some deployments.
- Some galleries expose a post but withhold its original file URL; those posts are skipped rather than downloading a thumbnail.
- The queue currently keeps completed URL records for deduplication. A future settings page should add queue history cleanup and export.
- Add integration tests with recorded API fixtures and a browser-based test suite before publishing broadly.

The extension only accesses public or otherwise browser-accessible content and does not bypass private-account controls, authentication barriers, or site restrictions.
