# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
