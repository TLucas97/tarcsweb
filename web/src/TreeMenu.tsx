import { useEffect, useLayoutEffect, useRef, useState } from 'react';

export type MenuItem = { label: string; run: () => void };
export type MenuAt = { x: number; y: number; kbd: boolean };

// The pick blinks (off, then on) before the menu closes, so the choice reads as confirmed.
const BLINK_MS = 160;

// A right-click menu: opens at the pointer with no entrance; arrows, Enter and Esc work, outside clicks close it.
export function TreeMenu({ at, caption, items, onClose }: { at: MenuAt; caption?: string; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(at.kbd ? 0 : -1);
  const [picked, setPicked] = useState(-1);
  const [pos, setPos] = useState({ left: at.x, top: at.y });
  const live = useRef({ active, picked, onClose, items });
  useLayoutEffect(() => {
    live.current = { active, picked, onClose, items };
  });

  // Flips to the other side of the pointer when it would leave the window.
  useLayoutEffect(() => {
    const r = ref.current!.getBoundingClientRect();
    const left = at.x + r.width > innerWidth - 8 ? Math.max(8, at.x - r.width) : at.x;
    const top = at.y + r.height > innerHeight - 8 ? Math.max(8, at.y - r.height) : at.y;
    setPos({ left, top });
  }, [at]);

  useEffect(() => {
    const back = document.activeElement;
    ref.current!.focus({ preventScroll: true });
    return () => {
      if (back instanceof HTMLElement && back.isConnected && (!document.activeElement || document.activeElement === document.body)) back.focus({ preventScroll: true });
    };
  }, []);

  const pick = (i: number) => {
    if (live.current.picked >= 0 || i < 0) return;
    live.current.picked = i;
    setActive(i);
    setPicked(i);
    window.setTimeout(() => {
      const { items: list, onClose: close } = live.current;
      close();
      list[i]?.run();
    }, BLINK_MS);
  };

  useEffect(() => {
    const close = () => live.current.picked < 0 && live.current.onClose();
    // Window capture runs before the focus view's own Esc handler, so Esc only closes the menu.
    const onKey = (e: KeyboardEvent) => {
      const { active: a, picked: p, items: list } = live.current;
      const n = list.length;
      const keys: Record<string, () => void> = {
        Escape: close,
        Tab: close,
        ArrowDown: () => setActive((a + 1) % n),
        ArrowUp: () => setActive(a <= 0 ? n - 1 : a - 1),
        Home: () => setActive(0),
        End: () => setActive(n - 1),
        Enter: () => pick(a),
        ' ': () => pick(a),
      };
      const run = keys[e.key];
      if (!run) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (p < 0) run();
    };
    const onDown = (e: PointerEvent) => {
      if (!ref.current!.contains(e.target as Node)) close();
    };
    const onScroll = (e: Event) => {
      if (!ref.current!.contains(e.target as Node)) close();
    };
    addEventListener('keydown', onKey, true);
    addEventListener('pointerdown', onDown, true);
    addEventListener('scroll', onScroll, true);
    addEventListener('resize', close);
    addEventListener('blur', close);
    return () => {
      removeEventListener('keydown', onKey, true);
      removeEventListener('pointerdown', onDown, true);
      removeEventListener('scroll', onScroll, true);
      removeEventListener('resize', close);
      removeEventListener('blur', close);
    };
  }, []);

  return (
    <div
      ref={ref} className="ft-menu" role="menu" tabIndex={-1} aria-label={caption ?? 'Actions'} style={pos}
      aria-activedescendant={active >= 0 ? `ft-mi-${active}` : undefined}
      onContextMenu={(e) => e.preventDefault()}
      onPointerLeave={() => picked < 0 && setActive(-1)}
    >
      {caption && <div className="ft-mcap mono" title={caption}>{caption}</div>}
      {items.map((it, i) => (
        <div
          key={it.label} id={`ft-mi-${i}`} role="menuitem"
          className={`ft-mi${i === active ? ' on' : ''}${i === picked ? ' pick' : ''}`}
          onPointerMove={() => picked < 0 && active !== i && setActive(i)}
          onClick={() => pick(i)}
        >
          {it.label}
        </div>
      ))}
    </div>
  );
}
