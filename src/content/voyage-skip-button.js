/*
 * Voyage Helper — Skip All button (MAIN world)
 *
 * Adds a "Skip All" button inline next to the dialogue's existing
 * "Press space to skip" prompt whenever the dialogue queue is blocking
 * input. Clicking the button dispatches synthetic spacebar keydown events
 * at ~80ms intervals until the queue is exhausted (skip prompt no longer
 * visible) or the visible narrative text stops changing for 3 consecutive
 * presses (safety net in case the prompt detector misfires).
 *
 * Why synthetic keydowns rather than direct state mutation:
 *   - The dialogue's queue/index is held in closure scope inside minified
 *     React components — not exposed via window globals, accessible Context
 *     providers, or hook dispatchers we could find. Walking the fiber tree
 *     surfaces only effect/memo state, no useState setters.
 *   - Dispatching to the page's existing handler ensures all side effects
 *     fire correctly (focus management, audio cleanup, the eventual swap to
 *     "input mode"). Setting an internal index directly would likely leave
 *     side effects half-applied.
 *   - Resilient to Voyage's internal changes — as long as they keep a
 *     spacebar handler, the button keeps working.
 *
 * Gated by data-voyage-skip-button="on" on <html>. Settings-controller.js
 * sets the attribute from the popup toggle.
 */

