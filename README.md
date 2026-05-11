# Voyage Tools

Chrome/Chromium extension for `beta.voyage.io` — built around one key feature: **saving your story**.

---

## Story Exporter

Voyage doesn't let you export your campaign. Your narration, your choices, the NPC dialogue in the sidebar — it all lives in the browser, and Voyage discards the full NPC conversation text the moment you move to the next turn (replacing it with a brief AI-generated summary). If you close the tab, lose your session, or Voyage has a bad day, your story is gone.

**Voyage Tools fixes that.** It captures every turn as it happens and gives you your full campaign as a clean, readable markdown file.

### What you can export

Open the extension popup at any time and choose:

- **Download current turn** — grab the turn in progress right now, mid-stream if you like
- **Download whole story** — pulls the entire campaign history and saves it as one markdown file
- **Live export** — pick a file once; the extension silently appends each new turn to it as it completes. Your story saves itself.

### Live export is the big one

Live export means you never have to remember to save. Pick your file, and from that point on the extension appends each completed turn in the background — even while the extension popup is closed. Open Voyage, play your session, close the tab: the file is already up to date.

**Per-campaign memory:** the extension remembers which file you picked for each campaign. Reopen the popup in the same room and it offers **Resume** — one click and you're writing to the same file again, picking up exactly where you left off. New turns append; the existing file is never rewritten. A hundred-turn campaign costs a few KB of disk I/O per turn instead of an ever-growing rewrite.

### NPC conversations, preserved

The big problem with NPC conversations is that the entire chat is **wiped when you advance to the next turn**, replaced by a short summary. The exporter captures your conversations with your NPCs in real time as it streams in. Every line of NPC dialogue in your exported file is the real thing, not the summary.

### Five content toggles

Choose exactly what ends up in your file. Toggle each on or off in the popup:

| Toggle | What it includes |
|---|---|
| **Your actions** | The text you typed each turn |
| **Skill checks** | Dice rolls and outcomes |
| **Status updates** | In-world status/condition changes |
| **NPC summaries** | The AI-generated summaries Voyage shows after turns |
| **Music cues** | Scene music and audio direction |

### Output

Files are standard markdown. Default filenames are derived from your campaign and character — e.g. `voyage-return_of_the_dragon_queen-jinn.md` — so your exports stay organized across multiple campaigns.

### How the exporter works

Voyage's story data flows over a Socket.IO websocket to `api-beta.aidungeon.com`. REST and GraphQL endpoints only carry session metadata — the actual story content is websocket-only. The extension patches `window.WebSocket` at page load so every message on the `/heroes/` connection runs through our parser.

Events captured:

- `joinedRoom` / `gameStateChanged` — campaign name, character, save ID; drives the default filename slug
- `narrationSync` — live turn streaming; each frame carries the cumulative chunks so far with full per-block fields (`type`, `text`, `speaker`, `direction`, `speakerKind`)
- `notifyTurnEnd` / `notifySkillChecksFinished` — fires when a turn completes, carrying the canonical `turnData[]` shape; triggers live-export append
- `turnHistoryResponse` — bulk history delivered in response to a `requestTurnHistory` frame the extension sends back

For **Whole story**, the exporter walks backwards through history using the `beforeTick` cursor (10 turns per batch) until the server returns `hasMore: false` — no clicking "Show Previous Turns" by hand.

For **Live export**, the file is held open via the **File System Access API**. The popup handles the `showSaveFilePicker` call (it needs a user-gesture context), then ships the `FileSystemFileHandle` to the content script via `chrome.tabs.sendMessage`. The handle and the highest tick already written are stored in IndexedDB, keyed by `roomId`. This is what powers Resume.

The popup polls the content script every two seconds while open, so the displayed turn count and "last written tick" stay live as new turns land.

---

## Additional Features

### Skip All button

When the dialogue queue is blocking input ("Press space to skip"), a **⏭ Skip All** button appears next to the prompt. One click dispatches synthetic spacebar presses at 80 ms intervals through Voyage's existing handler — focus, audio cleanup, and transition to input mode all fire correctly. Stops automatically when the prompt disappears or the visible text stops changing.

