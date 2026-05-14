/*
 * Voyage Tools — Configure window (chrome.windows.create popup)
 *
 * Runs in a separate extension window opened by the main popup. Survives the
 * blur-on-OS-picker that closes the main popup, so the folder-picker → save
 * flow runs to completion without losing state.
 *
 * Receives the Voyage tab id via location.hash (#tabId=N). All chrome.scripting
 * injections target that tab; the directory handle never crosses a structured-
 * clone boundary — it stashes on the Voyage tab's isolated-world window
 * (`__voyageStoryPendingDir`) and `commitConfiguration` hands it to
 * `__voyageStoryHelper.configureLiveExport`.
 */

const NAMESPACE = 'voyage-story';

// ---------- Settings persistence (only the storyInclude* keys live here) ----------
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

// ---------- Tab discovery ----------
function readTabIdFromHash() {
  const m = (location.hash || '').match(/tabId=(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}
const tabId = readTabIdFromHash();

// ---------- Element refs ----------
const els = {
  lockTip:        null,
  pickFolderBtn:  null,
  pickedFolder:   null,
  configFilename: null,
  configPreview:  null,
  configSaveBtn:  null,
  configCancelBtn:null,
  clearConfig:    null,
  tabGoneBanner:  null,
  markersLabel:   null,
  markersInput:   null,
};

// ---------- Per-visit state ----------
let configDraft = {
  folderName: null,    // most recently picked or restored folder name
  hasFolder: false,    // can Save commit? (i.e. is a directoryHandle reachable)
};
let pollingTimer = null;
let lastStatus = null;
let tabIsGone = false;

// ---------- Status helper ----------
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

// ---------- Tab health ----------
function markTabGone(reason) {
  if (tabIsGone) return;
  tabIsGone = true;
  if (els.tabGoneBanner) els.tabGoneBanner.hidden = false;
  // Disable everything that depends on the Voyage tab. Toggles stay
  // editable — chrome.storage.local is shared across extension contexts and
  // doesn't require the tab.
  if (els.pickFolderBtn)  els.pickFolderBtn.disabled = true;
  if (els.configSaveBtn)  els.configSaveBtn.disabled = true;
  if (els.clearConfig)    els.clearConfig.disabled = true;
  if (reason) showConfigPreview('error', reason);
}

// ---------- Pending-folder recovery ----------
// If a prior configure window picked a folder and the user closed it before
// saving, the directoryHandle is still on the Voyage tab's isolated-world
// window. Read its `.name` so we can restore the "Folder picked: …" display.
async function recoverPendingFolder() {
  if (!tabId) return null;
  try {
    const arr = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      func: () => {
        const h = window.__voyageStoryPendingDir;
        return h && typeof h.name === 'string' ? h.name : null;
      },
    });
    return arr?.[0]?.result || null;
  } catch (e) {
    markTabGone(`The Voyage tab is no longer available (${e?.message || 'unknown error'}).`);
    return null;
  }
}

// Clears the stashed handle on the Voyage tab. Safe to call after Save (the
// handle is in IDB now) or Cancel (user discarded the pick).
async function clearPendingFolder() {
  if (!tabId) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      func: () => { window.__voyageStoryPendingDir = null; },
    });
  } catch {}
}

// ---------- Pick / commit injections (run in the Voyage tab's isolated world) ----------
async function pickFolderInPage() {
  if (typeof window.showDirectoryPicker !== 'function') {
    return { ok: false, message: 'Live export needs Chrome/Edge with File System Access support.' };
  }
  let handle;
  try {
    handle = await window.showDirectoryPicker({ mode: 'readwrite' });
  } catch (e) {
    if (e?.name === 'AbortError') return { ok: false, aborted: true };
    return { ok: false, message: 'Folder picker error: ' + (e?.message || e?.name || 'unknown error') };
  }
  window.__voyageStoryPendingDir = handle;
  return { ok: true, folderName: handle.name };
}

async function commitConfiguration(filename) {
  if (!window.__voyageStoryHelper || typeof window.__voyageStoryHelper.configureLiveExport !== 'function') {
    return { ok: false, message: 'Story exporter not ready — reload the Voyage tab and try again.' };
  }
  const handle = window.__voyageStoryPendingDir || null;
  const result = await window.__voyageStoryHelper.configureLiveExport(handle, filename);
  window.__voyageStoryPendingDir = null;
  return result;
}

