/*
 * Voyage Tools — Popup script
 *
 * The popup is a thin status + actions surface. The folder picker, filename
 * input, and export-option toggles live in a separate configure page
 * (configure.html / configure.js) opened in a new browser tab via
 * chrome.tabs.create. Tabs survive the OS folder picker's focus-steal, which
 * would otherwise close this popup mid-flow.
 *
 * Page-feature toggles (perfFix, skipButton) stay here because they're
 * always-on convenience flips, not part of the export pipeline.
 *
 * Communication with the Voyage tab's content script is via
 * chrome.tabs.sendMessage with { source: 'voyage-story', action }.
 */

// ---------- Settings persistence (page-feature toggles only) ----------
const MAIN_TOGGLES = ['perfFix', 'skipButton'];
const NAMESPACE = 'voyage-story';

function defaultFor(_key) {
  // Both main toggles default on.
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
  // Match both subdomains registered in the manifest.
  if (!tab || !tab.url || !/^https:\/\/(beta|alpha)\.voyage\.io\//.test(tab.url)) return null;
  return tab;
}

// ---------- Message helper ----------
async function sendToContentScript(tabId, action, extra = {}) {
  return await chrome.tabs.sendMessage(tabId, { source: NAMESPACE, action, ...extra });
}

// ---------- Configure-tab tracking ----------
// Configure runs in a regular browser tab (opened via chrome.tabs.create)
// rather than a chrome.windows.create popup window. Both survive the OS
// folder picker's blur, but a tab gives the user normal browser controls
// (back/forward, pin, drag-reorder) and avoids any "did the window
// disappear?" confusion when the picker lands on top of a small popup
// window. The configure.html body is `max-width`-locked so the tab
// content stays visually constrained even on wide displays.
//
// Single-instance: subsequent clicks focus the existing tab (and the
// window it lives in) instead of opening a duplicate. The id is cleared
// when the user closes the tab via chrome.tabs.onRemoved.
let configureTabId = null;
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === configureTabId) configureTabId = null;
});

async function openConfigureWindow() {
  if (currentTabId == null) return;
  // Permission must be requested under the popup's user-gesture context. If
  // we wait for the configure tab to ask, the gesture is lost.
  const granted = await ensureScriptingPermission();
  if (!granted) {
    setStatusText('Live export needs the "scripting" permission. Click Configure again to be prompted, or grant it in chrome://extensions.');
    return;
  }
  if (configureTabId != null) {
    try {
      const tab = await chrome.tabs.get(configureTabId);
      await chrome.tabs.update(configureTabId, { active: true });
      // The tab may live in a different browser window than the popup —
      // focus that window too so the user actually sees the tab.
      if (tab?.windowId != null) {
        try { await chrome.windows.update(tab.windowId, { focused: true }); } catch {}
      }
      return;
    } catch {
      // Stored id is stale (tab closed without onRemoved firing before we
      // got here, e.g. browser shutdown sequence). Fall through to create.
      configureTabId = null;
    }
  }
  const url = chrome.runtime.getURL(`src/popup/configure.html#tabId=${currentTabId}`);
  try {
    const tab = await chrome.tabs.create({
      url,
      active: true,
      // openerTabId places the new tab immediately to the right of the
      // Voyage tab in the tab strip, the same way a regular link click
      // would. Both tabs live in the same window since `currentTabId`
      // came from `chrome.tabs.query({ currentWindow: true })`.
      openerTabId: currentTabId,
    });
    configureTabId = tab?.id ?? null;
  } catch (e) {
    console.error('[voyage popup] openConfigureWindow', e);
    setStatusText(`Couldn't open the configure tab: ${e?.message || 'unknown error'}.`);
  }
}

async function ensureScriptingPermission() {
  try {
    return await chrome.permissions.request({ permissions: ['scripting'] });
  } catch (e) {
    console.error('[voyage popup] permission request failed', e);
    return false;
  }
}

