# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.2.1] - 2026-05-16

### Fixed
- **Live export resume no longer falsely rejects same-campaign files.** Voyage assigns a new `roomId` each time it joins a room for the same save, so the session marker the exporter wrote on a previous session (`<!-- voyage-session:roomId=... -->`) wouldn't match the current room and Start live export would refuse to append with "That folder already has X but it belongs to a different campaign." The exporter now also writes a `<!-- voyage-session:saveId=... -->` marker, which is stable per save, and prefers `saveId` for the match. Files written before this fix (only `roomId`) are accepted as legacy on first resume, and their header is migrated to include `saveId` going forward.

## [1.2.0] - 2026-05-13

### Changed
- **Configure flow moved to its own browser tab.** Clicking "Configure export options…" in the popup now opens a new browser tab (via `chrome.tabs.create`) right next to the Voyage tab. Tabs survive the OS folder picker's focus-steal without any close-on-blur behavior, and the user gets standard browser controls (back, pin, drag-reorder). The configure page's body is `max-width`-locked to 480px so the layout stays readable on wide displays. Single-instance: clicking Configure with the tab already open focuses it (and its window) instead of opening a duplicate.
- **Export-option toggles relocated to the Configure window.** The eight "Include in exports" toggles (typed actions, skill checks, status updates, NPC conversations, NPC summaries, characters in scene, music cues, resume markers) now live in the Configure window's "Include in exports" section. The main popup keeps only the page-feature toggles (Performance fix, Skip All button).
- Main popup is now status + actions only: status card, Current turn / Whole story export buttons, Start/Stop live export, file path display, and the Configure button. Tighter and quicker to scan.
- The "Change folder/filename…" link is removed; the Configure button is the single entry point for all export configuration.

### Fixed
- The Configure UI is no longer killed by the OS folder picker stealing focus. Previously, picking a folder closed the popup and lost the picked-handle state; users had to reopen the popup and discover the configuration hadn't saved.

### Added
- Configure window auto-recovers a previously-picked folder if it was closed before Save (defensive — the chrome.windows.create flow makes this nearly impossible now).
- Configure window detects when the Voyage tab is closed mid-flow and disables the form with a clear "tab is no longer available" banner.

## [1.1.0] - 2026-05-13

### Fixed
- **The actual root cause of every "NPC chat got wiped on resume/start" report.** On Windows, `window.showSaveFilePicker` pre-truncates the picked file's contents before our code can read them — every prior data-loss incident traced back to this. Live export now uses `window.showDirectoryPicker` to pick a folder, then opens the file inside it via `directoryHandle.getFileHandle(filename, { create: true })`, which never truncates. The v1.0.3 → v1.0.5 preservation logic (markers, pre-sync cleanup, conservation checks) now actually runs against real file content.

### Added
- New Configure subpage in the popup. Pick the export folder once and choose a filename (defaults to the canonical `voyage-{slug}-{character}.md`). Save persists folder + filename per campaign roomId. A "Change folder / filename…" link is always visible (disabled while live export is active) so the configuration can be updated without losing it.
- The Configure subpage shows whether the picked filename will **resume an existing export** (with the last turn number) or **create a new file**, before the user commits with Save.
- "Clear configuration" link inside Configure forgets the saved folder/filename for the current campaign.
- Filename validation in Configure: rejects path separators, NUL bytes, and Windows reserved names (`CON`, `PRN`, etc.); auto-appends `.md` if missing.
- The folder + filename are shown in the main view whenever a configuration exists, not just while live export is active.

### Changed
- **Live export is now configure-then-start.** The single Start/Resume/Stop button cycles based on configuration state: `Configure live export` (no config) → `Start live export` (has config, paused) → `Stop live export` (running). There's no longer any distinction between Start and Resume — Start always re-opens the configured file non-destructively.
- **Stop preserves the configuration.** Previously, Stop cleared the IDB record so the next launch required re-picking the file. Now Stop only pauses writing; the folder + filename persist until you explicitly Clear them.
- IDB record shape changed from `{ handle, lastWrittenTick }` (file handle) to `{ directoryHandle, filename, lastWrittenTick }`. **One-time reconfigure required for existing users** — old records are detected and cleaned up on load, and the popup falls through to "Configure live export" so users re-pick a folder once.

