/*
 * Voyage Tools — Popup script
 *
 * The popup is the single UI surface for story export. All configure options
 * (folder pick, filename, include toggles) live inline in configureSection,
 * toggled by configureToggleBtn — no separate browser tab needed.
 *
 * Folder picking uses chrome.scripting.executeScript to inject
 * showDirectoryPicker() into the Voyage tab's MAIN world (beta.voyage.io
 * origin). The handle is relayed to the isolated world via window.postMessage
 * (same-origin, so prototype methods survive). This sidesteps Chrome's
 * FileSystemHandle origin-locking, which destroys handles passed through
 * chrome.tabs.sendMessage even with structured_clone.
 *
 * Page-feature toggles (perfFix, skipButton) stay separate because they're
 * always-on convenience flips, not part of the export pipeline.
 */

// ---------- Settings persistence ----------
const MAIN_TOGGLES = ['perfFix', 'skipButton'];
const STORY_CONFIG = [
  'storyIncludeInputs',
  'storyIncludeChecks',
  'storyIncludeStatus',
  'storyIncludeNpcChats',
  'storyIncludeNpcConversations',
  'storyIncludeCharacters',
  'storyIncludeMusic',
  'storyIncludeMarkers',
];
const STORY_CONFIG_DEFAULTS_OFF = new Set(['storyIncludeNpcChats', 'storyIncludeMusic']);
const NAMESPACE = 'voyage-story';

function defaultFor(key) {
  if (STORY_CONFIG_DEFAULTS_OFF.has(key)) return false;
  return true;
}

function bindToggles(keys) {
  chrome.storage.local.get(keys, (result) => {
    for (const key of keys) {
      const el = document.getElementById(key);
      if (!el) continue;
      const stored = result[key];
      el.checked = typeof stored === 'boolean' ? stored : defaultFor(key);
    }
  });
  for (const key of keys) {
    const el = document.getElementById(key);
    if (!el) continue;
    el.addEventListener('change', (e) => {
      chrome.storage.local.set({ [key]: e.target.checked });
    });
  }
}

// ---------- Active Voyage tab discovery ----------
async function getActiveVoyageTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab || !tab.url || !/^https:\/\/(beta|alpha)\.voyage\.io\//.test(tab.url)) return null;
  return tab;
}

// ---------- Message helper ----------
async function sendToContentScript(tabId, action, extra = {}) {
  return await chrome.tabs.sendMessage(tabId, { source: NAMESPACE, action, ...extra });
}

// ---------- Story export UI element refs ----------
const els = {
  // Main view
  status:           null,
  exportRow:        null,
  tip:              null,
  filepath:         null,
  filename:         null,
  currentBtn:       null,
  wholeBtn:         null,
  liveBtn:          null,
  configureToggle:  null,
  // Configure section
  configureSection: null,
  lockTip:          null,
  pickFolderBtn:    null,
  pickedFolder:     null,
  configFilename:   null,
  configPreview:    null,
  configSaveBtn:    null,
  configCancelBtn:  null,
  clearConfig:      null,
  markersInput:     null,
  markersLabel:     null,
};

let pollingTimer = null;
let currentTabId = null;
let currentStatus = null;

// Configure section state
let configDraft = {
  folderName: null,
  hasFolder: false,
};
let savingInFlight = false;

// ---------- Status text helpers ----------
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

  if (status.syncPhase) {
    line.appendChild(document.createTextNode(` Live export — ${status.syncPhase}`));
  } else {
    let suffix = '';
    if (status.currentChatNpcName) {
      suffix = ` · recording chat with ${status.currentChatNpcName}`;
    } else if (status.hasLiveTurn) {
      suffix = ' · recording new turn';
    }
    line.appendChild(document.createTextNode(` Live export active${suffix}`));
  }
  return line;
}

function setStorySectionVisible(visible) {
  const section = document.getElementById('storySection');
  if (section) section.hidden = !visible;
}

// ---------- Configure section helpers ----------
function showConfigPreview(klass, text) {
  if (!els.configPreview) return;
  els.configPreview.hidden = false;
  els.configPreview.textContent = text;
  els.configPreview.className = `configure-preview ${klass}`;
}

function clearConfigPreview() {
  if (!els.configPreview) return;
  els.configPreview.hidden = true;
  els.configPreview.textContent = '';
}

function isLiveActive() {
  return !!currentStatus?.liveExport?.active;
}

function setConfigSaveButtonState() {
  if (!els.configSaveBtn) return;
  const filenameNonEmpty = !!(els.configFilename?.value || '').trim();
  els.configSaveBtn.disabled =
    !(configDraft.hasFolder && filenameNonEmpty) ||
    isLiveActive() ||
    savingInFlight ||
    currentTabId == null;
}

function setConfigureVisible(visible) {
  if (els.configureSection) els.configureSection.hidden = !visible;
}

