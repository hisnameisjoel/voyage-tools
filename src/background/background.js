/*
 * Voyage Tools — Background service worker
 *
 * Manages the per-tab "live export is recording" indicator on the action
 * icon. Content scripts (which can't call chrome.action.*) send messages
 * here when live export starts, stops, or resumes.
 *
 * Why not chrome.action.setBadgeText? The badge widget has a fixed minimum
 * width — even with text color = background color, it renders as a
 * disproportionately large pill. Instead we overlay a small yellow dot
 * onto the icon itself by rendering each size into an OffscreenCanvas and
 * passing the resulting ImageData to setIcon. Visually that's a true small
 * circle in the corner of the icon, not a separate badge.
 *
 * Messages handled (msg.source === 'voyage-story'):
 *   action: 'badge:set'    → draw yellow-dot overlay for sender.tab.id
 *   action: 'badge:clear'  → restore default icon for sender.tab.id
 */

const NAMESPACE = 'voyage-story';
const DOT_COLOR = '#ffd540'; // matches the popup's "live active" yellow
const ICON_SIZES = [16, 32, 48];
const ICON_PATHS = {
  16: 'icon-16.png',
  32: 'icon-32.png',
  48: 'icon-48.png',
};

// Lazy-loaded base icons (ImageBitmap per size). Service workers can be
// terminated and restarted at any time, so the cache lives only for the
// SW's lifetime — that's fine, refetch is essentially free.
let cachedBaseIcons = null;
async function loadBaseIcons() {
  if (cachedBaseIcons) return cachedBaseIcons;
  const out = {};
  for (const size of ICON_SIZES) {
    const url = chrome.runtime.getURL(ICON_PATHS[size]);
    const blob = await (await fetch(url)).blob();
    out[size] = await createImageBitmap(blob);
  }
  cachedBaseIcons = out;
  return out;
}

async function setBadge(tabId) {
  if (tabId == null) return;
  try {
    const bases = await loadBaseIcons();
    const imageData = {};
    for (const size of ICON_SIZES) {
      const canvas = new OffscreenCanvas(size, size);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bases[size], 0, 0, size, size);
      // Top-right corner. Dot is sized as a fraction of the icon so it
      // scales correctly at every density; ~22% gives a clearly visible
      // mark without obscuring the icon glyph below.
      const radius = Math.max(2, Math.round(size * 0.22));
      const cx = size - radius - Math.max(1, Math.round(size * 0.05));
      const cy = radius + Math.max(1, Math.round(size * 0.05));
      // Thin dark ring underneath gives contrast against the icon's
      // background regardless of theme.
      ctx.fillStyle = '#181a20';
      ctx.beginPath();
      ctx.arc(cx, cy, radius + 1, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = DOT_COLOR;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.fill();
      imageData[size] = ctx.getImageData(0, 0, size, size);
    }
    await chrome.action.setIcon({ imageData, tabId });
    // Defensive cleanup if a prior version of the extension left a text
    // badge in place. Safe no-op when no badge is set.
    chrome.action.setBadgeText({ text: '', tabId });
  } catch (e) {
    console.warn('[voyage-bg] setBadge failed:', e);
  }
}

async function clearBadge(tabId) {
  if (tabId == null) return;
  try {
    await chrome.action.setIcon({ path: ICON_PATHS, tabId });
    chrome.action.setBadgeText({ text: '', tabId });
  } catch (e) {
    console.warn('[voyage-bg] clearBadge failed:', e);
  }
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.source !== NAMESPACE) return;
  const tabId = sender.tab?.id;
  if (msg.action === 'badge:set')   setBadge(tabId);
  if (msg.action === 'badge:clear') clearBadge(tabId);
});

// Stale-icon cleanup on navigation: when the user navigates away from
// beta.voyage.io within the same tab, the content script tears down and
// can't send badge:clear itself. Watch URL changes and reset.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (!info.url) return;
  if (!/^https:\/\/beta\.voyage\.io\//.test(info.url)) {
    clearBadge(tabId);
  }
});
