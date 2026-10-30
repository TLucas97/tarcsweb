import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import type { ContextCategory, ContextDetail, ContextUsage, LimitKey, LimitWindow } from '../../server/protocol.ts';
import { useStore } from './store.ts';
import { onContextDetail, send } from './socket.ts';
import { Chev } from './bits.tsx';
import { LedGauge } from './led.tsx';
import { Flap } from './flap.tsx';

const tok = (n: number) => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
const pctText = (v: number | null) => (v === null ? '—' : `${Math.round(v)}%`);

// "Resets in 2h 14m" within a day, "Resets Thu 2:00 PM" beyond, like the mockup.
function resets(at: number, now: number) {
  const m = Math.max(0, Math.round((at - now) / 60_000));
  if (m < 60) return `Resets in ${m}m`;
  if (m < 1440) return `Resets in ${Math.floor(m / 60)}h ${m % 60}m`;
  return `Resets ${new Date(at).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`;
}

function cost(v: number) {
  return v > 0 && v < 0.005 ? '<$0.01' : `$${v.toFixed(2)}`;
}

type Mark = { at: number; label: string; hot?: boolean };

// The fill deepens near a limit and turns red at it.
const level = (pct: number | null) => (pct === null ? '' : pct >= 95 ? ' over' : pct >= 80 ? ' near' : '');

function Row({ label, pct, note, marks = [] }: { label: string; pct: number | null; note: string; marks?: Mark[] }) {
  return (
    <div className={`ur${level(pct)}`}>
      <span>{label}</span><span className="pc">{pctText(pct)}</span>
      <i>
        <b style={{ width: `${Math.min(100, pct ?? 0)}%` }}></b>
        {marks.map((m) => <u key={m.label} className={m.hot ? 'hot' : undefined} style={{ left: `${m.at}%` }} title={m.label}></u>)}
      </i>
      <small>{note}</small>
    </div>
  );
}

const WEEKLY: [LimitKey, string][] = [['seven_day_opus', 'Week · Opus'], ['seven_day_sonnet', 'Week · Sonnet']];

// A category's list by `${sessionId}\n${category}`, loaded on its first expand; the oldest go past DETAIL_MAX.
type Detail = { at: number; items: ContextDetail[] | null } | 'loading';
const DETAIL_MAX = 24;
const useDetails = create<Record<string, Detail>>(() => ({}));

function putDetail(key: string, v: Detail) {
  useDetails.setState((s) => {
    const next = { ...s };
    delete next[key];
    next[key] = v;
    const keys = Object.keys(next);
    for (let i = 0; i < keys.length - DETAIL_MAX; i++) delete next[keys[i]];
    return next;
  }, true);
}

onContextDetail((m) => putDetail(`${m.sessionId}\n${m.category}`, { at: m.at, items: m.items }));

function DetailRow({ item }: { item: ContextDetail }) {
  const [open, setOpen] = useState(false);
  const label = <><span>{item.name}{item.children?.length ? <Chev /> : null}</span><span>{tok(item.tokens)}</span></>;
  if (!item.children?.length) return <li><div>{label}</div></li>;
  return <li>
    <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>{label}</button>
    {open && <Details items={item.children} />}
  </li>;
}

function Details({ items }: { items: ContextDetail[] }) {
  return <ul className="ux-details">{items.map((item, i) => <DetailRow key={`${item.name}:${i}`} item={item} />)}</ul>;
}

// Asks again only when the totals come from a newer summary than the cached list, or after a reconnect lost the answer.
function CategoryDetail({ sid, id, at }: { sid: string; id: string; at: number }) {
  const key = `${sid}\n${id}`;
  const detail = useDetails((s) => s[key]);
  const connected = useStore((s) => s.connected);
  useEffect(() => {
    const had = useDetails.getState()[key];
    if (!connected || (had && had !== 'loading' && had.at === at)) return;
    if (send({ type: 'context-load', sessionId: sid, category: id }) && !had) putDetail(key, 'loading');
  }, [key, at, connected]);
  if (!detail || detail === 'loading') return <div className="ux-note">Loading…</div>;
  if (!detail.items) return <div className="ux-note">No details available</div>;
  return <Details items={detail.items} />;
}

