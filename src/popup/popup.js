/*
 * Voyage Tools — Popup script
 *
 * Wires the feature toggles, exporter config checkboxes, and the Story
 * Export action buttons to chrome.storage.local and the active Voyage tab's
 * content script.
 *
 * Settings (perfFix, skipButton, storyExporter, storyInclude*) are persisted
 * in chrome.storage.local; the settings-controller.js content script picks
 * up the changes via chrome.storage.onChanged and applies them live.
 *
 * Story Export actions (current turn, whole story, start/resume/stop live
 * export) send messages to voyage-story-exporter.js on the active tab via
 * chrome.tabs.sendMessage. The popup hosts the showSaveFilePicker call
 * because it needs a user-gesture; the resulting FileSystemFileHandle is
 * passed to the content script through the structured-clone in sendMessage.
 */

// ---------- Settings persistence ----------
const MAIN_TOGGLES = ['perfFix', 'skipButton'];
const STORY_CONFIG = [
  'storyIncludeInputs',
  'storyIncludeChecks',
  'storyIncludeStatus',
  'storyIncludeNpcChats',
  'storyIncludeNpcConversations',
  'storyIncludeMusic',
  'storyIncludeMarkers',
];
const STORY_CONFIG_DEFAULTS_OFF = new Set(['storyIncludeNpcChats', 'storyIncludeMusic']);
const ALL_KEYS = [...MAIN_TOGGLES, ...STORY_CONFIG];
const NAMESPACE = 'voyage-story';

function defaultFor(key) {
  if (STORY_CONFIG_DEFAULTS_OFF.has(key)) return false;
  return true;
}

function setStorySectionVisible(visible) {
  const section = document.getElementById('storySection');
  if (section) section.hidden = !visible;
}

// ---------- Active Voyage tab discovery ----------
async function getActiveVoyageTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab || !tab.url || !/^https:\/\/beta\.voyage\.io\//.test(tab.url)) return null;
  return tab;
}

// ---------- Message helper ----------
async function sendToContentScript(tabId, action, extra = {}) {
  return await chrome.tabs.sendMessage(tabId, { source: NAMESPACE, action, ...extra });
}

// ---------- Story export UI ----------
const els = {
  status:     null,
  exportRow:  null,
  tip:        null,
  filepath:   null,
  filename:   null,
  currentBtn: null,
  wholeBtn:   null,
  liveBtn:    null,
};

let pollingTimer = null;
let currentTabId = null;
let currentStatus = null;

function setStatusText(html) {
  if (!els.status) return;
  // Clear existing
  while (els.status.firstChild) els.status.removeChild(els.status.firstChild);
  if (typeof html === 'string') {
    els.status.textContent = html;
  } else {
    for (const node of html) {
      if (typeof node === 'string') {
        els.status.appendChild(document.createTextNode(node));
      } else {
        els.status.appendChild(node);
      }
    }
  }
}

function makeLine(text, className) {
  const div = document.createElement('div');
  if (className) div.className = className;
  div.textContent = text;
  return div;
}

// The "Live export active" line gets a pulsing dot to signal we're actively
// listening on the WebSocket, plus a contextual suffix when something
// specific is being captured right now. Priority is chat > new turn > idle —
// chat takes precedence because it's a per-message append and the user
// usually wants to confirm we're catching it as they type.
function makeLiveActiveLine(status) {
  const line = document.createElement('div');
  line.className = 'live-active';
  const dot = document.createElement('span');
  dot.className = 'live-pulse';
  dot.textContent = '●';
  line.appendChild(dot);

  let suffix = '';
  if (status.currentChatNpcName) {
    suffix = ` · recording chat with ${status.currentChatNpcName}`;
  } else if (status.hasLiveTurn) {
    suffix = ' · recording new turn';
  }
  line.appendChild(document.createTextNode(` Live export active${suffix}`));
  return line;
}

function hideActions() {
  if (els.exportRow) els.exportRow.hidden = true;
  if (els.liveBtn)   els.liveBtn.hidden = true;
  if (els.tip)       els.tip.hidden = true;
  if (els.filepath)  els.filepath.hidden = true;
}