The button only shows when the prompt is actually in the viewport. We looked for Voyage's internal queue index (to jump straight to the end) but it's held in closures inside minified components. Synthetic events through the public input path are more robust — they survive internal refactors as long as a spacebar handler exists.

### Performance fix

Reduces typing lag in the narrator sidebar by ~46% (measured: 74.9 ms → 40.7 ms per keystroke on a 200-message chat). Two mechanisms working together:

- **CSS layer** — `content-visibility: auto` on off-screen messages so the browser skips layout/paint for rows not in view
- **Style cache** — wraps `window.getComputedStyle` to deduplicate the redundant calls Tamagui makes on every keystroke within a single animation frame

The root cause is on Voyage's side (virtualization, memoization, or removing per-keystroke style reads). This is a workaround that gets typing from "noticeably sluggish" toward "tolerable."

---

## Install

Chrome doesn't support installing unpacked extensions from a URL — you need the files on your machine first.

**If you're not a developer:**

1. Go to the [Releases page](https://github.com/hisnameisjoel/voyage-tools/releases/latest) and download the `.zip` file (e.g. `voyage-helper-v1.0.0.zip`)
2. Unzip it — you'll get a folder named something like `voyage-helper-v1.0.0`
3. **Move that folder somewhere permanent before loading it.** Chrome links directly to the folder path, so if it moves or gets deleted, the extension breaks. A good spot is `Documents/Extensions/voyage-helper` or anywhere you won't accidentally clean up

**If you use git:**

```
git clone https://github.com/hisnameisjoel/voyage-tools.git
```

**Then, in Chrome or any Chromium browser (Chrome, Edge, Brave, Arc):**

1. Open `chrome://extensions`
2. Toggle **Developer mode** on (top-right corner)
3. Click **Load unpacked** and select the folder (the one containing `manifest.json` — don't go inside it, select the folder itself)
4. Reload any open `beta.voyage.io` tab
5. Click the extension icon in your toolbar to open the popup

All key features are on by default. Toggle any off in the popup; changes apply live on open tabs — no reload needed.

---

## Caveats

- **Story exporter** depends on Socket.IO event names (`narrationSync`, `turnHistoryResponse`, `joinedRoom`, etc.) and the turn shape (`storyParagraphs[]`, `playerInputs{}`, `pastUpdates.skillChecks[]`). If Voyage renames or restructures these in a backend change, the exporter will break silently — captured turns will be empty or formatting will look wrong. Check the browser console for `[voyage-story]` errors first when troubleshooting.
- **Live export** uses the File System Access API — available in Chromium-based browsers (Chrome, Edge, Brave, Arc) but not Firefox or Safari. The permission grant lasts one browser session; on restart, click Resume in the popup to re-link the file.
- **Skip All** relies on Voyage's spacebar handler. If they add an `event.isTrusted` check, it will silently stop advancing.
- **Performance fix and Skip All** are workarounds. If Voyage ships real fixes, those features become redundant — turn them off or uninstall.
- The CSS rule and chat row selector depend on Tamagui's atomic class names. If those change in a deploy, the rule stops matching and behavior reverts to normal.

---

## Files

- `manifest.json` — Manifest V3, registers content scripts and the popup
- `settings-controller.js` — Isolated content script; reads `chrome.storage.local` and mirrors toggles to `<html>` data-attributes
- `voyage-story-cache.js` — MAIN-world JS; patches `window.WebSocket`, parses Socket.IO frames, maintains the in-memory turn cache, exposes `requestHistory` / `pullAllHistory` / `getSnapshot` to the isolated world via `postMessage`
- `voyage-story-exporter.js` — Isolated content script; listens for popup messages, formats the cache as markdown, manages the live-export `FileSystemFileHandle` and IndexedDB state
- `popup.html` / `popup.js` — Extension popup UI
- `voyage-fix.css` — Performance CSS layer, gated by `:root[data-voyage-perf-css="on"]`
- `voyage-fix-cache.js` — MAIN-world JS; wraps `window.getComputedStyle` for the per-frame dedup cache
- `voyage-skip-button.js` — MAIN-world JS; polls for the dialogue prompt, injects/removes the Skip All button, dispatches synthetic spacebars
- `icon-{16,32,48,128}.png` — Toolbar and extension icons