// ---------- Action handlers: configure section ----------
async function onPickFolderClick() {
  if (currentTabId == null || isLiveActive()) return;
  clearConfigPreview();
  // Inject showDirectoryPicker() into the Voyage tab's MAIN world. The popup
  // overlays the active tab so the user gesture propagates. The handle stays
  // in the beta.voyage.io realm and is relayed to the isolated world via
  // window.postMessage (same-origin, preserving prototype methods).
  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId: currentTabId },
      world: 'MAIN',
      func: async () => {
        try {
          const h = await window.showDirectoryPicker({ mode: 'readwrite' });
          window.postMessage(
            { source: 'voyage-story', type: 'pushPendingDir', directoryHandle: h, dirName: h.name },
            location.origin,
          );
          return { ok: true, dirName: h.name };
        } catch (e) {
          if (e?.name === 'AbortError') return { ok: false, aborted: true };
          return { ok: false, message: e?.message || e?.name || 'unknown' };
        }
      },
    });
  } catch (e) {
    showConfigPreview('error', `Folder picker failed: ${e?.message || 'unknown error'}.`);
    return;
  }

  const result = results?.[0]?.result;
  console.log('[voyage popup] executeScript result:', result);
  if (!result || result.aborted) return;
  if (!result.ok) {
    showConfigPreview('error', `Folder picker error: ${result.message || 'unknown'}.`);
    return;
  }

  configDraft.folderName = result.dirName;
  configDraft.hasFolder = true;
  if (els.pickedFolder) {
    els.pickedFolder.textContent = result.dirName;
    els.pickedFolder.classList.remove('empty');
  }
  showConfigPreview('info', 'Folder picked. Confirm the filename and click Save.');
  setConfigSaveButtonState();
}

async function onConfigSave() {
  if (currentTabId == null || isLiveActive() || savingInFlight) return;
  if (!configDraft.hasFolder) {
    showConfigPreview('error', 'Pick a folder first.');
    return;
  }
  const filename = (els.configFilename?.value || '').trim();
  if (!filename) {
    showConfigPreview('error', 'Filename is empty.');
    return;
  }
  savingInFlight = true;
  setConfigSaveButtonState();

  let result;
  try {
    // handle is passed as null — the content script reads pendingDirHandle
    // (set by the MAIN-world postMessage relay) instead.
    result = await sendToContentScript(currentTabId, 'configureLiveExport', { handle: null, filename });
  } catch (e) {
    savingInFlight = false;
    showConfigPreview('error', `Save failed: ${e?.message || 'tab gone'}.`);
    setConfigSaveButtonState();
    return;
  }

  savingInFlight = false;
  setConfigSaveButtonState();

  if (!result) {
    showConfigPreview('error', 'Save returned no result.');
    return;
  }
  if (!result.ok) {
    showConfigPreview('error', result.message || 'Save failed.');
    return;
  }

  setConfigureVisible(false);
  await refreshStatus();
}

function onConfigCancel() {
  clearConfigPreview();
  setConfigureVisible(false);
}

async function onClearConfig() {
  if (currentTabId == null) return;
  if (!confirm('Clear the saved folder and filename for this campaign?')) return;
  let result;
  try {
    result = await sendToContentScript(currentTabId, 'clearConfig');
  } catch (e) {
    showConfigPreview('error', `Couldn't clear configuration: ${e?.message || 'reload the Voyage tab.'}`);
    return;
  }
  if (result && !result.ok) {
    showConfigPreview('error', result.message || 'Clear failed.');
    return;
  }
  configDraft.hasFolder = false;
  configDraft.folderName = null;
  if (els.pickedFolder) {
    els.pickedFolder.textContent = 'No folder picked yet';
    els.pickedFolder.classList.add('empty');
  }
  setConfigureVisible(false);
  await refreshStatus();
}

function openConfigureSection() {
  if (currentTabId == null) return;
  clearConfigPreview();

  // Pre-fill from current status
  if (els.configFilename) {
    els.configFilename.value =
      currentStatus?.configFilename ||
      currentStatus?.suggestedFilename ||
      'voyage-story.md';
  }

  // Pre-fill folder display: prefer saved config, then any pending pick
  const folderName = currentStatus?.configFolderName || currentStatus?.pendingDirName || null;
  if (folderName) {
    configDraft.folderName = folderName;
    configDraft.hasFolder = true;
    if (els.pickedFolder) {
      els.pickedFolder.textContent = folderName;
      els.pickedFolder.classList.remove('empty');
    }
  } else {
    configDraft.folderName = null;
    configDraft.hasFolder = false;
    if (els.pickedFolder) {
      els.pickedFolder.textContent = 'No folder picked yet';
      els.pickedFolder.classList.add('empty');
    }
  }

  applyConfigureLockState();
  setConfigSaveButtonState();
  setConfigureVisible(true);
}

