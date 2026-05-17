/*
 * Voyage Tools — Story Exporter (isolated world)
 *
 * Headless on the page — all user-facing UI is in the extension popup. This
 * content script listens for chrome.runtime messages from the popup and
 * performs the requested action:
 *
 *   getStatus           — returns current session info, live-export state,
 *                         turn count, and whether a folder/filename config
 *                         exists, so the popup can render its controls
 *   exportCurrentTurn   — one-shot blob download of the live in-progress turn
 *   exportWholeStory    — pulls full history, formats markdown, blob download
 *   configureLiveExport — receives a filename from the popup. The
 *                         FileSystemDirectoryHandle is taken from
 *                         pendingDirHandle (posted by the MAIN world after
 *                         the popup triggers showDirectoryPicker via
 *                         executeScript) or falls back to the IDB record.
 *                         Validates, resolves the file non-destructively,
 *                         persists to IDB. Does NOT start writing.
 *   startLiveExport     — loads the saved directory handle + filename, opens
 *                         the file inside the folder via
 *                         `directoryHandle.getFileHandle(filename,
 *                         { create: true })` (never truncates), then:
 *                           - new/empty file : write the full story, then
 *                                              append on each turn
 *                           - existing file  : parse for the last turn we
 *                                              already documented, append
 *                                              any missing turns, then
 *                                              continue appending live —
 *                                              never overwrites existing
 *                                              content the user may have
 *                                              authored / edited offline
 *   stopLiveExport      — clears in-memory state (pauses writing). Keeps
 *                         the IDB config record so Start re-uses the same
 *                         folder/filename without reconfiguring.
 *   clearConfig         — forgets the folder/filename config for the
 *                         current campaign. Forces a re-Configure on next
 *                         use.
 *
 * Resume markers: every turn's markdown is preceded by an HTML comment
 *   <!-- voyage-turn:tick=N -->
 * and the top of the file has
 *   <!-- voyage-session:roomId=XXX -->
 * Both are invisible in rendered markdown (VS Code, GitHub, etc.). They let
 * us pick up exactly where we left off when the user resumes from another
 * device, and warn if the picked file belongs to a different campaign.
 *
 * Markdown formatting is driven by five "include" toggles configured in the
 * popup (player inputs, skill checks, status updates, NPC summaries, music
 * cues). They're read from chrome.storage and react live to changes.
 *
 * The campaign data cache lives in the main world (see voyage-story-cache.js).
 * We talk to it via window.postMessage using a { source: 'voyage-story', ... }
 * RPC envelope.
 */