function renderStatus(status) {
  // The whole story-section visibility is tied to "are we on a Voyage tab".
  // The actual roomId/session/etc. determine what we show inside it.
  setStorySectionVisible(currentTabId != null);

  if (!status) {
    setStatusText('No Voyage tab is active. Open beta.voyage.io in the current window.');
    hideActions();
    return;
  }
  if (!status.connected) {
    setStatusText(status.message || 'Connecting to the Voyage tab…');
    hideActions();
    return;
  }
  if (!status.session?.roomId) {
    setStatusText('Waiting for the campaign to finish loading on the page…');
    hideActions();
    return;
  }

  const lines = [];
  const session = status.session;
  // Title combines all available identifiers on one line — character, save
  // name, world/story title — separated by middle-dots, deduped against
  // each other in case Voyage reuses the same string in multiple fields.
  // The meta line (turn count etc.) sits below as before.
  const idParts = [];
  if (session.characterName) idParts.push(session.characterName);
  if (session.name && session.name !== session.characterName) idParts.push(session.name);
  if (
    session.worldTitle &&
    session.worldTitle !== session.name &&
    session.worldTitle !== session.characterName
  ) idParts.push(session.worldTitle);
  const title = idParts.length ? idParts.join(' · ') : 'Voyage campaign';
  lines.push(makeLine(title, 'session-name'));

  const metaParts = [];
  if (status.loadingHistory) {
    metaParts.push('loading history…');
  } else if (typeof status.turnCount === 'number') {
    const total = status.turnCount + (status.hasLiveTurn ? 1 : 0);
    metaParts.push(`${total} turn${total === 1 ? '' : 's'} loaded`);
  }
  if (metaParts.length) lines.push(makeLine(metaParts.join(' · '), 'session-meta'));

  if (status.liveExport?.active) {
    lines.push(makeLiveActiveLine(status));
  }
  if (status.lastStatus && Date.now() - status.lastStatusAt < 30000) {
    lines.push(makeLine(status.lastStatus, 'session-meta'));
  }
  setStatusText(lines);

  // While live export is active, the one-shot export buttons (Current turn /
  // Whole story) are hidden — the live exporter is already capturing
  // everything continuously, so individual exports would be redundant. Their
  // row position is taken over by the Stop button.
  const liveActive = !!status.liveExport?.active;
  if (els.exportRow) els.exportRow.hidden = liveActive;
  if (els.currentBtn) {
    els.currentBtn.disabled = !status.hasLiveTurn && (status.turnCount || 0) === 0;
  }
  if (els.wholeBtn)   els.wholeBtn.disabled = false;

  // The single live-export button cycles through four states:
  //   active   → "Stop live export"   (soft red, replacing the export row)
  //   stored   → "Resume live export…" (yellow primary)
  //   fresh    → "Start live export…"  (yellow primary)
  //   no-FSA   → disabled "Live export not supported here"
  if (els.liveBtn) {
    els.liveBtn.hidden = false;
    if (liveActive) {
      els.liveBtn.textContent = 'Stop live export';
      els.liveBtn.disabled = false;
      els.liveBtn.classList.add('primary', 'danger');
    } else if (!status.filePickerSupported) {
      els.liveBtn.textContent = 'Live export not supported here';
      els.liveBtn.disabled = true;
      els.liveBtn.classList.remove('primary', 'danger');
    } else if (status.hasStoredHandle) {
      els.liveBtn.textContent = 'Resume live export…';
      els.liveBtn.disabled = false;
      els.liveBtn.classList.add('primary');
      els.liveBtn.classList.remove('danger');
    } else {
      els.liveBtn.textContent = 'Start live export…';
      els.liveBtn.disabled = false;
      els.liveBtn.classList.add('primary');
      els.liveBtn.classList.remove('danger');
    }
  }
  // Filepath: only meaningful while live export is active and we know the
  // file's name. FileSystemFileHandle never gives us the absolute path, so
  // we show just the filename — enough for the user to verify they're
  // writing to the file they intended.
  if (els.filepath && els.filename) {
    if (status.liveExport?.active && status.liveExport?.filename) {
      els.filename.textContent = status.liveExport.filename;
      els.filepath.hidden = false;
    } else {
      els.filepath.hidden = true;
    }
  }

  if (els.tip) {
    if (status.liveExport?.active) {
      els.tip.textContent = 'Turns auto-append while the Voyage tab is open.';
      els.tip.hidden = false;
    } else if (status.hasStoredHandle) {
      els.tip.textContent = 'Re-links your previously picked file and catches it up.';
      els.tip.hidden = false;
    } else {
      els.tip.hidden = true;
    }
  }
}

async function refreshStatus() {
  if (currentTabId == null) {
    renderStatus(null);
    return;
  }
  try {
    const resp = await sendToContentScript(currentTabId, 'getStatus');
    currentStatus = resp;
    renderStatus(resp);
  } catch (e) {
    currentStatus = null;
    renderStatus({ connected: false, message: 'Reload the Voyage tab to activate the exporter.' });
  }
}

function startPolling() {
  stopPolling();
  pollingTimer = setInterval(refreshStatus, 2000);
}
function stopPolling() {
  if (pollingTimer) {
    clearInterval(pollingTimer);
    pollingTimer = null;
  }
}

// ---------- Action handlers ----------
async function onExportCurrentTurn() {
  if (currentTabId == null) return;
  els.currentBtn.disabled = true;
  try {
    await sendToContentScript(currentTabId, 'exportCurrentTurn');
  } catch (e) {
    console.error('[voyage popup] exportCurrentTurn', e);
  }
  await refreshStatus();
}

async function onExportWholeStory() {
  if (currentTabId == null) return;
  els.wholeBtn.disabled = true;
  els.wholeBtn.textContent = 'Working…';
  try {
    await sendToContentScript(currentTabId, 'exportWholeStory');
  } catch (e) {
    console.error('[voyage popup] exportWholeStory', e);
  }
  els.wholeBtn.textContent = 'Whole story';
  els.wholeBtn.disabled = false;
  await refreshStatus();
}

