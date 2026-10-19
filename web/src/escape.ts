// Views waiting for Esc, newest last; one shared window listener serves them all.
const escapes: (() => void)[] = [];

function onEscape(e: KeyboardEvent) {
  const top = escapes.at(-1);
  if (!top || e.key !== 'Escape' || document.querySelector(':popover-open, dialog[open]')) return;
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
