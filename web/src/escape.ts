// Views waiting for Esc, newest last; one shared window listener serves them all.
const escapes: (() => void)[] = [];

// Engines without :popover-open throw on the full selector; they only have dialogs to check.
let overlaySel = ':popover-open, dialog[open]';
export function overlayOpen() {
  try {
    return !!document.querySelector(overlaySel);
  } catch {
    overlaySel = 'dialog[open]';
    return !!document.querySelector(overlaySel);
  }
}

function onEscape(e: KeyboardEvent) {
  const top = escapes.at(-1);
  if (!top || e.key !== 'Escape' || overlayOpen()) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  top();
}

// Puts `fn` on top of the Esc stack; the returned function takes it off.
export function pushEscape(fn: () => void) {
  if (!escapes.length) window.addEventListener('keydown', onEscape, true);
  escapes.push(fn);
  return () => {
    const i = escapes.indexOf(fn);
    if (i >= 0) escapes.splice(i, 1);
    if (!escapes.length) window.removeEventListener('keydown', onEscape, true);
  };
}
