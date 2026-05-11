# Voyage Helper

Tiny Chrome/Chromium extension with quality-of-life tweaks for `beta.voyage.io`. Each feature can be toggled independently from the extension popup.

## Features

1. **Performance fix** — Reduces typing lag in the narrator chat sidebar by ~46% (measured: 74.9 ms → 40.7 ms per keystroke on a 200-message chat). Combines two layered tricks under the hood: `content-visibility: auto` on off-screen messages so the browser skips layout for them, plus a per-animation-frame cache that dedupes the redundant `getComputedStyle` calls Tamagui makes on every keystroke.
2. **Skip All button** — "⏭ Skip All" button appears next to the "Press space to skip" prompt whenever the dialogue queue is blocking input on a turn. One click skips the entire queue at ~80 ms per segment, getting you to the "What do you do?" prompt without manually pressing space 10–20 times.
3. **Story exporter** — Save your campaign as markdown. The actions live in the extension popup: download the current in-progress turn, download the whole campaign so far, or "live export" — pick a file once and the extension keeps appending new turns to it as they complete. Output is markdown with five toggleable "include" options (your typed actions, skill checks, status updates, NPC summaries, music cues). Default filenames are derived from the campaign name + character (e.g. `voyage-return_of_the_dragon_queen-jinn.md`), and the extension remembers per-campaign live-export files so reopening the popup in the same room offers Resume.

All three are on by default. Toggle any of them off in the extension popup; changes apply live on open Voyage tabs (no reload needed).

## Install (unpacked)

1. Open `chrome://extensions` in Chrome / any Chromium browser.
2. Toggle **Developer mode** on (top-right).
3. Click **Load unpacked** and select this folder.
4. Reload any open `beta.voyage.io` tab.
5. Click the extension icon in the toolbar to open the popup with toggles.

## How the perf fix works

The narrator sidebar mounts every chat message in a non-virtualized list (~200 rows for an active campaign). Each keystroke in the input triggers Tamagui's style cascade, which calls `getComputedStyle` on dozens of styled ancestors and reads the textarea's `scrollHeight` for auto-resize. Because those reads happen after DOM writes from the same React commit, each one forces synchronous layout — and with 200 rows mounted, layout is expensive.

- The CSS layer tells the browser to skip layout/paint for off-screen rows, so each forced reflow only walks visible messages.
- The cache layer dedupes the redundant `getComputedStyle` reads within a single frame. Tamagui asks for the same theme tokens on the same elements many times per render — values that don't change inside one frame.

The underlying issue is on Voyage's side (memoization, virtualization, or removing the per-keystroke style reads from the input's `onChange` path) and would need source-side changes to fully fix. This extension is a workaround that gets typing from "noticeably sluggish" toward "tolerable."

## How the Skip button works

The dialogue queue is fully client-side: pressing space just steps a local index, no network calls. The button dispatches synthetic `KeyboardEvent` keydowns at 80 ms intervals through Voyage's existing handler, which means side effects (focus, audio cleanup, transition to input mode) all fire correctly.

The button only appears when the "Press space to skip" prompt is actually visible in the viewport. It auto-stops when the prompt disappears or when the visible narrative text stops changing for 3 consecutive presses.

We did try to find Voyage's queue/index state directly so we could jump to the end without iterating, but it's held in closures inside minified components — not reachable cleanly from outside. Synthetic events through the public input path are more robust anyway: they survive Voyage's internal refactors as long as a spacebar handler exists.

## How the Story exporter works

Voyage's game state flows over a Socket.IO websocket connection to `api-beta.aidungeon.com` under the path `/heroes/`. Every turn — both live in-progress turns (streamed in chunks) and historical turns delivered on demand — passes through this socket, with completed turns delivered pre-assembled as `storyParagraphs[]` (one element per dialogue/narration block in the UI). REST endpoints (`/voyage/load-room`, GraphQL `/graphql`) only carry session/metadata, not story content.

The extension patches `window.WebSocket` at `document_start` in the MAIN world so every WebSocket the page constructs runs through our subclass. When the URL contains `heroes`, we wrap the message listener and parse the Engine.IO + Socket.IO framing (`42[event, payload]`). Captured events:

- `joinedRoom` / `usersChanged` / `worldChanged` / `gameStateChanged` — room/world/character/save metadata. The campaign name, character name, save id, and world title come from `gameState.gameConfig` and drive the default filename slug.
- `narrationStarted` / `narrationSync` — current live turn. Each `narrationSync` carries the cumulative `chunks[]` so far, with rich per-block fields (`type`, `text`, `speaker`, `direction`, `speakerKind`, `imageUrl`, `ttsDescription`). The live-turn formatter renders these at the same fidelity as historical turns.
- `notifyTurnEnd` / `notifySkillChecksFinished` — fire as a turn completes, each carrying `turnData[]` in the same canonical shape as historical turns. The exporter harvests these directly for append-on-completion live export.
- `turnHistoryResponse` — bulk historical turns when we send a `requestTurnHistory` frame back. Used for "Whole story" and to backfill on resume.

For **Whole story**, the exporter sends `requestTurnHistory` in a loop with the `beforeTick` cursor walking backwards (and `count: 10` per batch), until the server signals `hasMore: false`. No clicking "Show Previous Turns" by hand.

For **Live export**, the file is held open via the **File System Access API**. The popup hosts the `showSaveFilePicker` call so it has the user-gesture context it needs; the resulting `FileSystemFileHandle` is shipped to the content script via `chrome.tabs.sendMessage` (FileSystemHandles are structured-cloneable across extension contexts in Chromium 94+) and stored in IndexedDB alongside the highest tick we've already written, keyed by `roomId`. The next page load detects the saved record for the current room and offers "Resume live export…" (Chromium still asks for one read-write permission grant per browser session). New turns are **appended-only** on `notifyTurnEnd` (debounced 500 ms) — the file is never fully rewritten while live export is active, so a 100-turn campaign costs a few KB of disk I/O per turn instead of a full-file rewrite.

The popup polls the content script's `getStatus` every two seconds while open so the displayed turn count, "last written tick", and active/inactive state stay current as new turns land. When the popup is closed, polling stops and the content script keeps the live export running silently.

## Files

- `manifest.json` — Manifest V3, registers content scripts and the popup.
- `settings-controller.js` — Isolated content script. Reads `chrome.storage.local` and mirrors the user-facing toggles to `<html>` data-attributes. The single "Performance fix" toggle drives both `data-voyage-perf-css` and `data-voyage-gcs-cache` because the two sub-mechanisms always belong together.
- `voyage-fix.css` — Performance CSS layer, gated by `:root[data-voyage-perf-css="on"]`.
- `voyage-fix-cache.js` — MAIN-world JS. Wraps `window.getComputedStyle` once at document_start and bypasses the cache when the toggle is off.
- `voyage-skip-button.js` — MAIN-world JS. Polls for the dialogue prompt, injects/removes the inline Skip All button, dispatches the synthetic spacebars.
- `voyage-story-cache.js` — MAIN-world JS. Patches `window.WebSocket` at document_start, parses Socket.IO frames on the `/heroes/` connection, maintains the in-memory turn cache, exposes `requestHistory` / `pullAllHistory` / `getSnapshot` to the isolated world via `postMessage`. Always runs (memory cost is small and the cache must be populated by the time the user opens the popup).
- `voyage-story-exporter.js` — Isolated content script. Headless on the page — listens for `chrome.runtime` messages from the popup and performs the requested action (current turn / whole story / start/resume/stop live export). Formats the cache as markdown according to the popup's "include" toggles, holds the live-export FileSystemFileHandle, persists state to IndexedDB.
- `popup.html` / `popup.js` — Extension popup UI.
- `icon-{16,32,48,128}.png` — Toolbar/extension icons.

## Caveats

- The Performance fix and Skip All button are workarounds. If Voyage ships real fixes on their end, those features become redundant — turn them off in the popup or uninstall the extension.
- The Skip All button relies on Voyage's spacebar handler. If they ever add a check for `event.isTrusted`, the button will silently stop advancing. Easy to fix when it happens; let the maintainer know.
- The CSS rule and the chat row selector depend on Tamagui's atomic class names. If those change in a deploy, the rule simply stops matching and behavior reverts to original.
- The Story exporter depends on Socket.IO event names (`narrationSync`, `turnHistoryResponse`, `joinedRoom`, etc.) and the historical-turn shape (`storyParagraphs[]`, `playerInputs{}`, `pastUpdates.skillChecks[]`). If Voyage renames or restructures these in a backend change the exporter will break silently — captured `turns` will be empty or formatting will look wrong. Check the browser console for `[voyage-story]` errors first when troubleshooting.
- Live export uses the File System Access API. Available in Chromium-based browsers (Chrome/Edge/Brave/Arc) but not Firefox/Safari. The picked file's permission grant lasts one browser session — on restart, click the menu item again to re-link.
