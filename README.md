# X Feed Image Downloader

Chrome/Opera Manifest V3 extension for downloading images from X/Twitter profile feeds.

## Version 1.1.0\n\nFixes X media URLs that require the original `format` query parameter.\n\n## What it does

- Accepts an X/Twitter profile URL.
- Opens the profile if it is not already active.
- Scans `article` elements representing posts.
- Finds media hosted at `pbs.twimg.com/media/...`.
- Ignores profile pictures and most UI images.
- Can exclude quoted tweets.
- Automatically scrolls the feed.
- Removes duplicate image URLs.
- Downloads original-size media.
- Stores files under the browser Downloads directory in `X_Feed/`.

## Install

1. Extract this directory.
2. Open Chrome or Opera extensions.
3. Enable Developer mode.
4. Select `Load unpacked`.
5. Select the `twitter_feed_image_downloader` directory.
6. Open an X/Twitter profile.
7. Click the extension icon.
8. Enter the profile URL.
9. Press `START`.

## Important

X changes its DOM frequently. This implementation intentionally avoids depending on CSS class names. It uses semantic `article` elements and `pbs.twimg.com/media/` URLs, but X can change its frontend and require scanner updates.

The extension only downloads media that is already exposed to the browser on the profile feed. It does not bypass private accounts, authentication barriers, rate limits, or access controls.
