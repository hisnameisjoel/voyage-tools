/*
 * Voyage Tools — Story Exporter (isolated world)
 *
 * Headless on the page — all user-facing UI is in the extension popup. This
 * content script listens for chrome.runtime messages from the popup and
 * performs the requested action:
 *
 *   getStatus           — returns current session info, live-export state,
 *                         turn count, and whether a stored handle exists,
 *                         so the popup can render its controls
 *   exportCurrentTurn   — one-shot blob download of the live in-progress turn
 *   exportWholeStory    — pulls full history, formats markdown, blob download
 *   startLiveExport     — receives a FileSystemFileHandle from the popup
 *                         (the popup hosts the showSaveFilePicker call so
 *                         the user-gesture requirement is satisfied), then:
 *                           - empty file       : write the full story, then
 *                                                append on each turn
 *                           - existing file    : parse for the last turn we
 *                                                already documented, append
 *                                                any missing turns, then
 *                                                continue appending live —
 *                                                never overwrites existing
 *                                                content the user may have
 *                                                authored / edited offline
 *   stopLiveExport      — clears state, removes the IDB record
 *   resumeLiveExport    — loads the saved handle, re-requests permission,
 *                         backfills anything missed, then appends new turns
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
  // We store { handle, lastWrittenTick } per roomId so a reload can resume
  // append-only writing exactly where the previous session left off. File
  // handles survive structured cloning into IDB; the browser still requires
  // user-gesture permission re-grant on restart (one click), but a stored
  // handle is what lets us offer "Resume" instead of re-picking the file.
  //
  // Backwards-compat: v1.5.0 / v1.5.1 stored a bare handle under the same
  // store. loadRecord transparently upgrades that to { handle, lastWrittenTick: null }
  // so a user reloading after upgrade gets a polite first re-pick instead of
  // a hard error.
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
    return new Promise((resolve) => {
      const tx = db.transaction(DB_STORE, 'readonly');
      const r = tx.objectStore(DB_STORE).get(key);
      r.onsuccess = () => {
        const v = r.result;
        if (!v) return resolve(null);
        // Normalize: either { handle, lastWrittenTick } or a bare handle from
        // a pre-1.5.2 install.
        if (v.handle && typeof v.handle === 'object') {
          resolve({ handle: v.handle, lastWrittenTick: v.lastWrittenTick ?? null });
        } else {
          resolve({ handle: v, lastWrittenTick: null });
        }
      };
      r.onerror = () => resolve(null);
    });
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
    try {
      await saveRecord(liveExport.roomId, {
        handle: liveExport.handle,
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
    if (includeLive && snap.liveTurn) pushLiveTurn(out, snap.liveTurn);
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

  function pushLiveTurn(out, live) {
    const statusTag = live.status && live.status !== 'idle'
      ? ' *(live — in progress)*'
      : ' *(live)*';
    out.push(`## Turn ${live.turnNumber}${statusTag}`);
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
      pushLiveTurn(out, snap.liveTurn);
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
  const TURN_MARKER_RE    = /<!--\s*voyage-turn:tick=(\d+)\s*-->/g;
  const SESSION_MARKER_RE = /<!--\s*voyage-session:roomId=([\w-]+)\s*-->/;
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

  function parseSessionRoomId(text) {
    const m = text.match(SESSION_MARKER_RE);
    return m ? m[1] : null;
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

  // Receives a FileSystemFileHandle (and roomId) from the popup, which has
  // already invoked showSaveFilePicker under its own user gesture.
  //
  // Three outcomes:
  //   - Empty file (brand-new pick or zero-byte file) → write the full story
  //     so the user lands "caught up" before live appends begin.
  //   - Existing Voyage export (markers or parseable turn headings) → parse
  //     for the highest documented tick and append only newer turns. Never
  //     overwrites existing content (the user may have edited prior turns).
  //   - Anything else (random markdown, mismatched campaign, unreadable
  //     file) → bail with a clear status message. We never set liveExport
  //     state for a failed start, so the popup can't show "active" while
  //     writes are failing.
  async function startLiveExport(handle) {
    const trace = newTraceId('start');
    dbg(trace, 'start', { filename: handle?.name });
    if (!handle) {
      setStatus('Internal error: no file handle.');
      return { ok: false, message: 'no handle' };
    }
    if (typeof handle.createWritable !== 'function' || typeof handle.getFile !== 'function') {
      setStatus('Internal error: the file handle is missing its methods. Reload the Voyage tab and try again.');
      return { ok: false, message: 'handle methods missing' };
    }
    const snap = await callMain('getSnapshot');
    if (!snap.roomId) {
      setStatus('Wait for the room to finish loading before starting live export.');
      dbg(trace, 'abort', { reason: 'no roomId' });
      return { ok: false, message: 'room not ready' };
    }
    let existing;
    try {
      const f = await handle.getFile();
      existing = await f.text();
      dbg(trace, 'file read', { bytes: f.size, summary: summarizeContent(existing) });
    } catch (e) {
      setStatus(`Couldn't read the picked file: ${e.message || e.name || 'unknown error'}. Pick a different file.`);
      dbg(trace, 'abort', { reason: 'file read failed', message: e?.message });
      return { ok: false, message: 'read failed: ' + (e.message || e.name) };
    }

    // Empty file → fresh export. Safe to do the full initial write.
    if (!existing.trim()) {
      liveExport = {
        handle,
        roomId: snap.roomId,
        lastWrittenTick: null,
        debounceTimer: null,
        chatDebounceTimer: null,
        writtenChatState: new Map(),
      };
      storedHandleRoomId = snap.roomId;
      rememberFilename(snap.roomId, handle.name);
      notifyBadge(true);
      setStatus('Live export active. Backfilling history…');
      await initialWrite();
      // initialWrite tears down liveExport on failure; reflect that result.
      return liveExport
        ? { ok: true, mode: 'fresh' }
        : { ok: false, message: 'initial write failed' };
    }

    // Non-empty. Must be a recognizable Voyage export, and (if it identifies
    // a campaign) must match the current one.
    const fileRoomId = parseSessionRoomId(existing);
    if (fileRoomId && fileRoomId !== snap.roomId) {
      setStatus("That file is from a different Voyage campaign. Pick a different file or an empty one.");
      return { ok: false, message: 'session mismatch', fileRoomId };
    }

    const parsed = parseLastTickInFile(existing);
    if (parsed.tick == null) {
      setStatus("That file doesn't look like a Voyage export. Pick an empty file, or click 'Whole story' to start a fresh export.");
      return { ok: false, message: 'unparseable' };
    }

    liveExport = {
      handle,
      roomId: snap.roomId,
      lastWrittenTick: parsed.tick,
      debounceTimer: null,
      chatDebounceTimer: null,
      writtenChatState: new Map(),
    };
    storedHandleRoomId = snap.roomId;
    rememberFilename(snap.roomId, handle.name);
    notifyBadge(true);
    // Pre-sync cleanup: close any orphan chat blocks in the file (e.g.
    // chats left open by a crashed prior session) before we seed the
    // writtenChatState. Without this, seedWrittenChatStateFromFile would
    // see only the half-written orphan and the live writer could end up
    // emitting duplicate content past it.
    syncPhase = 'Cleaning up interrupted chats…';
    const { content: cleaned } = await preSyncCleanupChatBlocks(existing, snap);
    if (cleaned !== existing) {
      await writeToHandle(handle, cleaned, 'startLiveExport:preSyncCleanup');
    }
    seedWrittenChatStateFromFile(cleaned, snap, liveExport.writtenChatState);
    syncPhase = 'Fetching history…';
    await callMain('pullAllHistory', { count: 10 }, 5 * 60 * 1000).catch(() => {});
    syncPhase = 'Backfilling characters…';
    await backfillCharactersInFile();
    syncPhase = 'Writing missing turns…';
    await appendNewTurns();
    // appendNewTurns persists only when it actually wrote something; make
    // sure the handle + tick land in IDB even if there was nothing new.
    await persistLiveExport();
    syncPhase = null;
    const finalSnap = await callMain('getSnapshot');
    const count = finalSnap?.turns?.length || 0;
    syncCompleteMsg = `Sync complete — ${count} turn${count === 1 ? '' : 's'} up to date`;
    setStatus('');
    return { ok: true, mode: 'resumed', resumedFromTick: parsed.tick };
  }

  // opts.preserveRecord (default false): keep the IDB record so the popup
  // can offer "Resume live export" next time the user enters this campaign.
  // Used by the auto-stop-on-campaign-switch path; manual stops clear it.
  async function stopLiveExport(opts = {}) {
    const { preserveRecord = false } = opts;
    syncPhase = null;
    syncCompleteMsg = null;
    if (liveExport) {
      clearTimeout(liveExport.debounceTimer);
      clearTimeout(liveExport.chatDebounceTimer);
      const roomId = liveExport.roomId;
      liveExport = null;
      notifyBadge(false);
      if (!preserveRecord) {
        try { await removeRecord(roomId); } catch {}
        if (storedHandleRoomId === roomId) storedHandleRoomId = null;
      }
    }
    setStatus('Live export stopped.');
    return { ok: true };
  }

  async function resumeLiveExport() {
    const trace = newTraceId('resume');
    dbg(trace, 'start');
    const snap = await callMain('getSnapshot');
    if (!snap.roomId) {
      setStatus('Wait for the room to finish loading.');
      dbg(trace, 'abort', { reason: 'no roomId in snapshot' });
      return { ok: false, message: 'room not ready' };
    }
    const record = await loadRecord(snap.roomId);
    if (!record) {
      dbg(trace, 'abort', { reason: 'no IDB record for room', roomId: snap.roomId });
      return { ok: false, message: 'no stored handle for this room — pick a file first' };
    }
    dbg(trace, 'record loaded', {
      roomId: snap.roomId,
      recordLastWrittenTick: record.lastWrittenTick,
      filename: record.handle?.name,
      snapTurns: (snap.turns || []).length,
      snapNpcChats: (snap.npcChats || []).length,
    });
    const ok = await ensureHandlePermission(record.handle);
    if (!ok) {
      setStatus('Permission denied for the saved file.');
      dbg(trace, 'abort', { reason: 'permission denied' });
      return { ok: false, message: 'permission denied' };
    }
    liveExport = {
      handle: record.handle,
      roomId: snap.roomId,
      lastWrittenTick: record.lastWrittenTick ?? null,
      debounceTimer: null,
      chatDebounceTimer: null,
      writtenChatState: new Map(),
    };
    storedHandleRoomId = snap.roomId;
    rememberFilename(snap.roomId, record.handle?.name);
    notifyBadge(true);

    // Read the file once up front. We use it for three things in order:
    //   1. Pre-sync cleanup: close any orphan NPC chat blocks left open by a
    //      crashed prior session, so the file is structurally complete before
    //      any further writes.
    //   2. Seed writtenChatState from file markers (the only reliable source
    //      of truth for what's actually on disk — server-side chat history
    //      gets wiped after each turn commit).
    //   3. Fall back to file-derived watermark when IDB has none (pre-1.5.2
    //      installs, or any future state-loss scenario).
    let existing = '';
    try {
      const f = await liveExport.handle.getFile();
      if (f.size > 0) existing = await f.text();
      dbg(trace, 'file read', { bytes: f.size, summary: summarizeContent(existing) });
    } catch (e) {
      dbg(trace, 'file read failed', { message: e?.message });
    }

    syncPhase = 'Cleaning up interrupted chats…';
    const { content: cleaned, dirty } = await preSyncCleanupChatBlocks(existing, snap);
    if (dirty) {
      try { await writeToHandle(liveExport.handle, cleaned, 'resumeLiveExport:preSyncCleanup'); }
      catch (e) { console.warn('[voyage-story] preSyncCleanup write failed:', e); }
    }
    seedWrittenChatStateFromFile(cleaned, snap, liveExport.writtenChatState);
    dbg(trace, 'seeded writtenChatState', { entries: liveExport.writtenChatState.size });

    // The file is now structurally clean. Decide how to proceed based on
    // whether we have a turn watermark.
    if (liveExport.lastWrittenTick == null) {
      let fileWatermark = null;
      if (cleaned) {
        const parsed = parseLastTickInFile(cleaned);
        if (parsed.tick != null) fileWatermark = parsed.tick;
      }
      if (fileWatermark != null) {
        liveExport.lastWrittenTick = fileWatermark;
        dbg(trace, 'using file watermark', { fileWatermark });
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
        dbg(trace, 'done', { mode: 'watermark-from-file', count });
      } else if (cleaned.trim().length > 0) {
        // File has content but no parseable turn structure. Refusing
        // initialWrite here is the last line of defense against the
        // destructive overwrite path — we'd rather force the user to
        // pick a different file than silently shred their content.
        syncPhase = null;
        setStatus("Stored file has unrecognizable content. Stop live export and pick a different file, or clear this one.");
        liveExport = null;
        notifyBadge(false);
        return { ok: false, message: 'unrecognizable existing content — refusing to overwrite' };
      } else {
        // syncPhase lifecycle is managed inside initialWrite
        await initialWrite();
      }
    } else {
      dbg(trace, 'using IDB watermark', { recordLastWrittenTick: liveExport.lastWrittenTick });
      syncPhase = 'Fetching history…';
      await callMain('pullAllHistory', { count: 10 }, 5 * 60 * 1000).catch(() => {});
      syncPhase = 'Backfilling characters…';
      await backfillCharactersInFile();
      syncPhase = 'Writing missing turns…';
      await appendNewTurns();
      syncPhase = null;
      const finalSnap = await callMain('getSnapshot');
      const count = finalSnap?.turns?.length || 0;
      syncCompleteMsg = `Sync complete — ${count} turn${count === 1 ? '' : 's'} up to date`;
      setStatus('');
      dbg(trace, 'done', { mode: 'watermark-from-IDB', count });
    }
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
      // state so the popup falls back to "Start live export" instead of
      // showing a contradictory "active + error" status.
      setStatus(`Couldn't write to the picked file: ${e.message || e.name || 'unknown error'}.`);
      liveExport = null;
      notifyBadge(false);
      if (storedHandleRoomId) {
        try { await removeRecord(storedHandleRoomId); } catch {}
        storedHandleRoomId = null;
      }
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
  // preserveRecord: keep the IDB record so when the user re-enters this
  // campaign, the popup automatically shows "Resume live export…" pointing
  // at the same file (no need to re-pick).
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
    await stopLiveExport({ preserveRecord: true }).catch(() => {});
  }

  // ---------- Status state (polled by popup) ----------
  let lastStatusMessage = '';
  let lastStatusAt = 0;
  function setStatus(text) {
    lastStatusMessage = String(text || '');
    lastStatusAt = Date.now();
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
    let hasStoredHandle = false;
    if (roomId) {
      try {
        const record = await loadRecord(roomId);
        if (record) {
          hasStoredHandle = true;
          if (storedHandleRoomId !== roomId) storedHandleRoomId = roomId;
        }
      } catch {}
    }
    // Prefer the last-picked filename for this campaign if we have one;
    // otherwise fall back to the auto-generated default. Either way, this
    // becomes the picker's `suggestedName` on a fresh Start so the user
    // doesn't have to retype the same name they used last session.
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
            // FileSystemFileHandle exposes the filename but never the
            // absolute path (security). That's enough to confirm the user
            // is writing to the file they intended.
            filename: liveExport.handle?.name || null,
          }
        : { active: false },
      hasStoredHandle,
      suggestedFilename,
      syncPhase,
      syncCompleteMsg,
      lastStatus: lastStatusMessage,
      lastStatusAt,
      filePickerSupported: typeof window.showSaveFilePicker === 'function',
    };
  }

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
            return respond(await startLiveExport(msg.handle));
          case 'stopLiveExport':
            return respond(await stopLiveExport());
          case 'resumeLiveExport':
            return respond(await resumeLiveExport());
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

  // ---------- Cross-context bridge ----------
  // chrome.tabs.sendMessage's serialization has been observed to drop the
  // FileSystemFileHandle prototype methods, so a handle picked in the popup
  // arrives in the content script with createWritable/getFile missing.
  // The popup calls into the picker from inside this isolated world via
  // chrome.scripting.executeScript so the handle is created and used in
  // the same context — never crossing a structured-clone boundary.
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
  window.__voyageStoryHelper = { startLiveExport, dumpState, setDebug };

  // ---------- Lifecycle ----------
  // No page UI to manage — just load config and let messages drive everything.
  loadConfig();
})();
