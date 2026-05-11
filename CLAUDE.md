# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Voyage Tools — Claude Context

## Project overview

Chrome/Chromium Manifest V3 extension for `beta.voyage.io` (also `alpha.voyage.io`). Three features: Story Exporter (primary), Skip All button, and Performance fix. All source files live under `src/`. There is no build step — files are loaded directly by Chrome.

## Development workflow

No compilation, no `package.json`. To iterate:


1. Load the extension unpacked from the repo root at `chrome://extensions` → Developer mode → Load unpacked.
2. Edit source files.
3. Click the reload icon on the extension card at `chrome://extensions` (or use the Extensions toolbar shortcut).
4. For content-script changes, also reload the Voyage tab.

No linting or test suite exists. Manually verify against `beta.voyage.io`.

## Architecture: two content-script worlds

The manifest registers content scripts in two separate worlds, and code **cannot** directly call functions across that boundary:

**Isolated world** (`settings-controller.js`, `voyage-story-exporter.js`):

* Has access to `chrome.*` APIs (storage, runtime messages).
* Cannot see `window` globals set by MAIN-world scripts.

**MAIN world** (`voyage-fix-cache.js`, `voyage-skip-button.js`, `voyage-story-cache.js`):

* Shares the page's `window` — required for WebSocket patching.
* No `chrome.*` API access.

**Cross-world RPC**: `voyage-story-exporter.js` (isolated) calls `voyage-story-cache.js` (MAIN) via `window.postMessage` using a `{ source: 'voyage-story', requestType, requestId }` envelope. The MAIN world replies with `{ source: 'voyage-story', type: 'response', requestId, ok, result }`. See `callMain()` in `voyage-story-exporter.js`.

## Popup → content script protocol

The popup (`popup.js`) talks to `voyage-story-exporter.js` exclusively via `chrome.tabs.sendMessage` with `{ source: 'voyage-story', action }`. The popup polls `getStatus` every 2 seconds while open.

**Critical exception — live export start**: `FileSystemFileHandle` methods are stripped when the handle crosses a `chrome.tabs.sendMessage` serialization boundary. To work around this, the popup injects `pickAndStartLiveExport` directly into the isolated world via `chrome.scripting.executeScript`. That function calls `window.showSaveFilePicker` and then `window.__voyageStoryHelper.startLiveExport(handle)`, keeping the handle in one realm throughout. This is why `scripting` is an optional permission — it's only requested lazily on the first "Start live export" click.

## chrome.storage.local keys

| Key | Default | Purpose |
|----|----|----|
| `perfFix` | `true` | CSS + `getComputedStyle` cache performance fix |
| `skipButton` | `true` | Skip All button on dialogue queue |
| `storyIncludeInputs` | `true` | Player actions in export |
| `storyIncludeChecks` | `true` | Skill check results in export |
| `storyIncludeStatus` | `true` | Status updates in export |
| `storyIncludeNpcChats` | `false` | NPC chat summaries in export |
| `storyIncludeNpcConversations` | `true` | Full NPC dialog blocks in export |
| `storyIncludeMusic` | `false` | Music context in export |
| `storyIncludeMarkers` | `true` | HTML comment resume markers in export |
| `voyage-last-filename:{roomId}` | — | Last picked filename per campaign (harmless to retain after Stop) |

`settings-controller.js` applies `perfFix` and `skipButton` by setting `data-voyage-perf-css`, `data-voyage-gcs-cache`, and `data-voyage-skip-button` on `<html>`. CSS and JS gate on those attributes.

## Live export persistence

IndexedDB database `voyage-helper`, object store `storyHandles`. Records are keyed by `roomId` and shaped as `{ handle: FileSystemFileHandle, lastWrittenTick: number | null }`. `lastWrittenTick` is the highest turn tick already written; appends only write turns above that watermark.

Resume markers in the markdown file (`<!-- voyage-turn:tick=N -->`, `<!-- voyage-session:roomId=XXX -->`) allow parsing the watermark from the file itself when IDB has no record (e.g. after a `stop` or cross-device scenario).

## Releasing a new version

### 1. Update CHANGELOG.md

Add a new entry at the top **before** tagging. The release workflow extracts notes from the matching `## [x.y.z]` entry automatically. If no matching entry exists, the release body falls back to "See CHANGELOG.md for details."

Format (Keep a Changelog):

```markdown
## [1.1.0] - YYYY-MM-DD

### Added
- ...

### Fixed
- ...
```

### 2. Push a version tag

```
git tag v1.1.0
git push origin v1.1.0
```

The tag **must match** `v*.*.*`. The `v` prefix is stripped when matching against CHANGELOG.md.

### 3. What the workflow does

Defined in `.github/workflows/release.yml`. On a matching tag push it:


1. Creates `dist/voyage-helper-v1.1.0/` containing only `manifest.json` and `src/`
2. Zips to `voyage-helper-v1.1.0.zip`
3. Creates a GitHub Release with the changelog notes as the body and the zip as the sole asset

The release zip is intentionally minimal — no `.github/`, `.claude/`, `CHANGELOG.md`, or other dev files.

### 4. Monitor the run

Watch progress at: `https://github.com/hisnameisjoel/voyage-tools/actions`

## Key technical notes

* **WebSocket patching** — `voyage-story-cache.js` patches `window.WebSocket` at `document_start` in the MAIN world. It must run before the page constructs its socket or it misses the `/heroes/` connection. The `/tts/` socket is intentionally ignored.
* **Turn completion guard** — `notifyTurnEnd` fires as soon as the player submits an action with only `playerInputs` populated; narration arrives in a subsequent event. `isTurnComplete()` gates appends on `storyParagraphs` or `storyMessage` being present to avoid writing incomplete turns.
* **NPC conversation capture** — Voyage wipes full NPC chat text when advancing turns, keeping only an AI summary. The exporter captures `narrationSync` chunks and `openNpcChat`/`npcChatResponse` events in real time. NPC chats are grouped by `turnTick` and rendered immediately before the turn heading they preceded.
* **Toggle mechanism** — `settings-controller.js` (isolated world) mirrors `chrome.storage.local` toggles to `<html>` data-attributes. CSS and JS features gate on those attributes, so toggling applies live without a page reload.
* **Debug handle** — `window.__voyageStory` (set by `voyage-story-cache.js`) exposes `getSnapshot`, `requestHistory`, `pullAllHistory`, and `_cache` for DevTools console use during development.


