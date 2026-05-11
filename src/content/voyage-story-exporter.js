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
  };
  const CONFIG_KEYS = Object.keys(DEFAULT_CONFIG);
  let currentConfig = { ...DEFAULT_CONFIG };
  // While live export is active:
  //   { handle, roomId, lastWrittenTick, debounceTimer }
  // lastWrittenTick is the highest tick whose markdown we've already written
  // to the file. We append-only beyond that. Persisted to IDB alongside the
  // handle so a reload + Resume picks up exactly where we left off.
  let liveExport = null;
  let storedHandleRoomId = null;    // roomId for which we have a saved handle but aren't actively writing

  // ---------- Config: chrome.storage ----------
  function loadConfig() {
    return new Promise((resolve) => {
      chrome.storage.local.get(CONFIG_KEYS, (result) => {
        for (const k of CONFIG_KEYS) {
          if (typeof result[k] === 'boolean') currentConfig[k] = result[k];
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
      callback(m.event);
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
  async function writeToHandle(handle, content) {
    // Full overwrite. Used for the initial write of a live-export file and
    // for one-shot downloads.
    const writable = await handle.createWritable();
    await writable.write(content);
    await writable.close();
  }
  async function appendToHandle(handle, content) {
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

  function chatKey(chat) {
    return `${chat.npcName}::${chat.turnTick}`;
  }
  function snapshotChatState(chat) {
    return {
      messageCount: chat.messages?.length || 0,
      summary: chat.summary || null,
    };
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
  // prev: { messageCount, summary } from writtenChatState, or null/undefined
  //       on the first write. When provided, only messages past prev.messageCount
  //       and a summary that differs from prev.summary are emitted (no header).
  //
  // Layout depends on the toggle pair:
  //   storyIncludeNpcConversations ON  → full dialog block; summary line at
  //                                       the end if storyIncludeNpcChats is
  //                                       also on
  //   storyIncludeNpcConversations OFF → if storyIncludeNpcChats is on,
  //                                       render a compact single-line summary
  //                                       in the same style as statusUpdate
  //                                       summaries (the historical fallback)
  //   both OFF                         → nothing
  //
  // Returns true if anything was emitted, so callers can update
  // writtenChatState only when an actual write happened.
  function pushChat(out, chat, playerName, config, prev) {
    const startIdx = prev?.messageCount || 0;
    const prevSummary = prev?.summary || null;
    const curSummary  = chat.summary    || null;
    const summaryChanged = curSummary !== prevSummary;
    const newMessages = (chat.messages || []).slice(startIdx);
    if (newMessages.length === 0 && !summaryChanged) return false;

    if (config.storyIncludeNpcConversations) {
      if (!prev) {
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
      if (config.storyIncludeNpcChats && summaryChanged && curSummary) {
        out.push(`*Summary: ${curSummary}*`);
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
    if (!handle) {
      setStatus('Internal error: no file handle.');
      return { ok: false, message: 'no handle' };
    }
    // Sanity check: the handle should arrive via structured clone with its
    // FileSystemFileHandle methods intact. If not, every subsequent write
    // would fail with a confusing TypeError — bail up front.
    if (typeof handle.createWritable !== 'function' || typeof handle.getFile !== 'function') {
      setStatus('Internal error: the file handle is missing its methods. Reload the Voyage tab and try again.');
      return { ok: false, message: 'handle methods missing' };
    }
    const snap = await callMain('getSnapshot');
    if (!snap.roomId) {
      setStatus('Wait for the room to finish loading before starting live export.');
      return { ok: false, message: 'room not ready' };
    }

    // Read existing content. If this fails we abort — we never want to
    // overwrite a file we couldn't first read, even if Chrome would let us.
    let existing;
    try {
      const f = await handle.getFile();
      existing = await f.text();
    } catch (e) {
      setStatus(`Couldn't read the picked file: ${e.message || e.name || 'unknown error'}. Pick a different file.`);
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
    // Seed the chat-write state from whatever's currently in the cache: any
    // chats we already know about were presumably written in the previous
    // session (or arrived after the file was last saved). Treating them as
    // "already written" prevents duplicate rendering when liveAppendChats
    // fires for chat events that come in after resume.
    seedWrittenChatState(snap, liveExport.writtenChatState);
    setStatus(`Resuming from turn ${parsed.tick}. Catching up…`);
    await callMain('pullAllHistory', { count: 10 }, 5 * 60 * 1000).catch(() => {});
    await appendNewTurns();
    // appendNewTurns persists only when it actually wrote something; make
    // sure the handle + tick land in IDB even if there was nothing new.
    await persistLiveExport();
    return { ok: true, mode: 'resumed', resumedFromTick: parsed.tick };
  }

  // opts.preserveRecord (default false): keep the IDB record so the popup
  // can offer "Resume live export" next time the user enters this campaign.
  // Used by the auto-stop-on-campaign-switch path; manual stops clear it.
  async function stopLiveExport(opts = {}) {
    const { preserveRecord = false } = opts;
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
    const snap = await callMain('getSnapshot');
    if (!snap.roomId) {
      setStatus('Wait for the room to finish loading.');
      return { ok: false, message: 'room not ready' };
    }
    const record = await loadRecord(snap.roomId);
    if (!record) {
      return { ok: false, message: 'no stored handle for this room — pick a file first' };
    }
    const ok = await ensureHandlePermission(record.handle);
    if (!ok) {
      setStatus('Permission denied for the saved file.');
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
    seedWrittenChatState(snap, liveExport.writtenChatState);

    // If we have no record of having written before, this is effectively a
    // fresh start (e.g., resuming from a pre-1.5.2 install). Do a full
    // initial write so the header is present and lastWrittenTick is set.
    // Otherwise, just backfill any turns the page missed while it was closed
    // and append them.
    if (liveExport.lastWrittenTick == null) {
      setStatus('Live export resumed. Rebuilding file…');
      await initialWrite();
    } else {
      setStatus('Live export resumed. Catching up…');
      await callMain('pullAllHistory', { count: 10 }, 5 * 60 * 1000).catch(() => {});
      await appendNewTurns();
    }
    return { ok: true };
  }

  // Full overwrite: writes header + every completed turn. Called once when
  // a live export starts (or on a "rebuild from scratch" resume). Records
  // lastWrittenTick so subsequent updates can append-only.
  async function initialWrite() {
    if (!liveExport) return;
    try {
      await callMain('pullAllHistory', { count: 10 }, 5 * 60 * 1000).catch(() => {});
      const snap = await callMain('getSnapshot');
      // Don't include the live in-progress turn in the persistent file —
      // we only commit completed turns. The live turn is for one-off Current
      // turn downloads.
      const md = buildMarkdown(snap, currentConfig, { includeLive: false });
      await writeToHandle(liveExport.handle, md);
      const lastTick = snap.turns.length ? snap.turns[snap.turns.length - 1].tick : null;
      liveExport.lastWrittenTick = lastTick;
      // buildMarkdown just rendered every chat in cache as a full block, so
      // mark them all as fully written. Subsequent chat events render only
      // the delta past this point.
      seedWrittenChatState(snap, liveExport.writtenChatState);
      await persistLiveExport();
      setStatus(`Live export: ${snap.turns.length} turn${snap.turns.length === 1 ? '' : 's'} written.`, 0);
    } catch (e) {
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
      if (newTurns.length === 0) return;
      const md = buildTurnRangeMarkdown(newTurns, snap, currentConfig, liveExport.writtenChatState);
      await appendToHandle(liveExport.handle, md);
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

  function scheduleAppend() {
    if (!liveExport) return;
    clearTimeout(liveExport.debounceTimer);
    // Short debounce coalesces back-to-back turn-completion events
    // (notifySkillChecksFinished often fires right before notifyTurnEnd) into
    // a single append call.
    liveExport.debounceTimer = setTimeout(appendNewTurns, 500);
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
    liveExport.chatDebounceTimer = setTimeout(liveAppendChats, 500);
  }

  async function liveAppendChats() {
    if (!liveExport) return;
    try {
      const snap = await callMain('getSnapshot');
      const playerName = snap.character?.characterChoices?.name || 'Player';
      const writtenState = liveExport.writtenChatState;

      const out = [];
      const toCommit = [];
      for (const chat of (snap.npcChats || [])) {
        const key = chatKey(chat);
        const prev = writtenState.get(key);
        const wrote = pushChat(out, chat, playerName, currentConfig, prev);
        if (wrote) toCommit.push({ key, state: snapshotChatState(chat) });
      }
      if (out.length === 0) return;
      await appendToHandle(liveExport.handle, out.join('\n'));
      for (const { key, state } of toCommit) writtenState.set(key, state);
    } catch (e) {
      console.error('[voyage-story] liveAppendChats:', e);
      setStatus(`Live export error: ${e.message}`, 5000);
    }
  }

  // Snapshot the current cache state of all chats into writtenChatState.
  // Called when we've just done a full render (initialWrite) or when we
  // resume into an existing file where chats from prior sessions should
  // be treated as already-written.
  function seedWrittenChatState(snap, writtenChatState) {
    for (const chat of (snap?.npcChats || [])) {
      writtenChatState.set(chatKey(chat), snapshotChatState(chat));
    }
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
  onMainChange((event) => {
    if (!liveExport) return;
    if (event === 'joinedRoom') {
      maybeAutoStopOnCampaignSwitch();
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
  window.__voyageStoryHelper = { startLiveExport };

  // ---------- Lifecycle ----------
  // No page UI to manage — just load config and let messages drive everything.
  loadConfig();
})();
