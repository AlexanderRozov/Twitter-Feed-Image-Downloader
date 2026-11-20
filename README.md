# Image Feed Downloader

Manifest V3 Chromium extension for downloading original-size media from X/Twitter and tag-based Booru galleries.

## Sources
- X / Twitter profile feed. The source tab must remain open while discovering new posts.
- Danbooru
- Gelbooru
- Rule34

Booru searches prefer each post's original `file_url`. The extension does not intentionally use sample or thumbnail URLs as downloads.

## Install
1. Clone or download this repository.
2. Open `chrome://extensions` (or the equivalent Chromium extensions page).
3. Enable Developer mode and choose **Load unpacked**.
4. Select the repository folder.
5. Open the extension popup and choose a source.

## Tag search and blacklist
Choose **Booru gallery**, select a site, enter space-separated search tags, then optionally add blacklist tags separated by spaces or commas. A post is excluded when its returned tag set contains any blacklist entry. The blacklist is also sent to the gallery API as negative tags where supported, then checked locally as a second filter.

## Gelbooru access strategy
Gelbooru uses a two-stage strategy:
1. Try the anonymous DAPI JSON endpoint first. If both Gelbooru User ID and API Key are entered, they are added to that request.
2. If DAPI is denied (for example HTTP 401/403), returns non-JSON content, or has an unexpected response shape, retry the search through Gelbooru's public HTML listing page. The HTML fallback does not require API credentials, but it can expose less metadata and may be subject to site restrictions or markup changes.

The HTML parser reads post IDs, preview URLs, and the tag text exposed in the listing. For HTML results, it reconstructs the likely original image URL only when the preview path follows Gelbooru's known `/thumbnails/.../thumbnail_...` layout, replacing those path segments with `/images/.../...`. This URL transformation follows the approach used by [Bionus/imgbrd-grabber's Gelbooru 0.1 source](https://github.com/Bionus/imgbrd-grabber/blob/develop/src/sites/Gelbooru%20(0.1)/model.ts). It is a URL heuristic, not a guarantee that every reconstructed file exists; unavailable files will fail in the browser download manager.

### Optional Gelbooru credentials
Credentials are optional. Some Gelbooru API access may be limited without login, so you can provide both values to improve DAPI access:
1. Sign in to Gelbooru.
2. Open [Account Options](https://gelbooru.com/index.php?page=account&s=options).
3. Find **API Access Credentials**.
4. Copy **User ID** and **API Key** into the extension popup.

Credentials are stored in this browser profile's `chrome.storage.local` and are sent only as DAPI query parameters. Do not share screenshots or logs containing the API key. The extension cannot create credentials for you.

## Download folders
The **Organize downloads into folders** checkbox controls the download path:
- Disabled by default: files are saved directly in the browser's default download directory.
- Enabled: X downloads are grouped under `X_Feed`; Booru downloads are grouped by source and the first positive tag from your search query (for example, `1girl armlet bare_shoulders` creates `Gelbooru/1girl`).
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
- The Gelbooru HTML fallback depends on the site's public listing markup and its thumbnail URL layout; changes on Gelbooru may require parser updates.
- The blacklist depends on tags returned by the gallery API or public listing; it cannot infer visual content from an image.
- Live integration tests against current gallery APIs and Chrome/Opera have not yet been performed. Verify each gallery, long-running queue recovery, original-file URL reconstruction, and X lazy loading before publishing.

The extension does not bypass private-account controls, authentication barriers, or site restrictions.
