import { useLayoutEffect, useRef } from 'react';

export type TipRow = { color: string; name: string; value: string };

// Value readout beside (x, y), right of it unless that overflows, so it never covers the marks it describes.
export function Tip({ at, title, rows }: { at: { x: number; y: number } | null; title: string; rows: TipRow[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const box = el?.parentElement;
    if (!el || !box || !at) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const x = at.x + 14 + w <= box.clientWidth - 4 ? at.x + 14 : Math.max(4, at.x - 14 - w);
    const y = Math.min(Math.max(2, at.y - h / 2), box.clientHeight - h - 2);
    el.style.transform = `translate(${Math.round(x)}px,${Math.round(y)}px)`;
  });
  return (
    <div ref={ref} className="ub-tip" role="status" hidden={!at}>
      {at && (
        <>
          <div className="ub-tip-t">{title}</div>
          {rows.map((r, i) => (
            <div key={i} className="ub-tip-r">
              <i style={{ background: r.color }}></i>
              <b>{r.value}</b>
              {r.name && <span>{r.name}</span>}
            </div>
          ))}
        </>
      )}
    </div>
  );
}
