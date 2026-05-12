# Voyage Networking Protocol — Field Notes

This document captures everything we've learned about how Voyage (beta.voyage.io) moves game data between client and server, the techniques used to discover it, and the recipes for adapting when Voyage changes things. Purely networking — code architecture is inferable from the source.

---

## 1. Connection Topology

Voyage uses **Socket.IO over WebSocket** as its primary game-state channel. There are two separate WebSocket endpoints:

- **`wss://voyage-ws-beta-1.aidungeon.com/heroes/?EIO=4&transport=websocket`** — game state, turns, NPC chats. **This is the one we care about.**
- **`wss://voyage-ws-beta-1.aidungeon.com/tts/?EIO=4&transport=websocket`** — text-to-speech audio chunks. We ignore this entirely; it produces a lot of binary traffic but no game data.

There's also REST traffic (`/graphql`, `/voyage/load-room`, `/voyage/request-server`) but those carry only metadata (auth, room discovery, save lists). **All actual gameplay data flows over `/heroes/`**.

Both endpoints use the **EIO=4 transport=websocket** Engine.IO protocol. Voyage does **not** use Socket.IO namespaces (frames have no `/namespace,` prefix) — each Socket.IO server is reached via its own Engine.IO path (`/heroes/`, `/tts/`) instead.

---

## 2. Frame Format

Each WebSocket frame is a string with a small integer header that identifies its type.

### Engine.IO packet types (first character)
| Char | Meaning   |
|------|-----------|
| `0`  | open      |
| `1`  | close     |
| `2`  | ping      |
| `3`  | pong      |
| `4`  | message   |
| `5`  | upgrade   |
| `6`  | noop      |

### Socket.IO sub-types (second character, only inside `4` packets)
| Char | Meaning        |
|------|----------------|
| `0`  | CONNECT        |
| `1`  | DISCONNECT     |
| `2`  | EVENT          |
| `3`  | ACK            |
| `4`  | CONNECT_ERROR  |

### Event frame anatomy

A typical inbound game event:
```
42["narrationSync",{"turnNumber":117,"chunks":[…],"status":"active"}]
```
- `4` → Engine.IO message
- `2` → Socket.IO EVENT
- `[event, payload]` → JSON array, event name first, payload second

Optional fields between `42` and the JSON array:
- **Namespace prefix** (not used by Voyage): `42/myns,["…"]` — would have a `/namespace,` between the type and JSON
- **ACK id** (numeric, before the JSON): `42123["event",…]` — request id for ACK callback

When parsing, walk past any namespace prefix, then any digit run (ACK id), then JSON.parse the rest.

### Inbound vs outbound

The same event name can travel both directions with different payloads (see `openNpcChat` and `closeNpcChat`). **Direction matters.** In our cache, `addEventListener('message', …)` captures inbound only; we override `WebSocket.prototype.send` to capture outbound separately.

In Chrome DevTools → Network → WS, **↑ is outgoing, ↓ is incoming**.

---

## 3. Interception Technique

### Where to inject

Patch `window.WebSocket` **at `document_start`** in the **MAIN world** (not the isolated content-script world). Page scripts construct their own `WebSocket` instances which would be invisible from the isolated world. Manifest:

```json
{
  "matches": ["https://beta.voyage.io/*"],
  "js": ["voyage-story-cache.js"],
  "run_at": "document_start",
  "world": "MAIN"
}
```

### How to subclass

```js
const OriginalWebSocket = window.WebSocket;
let heroesSocket = null;

class InterceptedWebSocket extends OriginalWebSocket {
  constructor(url, protocols) {
    super(url, protocols);
    if (/heroes/.test(String(url || ''))) {
      heroesSocket = this;
      this.addEventListener('message', (e) => handleSocketMessage(e.data));
      this.addEventListener('close', () => {
        if (heroesSocket === this) heroesSocket = null;
      });
    }
  }
  send(data) {
    if (this === heroesSocket) handleOutgoingMessage(data);
    return super.send(data);
  }
}
// Preserve static constants — required for "instanceof" and ".readyState" comparisons in app code:
InterceptedWebSocket.CONNECTING = OriginalWebSocket.CONNECTING;
InterceptedWebSocket.OPEN       = OriginalWebSocket.OPEN;
InterceptedWebSocket.CLOSING    = OriginalWebSocket.CLOSING;
InterceptedWebSocket.CLOSED     = OriginalWebSocket.CLOSED;
window.WebSocket = InterceptedWebSocket;
```

### Frame parser

