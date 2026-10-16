import { flushSync } from 'react-dom';
import { useStore } from './store.ts';

// The conversation mounts only its newest rows; code that targets an older row mounts it through here first.
type Bridge = { mountFrom: (index: number) => void; release: () => void };
let bridge: Bridge | null = null;

export function bindWindow(b: Bridge) {
  bridge = b;
  return () => {
    if (bridge === b) bridge = null;
  };
}

// Stops following the bottom for a scroll the code is about to make.
export function release() {
  bridge?.release();
}

// After the next frame has laid out, so rows just mounted have their place (and the browser's scroll anchoring has run).
export function afterFrames(fn: () => void) {
  requestAnimationFrame(() => requestAnimationFrame(fn));
}

// Mounts every row, for searches over the rendered text.
export function showAll() {
  if (bridge) flushSync(() => bridge!.mountFrom(0));
}

// Mounts the row holding `id` (a row, or a tool inside a group) and lets go of the bottom; false when it is not in the conversation.
export function showRow(id: string) {
  const s = useStore.getState();
  const item = s.items[id];
  let i = s.order.lastIndexOf(id);
  if (i < 0 && item?.kind === 'tool' && item.group) i = s.order.lastIndexOf(item.group);
  if (i < 0 || !bridge) return false;
  bridge.release();
  flushSync(() => bridge!.mountFrom(i));
  return true;
}