function applyConfigureLockState() {
  const liveActive = isLiveActive();
  if (els.lockTip) els.lockTip.hidden = !liveActive;
  if (els.pickFolderBtn) els.pickFolderBtn.disabled = liveActive;
  if (els.markersInput) els.markersInput.disabled = liveActive;
  if (els.markersLabel) {
    els.markersLabel.textContent = liveActive
      ? 'Live export resume markers (required while live export is active)'
      : 'Live export resume markers (hidden comments needed to resume existing story documents.)';
  }
  if (els.clearConfig) els.clearConfig.hidden = !currentStatus?.hasConfig;
}

// ---------- Main action handlers ----------
function hideActions() {
  if (els.exportRow)       els.exportRow.hidden = true;
  if (els.liveBtn)         els.liveBtn.hidden = true;
  if (els.tip)             els.tip.hidden = true;
  if (els.filepath)        els.filepath.hidden = true;
  if (els.configureToggle) els.configureToggle.hidden = true;
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
  if (status.syncPhase && !status.liveExport?.active) {
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

  if (els.filepath && els.filename) {
    let displayFolder = null;
    let displayFilename = null;
    if (liveActive) {
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

  if (els.configureToggle) {
    els.configureToggle.hidden = !status.directoryPickerSupported;
    els.configureToggle.disabled = false;
    els.configureToggle.textContent = hasConfig
      ? 'Configure export options…'
      : 'Configure live export…';
  }

  if (els.tip) {
    if (liveActive) {
      els.tip.textContent = 'Turns auto-append while the Voyage tab is open.';
      els.tip.hidden = false;
    } else if (!status.directoryPickerSupported) {
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

  // If configure section is open, keep lock state in sync with live export status.
  if (els.configureSection && !els.configureSection.hidden) {
    applyConfigureLockState();
    setConfigSaveButtonState();
    // If a pending pick landed (postMessage relay), update folder display.
    if (status.pendingDirName && status.pendingDirName !== configDraft.folderName) {
      configDraft.folderName = status.pendingDirName;
      configDraft.hasFolder = true;
      if (els.pickedFolder) {
        els.pickedFolder.textContent = status.pendingDirName;
        els.pickedFolder.classList.remove('empty');
      }
      showConfigPreview('info', 'Folder picked. Confirm the filename and click Save.');
      setConfigSaveButtonState();
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

// ---------- Main action handlers ----------
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
  openConfigureSection();
}

// ---------- Init ----------
async function init() {
  els.status          = document.getElementById('storyStatus');
  els.exportRow       = document.getElementById('storyExportRow');
  els.tip             = document.getElementById('storyTip');
  els.filepath        = document.getElementById('storyFilepath');
  els.filename        = document.getElementById('storyFilename');
  els.currentBtn      = document.getElementById('exportCurrentTurnBtn');
  els.wholeBtn        = document.getElementById('exportWholeStoryBtn');
  els.liveBtn         = document.getElementById('liveExportBtn');
  els.configureToggle = document.getElementById('configureToggleBtn');
  // Configure section
  els.configureSection = document.getElementById('configureSection');
  els.lockTip          = document.getElementById('lockTip');
  els.pickFolderBtn    = document.getElementById('pickFolderBtn');
  els.pickedFolder     = document.getElementById('pickedFolderDisplay');
  els.configFilename   = document.getElementById('configFilename');
  els.configPreview    = document.getElementById('configResolvePreview');
  els.configSaveBtn    = document.getElementById('configSaveBtn');
  els.configCancelBtn  = document.getElementById('configCancelBtn');
  els.clearConfig      = document.getElementById('clearConfigLink');
  els.markersInput     = document.getElementById('storyIncludeMarkers');
  els.markersLabel     = document.getElementById('storyIncludeMarkersLabel');

  bindToggles([...MAIN_TOGGLES, ...STORY_CONFIG]);

  els.currentBtn?.addEventListener('click', onExportCurrentTurn);
  els.wholeBtn?.addEventListener('click', onExportWholeStory);
  els.liveBtn?.addEventListener('click', onLiveExportClick);
  els.configureToggle?.addEventListener('click', openConfigureSection);

  els.pickFolderBtn?.addEventListener('click', onPickFolderClick);
  els.configSaveBtn?.addEventListener('click', onConfigSave);
  els.configCancelBtn?.addEventListener('click', onConfigCancel);
  els.clearConfig?.addEventListener('click', onClearConfig);
  els.configFilename?.addEventListener('input', setConfigSaveButtonState);

  const tab = await getActiveVoyageTab();
  currentTabId = tab?.id ?? null;
  await refreshStatus();
  if (currentTabId != null) startPolling();
}

window.addEventListener('unload', stopPolling);
init();