```js
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
  if (sioType === '0') {  // CONNECT ack carries sid
    try { return { kind: 'sioConnect', payload: rest ? JSON.parse(rest) : null }; }
    catch { return null; }
  }
  if (sioType === '2') {  // EVENT
    try {
      const arr = JSON.parse(rest);
      if (Array.isArray(arr) && arr.length > 0) {
        return { kind: 'event', event: arr[0], payload: arr[1], rest: arr.slice(2) };
      }
    } catch { return null; }
  }
  return null;
}
```

### Capturing the `sid`

The Socket.IO CONNECT ack (`40{"sid":"…"}`) lands first. Save the `sid` — the server requires it echoed back as the `from` field on outbound requests like `requestTurnHistory`.

---

## 4. Inbound Event Catalog

Listed in roughly the order they fire during a session. **Payload shapes are descriptive — always verify against the wire** before relying on a field.

### Lifecycle / room
- **`sioConnect`** (Socket.IO `40` packet, not a 42 event) — `{ sid }`. Capture and store.
- **`joinedRoom`** — `{ roomId, hostUserId, worldShortId }`. Treat a change in `roomId` as a campaign switch and wipe per-campaign state.
- **`worldChanged`** — `{ worldState: { worldTitle, worldDescription, … } }`.
- **`usersChanged`** — `{ users: [ { userId, username, characterChoices: { name, gender, race, … } } ] }`. Position `[0]` is the player character. **Note:** in multiplayer this may include other players.
- **`gameStateChanged`** — `{ gameState: { gameConfig: { storyStart, users[], worldTitle, saveId, saveSlot, worldShortId, … } }, changeType }`. The biggest payload Voyage sends; rich session metadata.

### Live turn streaming
- **`narrationStarted`** — `{ turnNumber }`. Marks the start of an in-progress turn. `turnNumber` here is a **0-indexed tick**.
- **`narrationSync`** — `{ turnNumber, chunks: [chunkBlock], status }`. **Critical gotcha: `chunks` is CUMULATIVE.** Each frame contains the full array of all chunks seen so far for this turn — not deltas. Replace your local state wholesale on each fire. `status` is `"active"`, `"idle"`, possibly others. Each `chunkBlock` looks like:
  ```js
  {
    type: 'dialogue' | 'narration',
    text: '…',
    speaker: 'Borun' | undefined,
    direction: 'shouting' | undefined,
    speakerKind: 'npc' | 'player' | 'narrator',
    ttsDescription, voiceId, imageUrl: …
  }
  ```
- **`narrationAdvanced`** — incremental advance signal. We ignore it because `narrationSync` already gives us the full cumulative state.
- **`narrationEnded`** — fires when narration is finalized. Not relied on; the canonical signal that a turn is "done" arrives via `notifyTurnEnd` (see below).

### Completed turn delivery
- **`notifyTurnEnd`** — `{ turnData: [turnRecord, …] }`. **Critical gotcha: fires TWICE per turn.** First fire when player submits — payload has `playerInputs` populated but no `storyParagraphs`. Second fire after narration completes — `storyParagraphs` is now populated. If your code commits on the first fire, you'll silently miss the narrator's reply. Always check that the turn has body content (`storyParagraphs.length > 0` or `storyMessage` non-empty) before treating it as committed.
- **`notifySkillChecksFinished`** — `{ engineState, turnData: [turnRecord, …] }`. Fires during turn resolution, often right around `notifyTurnEnd`. The `turnData` window has the same canonical shape; `engineState` is rich game state we don't need.
- **`turnHistoryResponse`** — `{ turns: [turnRecord, …], hasMore: boolean, requestId }`. Reply to our `requestTurnHistory`. `requestId` matches what we sent so multiple in-flight requests can be demuxed.

### NPC chat (the most complex sub-protocol — see Section 7)
- **`openNpcChat`** (inbound) — `{ npcName, messages: [{ role, content, turnTick }] }`. The server's reply to an open request. `messages` is the **full conversation history**, not just new ones (replays everything on reopen).
- **`npcChatResponse`** — `{ npcName, message }`. NPC's incremental reply during an open chat.
- **`closeNpcChat`** (inbound) — `{ npcName, summary }`. Final summary when chat closes.

### Other observed (may not be exhaustive)
- **`requestGameStateSync`** — outbound request, server replies via `gameStateChanged`.
- **`storyGenerationComplete`** — observed but unused; presumably fires when the AI's generation step finishes. Not load-bearing for our use.

---

## 5. Outbound Event Catalog