async function onLiveExportClick() {
  if (currentTabId == null) return;
  // Three modes based on current state.
  if (currentStatus?.liveExport?.active) {
    try { await sendToContentScript(currentTabId, 'stopLiveExport'); }
    catch (e) { console.error('[voyage popup] stopLiveExport', e); }
    await refreshStatus();
    return;
  }
  if (currentStatus?.hasStoredHandle) {
    els.liveBtn.disabled = true;
    els.liveBtn.textContent = 'Resuming…';
    try { await sendToContentScript(currentTabId, 'resumeLiveExport'); }
    catch (e) { console.error('[voyage popup] resumeLiveExport', e); }
    await refreshStatus();
    return;
  }

  // Fresh start: run the picker INSIDE the content script's isolated world.
  // chrome.tabs.sendMessage strips FileSystemFileHandle methods on some
  // Chrome versions, so we can't pick in the popup and ship the handle —
  // we'd get back a handle with no createWritable. Instead, inject a
  // function via chrome.scripting.executeScript that both picks and starts
  // the live export, keeping the handle in one context the whole time.
  //
  // "scripting" is declared optional so users aren't prompted at install
  // time for a feature they may never use. We request it lazily here, on
  // the user gesture that actually needs it.
  const granted = await ensureScriptingPermission();
  if (!granted) {
    setStatusText('Live export needs the "scripting" permission to open the file picker on the Voyage tab. Click Start live export again to be prompted, or grant it in chrome://extensions.');
    return;
  }
  els.liveBtn.disabled = true;
  els.liveBtn.textContent = 'Starting…';
  const suggestedName = currentStatus?.suggestedFilename || 'voyage-story.md';
  let result;
  try {
    const arr = await chrome.scripting.executeScript({
      target: { tabId: currentTabId },
      world: 'ISOLATED',
      func: pickAndStartLiveExport,
      args: [suggestedName],
    });
    result = arr?.[0]?.result;
  } catch (e) {
    console.error('[voyage popup] startLiveExport (scripting)', e);
    result = { ok: false, message: e.message || String(e) };
  }
  if (result && !result.ok && !result.aborted && result.message) {
    setStatusText(result.message);
  }
  await refreshStatus();
}

// chrome.permissions.request must be called from a user gesture, which the
// click that landed us in onLiveExportClick provides. If the user has
// already granted "scripting" on a previous click, request() resolves true
// immediately with no prompt.
async function ensureScriptingPermission() {
  try {
    return await chrome.permissions.request({ permissions: ['scripting'] });
  } catch (e) {
    console.error('[voyage popup] permission request failed', e);
    return false;
  }
}

// Runs inside the page's isolated world (same context as the content
// script), so showSaveFilePicker's handle and __voyageStoryHelper live in
// the same realm — no structured-clone hop for the FileSystemFileHandle.
async function pickAndStartLiveExport(suggestedName) {
  if (typeof window.showSaveFilePicker !== 'function') {
    return { ok: false, message: 'Live export needs Chrome/Edge with File System Access support.' };
  }
  let handle;
  try {
    handle = await window.showSaveFilePicker({
      suggestedName,
      types: [{ description: 'Markdown', accept: { 'text/markdown': ['.md'] } }],
    });
  } catch (e) {
    if (e.name === 'AbortError') return { ok: false, aborted: true };
    return { ok: false, message: 'File picker error: ' + (e.message || e.name) };
  }
  if (!window.__voyageStoryHelper || typeof window.__voyageStoryHelper.startLiveExport !== 'function') {
    return { ok: false, message: 'Story exporter not ready — reload the Voyage tab and try again.' };
  }
  return await window.__voyageStoryHelper.startLiveExport(handle);
}

// ---------- Init ----------
function bindToggles() {
  chrome.storage.local.get(ALL_KEYS, (result) => {
    for (const key of ALL_KEYS) {
      const el = document.getElementById(key);
      if (!el) continue;
      const stored = result[key];
      el.checked = typeof stored === 'boolean' ? stored : defaultFor(key);
    }
  });

  for (const key of ALL_KEYS) {
    const el = document.getElementById(key);
    if (!el) continue;
    el.addEventListener('change', (e) => {
      chrome.storage.local.set({ [key]: e.target.checked });
    });
  }
}

async function init() {
  els.status     = document.getElementById('storyStatus');
  els.exportRow  = document.getElementById('storyExportRow');
  els.tip        = document.getElementById('storyTip');
  els.filepath   = document.getElementById('storyFilepath');
  els.filename   = document.getElementById('storyFilename');
  els.currentBtn = document.getElementById('exportCurrentTurnBtn');
  els.wholeBtn   = document.getElementById('exportWholeStoryBtn');
  els.liveBtn    = document.getElementById('liveExportBtn');

  bindToggles();

  els.currentBtn?.addEventListener('click', onExportCurrentTurn);
  els.wholeBtn?.addEventListener('click', onExportWholeStory);
  els.liveBtn?.addEventListener('click', onLiveExportClick);

  const tab = await getActiveVoyageTab();
  currentTabId = tab?.id ?? null;
  await refreshStatus();
  if (currentTabId != null) startPolling();
}

window.addEventListener('unload', stopPolling);
init();
