import { useStore } from './store.ts';

// First-guess thresholds. A 20 s window is bad when it is busy, blocks the main thread for long and has several long frames.
const T = {
  warmupMs: 20_000, windowMs: 20_000, settleMs: 5_000, inputMs: 3_000,
  blockingMs: 2_000, longFrameMs: 100, longFrames: 5,
  badWindows: 2, ofLast: 3, withinMs: 5 * 60_000,
};

type Frame = PerformanceEntry & { blockingDuration?: number };

// Watches long frames while the user is busy; calls onStutter when two of the last three busy windows were bad.
// Holds only counters. Returns the stop function.
export function watchLag(onStutter: () => void): () => void {
  const types = PerformanceObserver.supportedEntryTypes ?? [];
  const type = types.includes('long-animation-frame') ? 'long-animation-frame' : types.includes('longtask') ? 'longtask' : null;
  if (!type) return () => {};
  const blockOf = (e: Frame) => (type === 'long-animation-frame' ? (e.blockingDuration ?? 0) : Math.max(0, e.duration - 50));

  // Window start on the performance clock; Infinity while the tab is hidden.
  let from = Infinity;
  let blocking = 0;
  let long = 0;
  let active = false;
  let lastInput = 0;
  let timer = 0;
  const history: { at: number; bad: boolean }[] = [];

  const busy = () => useStore.getState().status === 'working' || performance.now() - lastInput < T.inputMs;

  const begin = (delayMs: number) => {
    clearTimeout(timer);
    from = performance.now() + delayMs;
    blocking = 0;
    long = 0;
    active = false;
    timer = window.setTimeout(close, delayMs + T.windowMs);
  };

  function close() {
    if (busy()) active = true;
    if (active) {
      history.push({ at: Date.now(), bad: blocking >= T.blockingMs && long >= T.longFrames });
      if (history.length > T.ofLast) history.shift();
      const recent = history.filter((h) => h.bad && Date.now() - h.at <= T.withinMs);
      if (recent.length >= T.badWindows) return onStutter();
    }
    begin(0);
  }

  const observer = new PerformanceObserver((list) => {
    for (const e of list.getEntries() as Frame[]) {
      if (e.startTime < from) continue;
      const b = blockOf(e);
      blocking += b;
      if (b >= T.longFrameMs) long++;
      if (!active && busy()) active = true;
    }
  });

  const onInput = () => {
    lastInput = performance.now();
    if (lastInput >= from) active = true;
  };
  const onVisibility = () => {
    if (document.hidden) {
      clearTimeout(timer);
      from = Infinity;
    } else begin(T.settleMs);
  };

  const input = ['scroll', 'wheel', 'keydown', 'pointerdown'] as const;
  for (const name of input) document.addEventListener(name, onInput, { capture: true, passive: true });
  document.addEventListener('visibilitychange', onVisibility);
  observer.observe({ type, buffered: false });
  if (document.hidden) onVisibility();
  else begin(Math.max(0, T.warmupMs - performance.now()));

  return () => {
    observer.disconnect();
    clearTimeout(timer);
    for (const name of input) document.removeEventListener(name, onInput, { capture: true });
    document.removeEventListener('visibilitychange', onVisibility);
  };
}