function Category({ c, sid, at }: { c: ContextCategory; sid: string; at: number }) {
  const [open, setOpen] = useState(false);
  const off = c.kind === 'deferred' ? ' ux-off' : '';
  const label = <><span className="ux-swatch" data-c={c.id} data-k={c.kind} /><span>{c.name}{c.more && <Chev />}</span><span>{tok(c.tokens)}</span></>;
  if (!c.more || !c.id) return <div className={`ux-row${off}`}>{label}</div>;
  return <>
    <button type="button" className={`ux-row${off}`} aria-expanded={open} onClick={() => setOpen(!open)}>{label}</button>
    {open && <CategoryDetail sid={sid} id={c.id} at={at} />}
  </>;
}

// The list mounts only while the popover shows (its exit fade included), so map patches never re-render it closed.
function Context({ ctx, sid, open, note, marks }: { ctx: ContextUsage | null; sid: string; open: boolean; note: string; marks: Mark[] }) {
  const breakdown = ctx?.breakdown;
  if (!ctx || !breakdown || (breakdown.provider === 'claude' && !breakdown.categories.length)) return <Row label="Context" pct={ctx?.pct ?? null} note={note} marks={marks} />;
  // Cached input is part of input and reasoning part of output. Cache writes stay out: the schema does not say if input includes them.
  const all: ContextCategory[] = breakdown.provider === 'claude' ? breakdown.categories : [
    { id: 'input', name: 'Input (uncached)', tokens: Math.max(0, breakdown.input - breakdown.cachedInput), kind: 'used' },
    { id: 'cached_input', name: 'Cached input', tokens: breakdown.cachedInput, kind: 'used' },
    { id: 'output', name: 'Output (non-reasoning)', tokens: Math.max(0, breakdown.output - breakdown.reasoning), kind: 'used' },
    { id: 'reasoning', name: 'Reasoning', tokens: breakdown.reasoning, kind: 'used' },
  ];
  const categories = all.filter((c) => c.tokens > 0);
  const at = breakdown.provider === 'claude' ? breakdown.at : 0;
  return <div className={`ur ux-context${level(ctx.pct)}`}>
    <span>Context</span><span className="pc">{pctText(ctx.pct)}</span>
    <i className="ux-stack" aria-label="Context token breakdown">
      {categories.map((c) => c.kind !== 'deferred' && <b key={c.id ?? c.name} data-c={c.id} data-k={c.kind} title={`${c.name}: ${c.tokens.toLocaleString()} tokens`}
        style={{ width: `${Math.min(100, c.tokens / ctx.max * 100)}%` }} />)}
      {marks.map((m) => <u key={m.label} className={m.hot ? 'hot' : undefined} style={{ left: `${m.at}%` }} title={m.label} />)}
    </i>
    <small>{note}</small>
    {open && <div className="ux-categories">{categories.map((c) => <Category key={c.id ?? c.name} c={c} sid={sid} at={at} />)}</div>}
    <small>{breakdown.provider === 'claude' ? 'Estimated usage by category'
      : `By token type, from the latest response${breakdown.cacheWriteInput ? ` · ${tok(breakdown.cacheWriteInput)} cache writes` : ''}`}</small>
  </div>;
}