(() => {
  const BUTTON_ID = 'voyage-helper-skip-all-button';
  const STEP_MS = 80;
  const MAX_STEPS = 200;

  const findVisibleSkipPrompt = () => {
    // Look for the leaf text node containing "Press space to skip"
    const all = document.querySelectorAll('p, span, div');
    for (const el of all) {
      if (el.children.length > 0) continue;
      const text = el.textContent || '';
      if (!/press\s+space\s+to\s+skip/i.test(text)) continue;
      // Must be visible in the viewport
      const r = el.getBoundingClientRect();
      if (r.width < 5 || r.height < 5) continue;
      if (r.bottom < 0 || r.top > window.innerHeight) continue;
      return el;
    }
    return null;
  };

  const findDialogueContainer = (skipEl) => {
    let d = skipEl;
    for (let i = 0; i < 10 && d.parentElement; i++) {
      d = d.parentElement;
      if (d.getBoundingClientRect().height > 100) return d;
    }
    return d;
  };

  const getCurrentNarrativeText = (dialogue) => {
    const candidates = dialogue.querySelectorAll('p, [class*="Paragraph"], [class*="Text"]');
    for (const el of candidates) {
      const t = el.textContent || '';
      if (t.length > 30 && !/press\s+space|skip/i.test(t)) return t;
    }
    return '';
  };

  const fireSpace = () => {
    const init = {
      key: ' ',
      code: 'Space',
      keyCode: 32,
      which: 32,
      bubbles: true,
      cancelable: true,
    };
    document.dispatchEvent(new KeyboardEvent('keydown', init));
    window.dispatchEvent(new KeyboardEvent('keydown', init));
    if (document.body) document.body.dispatchEvent(new KeyboardEvent('keydown', init));
  };

  let isSkipping = false;
  const skipAll = async (button) => {
    if (isSkipping) return;
    isSkipping = true;
    button.textContent = 'Skipping…';
    button.disabled = true;
    button.style.opacity = '0.7';
    button.style.cursor = 'wait';

    let lastText = '';
    let stuckCount = 0;
    for (let i = 0; i < MAX_STEPS; i++) {
      const skip = findVisibleSkipPrompt();
      if (!skip) break;
      const dialogue = findDialogueContainer(skip);
      const text = getCurrentNarrativeText(dialogue);

      fireSpace();
      await new Promise((r) => setTimeout(r, STEP_MS));

      if (text && text === lastText) {
        stuckCount++;
        if (stuckCount >= 3) break;
      } else if (text) {
        lastText = text;
        stuckCount = 0;
      }
    }

    isSkipping = false;
    button.textContent = '⏭ Skip All';
    button.disabled = false;
    button.style.opacity = '1';
    button.style.cursor = 'pointer';
  };

  const createButton = () => {
    const btn = document.createElement('button');
    btn.id = BUTTON_ID;
    btn.type = 'button';
    btn.textContent = '⏭ Skip All';
    Object.assign(btn.style, {
      // Absolutely positioned within the skip-prompt's parent (which uses
      // position: relative via Tamagui's _pos-relative class). The vertical
      // `top` is computed in alignButtonToSkipPrompt() so the button's
      // center matches the skip-text's center — sitting on the same row,
      // not pinned to a corner.
      position: 'absolute',
      right: '16px',
      // Compact sizing so it sits comfortably alongside the prompt
      padding: '4px 12px',
      backgroundColor: '#FFD540',
      color: '#181a20',
      border: 'none',
      borderRadius: '4px',
      cursor: 'pointer',
      fontWeight: '600',
      fontSize: '11px',
      lineHeight: '1.4',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      letterSpacing: '0.3px',
      boxShadow: '0 1px 3px rgba(0, 0, 0, 0.4)',
      // Make sure it isn't styled away by Tamagui's resets
      textTransform: 'none',
      pointerEvents: 'auto',
      // High z-index in case it overlaps anything weird
      zIndex: '2147483600',
    });
    btn.addEventListener('mouseenter', () => {
      if (!btn.disabled) btn.style.backgroundColor = '#FFE066';
    });
    btn.addEventListener('mouseleave', () => {
      if (!btn.disabled) btn.style.backgroundColor = '#FFD540';
    });
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      skipAll(btn);
    });
    // Also stop propagation on mousedown/mouseup so clicking the button
    // doesn't get routed as a "click anywhere on the dialogue to advance"
    ['mousedown', 'mouseup'].forEach((evt) => {
      btn.addEventListener(evt, (e) => e.stopPropagation());
    });
    return btn;
  };

  const alignButtonToSkipPrompt = (btn, skip) => {
    // Center the button vertically on the skip text's vertical center,
    // measured relative to the parent (which is our positioned ancestor).
    const skipR = skip.getBoundingClientRect();
    const parentR = skip.parentElement.getBoundingClientRect();
    const centerFromParentTop =
      skipR.top + skipR.height / 2 - parentR.top;
    btn.style.top = `${Math.round(centerFromParentTop - btn.offsetHeight / 2)}px`;
  };

  const ensureButtonState = () => {
    const enabled =
      document.documentElement?.dataset?.voyageSkipButton === 'on';
    let btn = document.getElementById(BUTTON_ID);

    if (!enabled) {
      if (btn) btn.remove();
      return;
    }

    const skip = findVisibleSkipPrompt();
    if (!skip) {
      if (btn) btn.remove();
      return;
    }

    const parent = skip.parentElement;
    if (!parent) return;

    // If the button got orphaned (e.g., React re-rendered the dialogue) or
    // attached somewhere stale, reattach it next to the current skip text.
    if (btn && btn.parentElement !== parent) {
      btn.remove();
      btn = null;
    }

    if (!btn) {
      btn = createButton();
      // Append to the skip-prompt's parent (which has position: relative
      // via Tamagui's _pos-relative class). The button uses position:
      // absolute, so its position in the children list doesn't matter.
      parent.appendChild(btn);
    }

    // Re-align on every poll so the button stays on the skip text's row
    // even if the dialogue resizes (window resize, sidebar toggle, etc.).
    alignButtonToSkipPrompt(btn, skip);
  };

  // Poll for dialogue presence + setting changes on a slow interval.
  // 500ms is fine — if React clobbers the button we'll re-add it within
  // half a second, and the cost of each check is just a querySelectorAll
  // and an attribute read.
  setInterval(ensureButtonState, 500);

  // React to data-attribute changes on <html> immediately (toggle in popup).
  const attrObserver = new MutationObserver(ensureButtonState);
  if (document.documentElement) {
    attrObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-voyage-skip-button'],
    });
  }

  // Initial check (document_start may run before <body> exists, so wait
  // briefly if needed).
  if (document.body) ensureButtonState();
  else document.addEventListener('DOMContentLoaded', ensureButtonState);
})();