// ---------- Action handlers ----------
async function ensureScriptingPermission() {
  try {
    return await chrome.permissions.request({ permissions: ['scripting'] });
  } catch (e) {
    console.error('[voyage configure] permission request failed', e);
    return false;
  }
}

function setConfigSaveButtonState() {
  if (!els.configSaveBtn) return;
  const filenameNonEmpty = !!(els.configFilename?.value || '').trim();
  els.configSaveBtn.disabled = !(configDraft.hasFolder && filenameNonEmpty) || tabIsGone || isLiveActive();
}

function isLiveActive() {
  return !!lastStatus?.liveExport?.active;
}

async function onPickFolderClick() {
  if (tabIsGone || isLiveActive()) return;
  clearConfigPreview();
  const granted = await ensureScriptingPermission();
  if (!granted) {
    showConfigPreview('error', 'The "scripting" permission is required to open the folder picker on the Voyage tab.');
    return;
  }
  let result;
  try {
    const arr = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      func: pickFolderInPage,
    });
    result = arr?.[0]?.result;
  } catch (e) {
    markTabGone(`Folder picker failed: ${e?.message || 'tab gone'}.`);
    return;
  }
  if (!result) {
    showConfigPreview('error', 'Folder picker returned no result.');
    return;
  }
  if (!result.ok) {
    if (result.aborted) return;
    showConfigPreview('error', result.message || 'Folder picker failed.');
    return;
  }
  configDraft.folderName = result.folderName;
  configDraft.hasFolder = true;
  if (els.pickedFolder) {
    els.pickedFolder.textContent = result.folderName;
    els.pickedFolder.classList.remove('empty');
  }
  showConfigPreview('info', 'Folder picked. Confirm the filename and click Save.');
  setConfigSaveButtonState();
}

async function onConfigSave() {
  if (tabIsGone || isLiveActive()) return;
  if (!configDraft.hasFolder) {
    showConfigPreview('error', 'Pick a folder first.');
    return;
  }
  const filename = (els.configFilename?.value || '').trim();
  if (!filename) {
    showConfigPreview('error', 'Filename is empty.');
    return;
  }
  els.configSaveBtn.disabled = true;
  let result;
  try {
    const arr = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      func: commitConfiguration,
      args: [filename],
    });
    result = arr?.[0]?.result;
  } catch (e) {
    markTabGone(`Save failed: ${e?.message || 'tab gone'}.`);
    return;
  }
  setConfigSaveButtonState();
  if (!result) {
    showConfigPreview('error', 'Save returned no result.');
    return;
  }
  if (!result.ok) {
    showConfigPreview('error', result.message || 'Save failed.');
    return;
  }
  if (result.created) {
    showConfigPreview('created', `Created new file. Returning to main popup…`);
  } else if (typeof result.parsedTick === 'number') {
    showConfigPreview('info', `Resuming existing export — last turn ${result.parsedTick}. Returning to main popup…`);
  } else {
    showConfigPreview('info', `Configuration saved. Returning to main popup…`);
  }
  // The handle is now in IDB. Clear the page-side pending stash, then close
  // this window so the main popup is the next interaction.
  await clearPendingFolder();
  setTimeout(() => { window.close(); }, 1200);
}

async function onConfigCancel() {
  // Discard any pending folder pick that hadn't been saved. (Toggle changes
  // have already auto-saved to chrome.storage.local — those persist.)
  await clearPendingFolder();
  window.close();
}

async function onClearConfig() {
  if (tabIsGone) return;
  if (!confirm('Clear the saved folder and filename for this campaign?')) return;
  let result;
  try {
    result = await sendToContentScript('clearConfig');
  } catch (e) {
    showConfigPreview('error', `Couldn't clear configuration: ${e?.message || 'reload the Voyage tab.'}`);
    return;
  }
  if (result && !result.ok) {
    showConfigPreview('error', result.message || 'Clear failed.');
    return;
  }
  await clearPendingFolder();
  window.close();
}

// ---------- Message helper (status polling) ----------
async function sendToContentScript(action, extra = {}) {
  if (!tabId) throw new Error('no tabId');
  return await chrome.tabs.sendMessage(tabId, { source: NAMESPACE, action, ...extra });
}