Send via `heroesSocket.send('42' + JSON.stringify([event, payload]))`. The server expects:
- **`from`** field set to the captured `sid` on most requests
- **`currentRoomId`** field set to the joined room

Common outbound events we've seen / used:
- **`requestTurnHistory`** — `{ beforeTick, count, requestId, from, currentRoomId }`. Walks turns backward from `beforeTick`. Server replies with `turnHistoryResponse` matching `requestId`. Loop until `hasMore: false` to backfill the whole campaign.
- **`openNpcChat`** (request) — `{ npcName, from, currentRoomId }`. No `messages` field on the outbound; server replies with the full state.
- **`sendNpcChatMessage`** — `{ npcName, message, from, currentRoomId }`. Player's message text.
- **`closeNpcChat`** (request) — `{ npcName, from, currentRoomId }`. No `summary` on outbound; server replies with the AI-generated summary.
- **`playerAction`** — the player's submitted action. We don't intercept this (the resulting `notifyTurnEnd` gives us everything).

---

## 6. Turn Record Shape

The canonical "turn" appears in `turnHistoryResponse.turns[]`, `notifyTurnEnd.turnData[]`, and `notifySkillChecksFinished.turnData[]`. Same shape across all three sources.

```js
{
  type: 'simple' | 'complex',         // see legacy note below
  tick: 0,                            // 0-indexed turn number
  playerInputs: {                     // map of speaker name → typed text
    'Jinn': '*I nod.* Agreed. Lead the way.'
  },
  storyParagraphs: [                  // array of "Speaker: text" or "NARRATOR: text"
    'NARRATOR: The wind rises…',
    'Jinn: "Hold."',
    'Pyre Leader: [confused, shouting] "Designated zones?"'
  ],
  storyMessage: '…',                  // same content joined with \n\n (legacy)
  locationContext: {
    currentLocationArea: 'The Yard',
    currentLocation: 'The Crossroads Inn',
    currentRegion: 'Highvale'
  },
  musicContext: {
    musicTrack: 'tavern_evening',
    musicMood: 'tense',
    soundAmbience: 'firelight_crowd'
  },
  statusUpdates: [
    { eventType: 'INVENTORY', text: '…' },
    { eventType: 'SKILL',     text: '…' },
    { eventType: 'LEVEL',     text: '…' },
    { eventType: 'ABILITY_POINT',    text: '…' },
    { eventType: 'RESOURCE',         text: '…' },
    { eventType: 'NPC_CONVERSATION', text: 'Borun: Borun warned Jinn that …' }
  ],
  pastUpdates: {
    skillChecks: [
      {
        relevantSkill: 'persuasion',
        difficulty: 'hard',
        successLevel: 'success' | 'partialSuccess' | 'failure',
        modifiers: [ { name: '…', modifier: 0.4 } ]
      }
    ]
  }
}
```

### Legacy "simple" turns
Turns from very early in a campaign's history may have `type: "simple"` with only `playerInputs`, `tick`, `storyMessage`, `locationContext`, `musicContext`. No `storyParagraphs`, no `statusUpdates`, no `pastUpdates`. When parsing, fall back from `storyParagraphs` to splitting `storyMessage` on `\n\n+`.

### NPC summary parsing
Items in `statusUpdates` with `eventType: 'NPC_CONVERSATION'` have the speaker name baked into the text as a prefix: `"Borun: Borun warned Jinn that…"`. Extract speaker by splitting on the first `": "`. The AI usually restates the name as the summary's first word — slight stutter but it's a model artifact, not our bug.

---

## 7. NPC Chat Sub-Protocol

NPC conversations have unusual lifecycle rules — capture them carefully or you'll lose data.

### Lifecycle
1. **User opens chat** — client sends `openNpcChat` (`{ npcName, from, currentRoomId }`).
2. **Server replies** with `openNpcChat` carrying `messages: [{ role: 'npc', content, turnTick }]`. First open: just the NPC's opening line. Reopens: **full prior history** is replayed.
3. **User types message** — client sends `sendNpcChatMessage`. Server appends and replies asynchronously.
4. **Server sends `npcChatResponse`** — `{ npcName, message }`. Incremental NPC reply, no `turnTick` echoed.
5. **User closes chat** — client sends `closeNpcChat`. Server replies with `closeNpcChat` carrying `summary` — an AI-generated recap.

### Ephemeral!
The server **discards conversation messages when the next turn commits**. The conversation history is *only* available while you're between turns. Once the next `notifyTurnEnd` fires for that turn, calling `openNpcChat` for the same NPC returns an empty/new state.

