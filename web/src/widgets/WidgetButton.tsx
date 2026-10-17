import type { MouseEvent } from 'react';
import { WIDGET_MAX, useWidgets, widgetFor } from './state.ts';

export const WidgetIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="1.8" y="2.4" width="10.4" height="9.2" rx="2.2" /><path d="M4.4 5.4h5.2M4.4 7.6h3" /></svg>
);

// Opens a session as a floating widget from a list row; a closed one is reopened first. Hidden once it is one.
export function WidgetButton({ id, open, className, onDone }: { id: string; open: boolean; className?: string; onDone?: () => void }) {
  const has = useWidgets((w) => w.list.some((x) => x.id === id));
  const full = useWidgets((w) => w.list.length >= WIDGET_MAX);
  if (has) return null;
  const click = (e: MouseEvent) => {
    e.stopPropagation();
    widgetFor(id, open);
    onDone?.();
  };
  return (
    <button type="button" tabIndex={-1} className={className} aria-label="Open as widget" title={full ? `Up to ${WIDGET_MAX} widgets` : 'Open as widget'} disabled={full} onClick={click}>
      <WidgetIcon />
    </button>
  );
}