(() => {
  const NAMESPACE  = 'voyage-story';

  const DEFAULT_CONFIG = {
    storyIncludeInputs:   true,
    storyIncludeChecks:   true,
    storyIncludeStatus:   true,
    // Renders any AI-generated NPC conversation summary (from statusUpdates
    // on historical turns, or from the closeNpcChat event on live-captured
    // chats). Compact single-line format.
    storyIncludeNpcChats: false,
    storyIncludeMusic:    false,
    // Resume-from-existing-file is more reliable with the markers in place,
    // so default ON. Users who want clean markdown for sharing can disable
    // them at the cost of resume falling back to heading-regex scraping.
    storyIncludeMarkers:  true,
    // Renders the full back-and-forth NPC chat dialog as a block after the
    // preceding turn. Live-export only — Voyage scrubs these from its
    // servers when the next turn commits, so we can only capture them if
    // we're actively listening during the conversation.
    storyIncludeNpcConversations: true,
    // Renders a one-line "Characters: X, Y, Z" header per turn, derived
    // from playerInputs keys and the speaker prefixes of each story
    // paragraph (Narrator excluded).
    storyIncludeCharacters: true,
  };
  const CONFIG_KEYS = Object.keys(DEFAULT_CONFIG);
  let currentConfig = { ...DEFAULT_CONFIG };
  // While live export is active:
  //   { handle, roomId, lastWrittenTick, debounceTimer }
  // lastWrittenTick is the highest tick whose markdown we've already written
  // to the file. We append-only beyond that. Persisted to IDB alongside the
  // handle so a reload + Resume picks up exactly where we left off.
  let liveExport = null;
  // Current phase label shown in the popup status card while a sync is
  // running (resume / start). Null when no sync is in progress.
  let syncPhase = null;
  // Persistent "Sync complete" line shown in the popup while live export is
  // active. Set when a resume/start sync finishes; cleared by stopLiveExport.
  let syncCompleteMsg = null;

  // All file writes (append and rewrite) funnel through this queue so they
  // never interleave. appendNewTurns and rewriteTurnInFile each fire from
  // independent debounce timers; without serialization a rewrite read-modify-
  // write cycle can straddle an append and one write silently obliterates the
  // other's result.
  let writeQueue = Promise.resolve();
  function enqueueWrite(fn) {
    writeQueue = writeQueue.then(fn).catch(() => {});
  }
  let storedHandleRoomId = null;    // roomId for which we have a saved handle but aren't actively writing
  // FileSystemDirectoryHandle posted by the MAIN world (via window.postMessage)
  // after the popup triggers showDirectoryPicker via executeScript. Consumed
  // (and cleared) by configureLiveExport, then persisted to IDB.
  let pendingDirHandle = null;

  // ---------- Verbose debug logging ----------
  // Off by default. Toggle by setting `voyageStoryDebug: true` in
  // chrome.storage.local (Voyage tab DevTools → Application → Storage →
  // Local Storage isn't where chrome.storage lives — easiest enable is
  // running `chrome.storage.local.set({ voyageStoryDebug: true })` from
  // the popup's DevTools console, or by calling
  // `window.__voyageStoryHelper.setDebug(true)` from the Voyage tab's
  // console). When on, every file read/write, every cleanup decision,
  // every backfill insertion, and every append goes through dbg() with
  // a fixed `[voyage-story]` prefix so the Voyage tab's DevTools console
  // can be filtered down to the live-export trace.
  let DEBUG_LOG = false;
  function dbg(...args) {
    if (!DEBUG_LOG) return;
    try { console.log('[voyage-story]', ...args); } catch {}
  }
  // Trace-id helper — every high-level operation gets a short label so
  // interleaved logs stay correlatable across async hops.
  let traceCounter = 0;
  function newTraceId(label) {
    return `${label}#${(++traceCounter).toString(36)}`;
  }
  // Short summary of a chunk of markdown for log lines and conservation
  // checks. Counts both the new marker-wrapped chat blocks and the legacy
  // `### 💬 Conversation with …` headings (which are the only signal in
  // pre-v1.0.4 files). Any defensive write check should treat *all* of
  // these as load-bearing — dropping a legacy heading is just as bad as
  // dropping a marker.
  function summarizeContent(text) {
    if (typeof text !== 'string') {
      return { bytes: 0, turns: 0, chatStarts: 0, chatEnds: 0, legacyChats: 0 };
    }
    const bytes = text.length;
    const turns = (text.match(/<!--\s*voyage-turn:tick=\d+\s*-->/g) || []).length;
    const chatStarts = (text.match(/<!--\s*voyage-npc-chat:start:/g) || []).length;
    const chatEnds = (text.match(/<!--\s*voyage-npc-chat:end:/g) || []).length;
    const legacyChats = (text.match(/^### 💬 Conversation with /gm) || []).length;
    return { bytes, turns, chatStarts, chatEnds, legacyChats };
  }

  // ---------- Config: chrome.storage ----------
  function loadConfig() {
    return new Promise((resolve) => {
      chrome.storage.local.get([...CONFIG_KEYS, 'voyageStoryDebug'], (result) => {
        for (const k of CONFIG_KEYS) {
          if (typeof result[k] === 'boolean') currentConfig[k] = result[k];
        }
        if (typeof result.voyageStoryDebug === 'boolean') {
          DEBUG_LOG = result.voyageStoryDebug;
          if (DEBUG_LOG) {
            try { console.log('[voyage-story] verbose debug logging enabled'); } catch {}
          }
        }
        resolve();
      });
    });
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    for (const k of CONFIG_KEYS) {
      if (k in changes) {
        const v = changes[k].newValue;
        currentConfig[k] = typeof v === 'boolean' ? v : DEFAULT_CONFIG[k];
      }
    }
    if ('voyageStoryDebug' in changes) {
      const v = changes.voyageStoryDebug.newValue;
      DEBUG_LOG = typeof v === 'boolean' ? v : false;
      try { console.log('[voyage-story] verbose debug logging', DEBUG_LOG ? 'enabled' : 'disabled'); } catch {}
    }
    // Config changes don't retroactively re-render the live-export file —
    // already-appended turns keep whatever formatting they had when written.
    // New turns will pick up the new config automatically. Click "Whole
    // story" if you want a one-off rebuild with the current config.
  });

  // ---------- Action-icon badge ----------
  // Content scripts can't call chrome.action.* directly. The service worker
  // (background.js) takes ownership of the per-tab badge; we just send it
  // start/stop pings here. Wrapped in try/catch because sendMessage rejects
  // if the SW is in the middle of restarting — not worth surfacing.
  function notifyBadge(active) {
    try {
      chrome.runtime.sendMessage({
        source: NAMESPACE,
        action: active ? 'badge:set' : 'badge:clear',
      }).catch(() => {});
    } catch {}
  }
  // Clear on script load: if a previous page session left the badge lit and
  // we no longer have liveExport state, the badge would be a lie.
  notifyBadge(false);

  // ---------- RPC bridge to MAIN world ----------
  let rpcCounter = 0;
  function callMain(requestType, args = {}, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      const requestId = `${NAMESPACE}-rpc-${Date.now()}-${rpcCounter++}`;
      function handler(e) {
        if (e.source !== window) return;
        const m = e.data;
        if (!m || m.source !== NAMESPACE || m.type !== 'response') return;
        if (m.requestId !== requestId) return;
        window.removeEventListener('message', handler);
        if (m.ok) resolve(m.result);
        else reject(new Error(m.error || 'unknown error'));
      }
      window.addEventListener('message', handler);
      window.postMessage({ source: NAMESPACE, requestType, requestId, args }, location.origin);
      setTimeout(() => {
        window.removeEventListener('message', handler);
        reject(new Error(`callMain(${requestType}) timeout`));
      }, timeoutMs);
    });
  }

  function onMainChange(callback) {
    window.addEventListener('message', (e) => {
      if (e.source !== window) return;
      const m = e.data;
      if (!m || m.source !== NAMESPACE || m.type !== 'change') return;
      callback(m.event, m.extra ?? null);
    });
  }

  // ---------- IndexedDB for FileSystemHandle + state persistence ----------
  // We store { directoryHandle, filename, lastWrittenTick } per roomId so a
  // reload can resume append-only writing exactly where the previous session
  // left off. Directory handles survive structured cloning into IDB; the
  // browser still requires user-gesture permission re-grant on restart (one
  // click via Start), but a stored handle is what lets us offer a no-picker
  // resume.
  //
  // Why a *directory* handle and not a file handle: on Windows, the OS Save
  // As dialog that backs `showSaveFilePicker` pre-truncates the picked file's
  // contents before our code can read them. Picking a folder side-steps that
  // entirely — `directoryHandle.getFileHandle(filename, { create: true })`
  // never truncates.
  //
  // Backwards-compat: pre-1.1.0 records used { handle, lastWrittenTick } with
  // a file handle. loadRecord detects those, deletes them, and returns null
  // so the popup falls through to "Configure live export" — the user
  // re-picks via the new folder-based flow once and is set.
  const DB_NAME = 'voyage-helper';
  const DB_STORE = 'storyHandles';

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => { req.result.createObjectStore(DB_STORE); };
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve(req.result);
    });
  }
  async function saveRecord(key, record) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).put(record, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  async function removeRecord(key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  async function loadRecord(key) {
    const db = await openDb();
    const v = await new Promise((resolve) => {
      const tx = db.transaction(DB_STORE, 'readonly');
      const r = tx.objectStore(DB_STORE).get(key);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => resolve(null);
    });
    if (!v) return null;
    // New shape: { directoryHandle, filename, lastWrittenTick }.
    if (v.directoryHandle && typeof v.directoryHandle === 'object' && typeof v.filename === 'string') {
      return {
        directoryHandle: v.directoryHandle,
        filename: v.filename,
        lastWrittenTick: v.lastWrittenTick ?? null,
      };
    }
    // Legacy shape (file handle, pre-1.1.0): incompatible. Delete and
    // return null so the popup shows "Configure live export" instead.
    // Properly await the delete so a subsequent loadRecord can't re-encounter
    // the legacy entry; log if it fails so the migration silent-failure
    // mode is visible.
    try {
      await removeRecord(key);
    } catch (e) {
      console.warn('[voyage-story] failed to delete legacy IDB record:', e);
    }
    return null;
  }
  // ---------- Per-room filename memory ----------
  // Lets the file picker default to whatever name the user picked last time
  // for this campaign — even after a manual Stop wipes the IDB handle, or
  // after a page reload, or across browser sessions. Distinct from the IDB
  // handle store: handles are too sensitive to persist past a manual stop,
  // but a bare filename is harmless to remember and saves a rename per
  // resume from scratch.
  const FILENAME_KEY_PREFIX = 'voyage-last-filename:';
  function rememberFilename(roomId, filename) {
    if (!roomId || !filename) return;
    try {
      chrome.storage.local.set({ [FILENAME_KEY_PREFIX + roomId]: filename });
    } catch {}
  }
  function recallFilename(roomId) {
    return new Promise((resolve) => {
      if (!roomId) return resolve(null);
      try {
        const key = FILENAME_KEY_PREFIX + roomId;
        chrome.storage.local.get(key, (result) => resolve(result?.[key] || null));
      } catch {
        resolve(null);
      }
    });
  }

  async function ensureHandlePermission(handle) {
    const opts = { mode: 'readwrite' };
    if ((await handle.queryPermission(opts)) === 'granted') return true;
    return (await handle.requestPermission(opts)) === 'granted';
  }
  async function writeToHandle(handle, content, _caller) {
    // Full overwrite. Used for the initial write of a live-export file and
    // for one-shot downloads.
    if (DEBUG_LOG) {
      let preSize = null;
      try { preSize = (await handle.getFile()).size; } catch {}
      dbg('writeToHandle:start', {
        caller: _caller || '<unknown>',
        preBytes: preSize,
        newBytes: content?.length || 0,
        summary: summarizeContent(content),
      });
    }
    const writable = await handle.createWritable();
    await writable.write(content);
    await writable.close();
    dbg('writeToHandle:done', { caller: _caller || '<unknown>' });
  }
  async function appendToHandle(handle, content, _caller) {
    // Append-only write. Uses keepExistingData so the file's prior contents
    // are preserved, then seeks to the end and writes. If the user edited
    // the file outside the extension, our append simply goes after whatever
    // they left behind.
    //
    // Guard against the existing file not ending in a blank line — without
    // a separator the new turn's "## Turn N" heading would fuse onto the
    // previous paragraph and stop being a heading.
    const writable = await handle.createWritable({ keepExistingData: true });
    const file = await handle.getFile();
    let prefix = '';
    if (file.size > 0) {
      const tail = await file.slice(Math.max(0, file.size - 2)).text();
      if (!tail.endsWith('\n\n')) {
        prefix = tail.endsWith('\n') ? '\n' : '\n\n';
      }
    }
    await writable.seek(file.size);
    await writable.write(prefix + content);
    await writable.close();
    dbg('appendToHandle:done', {
      caller: _caller || '<unknown>',
      preBytes: file.size,
      appendedBytes: (prefix + content).length,
      summary: summarizeContent(content),
    });
  }
  async function persistLiveExport() {
    if (!liveExport) return;
    if (!liveExport.directoryHandle || !liveExport.filename) {
      // Defensive: liveExport must always carry its directory handle and
      // filename now. If it doesn't, the in-memory state has diverged from
      // the IDB record — silently skipping the save would let writes
      // continue against `liveExport.handle` while IDB believes a stale
      // record. Halt loudly so the divergence can't compound.
      console.error('[voyage-story] persistLiveExport: liveExport is missing directoryHandle/filename — halting');
      setStatus('Internal state error — stop and reconfigure live export.');
      liveExport = null;
      notifyBadge(false);
      return;
    }
    try {
      await saveRecord(liveExport.roomId, {
        directoryHandle: liveExport.directoryHandle,
        filename: liveExport.filename,
        lastWrittenTick: liveExport.lastWrittenTick,
      });
    } catch (e) {
      console.warn('[voyage-story] could not persist live-export record:', e);
    }
  }

  // ---------- Markdown formatter ----------
  const STATUS_ICONS = {
    INVENTORY:        '📦',
    SKILL:            '⚔️',
    LEVEL:            '⭐',
    ABILITY_POINT:    '✨',
    RESOURCE:         '❤️',
    NPC_CONVERSATION: '💬',
  };

  // includeLive=true is for one-shot downloads ("Whole story"); the live
  // export file doesn't include in-progress turns — only completed ones are
  // appended on notifyTurnEnd.
  function buildMarkdown(snap, config, { includeLive = true } = {}) {
    const out = [];
    if (config.storyIncludeMarkers && snap.roomId) {
      out.push(`<!-- voyage-session:roomId=${snap.roomId} -->`);
    }
    // saveId is the stable per-save identifier — roomId rotates each time
    // Voyage assigns a new room to the same save, so resumes need saveId to
    // recognize that an existing file belongs to the current campaign.
    if (config.storyIncludeMarkers && snap.session?.saveId) {
      out.push(`<!-- voyage-session:saveId=${snap.session.saveId} -->`);
    }
    if (snap.world?.worldTitle) {
      out.push(`# ${snap.world.worldTitle}`);
      out.push('');
    }
    const char = snap.character?.characterChoices;
    if (char?.name) {
      const tagline = [char.name];
      if (char.gender) tagline.push(char.gender);
      if (char.race)   tagline.push(char.race);
      out.push(`*Playing as ${tagline.join(' · ')}*`);
      out.push('');
    }
    if (snap.world?.worldDescription) {
      // Italic per-line rather than blockquote so renderers that style
      // blockquotes minimally don't leave bare ">" characters showing.
      for (const line of snap.world.worldDescription.split(/\n+/)) {
        const trimmed = line.trim();
        if (trimmed) {
          out.push(`*${trimmed}*`);
          out.push('');
        }
      }
    }
    const turns = (snap.turns || []).slice().sort((a, b) => a.tick - b.tick);
    const playerName = snap.character?.characterChoices?.name || 'Player';
    const chatsByTick = groupChatsByTurnTick(snap.npcChats);
    for (const t of turns) {
      // Chats with turnTick === t.tick happened in the lead-up to turn t,
      // so they belong immediately before turn t's heading.
      for (const chat of (chatsByTick.get(t.tick) || [])) {
        pushChat(out, chat, playerName, config);
      }
      pushTurn(out, t, config);
    }
    if (includeLive && snap.liveTurn) pushLiveTurn(out, snap.liveTurn, config);
    return out.join('\n');
  }

  // Builds the markdown for a contiguous range of completed turns, no header.
  // Used by appendNewTurns to write only what's new since lastWrittenTick.
  // Takes the full snapshot so we can prepend the right NPC chats to each
  // turn (chats are stored in the cache, not on the turn record itself).
  // writtenChatState is mutated in place — chats already partially written
  // via liveAppendChats won't be re-rendered.
  function buildTurnRangeMarkdown(turns, snap, config, writtenChatState) {
    const out = [];
    const playerName = snap?.character?.characterChoices?.name || 'Player';
    const chatsByTick = groupChatsByTurnTick(snap?.npcChats);
    for (const t of turns.slice().sort((a, b) => a.tick - b.tick)) {
      for (const chat of (chatsByTick.get(t.tick) || [])) {
        const key = chatKey(chat);
        const prev = writtenChatState?.get(key);
        const wrote = pushChat(out, chat, playerName, config, prev);
        if (wrote && writtenChatState) writtenChatState.set(key, snapshotChatState(chat));
      }
      pushTurn(out, t, config);
    }
    return out.join('\n');
  }

  // NPC names are rendered into HTML-comment markers. Slug to alphanumeric
  // + underscore so (a) the marker can't accidentally close itself with `--`
  // and (b) the slug is a stable round-trip key — file-side parsing recovers
  // the same slug we computed at write time. The slug is what chatKey uses,
  // so writtenChatState entries match cleanly against file markers.
  function slugifyNpcName(name) {
    const s = String(name || '').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    return s || 'unknown';
  }
  function chatKey(chat) {
    return `${slugifyNpcName(chat.npcName)}::${chat.turnTick}`;
  }
  function snapshotChatState(chat) {
    return {
      messageCount: chat.messages?.length || 0,
      summary: chat.summary || null,
      closed: !!chat.closed,
    };
  }
  // Sentinel for chats whose body is already in the file but whose exact
  // message count is unknown (seeded from file markers). Infinity guarantees
  // any pushChat slice against this prev produces zero new messages.
  function sealedChatState(summary) {
    return { messageCount: Infinity, summary: summary || '__sealed__', closed: true };
  }

  // NPC chats are keyed by the tick of the turn they precede (the turn the
  // user submitted *after* the conversation). Group them so the renderer can
  // splice the right ones in before each turn heading.
  function groupChatsByTurnTick(chats) {
    const m = new Map();
    for (const c of (chats || [])) {
      if (!c?.closed || typeof c.turnTick !== 'number') continue;
      if (!m.has(c.turnTick)) m.set(c.turnTick, []);
      m.get(c.turnTick).push(c);
    }
    return m;
  }

  // Renders a single NPC chat — either as a full block on first write, or
  // as a delta append on subsequent writes for the same chat.
  //
  // prev: { messageCount, summary, closed } from writtenChatState, or null on
  //       the first write. When provided, only messages past prev.messageCount
  //       and a summary that differs from prev.summary are emitted (no header).
  //       When prev.closed is already true, the chat is fully written — nothing
  //       further is emitted, even if the cache picks up additional state.
  //
  // Layout (when storyIncludeMarkers is on, which is forced during live export):
  //   <!-- voyage-npc-chat:start:tick=N:npc=Slug -->
  //   ### 💬 Conversation with NpcName
  //
  //   **NpcName**: dialogue…
  //   **Player**: dialogue…
  //
  //   *Summary: …*                                    ← when closeNpcChat fires
  //   <!-- voyage-npc-chat:end:tick=N:npc=Slug -->    ← when closeNpcChat fires
  //
  // Toggle pair behavior:
  //   storyIncludeNpcConversations ON  → full dialog block; summary always at
  //                                       the end of the block when the chat
  //                                       closes (no longer gated on the
  //                                       NpcChats toggle).
  //   storyIncludeNpcConversations OFF → if storyIncludeNpcChats is on, render
  //                                       a compact single-line summary in the
  //                                       same style as statusUpdate summaries.
  //   both OFF                         → nothing.
  //
  // Returns true if anything was emitted, so callers can update
  // writtenChatState only when an actual write happened.
  function pushChat(out, chat, playerName, config, prev) {
    // Once a chat has been sealed (end-marker written), any cache state past
    // that point is moot — the conversation is closed on disk. Skip entirely
    // so we don't emit a duplicate summary line or trailing end-marker.
    if (prev?.closed) return false;

    const startIdx = prev?.messageCount || 0;
    const prevSummary = prev?.summary || null;
    const curSummary  = chat.summary    || null;
    const summaryChanged = curSummary !== prevSummary;
    const newMessages = (chat.messages || []).slice(startIdx);
    const closingNow = !!chat.closed && !prev?.closed;
    if (newMessages.length === 0 && !summaryChanged && !closingNow) return false;

    const slug = slugifyNpcName(chat.npcName);
    const useMarkers = !!config.storyIncludeMarkers && typeof chat.turnTick === 'number';

    if (config.storyIncludeNpcConversations) {
      if (!prev) {
        if (useMarkers) {
          out.push(`<!-- voyage-npc-chat:start:tick=${chat.turnTick}:npc=${slug} -->`);
        }
        out.push(`### 💬 Conversation with ${chat.npcName}`);
        out.push('');
      }
      for (const msg of newMessages) {
        const speaker = msg.role === 'npc' ? chat.npcName : playerName;
        const content = String(msg.content || '').trim();
        if (!content) continue;
        // Split multi-paragraph messages (stage direction \n\n dialogue) so
        // each paragraph renders separately. The speaker label only prefixes
        // the first paragraph; continuation paragraphs are unprefixed prose.
        const paragraphs = content.split(/\n\n+/).map((p) => p.trim()).filter(Boolean);
        if (paragraphs.length === 0) continue;
        out.push(`**${speaker}**: ${paragraphs[0]}`);
        for (let i = 1; i < paragraphs.length; i++) {
          out.push('');
          out.push(paragraphs[i]);
        }
        out.push('');
      }
      // Summary always rides with the conversation now — the NpcChats toggle
      // is reserved for the compact one-liner mode below.
      if (summaryChanged && curSummary) {
        out.push(`*Summary: ${curSummary}*`);
        out.push('');
      }
      if (closingNow && useMarkers) {
        out.push(`<!-- voyage-npc-chat:end:tick=${chat.turnTick}:npc=${slug} -->`);
        out.push('');
      }
      return true;
    } else if (config.storyIncludeNpcChats && summaryChanged && curSummary) {
      out.push(`*💬 ${chat.npcName}: ${curSummary}*`);
      out.push('');
      return true;
    }
    return false;
  }

  // Pull a unique list of scene participants for a turn. Names come from two
  // sources: playerInputs keys (the acting player character) and the speaker
  // prefix of each story paragraph ("Speaker: …" — the Voyage server uses the
  // same shape for both narration and dialogue). Narrator lines are dropped.
  // Insertion order is preserved so the result reads in roughly the order
  // characters appear in the scene.
  function extractTurnCharacters(turn) {
    const names = new Set();
    for (const name of Object.keys(turn.playerInputs || {})) {
      const trimmed = String(name || '').trim();
      if (trimmed) names.add(trimmed);
    }
    const paragraphs =
      Array.isArray(turn.storyParagraphs) && turn.storyParagraphs.length
        ? turn.storyParagraphs
        : (typeof turn.storyMessage === 'string'
            ? turn.storyMessage.split(/\n{2,}/)
            : []);
    for (const p of paragraphs) {
      if (typeof p !== 'string') continue;
      const trimmed = p.trim();
      // ': ' (with trailing space) matches Voyage's "Speaker: …" pattern and
      // mirrors formatStoryParagraph's own delimiter — avoids false positives
      // on stray colons inside narrator prose.
      const idx = trimmed.indexOf(': ');
      if (idx <= 0) continue;
      const speaker = trimmed.slice(0, idx).trim();
      if (!speaker || /^narrator$/i.test(speaker)) continue;
      names.add(speaker);
    }
    return [...names];
  }

  function pushTurn(out, turn, config) {
    const loc = turn.locationContext;
    const locStr = loc
      ? [loc.currentLocationArea, loc.currentLocation, loc.currentRegion]
          .filter(Boolean).join(' · ')
      : '';
    out.push(`## Turn ${turn.tick}${locStr ? ` — *${locStr}*` : ''}`);
    if (config.storyIncludeMarkers) {
      out.push(`<!-- voyage-turn:tick=${turn.tick} -->`);
    }
    out.push('');

    if (config.storyIncludeCharacters) {
      const chars = extractTurnCharacters(turn);
      if (chars.length) {
        out.push(`*🎭 Characters: ${chars.join(', ')}*`);
        out.push('');
      }
    }

    if (config.storyIncludeMusic && turn.musicContext) {
      const mc = turn.musicContext;
      const bits = [];
      if (mc.musicTrack)    bits.push(mc.musicTrack);
      if (mc.musicMood)     bits.push(mc.musicMood);
      if (mc.soundAmbience) bits.push(mc.soundAmbience);
      if (bits.length) {
        out.push(`*🎵 ${bits.join(' · ')}*`);
        out.push('');
      }
    }

    // Player input renders as a blockquote so it's visually distinct from
    // the narrator/dialogue prose that follows in the same turn — without
    // the delimiter the two streams of paragraphs look identical and the
    // reader can't tell where their action ends and the response begins.
    //
    // Blockquote is used ONLY here, not elsewhere in the export (status
    // updates, world description, etc.). Renderers that don't style
    // blockquotes (looking at you, Notepad) will show literal "> " chars,
    // which is ugly but unambiguous; most renderers (VS Code, GitHub,
    // Obsidian, Discord, the typical editor) render an indented italic
    // bar that does the job nicely.
    //
    // Empty lines inside the player's text become bare ">" (no trailing
    // space) so strict CommonMark keeps the blockquote contiguous instead
    // of splitting it into separate ones.
    if (config.storyIncludeInputs && turn.playerInputs) {
      for (const [name, text] of Object.entries(turn.playerInputs)) {
        if (!text) continue;
        const lines = text.trim().split('\n').map((l) => (l.length ? `> ${l}` : '>'));
        out.push(`> **▶ ${name}'s action**`);
        out.push('>');
        out.push(...lines);
        out.push('');
      }
    }

    if (config.storyIncludeChecks && Array.isArray(turn.pastUpdates?.skillChecks)) {
      for (const sc of turn.pastUpdates.skillChecks) {
        out.push(formatSkillCheck(sc));
        out.push('');
      }
    }

    // Story body. Two sources, same shape ("Speaker: [direction] text" or
    // "NARRATOR: prose"):
    //   1. turn.storyParagraphs — pre-split array (newer "complex" turns)
    //   2. turn.storyMessage    — single string with paragraphs separated
    //                             by blank lines (older "simple" turns and
    //                             also present on complex turns as the
    //                             same content joined)
    // Older saves from before Voyage's schema upgrade only have (2), so we
    // fall back to splitting it on blank lines.
    const paragraphs =
      Array.isArray(turn.storyParagraphs) && turn.storyParagraphs.length
        ? turn.storyParagraphs
        : (typeof turn.storyMessage === 'string'
            ? turn.storyMessage.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean)
            : []);
    for (const p of paragraphs) {
      const formatted = formatStoryParagraph(p);
      if (formatted) {
        out.push(formatted);
        out.push('');
      }
    }

    if (Array.isArray(turn.statusUpdates) && turn.statusUpdates.length) {
      const lines = [];
      for (const su of turn.statusUpdates) {
        const isNpc = su.eventType === 'NPC_CONVERSATION';
        if (isNpc  && !config.storyIncludeNpcChats) continue;
        if (!isNpc && !config.storyIncludeStatus)   continue;
        const icon = STATUS_ICONS[su.eventType] || '•';
        // Status updates may have embedded newlines; collapse to a single
        // line so the italic wrapping doesn't break.
        const text = String(su.text || '').replace(/\s*\n\s*/g, ' ');
        lines.push(`*${icon} ${text}*`);
      }
      for (const line of lines) {
        out.push(line);
        out.push('');
      }
    }
  }

  function pushLiveTurn(out, live, config = {}) {
    const statusTag = live.status && live.status !== 'idle'
      ? ' *(live — in progress)*'
      : ' *(live)*';
    out.push(`## Turn ${live.turnNumber}${statusTag}`);
    if (config.storyIncludeMarkers && typeof live.turnNumber === 'number') {
      out.push(`<!-- voyage-turn:tick=${live.turnNumber} -->`);
    }
    out.push('');
    if (!Array.isArray(live.chunks) || live.chunks.length === 0) {
      out.push('*Waiting for content…*');
      out.push('');
      return;
    }
    // chunks is a flat array of blocks straight from narrationSync. Each
    // block has the same fields we'd derive by parsing a historical
    // storyParagraph, so we can render at full fidelity:
    //   { type: "dialogue" | "narration", text, speaker, direction,
    //     speakerKind: "player" | "npc" | "narrator", … }
    for (const block of live.chunks) {
      if (!block || typeof block.text !== 'string' || !block.text.length) continue;
      const isDialogue = block.type === 'dialogue' && block.speaker;
      if (isDialogue) {
        const dir = block.direction ? ` *(${block.direction})*` : '';
        out.push(`**${block.speaker}**${dir}: "${block.text.trim()}"`);
      } else {
        // Narration (or anything without a speaker) renders as plain prose,
        // matching how historical "Narrator:" lines are rendered (prefix
        // stripped, paragraph emitted directly).
        out.push(block.text.trim());
      }
      out.push('');
    }
  }

  function formatStoryParagraph(p) {
    if (typeof p !== 'string') return '';
    const trimmed = p.trim();
    if (!trimmed) return '';
    if (trimmed === '---') return '---';

    const idx = trimmed.indexOf(': ');
    if (idx === -1) return trimmed;
    const speaker = trimmed.slice(0, idx).trim();
    const body    = trimmed.slice(idx + 2).trim();

    // Narrator (any case — sources mix "Narrator" and "NARRATOR"): drop the
    // label and render the body as plain prose.
    if (/^narrator$/i.test(speaker)) return body;

    // Speaker with a bracketed stage direction:
    //   "Pyre Leader: [confused, shouting] You speak of designated zones..."
    const dirMatch = body.match(/^\[([^\]]+)\]\s*([\s\S]*)$/);
    if (dirMatch) {
      const [, direction, dialogue] = dirMatch;
      return `**${speaker}** *(${direction.trim()})*: "${dialogue.trim()}"`;
    }
    return `**${speaker}**: "${body}"`;
  }

  function formatSkillCheck(sc) {
    const skill = capitalize(sc.relevantSkill);
    const diff  = capitalize(sc.difficulty);
    const success = sc.successLevel
      ? sc.successLevel.replace(/\b\w/g, (c) => c.toUpperCase())
      : '';
    const mods = Array.isArray(sc.modifiers) && sc.modifiers.length
      ? sc.modifiers
          .map((m) => `${m.name}: ${m.modifier >= 0 ? '+' : ''}${(Math.round(m.modifier * 10) / 10)}`)
          .join(', ')
      : '';
    const head = `🎲 ${skill}${diff ? ` (${diff})` : ''}${success ? `: ${success}` : ''}`;
    return mods ? `*${head}* — *${mods}*` : `*${head}*`;
  }

  function capitalize(s) {
    if (!s || typeof s !== 'string') return '';
    return s[0].toUpperCase() + s.slice(1);
  }

  function safeFilename(s) {
    return String(s || '').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 60);
  }

  // Build a stable, human-readable filename from the session metadata.
  // Falls back gracefully if any field is missing.
  //   defaultFilename({ name: "Return of the Dragon Queen", characterName: "Jinn" })
  //     -> "voyage-return_of_the_dragon_queen-jinn.md"
  //   defaultFilename(session, "turn114")
  //     -> "voyage-return_of_the_dragon_queen-jinn-turn114.md"
  function defaultFilename(session, suffix) {
    const slug = (s) => safeFilename(s).toLowerCase().replace(/^_+|_+$/g, '');
    const base = slug(session?.name || session?.worldTitle || session?.roomId || 'campaign')
                  || 'campaign';
    const char = session?.characterName ? '-' + slug(session.characterName) : '';
    const suf  = suffix ? '-' + slug(suffix) : '';
    return `voyage-${base}${char}${suf}.md`;
  }

  // ---------- One-shot download ----------
  function triggerDownload(filename, content) {
    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
  }

  // ---------- Export actions ----------
  async function exportCurrentTurn() {
    setStatus('Reading current turn…');
    const snap = await callMain('getSnapshot');

    // Prefer the live in-progress turn if there's one streaming. Otherwise
    // fall back to the most recent completed turn from history — useful right
    // after a page refresh when no turn is in progress but the player wants
    // to grab the last completed beat.
    if (snap.liveTurn) {
      const out = [];
      pushLiveTurn(out, snap.liveTurn, currentConfig);
      const filename = defaultFilename(snap.session, `turn${snap.liveTurn.turnNumber}`);
      triggerDownload(filename, out.join('\n'));
      setStatus(`Current turn downloaded (${filename}).`);
      return { ok: true, filename };
    }

    const turns = (snap.turns || []).slice().sort((a, b) => a.tick - b.tick);
    const latest = turns[turns.length - 1];
    if (!latest) {
      setStatus('No turns loaded yet — wait for the campaign to finish loading.');
      return { ok: false, message: 'No turns loaded' };
    }
    const out = [];
    const playerName = snap.character?.characterChoices?.name || 'Player';
    for (const chat of (groupChatsByTurnTick(snap.npcChats).get(latest.tick) || [])) {
      pushChat(out, chat, playerName, currentConfig);
    }
    pushTurn(out, latest, currentConfig);
    const filename = defaultFilename(snap.session, `turn${latest.tick}`);
    triggerDownload(filename, out.join('\n'));
    setStatus(`Latest turn downloaded (${filename}).`);
    return { ok: true, filename };
  }

  async function exportWholeStory() {
    setStatus('Pulling full history…');
    const r = await callMain('pullAllHistory', { count: 10 }, 5 * 60 * 1000);
    setStatus(`Loaded ${r.totalTurns} turns. Building markdown…`);
    const snap = await callMain('getSnapshot');
    const md = buildMarkdown(snap, currentConfig);
    const filename = defaultFilename(snap.session);
    triggerDownload(filename, md);
    const total = r.totalTurns + (snap.liveTurn ? 1 : 0);
    setStatus(`Downloaded ${total} turns (${filename}).`);
    return { ok: true, filename, turnCount: total };
  }

  // ---------- Resume-from-existing-file parsing ----------
  // Each turn we write carries an HTML-comment marker. Reading them back is
  // how we know where to pick up when the user picks an existing markdown
  // file (e.g. they played on their phone, came back to desktop, and want to
  // resume live export into the same file).
  const TURN_MARKER_RE          = /<!--\s*voyage-turn:tick=(\d+)\s*-->/g;
  const SESSION_ROOM_MARKER_RE  = /<!--\s*voyage-session:roomId=([\w-]+)\s*-->/;
  const SESSION_SAVE_MARKER_RE  = /<!--\s*voyage-session:saveId=([\w-]+)\s*-->/;
  // Combined matcher for stripping legacy session markers when migrating a
  // file forward. Global flag so replace() reaches every occurrence.
  const SESSION_MARKER_LINE_RE  = /^<!--\s*voyage-session:(?:roomId|saveId)=[\w-]+\s*-->\r?\n?/gm;
  // Fallback for files written before markers existed (or files where the
  // user stripped the comments): scrape the heading tick directly.
  const TURN_HEADING_RE   = /^##\s+Turn\s+(\d+)/gm;

  function parseLastTickInFile(text) {
    let maxTick = -1;
    let sawAny  = false;
    for (const m of text.matchAll(TURN_MARKER_RE)) {
      sawAny = true;
      const t = parseInt(m[1], 10);
      if (Number.isFinite(t) && t > maxTick) maxTick = t;
    }
    if (sawAny) return { tick: maxTick, source: 'marker' };
    for (const m of text.matchAll(TURN_HEADING_RE)) {
      sawAny = true;
      const t = parseInt(m[1], 10);
      if (Number.isFinite(t) && t > maxTick) maxTick = t;
    }
    return sawAny ? { tick: maxTick, source: 'heading' } : { tick: null, source: null };
  }

  // Returns { roomId, saveId } parsed from the file header. Either field may
  // be null. Pre-v1.2.1 files only carry the roomId marker; v1.2.1+ also
  // include saveId, which is what we prefer for cross-session resume since
  // Voyage rotates roomId per joinedRoom even within the same save.
  function parseSessionMarkers(text) {
    const room = text.match(SESSION_ROOM_MARKER_RE);
    const save = text.match(SESSION_SAVE_MARKER_RE);
    return { roomId: room ? room[1] : null, saveId: save ? save[1] : null };
  }

  // ---------- Filename validation and directory-handle file resolution ----------
  // Reserved on Windows; rejected case-insensitively whether or not there's an
  // extension (`CON`, `con.md`, `CON.txt` — all blocked). NUL byte rejected
  // unconditionally. Trailing dots/spaces are stripped before the check
  // because Windows can't have them in filenames either.
  const RESERVED_WIN_NAMES = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i;
  function normalizeFilename(raw) {
    let name = String(raw || '').trim();
    if (!name) return { ok: false, message: 'Filename is empty.' };
    // Strip trailing dots/spaces — Windows silently does this and we don't
    // want the IDB record to disagree with what's actually on disk.
    name = name.replace(/[. ]+$/, '');
    if (!name) return { ok: false, message: 'Filename is empty after trimming.' };
    if (/[\\/:*?"<>|\x00]/.test(name)) {
      return { ok: false, message: 'Filename contains an illegal character (\\ / : * ? " < > |).' };
    }
    if (RESERVED_WIN_NAMES.test(name)) {
      return { ok: false, message: `"${name}" is a reserved Windows filename.` };
    }
    if (!/\.md$/i.test(name)) name += '.md';
    // Reject ".md" with no stem — would be a hidden file on Unix and an
    // invalid file on Windows. Anything one char longer ("a.md") is fine.
    if (/^\.md$/i.test(name)) return { ok: false, message: 'Filename must have a name before ".md".' };
    if (name.length > 255) return { ok: false, message: 'Filename is too long (max 255 characters).' };
    return { ok: true, filename: name };
  }

  // Given a directory handle, a filename, and the current campaign's roomId
  // + saveId, open the file inside the directory non-destructively and
  // return whether the file was created (empty) or resumed (existing).
  //
  // Mismatch logic — saveId is the stable per-campaign identifier; roomId
  // rotates on every joinedRoom (so the same save typically gets a different
  // roomId each session). Rules, in order:
  //
  //   1. File has saveId marker and we have a current saveId
  //        → strict match; mismatch is a real cross-campaign error.
  //   2. File has only a roomId marker (pre-v1.2.1, no saveId tracked yet)
  //        → accept regardless of roomId match; flag needsMarkerMigration so
  //          the caller can rewrite the header with both markers on its
  //          next full write.
  //   3. File has no session markers at all
  //        → accept; flag needsMarkerMigration so we tag it going forward.
  //
  // Returns:
  //   { ok: true,  fileHandle, created: false, existingContent, parsedTick,
  //     needsMarkerMigration?: true }                                          // resumed
  //   { ok: true,  fileHandle, created: true,  existingContent: '' }            // new file
  //   { ok: false, mismatch: true, fileSaveId, message }                        // saveId mismatch
  //   { ok: false, message }                                                    // any other error
  async function resolveFileHandle(directoryHandle, filename, expectedRoomId, expectedSaveId) {
    if (!directoryHandle || typeof directoryHandle.getFileHandle !== 'function') {
      return { ok: false, message: 'Directory handle is invalid. Reconfigure live export.' };
    }
    let fileHandle = null;
    let created = false;
    try {
      fileHandle = await directoryHandle.getFileHandle(filename, { create: false });
    } catch (e) {
      // getFileHandle throws DOMException with name 'NotFoundError' when the
      // file doesn't exist. Anything else is a real failure.
      if (e?.name !== 'NotFoundError') {
        return { ok: false, message: `Couldn't open file in folder: ${e?.message || e?.name || 'unknown error'}.` };
      }
      try {
        fileHandle = await directoryHandle.getFileHandle(filename, { create: true });
        created = true;
      } catch (e2) {
        return { ok: false, message: `Couldn't create file in folder: ${e2?.message || e2?.name || 'unknown error'}.` };
      }
    }
    if (created) {
      return { ok: true, fileHandle, created: true, existingContent: '' };
    }
    let text = '';
    try {
      const f = await fileHandle.getFile();
      if (f.size > 0) text = await f.text();
    } catch (e) {
      return { ok: false, message: `Couldn't read file in folder: ${e?.message || e?.name || 'unknown error'}.` };
    }
    let needsMarkerMigration = false;
    if (text) {
      const { roomId: fileRoomId, saveId: fileSaveId } = parseSessionMarkers(text);
      if (fileSaveId && expectedSaveId) {
        if (fileSaveId !== expectedSaveId) {
          return {
            ok: false, mismatch: true, fileSaveId,
            message: `That folder already has "${filename}" but it belongs to a different campaign. Pick a different folder or filename.`,
          };
        }
        // saveId matches — file is current. Still migrate if roomId marker
        // is stale (Voyage rotated rooms since the file was last touched).
        if (expectedRoomId && fileRoomId && fileRoomId !== expectedRoomId) {
          needsMarkerMigration = true;
        }
      } else if (!fileSaveId) {
        // Legacy file (pre-v1.2.1) — no saveId to verify against. We
        // deliberately don't reject on roomId mismatch here because Voyage
        // rotates roomId per session, so the marker is usually stale. The
        // caller migrates so future starts will use the strict saveId path.
        needsMarkerMigration = true;
      }
    } else {
      // Empty file — treat as effectively new; let the caller add markers
      // on initial write.
      needsMarkerMigration = true;
    }
    const parsed = parseLastTickInFile(text);
    return {
      ok: true, fileHandle, created: false,
      existingContent: text, parsedTick: parsed.tick,
      needsMarkerMigration: needsMarkerMigration || undefined,
    };
  }

  // Rewrite the session-marker line(s) at the top of an existing file's
  // content. Strips every pre-existing voyage-session:* marker (anywhere
  // in the file — defensively) and prepends fresh roomId/saveId markers
  // based on the current snapshot. Returns the new content string.
  //
  // Pure: does not write to disk. Callers feed the result into writeToHandle
  // when they're ready to commit (typically in startLiveExport, before any
  // subsequent appends, so the file's tag matches the live state).
  function migrateSessionMarkers(content, snap) {
    const stripped = content.replace(SESSION_MARKER_LINE_RE, '');
    const header = [];
    if (snap?.roomId) header.push(`<!-- voyage-session:roomId=${snap.roomId} -->`);
    if (snap?.session?.saveId) header.push(`<!-- voyage-session:saveId=${snap.session.saveId} -->`);
    if (!header.length) return stripped;
    return header.join('\n') + '\n' + stripped;
  }

  // NPC chat block markers — emitted by pushChat when live export is active.
  // Slug captures alphanumeric+underscore (the output of slugifyNpcName), so
  // the regex is strict enough that random `<!-- something -->` comments in
  // user-edited text don't get confused for chat boundaries.
  const NPC_CHAT_START_RE = /<!--\s*voyage-npc-chat:start:tick=(\d+):npc=([A-Za-z0-9_]+)\s*-->/g;
  const NPC_CHAT_END_RE   = /<!--\s*voyage-npc-chat:end:tick=(\d+):npc=([A-Za-z0-9_]+)\s*-->/g;
  // Legacy detection — files written before v1.0.4 didn't have NPC chat
  // markers. The `### 💬 Conversation with NAME` heading is the only signal
  // their boundary exists. Anchored to the start of a line.
  const LEGACY_CHAT_HEADING_RE = /^### 💬 Conversation with (.+?)\s*$/gm;

  // Returns chat blocks discovered in the file as an array of:
  //   { key, slug, tick, startIdx, endIdx, closed, source }
  // where `source` is 'marker' or 'legacy'. `endIdx` is the index AFTER the
  // end marker (or null for orphans). `closed` is true only when a paired
  // end marker was found at a position after the start marker.
  function parseNpcChatBlocksInFile(text) {
    const blocks = [];
    const starts = [];
    for (const m of text.matchAll(NPC_CHAT_START_RE)) {
      starts.push({
        tick: parseInt(m[1], 10),
        slug: m[2],
        startIdx: m.index,
        markerLen: m[0].length,
      });
    }
    const ends = [];
    for (const m of text.matchAll(NPC_CHAT_END_RE)) {
      ends.push({
        tick: parseInt(m[1], 10),
        slug: m[2],
        idx: m.index,
        markerLen: m[0].length,
      });
    }
    // Pair each start with the nearest later end that shares (tick, slug) and
    // hasn't already been consumed. Greedy left-to-right matching is safe
    // because chats can't be nested (a turn commit closes any open chat).
    const consumed = new Set();
    for (const s of starts) {
      const matchIdx = ends.findIndex(
        (e, i) => !consumed.has(i) && e.tick === s.tick && e.slug === s.slug && e.idx > s.startIdx
      );
      if (matchIdx >= 0) {
        consumed.add(matchIdx);
        const e = ends[matchIdx];
        blocks.push({
          key: `${s.slug}::${s.tick}`,
          slug: s.slug, tick: s.tick,
          startIdx: s.startIdx,
          endIdx: e.idx + e.markerLen,
          closed: true,
          source: 'marker',
        });
      } else {
        blocks.push({
          key: `${s.slug}::${s.tick}`,
          slug: s.slug, tick: s.tick,
          startIdx: s.startIdx,
          endIdx: null,
          closed: false,
          source: 'marker',
        });
      }
    }
    if (blocks.length > 0) return blocks;

    // Legacy fallback: scrape `### 💬 Conversation with NAME` headings and
    // infer turnTick from the next `## Turn N` heading (chats precede their
    // associated turn). Legacy blocks are assumed closed — we have no signal
    // suggesting otherwise, and treating them as orphans would mass-trigger
    // synthetic interruption markers in every pre-v1.0.4 file.
    for (const m of text.matchAll(LEGACY_CHAT_HEADING_RE)) {
      const name = m[1].trim();
      const slug = slugifyNpcName(name);
      const startIdx = m.index;
      const after = text.slice(startIdx + m[0].length);
      const nextTurnMatch = after.match(/\n##\s+Turn\s+(\d+)/);
      if (!nextTurnMatch) continue;
      const tick = parseInt(nextTurnMatch[1], 10);
      blocks.push({
        key: `${slug}::${tick}`,
        slug, tick,
        startIdx,
        endIdx: startIdx + m[0].length + nextTurnMatch.index, // before next `\n## Turn`
        closed: true,
        source: 'legacy',
      });
    }
    return blocks;
  }

  // Where an orphan chat block's content ends in the file — the next `## Turn`
  // heading, the next chat start marker, or EOF. Used by the cleanup pass to
  // know where to splice in a synthetic end marker.
  function findOrphanContentEnd(content, startMarkerIdx) {
    const after = content.slice(startMarkerIdx);
    const markerEndRel = after.indexOf('-->');
    const searchStart = markerEndRel >= 0 ? markerEndRel + 3 : 0;
    const searchSlice = after.slice(searchStart);
    let endRel = searchSlice.length;
    const turnMatch = searchSlice.match(/\n##\s+Turn\s+\d+/);
    if (turnMatch) endRel = Math.min(endRel, turnMatch.index + 1);
    const nextStartMatch = searchSlice.match(/<!--\s*voyage-npc-chat:start:/);
    if (nextStartMatch) endRel = Math.min(endRel, nextStartMatch.index);
    return startMarkerIdx + searchStart + endRel;
  }

  // Persist the directory handle + filename to IDB without starting the live
  // export. Called by the popup's "Configure" flow via the isolated-world
  // helper (handles can't cross chrome.tabs.sendMessage with their methods
  // intact, so configuration happens in this script's context).
  //
  // The roomId is re-fetched from the cache rather than taken as an argument
  // so we can't accidentally persist a config under the wrong room.
  //
  // Returns one of:
  //   { ok: true, created: true, filename }
  //   { ok: true, created: false, filename, parsedTick }
  //   { ok: false, mismatch: true, message }
  //   { ok: false, message }
  async function configureLiveExport(directoryHandle, filenameRaw) {
    const trace = newTraceId('configure');
    const normalized = normalizeFilename(filenameRaw);
    if (!normalized.ok) {
      dbg(trace, 'abort', { reason: 'invalid filename', message: normalized.message });
      return { ok: false, message: normalized.message };
    }
    const filename = normalized.filename;
    const snap = await callMain('getSnapshot').catch(() => null);
    if (!snap?.roomId) {
      dbg(trace, 'abort', { reason: 'no roomId in snapshot' });
      return { ok: false, message: 'Wait for the campaign to finish loading on the page, then try again.' };
    }

    // Rename-only flow: caller passes directoryHandle=null when the user
    // changes just the filename without re-picking the folder. Look up the
    // stored handle from IDB and reuse it. If there's no stored config,
    // we have nothing to reuse — surface a clear "pick a folder first"
    // error instead of silently behaving like a fresh configure.
    console.log('[voyage-story] STEP 4 — configureLiveExport(), directoryHandle param:', {
      isNull: directoryHandle == null,
      type: typeof directoryHandle,
      constructor: directoryHandle?.constructor?.name,
      kind: directoryHandle?.kind,
      name: directoryHandle?.name,
      hasGetFileHandle: typeof directoryHandle?.getFileHandle === 'function',
      hasQueryPermission: typeof directoryHandle?.queryPermission === 'function',
      ownKeys: directoryHandle ? Object.keys(directoryHandle) : null,
      proto: directoryHandle ? Object.getPrototypeOf(directoryHandle)?.constructor?.name : null,
    });
    let effectiveDir = directoryHandle;
    if (!effectiveDir) {
      const record = await loadRecord(snap.roomId);
      if (!record?.directoryHandle) {
        dbg(trace, 'abort', { reason: 'rename-only with no stored handle' });
        return { ok: false, message: 'No folder picked yet. Click "Pick export folder" first.' };
      }
      effectiveDir = record.directoryHandle;
      dbg(trace, 'rename-only: reusing stored handle', { folder: effectiveDir.name });
    } else if (typeof effectiveDir.getFileHandle !== 'function') {
      console.log('[voyage-story] STEP 4 FAIL — handle has no getFileHandle. Prototype chain:', {
        proto1: Object.getPrototypeOf(directoryHandle)?.constructor?.name,
        proto2: Object.getPrototypeOf(Object.getPrototypeOf(directoryHandle))?.constructor?.name,
        isPlainObject: Object.getPrototypeOf(directoryHandle) === Object.prototype,
        JSON: JSON.stringify(directoryHandle),
      });
      dbg(trace, 'abort', { reason: 'invalid directoryHandle' });
      return { ok: false, message: 'Invalid folder handle.' };
    }

    const granted = await ensureHandlePermission(effectiveDir);
    if (!granted) {
      dbg(trace, 'abort', { reason: 'permission denied' });
      return { ok: false, message: 'Permission to read/write the folder was denied.' };
    }
    const resolved = await resolveFileHandle(effectiveDir, filename, snap.roomId, snap.session?.saveId);
    if (!resolved.ok) {
      dbg(trace, 'abort', { reason: 'resolve failed', message: resolved.message, mismatch: resolved.mismatch });
      return resolved;
    }
    try {
      await saveRecord(snap.roomId, {
        directoryHandle: effectiveDir,
        filename,
        // Seed lastWrittenTick from file watermark so the first Start after a
        // configure-against-existing-file resumes cleanly. For new files this
        // is null and initialWrite will compute it.
        lastWrittenTick: resolved.created ? null : (resolved.parsedTick ?? null),
      });
      rememberFilename(snap.roomId, filename);
      storedHandleRoomId = snap.roomId;
    } catch (e) {
      dbg(trace, 'abort', { reason: 'persist failed', message: e?.message });
      return { ok: false, message: `Couldn't save configuration: ${e?.message || e?.name || 'unknown error'}.` };
    }
    dbg(trace, 'done', { created: resolved.created, filename, parsedTick: resolved.parsedTick });
    return {
      ok: true,
      created: resolved.created,
      filename,
      folderName: effectiveDir.name,
      parsedTick: resolved.parsedTick ?? null,
    };
  }

  // Explicitly forget the live-export configuration for the current campaign.
  // Removes the IDB record and the remembered-filename hint. Surfaces any
  // failure so a "cleared" status doesn't lie about a record that's still
  // in IDB.
  async function clearConfig() {
    const snap = await callMain('getSnapshot').catch(() => null);
    if (!snap?.roomId) return { ok: false, message: 'No campaign loaded.' };
    const failures = [];
    try { await removeRecord(snap.roomId); }
    catch (e) { failures.push(`IDB: ${e?.message || e?.name || 'unknown'}`); }
    try { chrome.storage.local.remove(FILENAME_KEY_PREFIX + snap.roomId); }
    catch (e) { failures.push(`storage: ${e?.message || e?.name || 'unknown'}`); }
    if (storedHandleRoomId === snap.roomId) storedHandleRoomId = null;
    pendingDirHandle = null;
    if (failures.length) {
      return { ok: false, message: `Couldn't fully clear configuration: ${failures.join('; ')}.` };
    }
    return { ok: true };
  }

  // Unified start. No arguments — config must already be in IDB (set via
  // configureLiveExport). Reads config, ensures permission on the directory,
  // resolves the file inside it, runs the existing preservation flow.
  async function startLiveExport() {
    const trace = newTraceId('start');
    dbg(trace, 'start');
    const snap = await callMain('getSnapshot');
    if (!snap.roomId) {
      setStatus('Wait for the room to finish loading before starting live export.');
      dbg(trace, 'abort', { reason: 'no roomId' });
      return { ok: false, message: 'room not ready' };
    }
    const record = await loadRecord(snap.roomId);
    if (!record) {
      dbg(trace, 'abort', { reason: 'no config' });
      return { ok: false, message: 'no configuration — click Configure live export first' };
    }
    dbg(trace, 'record loaded', {
      roomId: snap.roomId,
      filename: record.filename,
      folder: record.directoryHandle?.name,
      lastWrittenTick: record.lastWrittenTick,
    });
    const granted = await ensureHandlePermission(record.directoryHandle);
    if (!granted) {
      setStatus('Permission denied for the saved folder.');
      dbg(trace, 'abort', { reason: 'permission denied' });
      return { ok: false, message: 'permission denied' };
    }
    const resolved = await resolveFileHandle(record.directoryHandle, record.filename, snap.roomId, snap.session?.saveId);
    if (!resolved.ok) {
      dbg(trace, 'abort', { reason: 'resolve failed', message: resolved.message, mismatch: resolved.mismatch });
      setStatus(resolved.message);
      return resolved;
    }
    dbg(trace, 'file resolved', {
      created: resolved.created,
      parsedTick: resolved.parsedTick,
      contentBytes: resolved.existingContent?.length || 0,
      needsMarkerMigration: !!resolved.needsMarkerMigration,
    });

    liveExport = {
      handle: resolved.fileHandle,
      directoryHandle: record.directoryHandle,
      filename: record.filename,
      roomId: snap.roomId,
      // Prefer IDB watermark; fall back to file-derived watermark from
      // resolveFileHandle for first-resume into a hand-edited existing file.
      lastWrittenTick: record.lastWrittenTick ?? resolved.parsedTick ?? null,
      debounceTimer: null,
      chatDebounceTimer: null,
      writtenChatState: new Map(),
    };
    storedHandleRoomId = snap.roomId;
    notifyBadge(true);

    // Brand-new file → initialWrite path. Cache produces the full backfill.
    if (resolved.created || !resolved.existingContent.trim()) {
      setStatus('Live export active. Backfilling history…');
      await initialWrite();
      return liveExport
        ? { ok: true, mode: 'fresh' }
        : { ok: false, message: 'initial write failed' };
    }

    // Existing file → preservation flow. Migrate stale/missing session
    // markers first (so the file's header reflects the current room+save
    // before any subsequent append goes out), then run cleanup, seed
    // writtenChatState from file markers, then catch up new turns.
    let workingContent = resolved.existingContent;
    if (resolved.needsMarkerMigration) {
      workingContent = migrateSessionMarkers(workingContent, snap);
      dbg(trace, 'migrated session markers', {
        roomId: snap.roomId,
        saveId: snap.session?.saveId || null,
      });
    }
    syncPhase = 'Cleaning up interrupted chats…';
    const { content: cleaned, dirty } = await preSyncCleanupChatBlocks(workingContent, snap);
    // Write if cleanup changed anything, OR if we migrated markers (the
    // markers live at the top of the file and appendToHandle never rewrites
    // existing content, so a one-time full write is the only way to persist
    // them).
    const mustWrite = dirty || resolved.needsMarkerMigration;
    if (mustWrite) {
      try {
        await writeToHandle(liveExport.handle, cleaned, 'startLiveExport:preSyncCleanup');
      } catch (e) {
        // The cleanup write decided the file needed orphan-chat repairs.
        // If we proceed past a failed write, the file still has orphan
        // blocks but writtenChatState would be seeded from the *intended*
        // post-cleanup buffer — subsequent live writes would mismatch
        // what's on disk, exactly the silent-divergence bug class the
        // v1.0.3-1.0.5 fixes were chasing. Abort loudly instead.
        console.error('[voyage-story] preSyncCleanup write failed:', e);
        syncPhase = null;
        setStatus(`Couldn't repair interrupted chats: ${e?.message || e?.name || 'unknown error'}. Live export not started.`);
        liveExport = null;
        notifyBadge(false);
        dbg(trace, 'abort', { reason: 'preSyncCleanup write failed', message: e?.message });
        return { ok: false, message: 'preSyncCleanup write failed: ' + (e?.message || e?.name || 'unknown') };
      }
    }
    seedWrittenChatStateFromFile(cleaned, snap, liveExport.writtenChatState);
    dbg(trace, 'seeded writtenChatState', { entries: liveExport.writtenChatState.size });

    syncPhase = 'Fetching history…';
    await callMain('pullAllHistory', { count: 10 }, 5 * 60 * 1000).catch(() => {});
    syncPhase = 'Backfilling characters…';
    await backfillCharactersInFile();
    syncPhase = 'Writing missing turns…';
    await appendNewTurns();
    await persistLiveExport();
    syncPhase = null;
    const finalSnap = await callMain('getSnapshot');
    const count = finalSnap?.turns?.length || 0;
    syncCompleteMsg = `Sync complete — ${count} turn${count === 1 ? '' : 's'} up to date`;
    setStatus('');
    dbg(trace, 'done', { mode: 'resumed', resumedFromTick: liveExport.lastWrittenTick, count });
    return { ok: true, mode: 'resumed', resumedFromTick: liveExport.lastWrittenTick };
  }

  // Stop preserves the IDB config record. Stop = "pause writing"; the
  // config is forgotten only via clearConfig (popup's "Clear configuration"
  // link).
  async function stopLiveExport() {
    syncPhase = null;
    syncCompleteMsg = null;
    if (liveExport) {
      clearTimeout(liveExport.debounceTimer);
      clearTimeout(liveExport.chatDebounceTimer);
      liveExport = null;
      notifyBadge(false);
    }
    setStatus('Live export stopped.');
    return { ok: true };
  }

  // Full overwrite: writes header + every completed turn. Called once when
  // a live export starts (or on a "rebuild from scratch" resume). Records
  // lastWrittenTick so subsequent updates can append-only.
  async function initialWrite() {
    if (!liveExport) return;
    try {
      syncPhase = 'Fetching history…';
      await callMain('pullAllHistory', { count: 10 }, 5 * 60 * 1000).catch(() => {});
      const snap = await callMain('getSnapshot');
      syncPhase = 'Building file…';
      // Don't include the live in-progress turn in the persistent file —
      // we only commit completed turns. The live turn is for one-off Current
      // turn downloads.
      const md = buildMarkdown(snap, { ...currentConfig, storyIncludeMarkers: true }, { includeLive: false });
      await writeToHandle(liveExport.handle, md, 'initialWrite');
      const lastTick = snap.turns.length ? snap.turns[snap.turns.length - 1].tick : null;
      liveExport.lastWrittenTick = lastTick;
      // buildMarkdown just rendered every chat in cache as a full block, so
      // mark them all as fully written. Subsequent chat events render only
      // the delta past this point.
      seedWrittenChatStateFromCache(snap, liveExport.writtenChatState);
      await persistLiveExport();
      syncPhase = null;
      syncCompleteMsg = `Sync complete — ${snap.turns.length} turn${snap.turns.length === 1 ? '' : 's'} up to date`;
      setStatus('');
    } catch (e) {
      syncPhase = null;
      console.error('[voyage-story] initialWrite:', e);
      // The first write failed — "live export active" would be a lie. Clear
      // the in-memory state so the popup falls back to "Start live export"
      // instead of showing a contradictory "active + error" status. Keep
      // the IDB config record so the user can retry without reconfiguring.
      setStatus(`Couldn't write to the file: ${e.message || e.name || 'unknown error'}.`);
      liveExport = null;
      notifyBadge(false);
    }
  }

  // A turn is ready to commit once it has actual story-body content. The
  // server fires notifyTurnEnd as soon as the player submits an action,
  // with a turn record that has only playerInputs populated — narration
  // (storyParagraphs / storyMessage) is folded in by a later harvest event
  // (a second notifyTurnEnd or notifySkillChecksFinished). If we wrote on
  // the first event, lastWrittenTick would advance past the turn and the
  // later content would be silently dropped. Defer until the body lands.
  function isTurnComplete(t) {
    if (Array.isArray(t.storyParagraphs) && t.storyParagraphs.length > 0) return true;
    if (typeof t.storyMessage === 'string' && t.storyMessage.trim().length > 0) return true;
    return false;
  }

  // Append-only: writes just the turns whose tick is greater than what we've
  // already committed AND whose body has arrived. Called whenever the cache
  // lands new completed turns; turns whose body hasn't materialized yet are
  // skipped silently — the next harvest event will retrigger this.
  async function appendNewTurns() {
    if (!liveExport) return;
    try {
      const snap = await callMain('getSnapshot');
      const cutoff = liveExport.lastWrittenTick;
      const newTurns = (snap.turns || []).filter(
        (t) => typeof t?.tick === 'number'
          && (cutoff == null || t.tick > cutoff)
          && isTurnComplete(t)
      );
      if (newTurns.length === 0) {
        dbg('appendNewTurns:noop', { cutoff, totalTurns: (snap.turns || []).length });
        return;
      }
      const md = buildTurnRangeMarkdown(newTurns, snap, { ...currentConfig, storyIncludeMarkers: true }, liveExport.writtenChatState);
      dbg('appendNewTurns:writing', {
        cutoff,
        newTickRange: [newTurns[0].tick, newTurns[newTurns.length - 1].tick],
        newTurnCount: newTurns.length,
        bytes: md.length,
      });
      await appendToHandle(liveExport.handle, md, 'appendNewTurns');
      const newLast = newTurns.reduce((m, t) => Math.max(m, t.tick), cutoff ?? -Infinity);
      liveExport.lastWrittenTick = newLast;
      await persistLiveExport();
      const totalWritten = snap.turns.length;
      const deltaPart = newTurns.length === 1 ? '+1 turn' : `+${newTurns.length} turns`;
      setStatus(`Live export: ${deltaPart} (${totalWritten} total)`, 4000);
    } catch (e) {
      console.error('[voyage-story] appendNewTurns:', e);
      setStatus(`Live export error: ${e.message}`, 5000);
    }
  }

  // Non-destructive retroactive insert. For each turn marker in the file that
  // doesn't already have a Characters line, splice one in immediately after the
  // marker's blank line — using the cache's view of that turn's storyParagraphs.
  // Idempotent (skips turns that already have the line) and conservative
  // (skips any marker not followed by the canonical "\n\n" we ourselves emit,
  // so hand-mangled files are left untouched). Called once at start/resume
  // after pullAllHistory so the cache has every historical turn loaded.
  async function backfillCharactersInFile() {
    if (!liveExport) return;
    if (!currentConfig.storyIncludeCharacters) return;
    const trace = newTraceId('backfill');
    try {
      const file = await liveExport.handle.getFile();
      const content = await file.text();
      dbg(trace, 'start', { fileBytes: file.size, summary: summarizeContent(content) });
      if (!content) {
        dbg(trace, 'skip', { reason: 'empty file' });
        return;
      }

      const snap = await callMain('getSnapshot');
      const turnsByTick = new Map();
      for (const t of (snap.turns || [])) {
        if (typeof t?.tick === 'number') turnsByTick.set(t.tick, t);
      }
      if (turnsByTick.size === 0) {
        dbg(trace, 'skip', { reason: 'no turns in cache' });
        return;
      }
      dbg(trace, 'cache loaded', { cacheTurns: turnsByTick.size });

      const pieces = [];
      let lastIdx = 0;
      let backfilled = 0;
      const decisions = [];
      const markerRe = /<!--\s*voyage-turn:tick=(\d+)\s*-->/g;
      for (const m of content.matchAll(markerRe)) {
        const tick = parseInt(m[1], 10);
        const markerEnd = m.index + m[0].length;
        // Only operate on the canonical "marker\n\n" shape our writer emits;
        // refuse to splice into anything else.
        if (content[markerEnd] !== '\n' || content[markerEnd + 1] !== '\n') {
          decisions.push({ tick, skip: 'non-canonical marker tail' });
          continue;
        }
        const insertAt = markerEnd + 2;

        // Scope idempotency check to this turn's block. \n##\s matches only the
        // next ## Turn heading (the trailing \s rules out ### chat headings),
        // so any NPC chat blocks sitting between this turn and the next are
        // included in our scan — that's fine, they don't contain Characters lines.
        const afterInsert = content.slice(insertAt);
        const nextMatch = afterInsert.match(/\n##\s/);
        const blockEnd = nextMatch ? insertAt + nextMatch.index : content.length;
        const block = content.slice(insertAt, blockEnd);
        // The Characters line is distinctive enough (emoji + italic + literal
        // "Characters:") that a substring check has no realistic false-positive risk.
        if (block.includes('*🎭 Characters: ')) {
          decisions.push({ tick, skip: 'already has characters line' });
          continue;
        }

        const turn = turnsByTick.get(tick);
        if (!turn) {
          decisions.push({ tick, skip: 'tick not in cache' });
          continue;
        }
        const chars = extractTurnCharacters(turn);
        if (chars.length === 0) {
          decisions.push({ tick, skip: 'no characters extracted' });
          continue;
        }

        decisions.push({ tick, insert: chars, insertAt, blockEnd });
        pieces.push(content.slice(lastIdx, insertAt));
        pieces.push(`*🎭 Characters: ${chars.join(', ')}*\n\n`);
        lastIdx = insertAt;
        backfilled++;
      }

      dbg(trace, 'decisions', { backfilled, total: decisions.length, decisions });

      if (backfilled === 0) {
        dbg(trace, 'done:noop');
        return;
      }
      pieces.push(content.slice(lastIdx));
      const out = pieces.join('');
      const outSummary = summarizeContent(out);
      const inSummary = summarizeContent(content);
      // Defense check: if the rebuild dropped any turn marker or chat marker
      // that was in the input, refuse to write. We're supposed to be strictly
      // additive — any marker delta means a slicing bug.
      if (
        outSummary.turns < inSummary.turns ||
        outSummary.chatStarts < inSummary.chatStarts ||
        outSummary.chatEnds < inSummary.chatEnds ||
        outSummary.legacyChats < inSummary.legacyChats
      ) {
        console.error('[voyage-story] backfillCharactersInFile: refusing to write — would drop markers or chat headings', {
          inSummary, outSummary,
        });
        dbg(trace, 'abort:would-drop-markers', { inSummary, outSummary });
        // Surface to the popup so the user knows a write was refused. The
        // refusal itself is the right behavior (it's protecting against
        // data loss), but a silent refusal would let the user think
        // backfill succeeded when it didn't.
        setStatus('Refused Characters backfill — open DevTools console for details.', 8000);
        return;
      }
      dbg(trace, 'writing', {
        preBytes: content.length, postBytes: out.length, delta: out.length - content.length,
        inSummary, outSummary,
      });
      await writeToHandle(liveExport.handle, out, 'backfillCharactersInFile');
      setStatus(`Backfilled Characters into ${backfilled} existing turn${backfilled === 1 ? '' : 's'}.`);
    } catch (e) {
      console.error('[voyage-story] backfillCharactersInFile:', e);
      dbg(trace, 'error', { message: e?.message, stack: e?.stack });
    }
  }

  function scheduleAppend() {
    if (!liveExport) return;
    clearTimeout(liveExport.debounceTimer);
    // Short debounce coalesces back-to-back turn-completion events
    // (notifySkillChecksFinished often fires right before notifyTurnEnd) into
    // a single append call.
    liveExport.debounceTimer = setTimeout(() => enqueueWrite(appendNewTurns), 500);
  }

  // Called when sendUndoState arrives. Removes the undone turn (and any NPC
  // chat blocks attributed to it) from the live export file by truncating
  // from their start to EOF, then updates lastWrittenTick.
  // If the turn was never written (e.g. undo before narration completed),
  // the marker won't be in the file and we return early — no write needed.
  async function truncateFromTick(tick) {
    if (!liveExport) return;
    try {
      const file = await liveExport.handle.getFile();
      const content = await file.text();
      const markerStr = `<!-- voyage-turn:tick=${tick} -->`;
      const markerIdx = content.indexOf(markerStr);
      if (markerIdx === -1) return;

      // Locate the ## Turn heading above the marker (same logic as rewriteTurnInFile).
      const beforeMarker = content.slice(0, markerIdx);
      const headingNewlineIdx = beforeMarker.lastIndexOf('\n## ');
      const headingStart = headingNewlineIdx === -1 ? 0 : headingNewlineIdx + 1;

      // NPC chat blocks for this tick are placed immediately before the ##
      // heading. If any exist, extend the cut point to include them.
      const beforeHeading = content.slice(0, headingStart);
      const npcStartTag = `voyage-npc-chat:start:tick=${tick}:`;
      const npcIdx = beforeHeading.indexOf(npcStartTag);
      const cutIdx = npcIdx !== -1
        ? beforeHeading.lastIndexOf('<!--', npcIdx)
        : headingStart;

      const trimmed = content.slice(0, cutIdx).trimEnd();
      await writeToHandle(liveExport.handle, trimmed ? trimmed + '\n' : '', `truncateFromTick(${tick})`);

      const snap = await callMain('getSnapshot');
      const newLast = (snap.turns || []).reduce((m, t) => Math.max(m, t.tick), -Infinity);
      liveExport.lastWrittenTick = isFinite(newLast) ? newLast : null;

      // Remove chat state entries for the undone tick so they re-render if restored.
      for (const key of [...liveExport.writtenChatState.keys()]) {
        if (key.endsWith(`::${tick}`)) liveExport.writtenChatState.delete(key);
      }

      await persistLiveExport();
      setStatus(`Undo: removed turn ${tick} from live export.`, 3000);
      dbg('truncateFromTick', { tick, cutIdx, newLast: liveExport.lastWrittenTick });
    } catch (e) {
      console.error('[voyage-story] truncateFromTick:', e);
      setStatus(`Live export undo error: ${e.message}`, 5000);
    }
  }

  // NPC chats are written incrementally to the file as messages stream in —
  // each event (open, send, response, close) triggers a debounced flush
  // that appends only the delta since the last write. The 500ms debounce
  // coalesces rapid-fire openNpcChat → first message sequences into one
  // append, but is short enough that the user sees content land within
  // about half a second of each new message.
  function scheduleChatFlush() {
    if (!liveExport) return;
    clearTimeout(liveExport.chatDebounceTimer);
    liveExport.chatDebounceTimer = setTimeout(() => enqueueWrite(liveAppendChats), 500);
  }

  async function liveAppendChats() {
    if (!liveExport) return;
    const trace = newTraceId('liveAppendChats');
    try {
      const snap = await callMain('getSnapshot');
      const playerName = snap.character?.characterChoices?.name || 'Player';
      const writtenState = liveExport.writtenChatState;

      const out = [];
      const toCommit = [];
      const writeConfig = { ...currentConfig, storyIncludeMarkers: true };
      const perChat = [];
      for (const chat of (snap.npcChats || [])) {
        const key = chatKey(chat);
        const prev = writtenState.get(key);
        const before = out.length;
        const wrote = pushChat(out, chat, playerName, writeConfig, prev);
        if (wrote) {
          toCommit.push({ key, state: snapshotChatState(chat) });
          perChat.push({
            key, turnTick: chat.turnTick, closed: !!chat.closed,
            prevClosed: !!prev?.closed, prevMessageCount: prev?.messageCount ?? null,
            cacheMessageCount: chat.messages?.length || 0,
            linesEmitted: out.length - before,
          });
        }
      }
      if (out.length === 0) {
        dbg(trace, 'noop', { snapChats: (snap.npcChats || []).length });
        return;
      }
      dbg(trace, 'writing', { perChat, bytes: out.join('\n').length });
      await appendToHandle(liveExport.handle, out.join('\n'), 'liveAppendChats');
      for (const { key, state } of toCommit) writtenState.set(key, state);
    } catch (e) {
      console.error('[voyage-story] liveAppendChats:', e);
      dbg(trace, 'error', { message: e?.message });
      setStatus(`Live export error: ${e.message}`, 5000);
    }
  }

  // ----- In-place turn rewrite (storyRewritten event) -----
  // When the narrator rewrites a completed turn, we patch that turn's block in the
  // live-export file without touching anything outside its heading boundaries.
  // NPC chats live before the heading they precede, so they're always upstream of
  // the region we replace and are never affected.
  const pendingRewriteTicks = new Set();
  let rewriteDebounceTimer = null;

  function scheduleRewrite(tick) {
    if (!liveExport) return;
    pendingRewriteTicks.add(tick);
    clearTimeout(rewriteDebounceTimer);
    rewriteDebounceTimer = setTimeout(flushRewrites, 400);
  }

  function flushRewrites() {
    if (!liveExport || pendingRewriteTicks.size === 0) return;
    const ticks = [...pendingRewriteTicks].sort((a, b) => a - b);
    pendingRewriteTicks.clear();
    rewriteDebounceTimer = null;
    for (const tick of ticks) {
      enqueueWrite(() => rewriteTurnInFile(tick));
    }
  }

  async function rewriteTurnInFile(tick) {
    if (!liveExport) return;
    try {
      const snap = await callMain('getSnapshot');
      if (!liveExport) return;
      const turn = (snap.turns || []).find((t) => t.tick === tick);
      if (!turn) return;

      const file = await liveExport.handle.getFile();
      const content = await file.text();

      // Require the voyage-turn marker to locate the block precisely. If markers
      // are disabled or the turn hasn't been written yet, the updated storyMessage
      // stays in cache — a future "Whole story" export will render it correctly.
      const markerStr = `<!-- voyage-turn:tick=${tick} -->`;
      const markerIdx = content.indexOf(markerStr);
      if (markerIdx === -1) return;

      // Scan backward from the marker to find the start of the ## Turn heading.
      // The heading is always immediately above the marker (no blank line between).
      const beforeMarker = content.slice(0, markerIdx);
      const headingNewlineIdx = beforeMarker.lastIndexOf('\n## ');
      // Keep the \n before the heading as the separator from the prior block.
      const startIdx = headingNewlineIdx === -1 ? 0 : headingNewlineIdx + 1;

      // Scan forward from the marker end to find the next block boundary.
      // Three things count as a boundary, in priority of leftmost match:
      //   • \n##                            — next ## Turn or ### 💬 heading
      //   • \n<!-- voyage-npc-chat:start:   — chat for the next turn (placed
      //                                        immediately before its ### 💬
      //                                        heading; must be preserved)
      // Anything that follows the turn's body content but precedes the next
      // boundary belongs to a downstream block and must be left untouched.
      const afterMarker = content.slice(markerIdx + markerStr.length);
      const nextHeadingMatch = afterMarker.match(/\n##|\n<!--\s*voyage-npc-chat:start:/);
      // +1 to skip the \n so content.slice(endIdx) starts at the '#' or '<'
      // of the next boundary token.
      const endIdx = nextHeadingMatch
        ? markerIdx + markerStr.length + nextHeadingMatch.index + 1
        : content.length;

      const out = [];
      pushTurn(out, turn, { ...currentConfig, storyIncludeMarkers: true });
      const newBlock = out.join('\n');

      // content.slice(0, startIdx) ends with '\n\n' (prior block's trailing blank line).
      // newBlock ends with '\n' (trailing '' element from pushTurn joined with '\n').
      // The extra '\n' produces '\n\n' before the next heading — matching normal spacing.
      const newContent = content.slice(0, startIdx) + newBlock + '\n' + content.slice(endIdx);
      // Defense check: marker counts must be conserved across rewrites.
      const inSummary = summarizeContent(content);
      const outSummary = summarizeContent(newContent);
      if (
        outSummary.turns < inSummary.turns ||
        outSummary.chatStarts < inSummary.chatStarts ||
        outSummary.chatEnds < inSummary.chatEnds ||
        outSummary.legacyChats < inSummary.legacyChats
      ) {
        console.error('[voyage-story] rewriteTurnInFile: refusing to write — would drop markers or chat headings', {
          tick, inSummary, outSummary, startIdx, endIdx,
        });
        setStatus(`Refused narrator-rewrite of turn ${tick} — open DevTools console for details.`, 8000);
        return;
      }
      dbg('rewriteTurnInFile', {
        tick, startIdx, endIdx,
        replacedBytes: endIdx - startIdx, newBlockBytes: newBlock.length + 1,
        inSummary, outSummary,
      });
      await writeToHandle(liveExport.handle, newContent, `rewriteTurnInFile(${tick})`);
      setStatus(`Turn ${tick} rewritten in live export.`, 3000);
    } catch (e) {
      console.error('[voyage-story] rewriteTurnInFile:', e);
      setStatus(`Live export rewrite error: ${e.message}`, 5000);
    }
  }

  // Snapshot the current cache state of all chats into writtenChatState.
  // Called after a full render (initialWrite) where buildMarkdown emitted
  // every chat in cache as a complete block — those are now on disk, so we
  // mark every cached chat as sealed.
  //
  // NOT called blindly on resume — see seedWrittenChatStateFromFile for that.
  // Seeding from cache alone on resume is what produced the "permanently
  // suppressed chat" bug: a chat that arrived in cache after the file was
  // last written would be marked already-written and never emitted.
  function seedWrittenChatStateFromCache(snap, writtenChatState) {
    for (const chat of (snap?.npcChats || [])) {
      writtenChatState.set(chatKey(chat), snapshotChatState(chat));
    }
  }

  // Seed writtenChatState by scanning the existing file. The file is the only
  // reliable source of truth for what's *actually* been written — server-side
  // chat history gets wiped after each turn commits.
  //
  // For each marker-paired chat block, the chat is sealed (no further writes
  // for that chatKey will be emitted). For each orphan start marker (i.e. the
  // chat was begun but never closed), seed using the cache state if available
  // so liveAppendChats can continue the conversation cleanly. The pre-sync
  // cleanup pass is responsible for actually closing orphans in the file
  // BEFORE we get here — by the time we seed, every block that needs sealing
  // already has its end marker, so we set `closed: true`.
  function seedWrittenChatStateFromFile(content, snap, writtenChatState) {
    const blocks = parseNpcChatBlocksInFile(content);
    for (const block of blocks) {
      if (block.closed) {
        writtenChatState.set(block.key, sealedChatState());
      } else {
        // Orphan that survived cleanup — only happens for chats still open in
        // the current session (cache has them with closed=false). Seed with
        // current cache state so the incremental writer picks up cleanly.
        const cacheChat = (snap?.npcChats || []).find(
          (c) => slugifyNpcName(c.npcName) === block.slug && c.turnTick === block.tick
        );
        if (cacheChat) {
          writtenChatState.set(block.key, snapshotChatState(cacheChat));
        } else {
          // Shouldn't happen post-cleanup, but be defensive: treat as sealed
          // so we don't accidentally re-emit on a future flush.
          writtenChatState.set(block.key, sealedChatState());
        }
      }
    }
  }

  // Pre-sync cleanup phase. Runs once on resume / re-start into an existing
  // file, BEFORE the turn-catchup append. Walks every NPC chat block in the
  // file and:
  //   • closed (paired markers, or legacy `### 💬` block followed by a turn):
  //       no-op — block is already complete on disk.
  //   • orphan, cache HAS the chat closed:
  //       splice in a synthetic close — `*Summary: …*` (if cache has one) and
  //       an end marker — at the orphan's content boundary. Recovers a chat
  //       whose closeNpcChat fired after the page died but before the writer
  //       flushed the end marker.
  //   • orphan, cache HAS the chat still open:
  //       leave the file as-is. The chat is live in this session; the
  //       incremental writer will close it normally on closeNpcChat.
  //   • orphan, cache does NOT have the chat:
  //       splice in an "interrupted" note + end marker. The chat is sealed
  //       on disk so future writes can't append stray content; the note
  //       makes the gap visible to the reader.
  //
  // Returns the (possibly rewritten) content, and a list of effects for
  // callers to seed writtenChatState from. Cleans up in-place in the file
  // via a single writeToHandle call when anything changed.
  async function preSyncCleanupChatBlocks(content, snap) {
    const trace = newTraceId('preSyncCleanup');
    if (!content) {
      dbg(trace, 'skip', { reason: 'empty content' });
      return { content, dirty: false };
    }
    const blocks = parseNpcChatBlocksInFile(content);
    const orphans = blocks.filter((b) => !b.closed);
    dbg(trace, 'parsed', {
      totalBlocks: blocks.length,
      closed: blocks.length - orphans.length,
      orphans: orphans.length,
      sources: Array.from(new Set(blocks.map((b) => b.source))),
      blockKeys: blocks.map((b) => ({ key: b.key, closed: b.closed, source: b.source })),
    });
    if (orphans.length === 0) {
      dbg(trace, 'done:noop', { reason: 'no orphans' });
      return { content, dirty: false };
    }

    // Iterate from end → start so splicing one orphan doesn't shift the
    // indices of earlier orphans.
    const sortedOrphans = orphans.slice().sort((a, b) => b.startIdx - a.startIdx);
    let newContent = content;
    let changed = false;
    const orphanDecisions = [];

    for (const block of sortedOrphans) {
      const cacheChat = (snap?.npcChats || []).find(
        (c) => slugifyNpcName(c.npcName) === block.slug && c.turnTick === block.tick
      );
      // Chat still open in the current page session — let the live writer
      // handle the eventual close. Leave content untouched.
      if (cacheChat && !cacheChat.closed) {
        orphanDecisions.push({ key: block.key, action: 'leave-open' });
        continue;
      }

      const orphanEnd = findOrphanContentEnd(newContent, block.startIdx);
      const tailHasBlankLine = newContent.slice(0, orphanEnd).endsWith('\n\n');
      const tailHasNewline   = newContent.slice(0, orphanEnd).endsWith('\n');
      const leader = tailHasBlankLine ? '' : (tailHasNewline ? '\n' : '\n\n');

      let body;
      let action;
      if (cacheChat && cacheChat.closed && cacheChat.summary) {
        body = `*Summary: ${cacheChat.summary}*\n\n<!-- voyage-npc-chat:end:tick=${block.tick}:npc=${block.slug} -->\n\n`;
        action = 'close-with-summary';
      } else if (cacheChat && cacheChat.closed) {
        body = `<!-- voyage-npc-chat:end:tick=${block.tick}:npc=${block.slug} -->\n\n`;
        action = 'close-no-summary';
      } else {
        body = `*Conversation interrupted — live export was disconnected before it closed.*\n\n<!-- voyage-npc-chat:end:tick=${block.tick}:npc=${block.slug} -->\n\n`;
        action = 'close-interrupted';
      }

      newContent = newContent.slice(0, orphanEnd) + leader + body + newContent.slice(orphanEnd);
      changed = true;
      orphanDecisions.push({ key: block.key, action, orphanEnd, insertedBytes: leader.length + body.length });
    }

    // Defense check: marker counts must be ≥ input. Cleanup is supposed to
    // only add end markers and optional notes — never remove anything.
    const inSummary = summarizeContent(content);
    const outSummary = summarizeContent(newContent);
    if (
      outSummary.turns < inSummary.turns ||
      outSummary.chatStarts < inSummary.chatStarts ||
      outSummary.chatEnds < inSummary.chatEnds ||
      outSummary.legacyChats < inSummary.legacyChats
    ) {
      console.error('[voyage-story] preSyncCleanupChatBlocks: refusing to commit — would drop markers or chat headings', {
        inSummary, outSummary,
      });
      dbg(trace, 'abort:would-drop-markers', { inSummary, outSummary, orphanDecisions });
      setStatus('Refused chat-cleanup write — open DevTools console for details.', 8000);
      return { content, dirty: false };
    }
    dbg(trace, 'done', { changed, inSummary, outSummary, orphanDecisions });
    return { content: newContent, dirty: changed };
  }

  // Live export listens to three event families:
  //   • joinedRoom            → check for campaign switch; auto-stop if so
  //   • turn-completion       → scheduleAppend for the turn writer
  //     (notifyTurnEnd, notifySkillChecksFinished, turnHistoryResponse)
  //   • NPC chat              → scheduleChatFlush for the incremental
  //     (openNpcChat, sendNpcChatMessage, npcChatResponse, closeNpcChat)
  //     chat writer
  // The turn and chat paths share writtenChatState so a chat already
  // partially written by liveAppendChats won't be re-rendered when the
  // next turn commits.
  onMainChange((event, extra) => {
    if (!liveExport) return;
    if (event === 'joinedRoom') {
      maybeAutoStopOnCampaignSwitch();
    } else if (event === 'sendUndoState' && typeof extra?.undoneTick === 'number') {
      enqueueWrite(() => truncateFromTick(extra.undoneTick));
    } else if (event === 'storyRewritten' && typeof extra?.turnTick === 'number') {
      scheduleRewrite(extra.turnTick);
    } else if (
      event === 'notifyTurnEnd' ||
      event === 'notifySkillChecksFinished' ||
      event === 'turnHistoryResponse'
    ) {
      scheduleAppend();
    } else if (
      event === 'openNpcChat' ||
      event === 'sendNpcChatMessage' ||
      event === 'npcChatResponse' ||
      event === 'closeNpcChat'
    ) {
      scheduleChatFlush();
    }
  });

  // If the user navigates out of the campaign that live export was started
  // for (Save & Exit, switching to a different save, etc.), the cache wipes
  // its per-campaign turns/chats and points at the new roomId. Without this
  // guard, liveAppendChats and appendNewTurns would happily keep writing
  // the new campaign's content into the old campaign's file. Tear down
  // immediately on roomId mismatch so the file is preserved as-of the
  // moment the user left.
  //
  // stopLiveExport always preserves the IDB config record now, so returning
  // to the original campaign just shows Start (no reconfigure needed).
  async function maybeAutoStopOnCampaignSwitch() {
    if (!liveExport) return;
    let snap;
    try { snap = await callMain('getSnapshot', {}, 3000); }
    catch { return; }
    if (!liveExport) return; // bail if state changed during the await
    const startedFor = liveExport.roomId;
    const nowIn = snap?.roomId;
    if (!nowIn || nowIn === startedFor) return;
    setStatus(`Live export paused — left the campaign. Return to resume.`);
    await stopLiveExport().catch(() => {});
  }

  // ---------- Status state (polled by popup) ----------
  let lastStatusMessage = '';
  let lastStatusAt = 0;
  // setStatus(text, ttlMs?) — sets the popup status message. If ttlMs is
  // provided and > 0, the message auto-clears after that many milliseconds
  // (the popup's 30-second visibility window still caps the maximum
  // display time, but a shorter ttlMs lets transient messages disappear
  // sooner so longer-lived state doesn't get hidden behind them).
  let statusClearTimer = null;
  function setStatus(text, ttlMs) {
    if (statusClearTimer) {
      clearTimeout(statusClearTimer);
      statusClearTimer = null;
    }
    const value = String(text || '');
    lastStatusMessage = value;
    lastStatusAt = Date.now();
    if (typeof ttlMs === 'number' && ttlMs > 0) {
      statusClearTimer = setTimeout(() => {
        if (lastStatusMessage === value) {
          lastStatusMessage = '';
          lastStatusAt = Date.now();
        }
        statusClearTimer = null;
      }, ttlMs);
    }
  }

  // ---------- Background history fetch ----------
  // When the popup first opens we want the status card to reflect the actual
  // campaign size, not just whatever happened to be captured live during
  // this page session. The popup polls getStatus, which kicks off a single
  // background pullAllHistory the first time it's called per page load.
  // Subsequent polls await the same promise so we don't spawn duplicate
  // walks. The fetch is fire-and-forget from the popup's perspective —
  // getStatus returns immediately with current cache state plus a
  // `loadingHistory` flag the popup uses to render a spinner.
  let backgroundHistoryFetch = null;
  let backgroundHistoryDone = false;
  function ensureBackgroundHistoryFetch() {
    if (backgroundHistoryDone || backgroundHistoryFetch) return;
    backgroundHistoryFetch = callMain('pullAllHistory', { count: 10 }, 5 * 60 * 1000)
      .then(() => { backgroundHistoryDone = true; })
      .catch((e) => {
        console.warn('[voyage-story] background pullAllHistory failed:', e);
      })
      .finally(() => { backgroundHistoryFetch = null; });
  }

  // ---------- chrome.runtime message API ----------
  // The extension popup is the sole caller. Each handler returns a result
  // (or throws) via sendResponse. The popup also polls getStatus while open
  // so the user sees live export progress as turns are appended.
  async function handleGetStatus() {
    let snap;
    try {
      snap = await callMain('getSnapshot', {}, 3000);
    } catch (e) {
      return {
        ok: false,
        connected: false,
        message: 'Cache not ready yet — reload the Voyage tab once after installing/updating the extension.',
      };
    }

    // Kick off the background history pull the first time the popup asks
    // for status. The popup polls every 2s so the count will climb until
    // backgroundHistoryDone flips true.
    if (snap?.roomId) ensureBackgroundHistoryFetch();

    const roomId = snap?.roomId || null;
    let hasConfig = false;
    let configFolderName = null;
    let configFilename = null;
    if (roomId) {
      try {
        const record = await loadRecord(roomId);
        if (record) {
          hasConfig = true;
          configFolderName = record.directoryHandle?.name || null;
          configFilename = record.filename || null;
          if (storedHandleRoomId !== roomId) storedHandleRoomId = roomId;
        }
      } catch {}
    }
    // The configure subpage's filename input pre-fills with: remembered
    // filename for this room, or the auto-generated canonical default.
    const remembered = await recallFilename(roomId);
    const suggestedFilename = remembered || defaultFilename(snap?.session);
    return {
      ok: true,
      connected: true,
      session: snap?.session || null,
      turnCount: (snap?.turns?.length || 0),
      hasLiveTurn: !!snap?.liveTurn,
      liveTurnNumber: snap?.liveTurn?.turnNumber ?? null,
      currentChatNpcName: snap?.currentChatNpcName ?? null,
      loadingHistory: !!backgroundHistoryFetch,
      liveExport: liveExport
        ? {
            active: true,
            roomId: liveExport.roomId,
            lastWrittenTick: liveExport.lastWrittenTick,
            filename: liveExport.filename || liveExport.handle?.name || null,
            folderName: liveExport.directoryHandle?.name || null,
          }
        : { active: false },
      hasConfig,
      configFolderName,
      configFilename,
      suggestedFilename,
      pendingDirName: pendingDirHandle?.name ?? null,
      syncPhase,
      syncCompleteMsg,
      lastStatus: lastStatusMessage,
      lastStatusAt,
      directoryPickerSupported: typeof window.showDirectoryPicker === 'function',
    };
  }

  // Relay from the MAIN world: the popup triggers showDirectoryPicker via
  // executeScript (MAIN world, beta.voyage.io origin) then postMessages the
  // resulting handle to the isolated world. Same-origin postMessage preserves
  // the handle's prototype methods unlike cross-origin IPC.
  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const m = e.data;
    if (!m || m.source !== NAMESPACE || m.type !== 'pushPendingDir') return;
    if (m.directoryHandle && typeof m.directoryHandle.getFileHandle === 'function') {
      pendingDirHandle = m.directoryHandle;
      console.log('[voyage-story] pendingDirHandle set:', m.dirName);
    } else {
      console.warn('[voyage-story] pushPendingDir: handle missing or invalid', m);
    }
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.source !== NAMESPACE || !msg.action) return;
    const respond = (val) => {
      try { sendResponse(val); } catch {}
    };
    (async () => {
      try {
        switch (msg.action) {
          case 'getStatus':
            return respond(await handleGetStatus());
          case 'exportCurrentTurn':
            return respond(await exportCurrentTurn());
          case 'exportWholeStory':
            return respond(await exportWholeStory());
          case 'startLiveExport':
            return respond(await startLiveExport());
          case 'stopLiveExport':
            return respond(await stopLiveExport());
          case 'clearConfig':
            return respond(await clearConfig());
          case 'configureLiveExport': {
            // Use pendingDirHandle (set by the MAIN-world postMessage relay)
            // rather than msg.handle — FileSystemHandle is origin-locked and
            // cannot survive chrome.tabs.sendMessage even with structured_clone.
            const handle = pendingDirHandle || null;
            console.log('[voyage-story] configureLiveExport — pendingDirHandle:', {
              isNull: handle == null,
              name: handle?.name,
              hasGetFileHandle: typeof handle?.getFileHandle === 'function',
            });
            const result = await configureLiveExport(handle, msg.filename);
            if (result.ok) pendingDirHandle = null;
            return respond(result);
          }
          default:
            return respond({ ok: false, message: 'unknown action: ' + msg.action });
        }
      } catch (e) {
        console.error('[voyage-story] action failed:', msg.action, e);
        setStatus(`Error: ${e.message}`);
        respond({ ok: false, message: e.message });
      }
    })();
    return true; // async sendResponse
  });

  // Debug surface for live-console diagnostics. Call from the Voyage tab's
  // DevTools console — e.g. `__voyageStoryHelper.setDebug(true)` to enable
  // verbose logs, or `await __voyageStoryHelper.dumpState()` to inspect the
  // current liveExport / file / cache snapshot.
  async function dumpState() {
    let fileInfo = null;
    if (liveExport?.handle) {
      try {
        const f = await liveExport.handle.getFile();
        const text = await f.text();
        fileInfo = {
          filename: f.name,
          bytes: f.size,
          summary: summarizeContent(text),
          chatBlocks: parseNpcChatBlocksInFile(text).map((b) => ({
            key: b.key, closed: b.closed, source: b.source,
            startIdx: b.startIdx, endIdx: b.endIdx,
          })),
        };
      } catch (e) {
        fileInfo = { error: e?.message };
      }
    }
    let snap = null;
    try { snap = await callMain('getSnapshot'); } catch {}
    return {
      DEBUG_LOG,
      liveExport: liveExport ? {
        roomId: liveExport.roomId,
        lastWrittenTick: liveExport.lastWrittenTick,
        writtenChatStateSize: liveExport.writtenChatState.size,
        writtenChatStateKeys: Array.from(liveExport.writtenChatState.keys()),
      } : null,
      file: fileInfo,
      cache: snap ? {
        roomId: snap.roomId,
        turnCount: (snap.turns || []).length,
        latestTick: (snap.turns || []).reduce((m, t) => Math.max(m, t.tick ?? -1), -1),
        npcChats: (snap.npcChats || []).map((c) => ({
          npcName: c.npcName, turnTick: c.turnTick,
          messageCount: c.messages?.length || 0,
          closed: !!c.closed, hasSummary: !!c.summary,
        })),
      } : null,
    };
  }
  function setDebug(on) {
    DEBUG_LOG = !!on;
    try { chrome.storage.local.set({ voyageStoryDebug: DEBUG_LOG }); } catch {}
    try { console.log('[voyage-story] verbose debug logging', DEBUG_LOG ? 'enabled' : 'disabled'); } catch {}
    return DEBUG_LOG;
  }
  window.__voyageStoryHelper = {
    configureLiveExport,
    clearConfig,
    startLiveExport,
    dumpState,
    setDebug,
  };

  // ---------- Lifecycle ----------
  // No page UI to manage — just load config and let messages drive everything.
  loadConfig();
})();
