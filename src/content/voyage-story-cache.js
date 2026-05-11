/*
 * Voyage Tools — Story Cache (MAIN world)
 *
 * Captures live and historical turn data from the game's Socket.IO connection
 * so the Story Exporter UI can produce a markdown export of the entire
 * campaign without requiring the user to scroll back through "Show Previous
 * Turns" by hand.
 *
 * Wire-level overview
 * -------------------
 * Voyage's game state flows over a Socket.IO websocket to
 * api-beta.aidungeon.com under the path /heroes/. Audio is on a separate
 * /tts/ socket which we ignore.
 *
 * This script patches window.WebSocket at document_start so every WebSocket
 * the page constructs runs through our subclass. When the URL contains
 * "heroes" we attach a message listener that:
 *   - Parses each Engine.IO + Socket.IO frame and routes by event name.
 *   - Captures the Socket.IO sid (from the inbound CONNECT ack) — the server
 *     needs it echoed back as `from` on outbound requests.
 *   - Captures room/world/character metadata: joinedRoom, worldChanged,
 *     usersChanged, gameStateChanged.
 *   - Captures live turn streams: narrationStarted (marks a new turn),
 *     narrationSync (one cumulative chunks-so-far array of the active turn —
 *     the server replaces, not appends, on each event).
 *   - Captures completed turns from THREE event sources, all of which deliver
 *     turn objects in the same canonical "complex" shape (storyParagraphs[],
 *     playerInputs{}, locationContext, musicContext, statusUpdates[],
 *     pastUpdates{…}):
 *       • turnHistoryResponse.turns      — bulk backfill from requestTurnHistory
 *       • notifyTurnEnd.turnData         — fires at the end of every turn
 *       • notifySkillChecksFinished.turnData — also fires during turn resolution
 *     The latter two mean we get newly-completed turns "for free" without
 *     asking; requestTurnHistory is only needed to walk back through turns
 *     from before the page loaded.
 *
 * It also exposes requestHistory(beforeTick, count) which sends a
 * requestTurnHistory frame back over the captured socket — this is what the
 * exporter calls in a loop to walk the entire campaign without the user ever
 * clicking "Show Previous Turns".
 *
 * Bridge to the isolated world
 * ----------------------------
 * The exporter UI lives in the isolated content-script world and can't see
 * window globals from the main world. We use window.postMessage with a
 * { source: 'voyage-story', ... } envelope as the two-way RPC channel.
 *
 * Notes
 * -----
 *   - This script runs always, regardless of the popup toggle. The toggle
 *     only gates UI visibility. Memory cost is tiny (~6 KB per turn) and
 *     this way the cache is populated by the time the user clicks "Export".
 *   - Voyage uses separate Engine.IO paths per Socket.IO server, not
 *     Socket.IO namespaces, so frames carry no namespace prefix.
 *   - On room change (a fresh joinedRoom with a different roomId), the turn
 *     cache is reset to avoid mixing campaigns.
 */

