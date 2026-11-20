# Image Feed Downloader

Manifest V3 Chromium extension for downloading original-size media from X/Twitter and tag-based Booru galleries.

## Sources
- X / Twitter profile feed. The source tab must remain open while discovering new posts.
- Danbooru
- Gelbooru
- Rule34

Booru searches request the post's original `file_url`; the extension does not intentionally fall back to thumbnail/sample fields.

## Install
1. Clone or download this repository.
2. Open `chrome://extensions` (or the equivalent Chromium extensions page).
3. Enable Developer mode and choose **Load unpacked**.
4. Select the repository folder.
5. Open the extension popup and choose a source.

## Tag search and blacklist
Choose **Booru gallery**, select a site, enter space-separated search tags, then optionally add blacklist tags separated by spaces or commas. A post is excluded when its returned tag set contains any blacklist entry. The blacklist is also sent to the gallery API as negative tags where supported, then checked locally as a second filter.

## Download folders
The **Organize downloads into folders** checkbox controls the download path:
- Enabled: files are grouped by source and, for Booru, up to three tags.
- Disabled: files are saved directly in the browser's default download directory.

## Queue manager
Choose **QUEUE** in the popup or open the extension's Options page. The manager displays pending, downloading, completed, and failed items. It supports pause/resume, retrying failed items, removing individual queued/failed entries, and clearing completed history.

The queue and duplicate index are stored in `chrome.storage.local`. A URL is indexed when first queued, so the same original URL is not added again even after completed queue rows are cleared. Retry actions reuse the existing queue item.

## Background behavior
Already queued downloads continue after closing the popup or the source tab. The browser Downloads API performs the transfers; the Manifest V3 service worker wakes on download events and alarms to update state and retry interrupted transfers.

**X limitation:** discovering further posts still requires the X page DOM and scrolling. Keep the X tab open until scanning finishes. Images already added to the download queue are independent of that tab.

## Limitations and validation
- Gallery APIs, CDN hosts, access requirements, and rate limits can change.
- Some posts do not expose an original file URL and are skipped.
- The blacklist depends on tags returned by the gallery API; it cannot infer visual content from an image.
- This branch has not yet been integration-tested against current live APIs or in Chrome/Opera. Verify each gallery, long-running queue recovery, and X lazy loading before publishing.

The extension does not bypass private-account controls, authentication barriers, or site restrictions.

## Gelbooru API authentication (HTTP 401)
Gelbooru may require API credentials for DAPI requests. If the extension reports HTTP 401:
1. Sign in to Gelbooru.
2. Open [Account Options](https://gelbooru.com/index.php?page=account&s=options).
3. Find **API Access Credentials** near the bottom of the page.
4. Copy both **User ID** and **API Key** into the Gelbooru credential fields in the extension popup.
5. Select Gelbooru again and start the tag search.

The extension sends these values as the documented `user_id` and `api_key` query parameters. Credentials are stored in this browser profile's `chrome.storage.local`; do not share screenshots or logs containing the API key. The extension cannot create credentials for you. A 401 after entering them usually means one value is missing/incorrect or Gelbooru is denying the request for another reason.