// ---------- Story export UI ----------
const els = {
  status:        null,
  exportRow:     null,
  tip:           null,
  filepath:      null,
  filename:      null,
  currentBtn:    null,
  wholeBtn:      null,
  liveBtn:       null,
  configureBtn:  null,
};

let pollingTimer = null;
let currentTabId = null;
let currentStatus = null;

function setStatusText(html) {
  if (!els.status) return;
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
  if (els.exportRow)    els.exportRow.hidden = true;
  if (els.liveBtn)      els.liveBtn.hidden = true;
  if (els.tip)          els.tip.hidden = true;
  if (els.filepath)     els.filepath.hidden = true;
  if (els.configureBtn) els.configureBtn.hidden = true;
}

function renderStatus(status) {
  setStorySectionVisible(currentTabId != null);

  if (!status) {
    setStatusText('No Voyage tab is active. Open beta.voyage.io or alpha.voyage.io in the current window.');
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
  if (status.syncPhase) {
    metaParts.push(status.syncPhase);
  } else if (status.loadingHistory) {
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
  if (status.liveExport?.active && status.syncCompleteMsg) {
    lines.push(makeLine(`✓ ${status.syncCompleteMsg}`, 'session-meta'));
  }
  setStatusText(lines);

  const liveActive = !!status.liveExport?.active;
  const hasConfig = !!status.hasConfig;

  if (els.exportRow) els.exportRow.hidden = liveActive;
  if (els.currentBtn) {
    els.currentBtn.disabled = !status.hasLiveTurn && (status.turnCount || 0) === 0;
  }
  if (els.wholeBtn) els.wholeBtn.disabled = false;

  // Primary button:
  //   active    → "Stop live export"          (soft red)
  //   hasConfig → "Start live export"         (yellow primary)
  //   none      → hidden (user clicks Configure first; the Configure button
  //               below is the only way forward without a config)
  //   no-FSA    → disabled "Live export not supported here"
  if (els.liveBtn) {
    if (liveActive) {
      els.liveBtn.hidden = false;
      els.liveBtn.textContent = 'Stop live export';
      els.liveBtn.disabled = false;
      els.liveBtn.classList.add('primary', 'danger');
    } else if (!status.directoryPickerSupported) {
      els.liveBtn.hidden = false;
      els.liveBtn.textContent = 'Live export not supported here';
      els.liveBtn.disabled = true;
      els.liveBtn.classList.remove('primary', 'danger');
    } else if (hasConfig) {
      els.liveBtn.hidden = false;
      els.liveBtn.textContent = 'Start live export';
      els.liveBtn.disabled = false;
      els.liveBtn.classList.add('primary');
      els.liveBtn.classList.remove('danger');
    } else {
      els.liveBtn.hidden = true;
    }
  }

  // File path display.
  if (els.filepath && els.filename) {
    let displayFolder = null;
    let displayFilename = null;
    if (status.liveExport?.active) {
      displayFolder   = status.liveExport.folderName || status.configFolderName || null;
      displayFilename = status.liveExport.filename   || status.configFilename   || null;
    } else if (hasConfig) {
      displayFolder   = status.configFolderName || null;
      displayFilename = status.configFilename   || null;
    }
    if (displayFilename) {
      const text = displayFolder ? `${displayFolder}/${displayFilename}` : displayFilename;
      els.filename.textContent = text;
      els.filepath.hidden = false;
    } else {
      els.filepath.hidden = true;
    }
  }

  // Configure button is always visible (and enabled) as long as the
  // directory picker is supported. It opens the separate configure window
  // for everything: folder, filename, toggles. While live export is active
  // the configure window itself locks the folder/filename section — the
  // button stays clickable so the user can still adjust toggles.
  if (els.configureBtn) {
    els.configureBtn.hidden = false;
    els.configureBtn.disabled = !status.directoryPickerSupported;
    els.configureBtn.textContent = hasConfig
      ? 'Configure export options…'
      : 'Configure live export…';
  }

  if (els.tip) {
    if (liveActive) {
      els.tip.textContent = 'Turns auto-append while the Voyage tab is open.';
      els.tip.hidden = false;
    } else if (!status.directoryPickerSupported) {
      // Configure button is disabled in this state — point users at the
      // real problem instead of telling them to click a dead control.
      els.tip.textContent = 'Live export requires a Chromium-based browser with the File System Access API.';
      els.tip.hidden = false;
    } else if (hasConfig) {
      els.tip.textContent = 'Start re-opens the saved file and catches it up.';
      els.tip.hidden = false;
    } else {
      els.tip.textContent = 'Click Configure to pick a folder and filename, then come back to Start.';
      els.tip.hidden = false;
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
    const detail = e?.message ? ` (${e.message})` : '';
    renderStatus({ connected: false, message: `Reload the Voyage tab to activate the exporter.${detail}` });
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
  if (currentStatus?.liveExport?.active) {
    try {
      await sendToContentScript(currentTabId, 'stopLiveExport');
    } catch (e) {
      console.error('[voyage popup] stopLiveExport', e);
      setStatusText(`Stop failed — reload the Voyage tab. (${e?.message || 'unknown error'})`);
      return;
    }
    await refreshStatus();
    return;
  }
  if (currentStatus?.hasConfig) {
    els.liveBtn.disabled = true;
    els.liveBtn.textContent = 'Starting…';
    try {
      await sendToContentScript(currentTabId, 'startLiveExport');
    } catch (e) {
      console.error('[voyage popup] startLiveExport', e);
      setStatusText(`Start failed — reload the Voyage tab. (${e?.message || 'unknown error'})`);
      els.liveBtn.disabled = false;
      els.liveBtn.textContent = 'Start live export';
      return;
    }
    await refreshStatus();
    return;
  }
  // No config + live not active → open Configure. This branch is rare since
  // the Configure button is the primary entry point in that state, but it's
  // here as a fallback if the user clicks an outdated liveExportBtn before
  // status refreshes.
  await openConfigureWindow();
}

// ---------- Init ----------
function bindToggles() {
  chrome.storage.local.get(MAIN_TOGGLES, (result) => {
    for (const key of MAIN_TOGGLES) {
      const el = document.getElementById(key);
      if (!el) continue;
      const stored = result[key];
      el.checked = typeof stored === 'boolean' ? stored : defaultFor(key);
    }
  });

  for (const key of MAIN_TOGGLES) {
    const el = document.getElementById(key);
    if (!el) continue;
    el.addEventListener('change', (e) => {
      chrome.storage.local.set({ [key]: e.target.checked });
    });
  }
}

async function init() {
  els.status        = document.getElementById('storyStatus');
  els.exportRow     = document.getElementById('storyExportRow');
  els.tip           = document.getElementById('storyTip');
  els.filepath      = document.getElementById('storyFilepath');
  els.filename      = document.getElementById('storyFilename');
  els.currentBtn    = document.getElementById('exportCurrentTurnBtn');
  els.wholeBtn      = document.getElementById('exportWholeStoryBtn');
  els.liveBtn       = document.getElementById('liveExportBtn');
  els.configureBtn  = document.getElementById('configureExportBtn');

  bindToggles();

  els.currentBtn?.addEventListener('click', onExportCurrentTurn);
  els.wholeBtn?.addEventListener('click', onExportWholeStory);
  els.liveBtn?.addEventListener('click', onLiveExportClick);
  els.configureBtn?.addEventListener('click', openConfigureWindow);

  const tab = await getActiveVoyageTab();
  currentTabId = tab?.id ?? null;
  await refreshStatus();
  if (currentTabId != null) startPolling();
}

window.addEventListener('unload', stopPolling);
init();