async function refreshStatus() {
  if (!tabId || tabIsGone) return;
  try {
    const resp = await sendToContentScript('getStatus');
    lastStatus = resp;
    applyStatus(resp);
  } catch (e) {
    // Tab closed or content script unavailable.
    markTabGone(`Lost connection to the Voyage tab${e?.message ? `: ${e.message}` : ''}.`);
  }
}

function applyStatus(status) {
  if (!status) return;
  const liveActive = !!status.liveExport?.active;

  // Folder/filename section: lock while live export is running.
  if (els.lockTip) els.lockTip.hidden = !liveActive;
  if (els.pickFolderBtn) els.pickFolderBtn.disabled = liveActive || tabIsGone;
  setConfigSaveButtonState();

  // Resume markers toggle is mandatory while live export is active.
  if (els.markersInput) els.markersInput.disabled = liveActive;
  if (els.markersLabel) {
    els.markersLabel.textContent = liveActive
      ? 'Live export resume markers (required while live export is active)'
      : 'Live export resume markers (hidden comments needed to resume existing story documents.)';
  }

  // Clear-config link visibility tracks whether a config exists.
  if (els.clearConfig) els.clearConfig.hidden = !status.hasConfig;
}

// ---------- Init ----------
async function init() {
  els.lockTip        = document.getElementById('lockTip');
  els.pickFolderBtn  = document.getElementById('pickFolderBtn');
  els.pickedFolder   = document.getElementById('pickedFolderDisplay');
  els.configFilename = document.getElementById('configFilename');
  els.configPreview  = document.getElementById('configResolvePreview');
  els.configSaveBtn  = document.getElementById('configSaveBtn');
  els.configCancelBtn= document.getElementById('configCancelBtn');
  els.clearConfig    = document.getElementById('clearConfigLink');
  els.tabGoneBanner  = document.getElementById('tabGoneBanner');
  els.markersInput   = document.getElementById('storyIncludeMarkers');
  els.markersLabel   = document.getElementById('storyIncludeMarkersLabel');

  bindToggles(STORY_CONFIG);

  els.pickFolderBtn?.addEventListener('click', onPickFolderClick);
  els.configSaveBtn?.addEventListener('click', onConfigSave);
  els.configCancelBtn?.addEventListener('click', onConfigCancel);
  els.clearConfig?.addEventListener('click', onClearConfig);
  els.configFilename?.addEventListener('input', setConfigSaveButtonState);

  if (!tabId) {
    markTabGone('Configure window opened without a Voyage tab reference. Close this window and open it from the popup again.');
    return;
  }

  // Read the current status before any UI decisions. Pre-fill filename and
  // folder display from the existing config (if any) or the recovery slot.
  await refreshStatus();
  if (tabIsGone) return;

  // Filename pre-fill order: saved configFilename → suggestedFilename →
  // generic default. configFilename is the persisted user choice; suggested
  // is the slugified canonical (e.g. voyage-campaign-character.md).
  if (els.configFilename) {
    els.configFilename.value =
      lastStatus?.configFilename ||
      lastStatus?.suggestedFilename ||
      'voyage-story.md';
  }

  // Folder display pre-fill: prefer the persisted config, then any pending
  // pick recovered from the Voyage tab's isolated-world stash.
  if (lastStatus?.configFolderName) {
    configDraft.folderName = lastStatus.configFolderName;
    configDraft.hasFolder = true;
    if (els.pickedFolder) {
      els.pickedFolder.textContent = lastStatus.configFolderName;
      els.pickedFolder.classList.remove('empty');
    }
  } else {
    const pending = await recoverPendingFolder();
    if (pending) {
      configDraft.folderName = pending;
      configDraft.hasFolder = true;
      if (els.pickedFolder) {
        els.pickedFolder.textContent = pending;
        els.pickedFolder.classList.remove('empty');
      }
      showConfigPreview('info', 'Recovered the folder you previously picked. Confirm the filename and click Save.');
    }
  }

  setConfigSaveButtonState();
  pollingTimer = setInterval(refreshStatus, 2000);
}

window.addEventListener('unload', () => {
  if (pollingTimer) clearInterval(pollingTimer);
});

init();