// Hover peeks after 250ms; a click pins it open until Esc or a click outside.
export function Usage() {
  const sid = useStore((s) => s.current);
  const usage = useStore((s) => (s.current ? s.maps[s.current]?.usage : undefined));
  const limits = useStore((s) => s.limits);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(false);
  // Light dismiss closes a pinned card on pointerdown, before the click that meant "close" arrives.
  const downPinned = useRef(false);
  const ht = useRef(0);
  const [open, setOpen] = useState(false);
  const [listed, setListed] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const pop = popRef.current!;
    const onBefore = (e: Event) => {
      const next = (e as ToggleEvent).newState === 'open';
      setOpen(next);
      if (!next) return;
      setListed(true);
      setNow(Date.now());
      const r = btnRef.current!.getBoundingClientRect();
      pop.style.right = Math.max(12, innerWidth - r.right) + 'px';
      pop.style.bottom = innerHeight - r.top + 10 + 'px';
      pop.style.maxHeight = `${Math.max(120, r.top - 22)}px`;
    };
    const onToggle = (e: Event) => {
      if ((e as ToggleEvent).newState !== 'closed') return;
      pinned.current = false;
      // Unmounting the list at once would shrink the card while it still fades out.
      void Promise.allSettled(pop.getAnimations().map((a) => a.finished)).then(() => pop.matches(':popover-open') || setListed(false));
    };
    pop.addEventListener('beforetoggle', onBefore);
    pop.addEventListener('toggle', onToggle);
    return () => {
      pop.removeEventListener('beforetoggle', onBefore);
      pop.removeEventListener('toggle', onToggle);
      clearTimeout(ht.current);
    };
  }, []);

  const isOpen = () => popRef.current!.matches(':popover-open');
  const hover = () => matchMedia('(hover:hover)').matches;
  const enter = () => {
    if (!hover()) return;
    clearTimeout(ht.current);
    ht.current = window.setTimeout(() => isOpen() || popRef.current!.showPopover(), 250);
  };
  const leave = () => {
    if (!hover()) return;
    clearTimeout(ht.current);
    if (!pinned.current) ht.current = window.setTimeout(() => isOpen() && popRef.current!.hidePopover(), 120);
  };
  const click = () => {
    clearTimeout(ht.current);
    if (pinned.current || downPinned.current) {
      downPinned.current = false;
      pinned.current = false;
      return isOpen() && popRef.current!.hidePopover();
    }
    pinned.current = true;
    if (!isOpen()) popRef.current!.showPopover();
  };

  const ctx = usage?.ctx ?? null;
  const w = limits?.windows ?? {};
  const five: LimitWindow | undefined = w.five_hour;
  const week: LimitWindow | undefined = w.seven_day;
  const ctxPct = ctx?.pct ?? null;
  // Where the context gets compacted: the handoff mod's threshold first, the SDK's auto-compact as a fallback.
  const ctxMarks: Mark[] = [];
  if (ctx?.handoffAt) ctxMarks.push({ at: (ctx.handoffAt / ctx.max) * 100, label: `Handoff + compact at ${tok(ctx.handoffAt)}`, hot: true });
  if (ctx?.compactAt) ctxMarks.push({ at: ctx.compactAt, label: `Auto-compact at ${ctx.compactAt}%` });
  const ctxNote = !ctx ? 'Shows after the first reply'
    : `${tok(ctx.used)} of ${tok(ctx.max)} tokens${ctx.handoffAt ? ` · handoff at ${tok(ctx.handoffAt)}, ${tok(Math.max(0, ctx.handoffAt - ctx.used))} to go` : ''}`;
  const fivePct = five?.pct ?? null;
  const note = (x: LimitWindow | undefined) => (x?.resetsAt ? resets(x.resetsAt, now) : 'No data yet');

  return (
    <>
      <button
        type="button" ref={btnRef} className="seg use" aria-haspopup="dialog" aria-expanded={open}
        aria-label={`Usage: context ${ctxPct === null ? 'unknown' : `${Math.round(ctxPct)}%`}, 5-hour ${fivePct === null ? 'unknown' : `${Math.round(fivePct)}%`}`}
        onPointerDown={() => (downPinned.current = pinned.current)} onClick={click} onMouseEnter={enter} onMouseLeave={leave}
      >
        <span className="ring"><LedGauge value={ctxPct} />ctx <Flap text={pctText(ctxPct)} /></span>
        <span className="ring"><LedGauge value={fivePct} />5h <Flap text={pctText(fivePct)} /></span>
      </button>
      <div className="pop ux" popover="auto" ref={popRef} aria-label="Usage" onMouseEnter={enter} onMouseLeave={leave}>
        <Context ctx={ctx} sid={sid ?? ''} open={listed} note={ctxNote} marks={ctxMarks} />
        <Row label="5-hour session" pct={fivePct} note={note(five)} />
        <Row label="Week" pct={week?.pct ?? null} note={note(week)} />
        {WEEKLY.filter(([k]) => w[k]).map(([k, label]) => <Row key={k} label={label} pct={w[k]!.pct} note={note(w[k])} />)}
        <div className="ur">
          <span>API-equivalent cost</span><span className="pc">{usage?.cost != null ? cost(usage.cost) : '—'}</span>
          <small>{usage?.tokens ? `${tok(usage.tokens)} tokens · ` : ''}An estimate for this session; not billed on your subscription</small>
        </div>
      </div>
    </>
  );
}
