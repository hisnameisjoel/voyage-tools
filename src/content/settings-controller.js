/*
 * Voyage Tools — Settings Controller
 *
 * Bridges the extension popup's chrome.storage settings to the page by
 * setting data-* attributes on <html>. Other content scripts (CSS rules,
 * MAIN-world JS) gate their behavior off these attributes, so toggles in
 * the popup take effect live without a page reload.
 *
 * User-facing toggles:
 *   perfFix     -- Performance fix. Drives BOTH the CSS layer and the
 *                  getComputedStyle cache; the two are exposed as a single
 *                  toggle in the popup because users shouldn't have to
 *                  reason about which sub-mechanism does what.
 *   skipButton  -- Skip All button on each turn's dialogue queue.
 *
 * The Story Exporter feature has no toggle — its UI lives entirely in the
 * popup, only appears when you're on a Voyage tab, and only collects data
 * passively from the websocket. No page-side gating is needed.
 *
 * Attributes set on <html>:
 *   data-voyage-perf-css     -- "on" when the perf fix is enabled
 *   data-voyage-gcs-cache    -- "on" when the perf fix is enabled
 *   data-voyage-skip-button  -- "on" when the skip button is enabled
 */

const KEYS = ['perfFix', 'skipButton'];

const setDataAttr = (name, on) => {
  const root = document.documentElement;
  if (on) root.dataset[name] = 'on';
  else delete root.dataset[name];
};

const applySettings = (result) => {
  const perfOn  = result.perfFix    !== false; // default to enabled
  const skipOn  = result.skipButton !== false;
  setDataAttr('voyagePerfCss', perfOn);
  setDataAttr('voyageGcsCache', perfOn);
  setDataAttr('voyageSkipButton', skipOn);
};

chrome.storage.local.get(KEYS, applySettings);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (!Object.keys(changes).some((k) => KEYS.includes(k))) return;
  chrome.storage.local.get(KEYS, applySettings);
});