## [1.0.5] - 2026-05-13

### Added
- Sync progress display in the popup: the status card now shows the current sync phase ("Cleaning up interrupted chats…", "Fetching history…", "Backfilling characters…", "Writing missing turns…") in place of the turn count while a resume or start sync is running, then shows "Sync complete — N turns up to date" when done
- Verbose debug logging for live-export internals, gated behind `chrome.storage.local.voyageStoryDebug`. Enable from the Voyage tab's DevTools console with `__voyageStoryHelper.setDebug(true)`; disable with `setDebug(false)`. Logs prefix every line with `[voyage-story]` and trace every file read, write, cleanup decision, backfill insertion, append, and rewrite.
- `__voyageStoryHelper.dumpState()` debug handle — returns the current liveExport state, parsed file chat blocks, and cache snapshot summary in one object. Run from the Voyage tab's DevTools console (`await __voyageStoryHelper.dumpState()`).

### Fixed
- `backfillCharactersInFile`, `preSyncCleanupChatBlocks`, and `rewriteTurnInFile` now refuse to commit a write if the new content has fewer turn markers, NPC-chat-start markers, or NPC-chat-end markers than the input. Any slicing bug that would silently drop a chat block is now caught and logged instead of overwriting the file.

## [1.0.4] - 2026-05-13

### Added
- NPC chat blocks now carry `<!-- voyage-npc-chat:start:tick=N:npc=Slug -->` and matching end markers in the live-export file, so a resume can reliably tell which conversations are already on disk
- Pre-sync cleanup phase on resume: orphan chat blocks (start marker but no end marker) get closed in place — with the cache's summary if available, or an "interrupted" note if not — before any catch-up writes run
- AI summary line (`*Summary: …*`) now renders inside every full NPC conversation block when the chat closes; previously it required the separate "summaries" toggle
- New "Characters in scene" export toggle (default on) — renders a per-turn `*🎭 Characters: …*` cast line derived from `playerInputs` keys and story-paragraph speaker prefixes (narrator excluded)
- Retroactive backfill on live-export start/resume: existing turns that lack a Characters line get one spliced in non-destructively, anchored on each turn's resume marker. Idempotent and conservative — files with non-canonical formatting are left untouched

### Fixed
- NPC conversations no longer get permanently suppressed on resume when the cache happens to have them but the file does not — `writtenChatState` is now seeded from file markers (the only reliable source of truth) instead of from the transient cache
- Resume with an unrecognizable-but-non-empty file now refuses to proceed instead of falling through to a full overwrite, eliminating the last `initialWrite()` path that could shred prior content
- `rewriteTurnInFile` now treats `<!-- voyage-npc-chat:start: -->` markers as a forward boundary, so editing a turn whose next-turn chat block is already present no longer strips the chat's start marker

### Changed
- The "NPC conversation summaries" toggle has been clarified: full conversations now always include the AI summary, and the separate summary toggle only controls the compact one-liner mode used when full conversations are off

## [1.0.3] - 2026-05-12

### Fixed
- Resume live export no longer destroys live-captured NPC conversations when the IDB watermark is null; the file is read first and append-only mode is used if it already contains Voyage content

## [1.0.2] - 2026-05-11

### Added
- Narrator rewrites: when the narrator edits a completed turn, live export updates that turn's block in-place without affecting surrounding NPC chat blocks
- Resume markers are now enforced during live export to guarantee in-place rewrites can locate their target; the popup greys out the toggle with an explanation while live export is active
- Serial write queue prevents append and rewrite operations from interleaving on the file handle

## [1.0.1] - 2026-05-11

### Fixed
- Release zip now extracts to a plain `voyage-tools/` folder (no version suffix) so updating is a simple overwrite

### Changed
- Project renamed from Voyage Helper to Voyage Tools

## [1.0.0] - 2025-05-11

### Added
- Performance fix: reduces typing lag in the narrator chat sidebar (~46% improvement)
- Skip All button: one-click to skip the full dialogue queue on each turn
- Story Exporter: export your campaign as Markdown with configurable sections
  - Live export via File System Access API with automatic append
  - One-shot export of current turn or full story
  - IndexedDB persistence across sessions
  - Configurable include/exclude for inputs, skill checks, status updates, NPC chats, music cues, and resume markers
