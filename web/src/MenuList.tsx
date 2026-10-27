import { memo, useEffect, useImperativeHandle, useRef, useState, type MouseEvent, type ReactNode, type Ref } from 'react';

export type MenuApi = { at: () => number; move: (d: number) => void };
type Render = (i: number, selected: boolean) => ReactNode;

const Row = memo(function Row({ i, selected, render }: { i: number; selected: boolean; render: Render }) {
  return render(i, selected);
});

// An option list that owns its highlighted row, so hovering re-renders two rows instead of the composer around it.
// A new reset value puts the highlight back on the first row; render must put data-i on each option.
export function MenuList({ count, reset, api, keyOf, render, children }: {
  count: number; reset: string; api: Ref<MenuApi>; keyOf: (i: number) => string; render: Render; children?: ReactNode;
}) {
  const [hl, setHl] = useState({ i: 0, reset });
  const at = Math.min(hl.reset === reset ? hl.i : 0, Math.max(0, count - 1));
  const listRef = useRef<HTMLDivElement>(null);

  useImperativeHandle(api, () => ({
    at: () => at,
    move: (d) => count && setHl((h) => ({ i: ((h.reset === reset ? Math.min(h.i, count - 1) : 0) + d + count) % count, reset })),
  }), [at, count, reset]);

  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [at, reset]);

  const hover = (e: MouseEvent) => {
    const el = (e.target as Element).closest<HTMLElement>('[data-i]');
    const i = el ? Number(el.dataset.i) : at;
    if (i !== at) setHl({ i, reset });
  };

  return (
    <div className="sl-list" role="listbox" ref={listRef} onMouseMove={hover}>
      {Array.from({ length: count }, (_, i) => <Row key={keyOf(i)} i={i} selected={i === at} render={render} />)}
      {children}
    </div>
  );
}
