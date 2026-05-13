# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