The summary, however, is persisted — it gets folded into the **previous turn's** `statusUpdates[]` with `eventType: 'NPC_CONVERSATION'` (delivered via the next harvest of that turn). This means a "Whole story" export of a historical campaign only has summaries, never full back-and-forth.

### Reopen semantics
- Reopen during the same turn → server replays full message history in the inbound `openNpcChat`. Treat its `messages` array as authoritative; overwrite your local copy.
- Reopen after the turn rolls → server gives an empty state (conversation forgotten).

### Multiple NPCs per between-turn period
A user can chat with NPC1, close, chat with NPC2, close, return to NPC1, close again — all within the same "between turn" period. Each open-close cycle produces its own summary. If you want to track these as distinct sessions, key by `(npcName, openTimestamp)`; if you want them coalesced, key by `(npcName, turnTick)`.

### `turnTick` field
Messages in `openNpcChat` carry a `turnTick` indicating **the turn the conversation will be attributed to** — typically the *upcoming* turn (the one the player hasn't submitted yet). Use this for associating the conversation with the right turn boundary in your rendering.

---

## 8. Cache Reset / Campaign Switch

When `joinedRoom` arrives with a `roomId` different from the previously-stored one, the user has switched campaigns. The server doesn't actively tell you to discard old data — it just starts sending fresh data for the new room. You **must**:
- Clear per-campaign turn cache
- Clear live turn state
- Clear NPC chat cache
- Reset `currentChatKey`
- Reset `earliestTickLoaded` / `hasMoreHistory`

Otherwise old-campaign data will mix with the new campaign's data.

---

## 9. Discovery / Debugging Recipes

### Live frame inspection
1. Open DevTools → **Network** tab
2. Filter by **WS** (WebSocket)
3. Click the `/heroes/` connection
4. Switch to the **Messages** tab
5. Perform an action in Voyage and watch the frames in real-time

Direction matters:
- **↑** = client → server (outbound)
- **↓** = server → client (inbound)

### Diff-based exploration
To find what event delivers data X:
1. Note the frame timestamps before performing the action
2. Perform the action
3. Note the new frames — pattern-match against the known catalog
4. Unknown event name? Click the frame to expand JSON. Inspect payload shape.

### Console probes
The cache exposes a debug handle:
```js
__voyageStory._cache           // raw cache map
__voyageStory.getSnapshot()    // serialized snapshot
__voyageStory.requestHistory(beforeTick, count)  // manual paginate
__voyageStory.pullAllHistory(maxBatches, count)  // full backfill loop
```

Inspect a specific turn:
```js
const t = __voyageStory._cache.turns.get(116);
console.log('Keys:', Object.keys(t));
console.log(JSON.stringify(t, null, 2));
```

Find all chats:
```js
[...__voyageStory._cache.npcChats.values()]
```

### Force-trigger a backfill
```js
await __voyageStory.pullAllHistory(200, 10);
console.log(__voyageStory._cache.turns.size);
```

### Watch for an event in real-time
Temporary listener in DevTools console (page context only — paste into the Sources tab as a snippet and run, or set a conditional breakpoint):
```js
const orig = WebSocket.prototype.send;
WebSocket.prototype.send = function(data) {
  console.log('↑', data);
  return orig.call(this, data);
};
```
(Don't ship this — page-side hooks like this can persist across reloads if you're not careful.)

---

## 10. When Things Break — Diagnostic Playbook

Symptoms and where to look:

### Empty cache after a change
- Open DevTools → Network → WS
- Verify frames are still flowing on `/heroes/`
- Check the URL pattern — has Voyage changed the path? Update the regex in `InterceptedWebSocket`'s constructor
- Check for `[voyage-story]` errors in the console

### A specific event no longer fires
- In DevTools WS, do the action that should trigger it
- If the event name has changed: rename the case in `dispatchEvent`
- If the event no longer exists: find the new event that carries the same data (look for one that fires at the same moment in the sequence)

### Payload shape changed
- Capture the new payload (copy from DevTools WS Messages tab)
- Compare to the documented shape in this file
- Update the field accesses in `dispatchEvent` / `getSnapshot` / `pushTurn`

### Two turns are now one (or vice versa)
- Check `tick` values — has Voyage changed indexing?
- Check whether `notifyTurnEnd` is now firing once vs twice — adjust `isTurnComplete` check accordingly

### NPC chats no longer captured
- Have event names changed? (`openNpcChat`, `sendNpcChatMessage`, `npcChatResponse`, `closeNpcChat`)
- Has `messages[].turnTick` moved or been renamed?
- Are messages now structured differently? (e.g., dialogue separated from stage directions)

### Server rejects `requestTurnHistory`
- Verify you're echoing the captured `sid` in `from`
- Verify `currentRoomId` matches the active room
- Check whether Voyage now requires additional fields (auth token, etc.)

### Multiplayer changes
- `usersChanged.users` may have more than one entry; assumptions that `users[0]` is the player may break
- `playerInputs` may be keyed by user-id instead of character name
- Watch for new fields differentiating "your" turns from others'

---

## 11. Things That Look Like They Should Work But Don't

Before pursuing an alternate data source, know that these were exhaustively ruled out for content capture:

- **GraphQL / Apollo cache** — `/graphql` carries auth + metadata (save lists, room IDs, world descriptions) but **no turn content**. Apollo's in-memory cache reflects this.
- **Page IndexedDB** — Firebase auth tokens only. No game state.
- **Service workers** — Voyage doesn't register one for game data.
- **React fiber tree** — no top-level store with turn data. The page mounts components from the WS stream as it arrives; nothing aggregates.
- **REST endpoints (`/voyage/load-room`, `/voyage/request-server`)** — single-call session bootstrap, not a turn feed.

**The WebSocket at `/heroes/` is the only authoritative source of game-state content.** If it changes, the entire app changes.

---

## 12. Forward-Path Checklist

When you discover Voyage has changed something:

1. **Confirm the change** — inspect the actual frames in DevTools WS. Don't trust assumptions.
2. **Pinpoint the layer** — connection? event name? payload shape? Workflow timing (event-order changes)?
3. **Update the parser if needed** — `parseFrame` in `voyage-story-cache.js`.
4. **Update the event dispatch** — the `switch(event)` in `dispatchEvent`. Rename, add, remove cases.
5. **Update the cache shape** — fields stored on `cache.turns`, `cache.npcChats`, etc.
6. **Update the snapshot serialization** — `getSnapshot()` to include any new fields.
7. **Update the exporter rendering** — `pushTurn`, `pushChat`, `formatStoryParagraph` in `voyage-story-exporter.js`.
8. **Update the debug handle** — only if you've added new internal state worth exposing.
9. **Test against a real session** — open a Voyage tab, run through one turn + one NPC chat. Verify the markdown output looks right.

---

## 13. Quick Reference: Where Each Thing Lives in Code

| Concern                        | File                          | Symbol(s)                                   |
|--------------------------------|-------------------------------|---------------------------------------------|
| WebSocket subclassing          | `voyage-story-cache.js`       | `InterceptedWebSocket`                      |
| Frame parsing                  | `voyage-story-cache.js`       | `parseFrame`                                |
| Inbound event dispatch         | `voyage-story-cache.js`       | `dispatchEvent`                             |
| Outbound chat capture          | `voyage-story-cache.js`       | `handleOutgoingChatMessage`                 |
| Cache state shape              | `voyage-story-cache.js`       | `const cache = { … }`                       |
| Snapshot serialization         | `voyage-story-cache.js`       | `getSnapshot`                               |
| Pagination request             | `voyage-story-cache.js`       | `requestHistory`, `pullAllHistory`          |
| MAIN-world debug handle        | `voyage-story-cache.js`       | `window.__voyageStory`                      |
| MAIN↔isolated RPC bridge       | `voyage-story-cache.js`       | `notifyChange`, `window.postMessage`        |
| Turn markdown rendering        | `voyage-story-exporter.js`    | `pushTurn`                                  |
| NPC chat markdown rendering    | `voyage-story-exporter.js`    | `pushChat`                                  |
| Live turn rendering            | `voyage-story-exporter.js`    | `pushLiveTurn`                              |
| Paragraph parsing              | `voyage-story-exporter.js`    | `formatStoryParagraph`                      |

---

## 14. Versioning Voyage's Schema

Voyage doesn't expose a version string on its WS frames, so when a change lands you have to detect it by feel:

- New fields in payloads → add to cache shape + snapshot + renderers
- Removed fields → defensive `?.` access already in our code mostly survives, but renderers may emit empty sections
- Renamed events → rename cases in `dispatchEvent`
- Reordered event sequences → the turn-completion two-phase pattern is the most likely victim; revisit `isTurnComplete`

If you find yourself adding lots of "if version === X" branches, that's a sign you should fork the cache module and let the user pick which Voyage build they're on. We haven't had to do this yet.
