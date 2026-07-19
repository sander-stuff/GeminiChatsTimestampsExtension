# AGENTS.md — Gemini Chat Timestamps Extension

## Project Overview
Chrome Extension (Manifest V3) that shows timestamps above each chat bubble in Google Gemini and Perplexity AI conversations. Timestamps persist across sessions via `chrome.storage.local`.

## Key Files
- `manifest.json` — MV3 manifest, version, permissions (`storage`, host_permissions for both sites)
- `content.js` — Main content script: site detection, DOM scanning, timestamp injection, storage, SPA navigation, debug console
- `content.css` — `.gts-timestamp` styling (10px, italic, #9e9e9e)
- `icons/` — icon16.png, icon48.png, icon128.png

## Conventions
- Version bumps on every change (patch for fixes, minor for features)
- Commit + push to GitHub after every change
- GitHub repo: `https://github.com/sander-stuff/GeminiChatsTimestampsExtension`

## Architecture
- **Site detection** via `location.hostname` — `SITE.id` is `'gemini'` or `'perplexity'`
- Each site defines `SITE.getChatId()` and `SITE.getMessageGroups()` returning `{role, element, container}`
- **Message IDs**: `{chatId}::{role}::{FNV-1a hash of first 80 chars}::{occurrence}` — occurrence counter per role handles duplicate messages (e.g. multiple "Ja")
- **Timestamp format**: `YYYY-MM-DD HH:MM:SS` local time
- **Injection**: `injectBefore(el, container, timeStr)` inserts `.gts-timestamp` div above the message element
  - For Perplexity: uses `findOuterContainer()` to walk up past the bubble boundary
  - For Gemini: inserts at `container.firstChild` (the turn div `infinite-scroller > div[N]`)
- **Persistence**: `chrome.storage.local` with key `gts_data`, in-memory cache
- **MutationObserver** with 300ms debounce watches for DOM changes
- SPA navigation detected via monkey-patched `history.pushState/replaceState` + URL polling

## Known DOM Structures

### Gemini (`gemini.google.com/app/{chatId}`)
- Turn container: `infinite-scroller > div[N]` (recycled by virtual scrolling)
- User: `div > user-query`
- Model: `div > model-response`
- Both `user-query` AND `model-response` can be in the SAME turn div

### Perplexity (`perplexity.ai/search/{slug}`)
- User queries: `span.select-text` (semantic class)
- Assistant responses: `div[id^="markdown-content-"]` (sequential IDs)
- No turn container — messages are separate siblings
- `findTurnParent()` walks up to find outermost single-child container
- `findOuterContainer()` walks further up to get outside the bubble visually

## Debug
Run `window.__gts_debug()` in browser DevTools console — outputs site-specific diagnostics.