(() => {
  const NAMESPACE = 'voyage-story';

  // ----- Cache -----
  const cache = {
    socketId: null,         // Socket.IO sid (from inbound CONNECT ack 40{...})
    roomId: null,           // joinedRoom.roomId
    hostUserId: null,       // joinedRoom.hostUserId
    worldShortId: null,     // joinedRoom.worldShortId
    world: null,            // worldState from worldChanged
    character: null,        // first entry of users[] from usersChanged
    gameState: null,        // gameState from gameStateChanged (kept verbatim)
    turns: new Map(),       // tick -> turn object (canonical "complex" shape,
                            //   sourced from turnHistoryResponse,
                            //   notifyTurnEnd, or notifySkillChecksFinished —
                            //   later writes always win, so duplicate
                            //   deliveries are idempotent)
    liveTurn: null,         // { turnNumber, chunks: Array<chunkBlock>, status }
                            //   chunks is the latest cumulative array from
                            //   narrationSync — each block has
                            //   { type, text, speaker, direction, imageUrl,
                            //     speakerKind, ttsDescription, voiceId }
    earliestTickLoaded: null,
    hasMoreHistory: true,
    // NPC chat capture. The server scrubs conversations when the next turn
    // commits, so the only way to retain the full back-and-forth is to grab
    // it live off the wire. Keyed by `${npcName}::${turnTick}` so reopens
    // within the same turn coalesce while chats in different turns don't.
    //   { npcName, turnTick, messages: [{role:'npc'|'player', content}],
    //     summary, closed }
    npcChats: new Map(),
    // The chat the user currently has open. Set on inbound openNpcChat
    // (when the server replies with messages), cleared on closeNpcChat.
    // sendNpcChatMessage (outbound) and npcChatResponse (inbound) attach
    // to this chat.
    currentChatKey: null,
  };

  // ----- WebSocket interception -----
  const OriginalWebSocket = window.WebSocket;
  let heroesSocket = null;

  class InterceptedWebSocket extends OriginalWebSocket {
    constructor(url, protocols) {
      super(url, protocols);
      const urlStr = String(url || '');
      if (/heroes/.test(urlStr)) {
        heroesSocket = this;
        this.addEventListener('message', (e) => handleSocketMessage(e.data));
        this.addEventListener('close', () => {
          if (heroesSocket === this) heroesSocket = null;
        });
      }
    }
    // Outbound interception: the message handler only sees server→client
    // frames, but the player's typed NPC-chat messages travel client→server.
    // Wrap send so we can pick those up too.
    send(data) {
      if (this === heroesSocket) {
        const f = parseFrame(data);
        if (f && f.kind === 'event' && f.event === 'sendNpcChatMessage') {
          handleOutgoingChatMessage(f.payload);
        }
      }
      return super.send(data);
    }
  }
  InterceptedWebSocket.CONNECTING = OriginalWebSocket.CONNECTING;
  InterceptedWebSocket.OPEN       = OriginalWebSocket.OPEN;
  InterceptedWebSocket.CLOSING    = OriginalWebSocket.CLOSING;
  InterceptedWebSocket.CLOSED     = OriginalWebSocket.CLOSED;
  window.WebSocket = InterceptedWebSocket;

  // ----- Engine.IO + Socket.IO frame parser -----
  // Engine.IO packet types: 0=open, 1=close, 2=ping, 3=pong, 4=message, 5=upgrade, 6=noop.
  // Socket.IO sub-types (inside 4-packets): 0=CONNECT, 1=DISCONNECT, 2=EVENT, 3=ACK, 4=CONNECT_ERROR.
  function parseFrame(data) {
    if (typeof data !== 'string' || data.length === 0) return null;
    const engineType = data[0];
    if (engineType === '0') {
      try { return { kind: 'engineOpen', payload: JSON.parse(data.slice(1)) }; }
      catch { return null; }
    }
    if (engineType !== '4') return null;
    const sioType = data[1];
    if (sioType === undefined) return null;
    let i = 2;
    if (data[i] === '/') {
      const commaIdx = data.indexOf(',', i);
      if (commaIdx !== -1) i = commaIdx + 1;
    }
    while (data[i] >= '0' && data[i] <= '9') i++;
    const rest = data.slice(i);
    if (sioType === '0') {
      try { return { kind: 'sioConnect', payload: rest ? JSON.parse(rest) : null }; }
      catch { return null; }
    }
    if (sioType === '2') {
      try {
        const arr = JSON.parse(rest);
        if (Array.isArray(arr) && arr.length > 0) {
          return { kind: 'event', event: arr[0], payload: arr[1], rest: arr.slice(2) };
        }
      } catch { return null; }
    }
    return null;
  }

  // ----- Event dispatch -----
  const pendingHistory = new Map();
  let requestCounter = 0;

  function handleSocketMessage(data) {
    const f = parseFrame(data);
    if (!f) return;
    if (f.kind === 'sioConnect' && f.payload && f.payload.sid) {
      cache.socketId = f.payload.sid;
      return;
    }
    if (f.kind !== 'event') return;
    dispatchEvent(f.event, f.payload);
  }

  function dispatchEvent(event, payload) {
    if (!payload || typeof payload !== 'object') return;
    switch (event) {
      case 'joinedRoom': {
        // If we just switched rooms, wipe the per-campaign turn cache so we
        // don't mix history from two different rooms.
        if (cache.roomId && payload.roomId && cache.roomId !== payload.roomId) {
          cache.turns.clear();
          cache.liveTurn = null;
          cache.earliestTickLoaded = null;
          cache.hasMoreHistory = true;
          cache.npcChats.clear();
          cache.currentChatKey = null;
        }
        cache.roomId       = payload.roomId       || cache.roomId;
        cache.hostUserId   = payload.hostUserId   || cache.hostUserId;
        cache.worldShortId = payload.worldShortId || cache.worldShortId;
        break;
      }
      case 'worldChanged':
        if (payload.worldState) cache.world = payload.worldState;
        break;
      case 'usersChanged':
        if (Array.isArray(payload.users) && payload.users.length > 0) {
          cache.character = payload.users[0];
        }
        break;
      case 'gameStateChanged':
        if (payload.gameState) cache.gameState = payload.gameState;
        break;
      case 'narrationStarted':
        if (typeof payload.turnNumber === 'number') {
          if (!cache.liveTurn || cache.liveTurn.turnNumber !== payload.turnNumber) {
            cache.liveTurn = { turnNumber: payload.turnNumber, chunks: [], status: null };
          }
        }
        break;
      case 'narrationSync':
        if (typeof payload.turnNumber === 'number') {
          if (!cache.liveTurn || cache.liveTurn.turnNumber !== payload.turnNumber) {
            cache.liveTurn = { turnNumber: payload.turnNumber, chunks: [], status: payload.status };
          }
          // chunks is cumulative — server sends the whole array each time,
          // so we just replace.
          if (Array.isArray(payload.chunks)) cache.liveTurn.chunks = payload.chunks;
          if (payload.status) cache.liveTurn.status = payload.status;
        }
        break;
      case 'turnHistoryResponse': {
        harvestTurns(payload.turns);
        cache.hasMoreHistory = !!payload.hasMore;
        const reqId = payload.requestId;
        if (reqId && pendingHistory.has(reqId)) {
          const p = pendingHistory.get(reqId);
          pendingHistory.delete(reqId);
          p.resolve(payload);
        }
        break;
      }
      case 'notifyTurnEnd':
        // Server pushes the just-completed turn(s) as fully-formed records in
        // the same shape as turnHistoryResponse.turns. If we just received
        // the live turn's polished version, clear the live buffer so the
        // exporter shows the historical render instead.
        harvestTurns(payload.turnData);
        if (Array.isArray(payload.turnData) && cache.liveTurn) {
          if (payload.turnData.some((t) => t && t.tick === cache.liveTurn.turnNumber)) {
            cache.liveTurn = null;
          }
        }
        break;
      case 'notifySkillChecksFinished':
        // Carries `engineState` and a `turnData[]` window of recent turns.
        // We just harvest the turns; engineState is rich game-engine state we
        // don't need for export.
        harvestTurns(payload.turnData);
        break;
      case 'openNpcChat':
        // Two senders use this event name:
        //   client → server: { npcName, from, currentRoomId } — request
        //   server → client: { npcName, messages: [...] }    — state echo
        // Only inbound (server) frames reach this handler, so the presence
        // of `messages` confirms it's the state echo. The server replays the
        // full conversation history on every open — reopens mid-turn return
        // the same messages plus any new ones — so we treat its array as
        // authoritative and overwrite our local messages with it.
        if (payload.npcName && Array.isArray(payload.messages)) {
          const turnTick = payload.messages.find((m) => typeof m?.turnTick === 'number')?.turnTick;
          if (typeof turnTick === 'number') {
            const key = `${payload.npcName}::${turnTick}`;
            const prior = cache.npcChats.get(key);
            cache.npcChats.set(key, {
              npcName: payload.npcName,
              turnTick,
              messages: payload.messages.map((m) => ({ role: m.role, content: m.content })),
              summary: prior?.summary || null,
              closed: prior?.closed || false,
            });
            cache.currentChatKey = key;
          }
        }
        break;
      case 'npcChatResponse':
        // Incremental NPC reply during an open chat. Append to whichever
        // chat is currently open. (The server doesn't echo turnTick here —
        // it's implied by currentChatKey, which was set when the chat was
        // opened.)
        if (cache.currentChatKey && typeof payload.message === 'string') {
          const chat = cache.npcChats.get(cache.currentChatKey);
          if (chat) chat.messages.push({ role: 'npc', content: payload.message });
        }
        break;
      case 'closeNpcChat':
        // Server's close response carries the AI-generated `summary`. The
        // client's own close request (which lacks `summary`) also lands here,
        // so we gate on the presence of the field.
        if (typeof payload.summary === 'string') {
          const key = cache.currentChatKey ||
            (payload.npcName ? findLatestChatKeyForNpc(payload.npcName) : null);
          if (key) {
            const chat = cache.npcChats.get(key);
            if (chat) {
              chat.summary = payload.summary;
              chat.closed = true;
            }
          }
          cache.currentChatKey = null;
        }
        break;
    }
    notifyChange(event);
  }

  // Player's typed messages travel client→server. Called from the overridden
  // WebSocket.send() above with the parsed Socket.IO payload.
  function handleOutgoingChatMessage(payload) {
    if (!payload || typeof payload.message !== 'string') return;
    const key = cache.currentChatKey ||
      (payload.npcName ? findLatestChatKeyForNpc(payload.npcName) : null);
    if (!key) return;
    const chat = cache.npcChats.get(key);
    if (chat) {
      chat.messages.push({ role: 'player', content: payload.message });
      notifyChange('sendNpcChatMessage');
    }
  }

  // Fallback chat lookup when currentChatKey isn't set (defensive — e.g.,
  // if events arrive out of order or after a state reset). Picks the highest
  // turnTick among open chats for the named NPC.
  function findLatestChatKeyForNpc(npcName) {
    let best = null;
    let bestTick = -1;
    for (const [k, c] of cache.npcChats) {
      if (c.npcName !== npcName) continue;
      if ((c.turnTick ?? -1) > bestTick) { best = k; bestTick = c.turnTick ?? -1; }
    }
    return best;
  }

  function harvestTurns(arr) {
    if (!Array.isArray(arr)) return;
    let minTick = null;
    for (const t of arr) {
      if (!t || typeof t.tick !== 'number') continue;
      cache.turns.set(t.tick, t);
      if (minTick == null || t.tick < minTick) minTick = t.tick;
    }
    if (minTick != null) {
      if (cache.earliestTickLoaded == null || minTick < cache.earliestTickLoaded) {
        cache.earliestTickLoaded = minTick;
      }
    }
  }

  // ----- Outbound: requestTurnHistory -----
  function requestHistory(beforeTick, count = 10) {
    return new Promise((resolve, reject) => {
      if (!heroesSocket || heroesSocket.readyState !== OriginalWebSocket.OPEN) {
        reject(new Error('heroes socket not connected'));
        return;
      }
      if (!cache.socketId || !cache.roomId) {
        reject(new Error('socket identity (sid/roomId) not yet established'));
        return;
      }
      const requestId = Date.now() + '-' + (requestCounter++).toString(36) + 'vh';
      const frame = '42' + JSON.stringify(['requestTurnHistory', {
        beforeTick,
        count,
        requestId,
        from: cache.socketId,
        currentRoomId: cache.roomId,
      }]);
      pendingHistory.set(requestId, { resolve, reject });
      try {
        heroesSocket.send(frame);
      } catch (e) {
        pendingHistory.delete(requestId);
        reject(e);
        return;
      }
      setTimeout(() => {
        if (pendingHistory.has(requestId)) {
          pendingHistory.delete(requestId);
          reject(new Error('requestHistory timeout'));
        }
      }, 30000);
    });
  }

  async function pullAllHistory(maxBatches = 200, count = 10) {
    let anchor;
    if (cache.earliestTickLoaded != null) {
      anchor = cache.earliestTickLoaded;
    } else if (cache.liveTurn && typeof cache.liveTurn.turnNumber === 'number') {
      anchor = cache.liveTurn.turnNumber + 1;
    } else {
      throw new Error('no anchor tick — wait for the live turn to start before exporting');
    }
    let batches = 0;
    while (cache.hasMoreHistory && batches < maxBatches) {
      await requestHistory(anchor, count);
      const newEarliest = cache.earliestTickLoaded;
      if (newEarliest == null || newEarliest >= anchor) break;
      anchor = newEarliest;
      batches++;
    }
    return { batches, totalTurns: cache.turns.size, hasMoreHistory: cache.hasMoreHistory };
  }

  // ----- Snapshot serialization -----
  // Maps don't always survive structured cloning the way we want, and the
  // exporter wants stable ordering anyway. Materialize to plain arrays.
  function getSnapshot() {
    const sortedTurns = Array.from(cache.turns.values()).sort((a, b) => a.tick - b.tick);
    let liveTurn = null;
    if (cache.liveTurn) {
      // Don't duplicate live turn data if its tick is already in turns Map
      // (notifyTurnEnd may have just promoted it).
      const alreadyInHistory = cache.turns.has(cache.liveTurn.turnNumber);
      if (!alreadyInHistory) {
        liveTurn = {
          turnNumber: cache.liveTurn.turnNumber,
          chunks: Array.isArray(cache.liveTurn.chunks) ? cache.liveTurn.chunks : [],
          status: cache.liveTurn.status,
        };
      }
    }

    // Session metadata is what the popup needs to display "which campaign is
    // this?" and what we use to slug the default filename. Sourced from
    // gameStateChanged.gameState.gameConfig; falls back to worldChanged data
    // and to character info captured separately.
    const cfg = cache.gameState?.gameConfig;
    const cfgUser = Array.isArray(cfg?.users) ? cfg.users[0] : null;
    const characterName =
      cfgUser?.characterChoices?.name ||
      cache.character?.characterChoices?.name ||
      null;
    const session = {
      roomId: cache.roomId,
      name: cfg?.storyStart?.name || null,           // e.g. "Return of the Dragon Queen"
      characterName,                                 // e.g. "Jinn"
      worldTitle: cfg?.worldTitle || cache.world?.worldTitle || null,
      saveId: cfg?.saveId || null,
      saveSlot: typeof cfg?.saveSlot === 'number' ? cfg.saveSlot : null,
      worldShortId: cfg?.worldShortId || cache.worldShortId || null,
    };

    const npcChats = Array.from(cache.npcChats.values())
      .map((c) => ({
        npcName: c.npcName,
        turnTick: c.turnTick,
        messages: c.messages.slice(),
        summary: c.summary,
        closed: c.closed,
      }))
      .sort((a, b) => (a.turnTick || 0) - (b.turnTick || 0));
    const currentChat = cache.currentChatKey
      ? cache.npcChats.get(cache.currentChatKey) : null;
    const currentChatNpcName = currentChat ? currentChat.npcName : null;

    return {
      socketId: cache.socketId,
      roomId: cache.roomId,
      hostUserId: cache.hostUserId,
      worldShortId: cache.worldShortId,
      session,
      world: cache.world && {
        worldTitle: cache.world.worldTitle,
        worldDescription: cache.world.worldDescription,
      },
      character: cache.character && {
        userId: cache.character.userId,
        username: cache.character.username,
        characterChoices: cache.character.characterChoices,
      },
      turns: sortedTurns,
      liveTurn,
      npcChats,
      currentChatNpcName,
      earliestTickLoaded: cache.earliestTickLoaded,
      hasMoreHistory: cache.hasMoreHistory,
    };
  }

  // ----- PostMessage bridge to isolated world -----
  function notifyChange(event) {
    window.postMessage({ source: NAMESPACE, type: 'change', event }, location.origin);
  }

  window.addEventListener('message', async (e) => {
    if (e.source !== window) return;
    const m = e.data;
    if (!m || m.source !== NAMESPACE || !m.requestType) return;
    const { requestType, requestId, args = {} } = m;
    let respond;
    try {
      let result;
      if (requestType === 'getSnapshot') {
        result = getSnapshot();
      } else if (requestType === 'requestHistory') {
        result = await requestHistory(args.beforeTick, args.count);
      } else if (requestType === 'pullAllHistory') {
        result = await pullAllHistory(args.maxBatches, args.count);
      } else {
        throw new Error('Unknown requestType: ' + requestType);
      }
      respond = { source: NAMESPACE, type: 'response', requestId, ok: true, result };
    } catch (err) {
      respond = {
        source: NAMESPACE,
        type: 'response',
        requestId,
        ok: false,
        error: String((err && err.message) || err),
      };
    }
    window.postMessage(respond, location.origin);
  });

  // ----- Debug handle -----
  // Not relied upon by the exporter (which uses postMessage). Useful from the
  // DevTools console while iterating: __voyageStory.getSnapshot(), etc.
  window.__voyageStory = { getSnapshot, requestHistory, pullAllHistory, _cache: cache };
})();
