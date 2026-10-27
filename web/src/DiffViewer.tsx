import { memo, useEffect, useEffectEvent, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import type { ChangeFile, DiffLine, FileDiff } from '../../server/protocol.ts';
import { useStore } from './store.ts';
import { send } from './socket.ts';
import { clearRevert, diffKey, startRevert, useDiffs, useGaps, useRevert, type Gaps } from './diffs.ts';
import { highlight, langOf, type Token } from './highlight.ts';
import { CopyBtn, pref } from './bits.tsx';
import { openFile } from './FileTree.tsx';

// Which card the viewer shows: the conversation item holding it and the card's id.
export type DiffSource = { sessionId: string; item: string; card: string };

const CHUNK = 800;
const newReq = () => Math.random().toString(36).slice(2, 10);
// Bigger diffs stay plain: highlighting them would stall the page.
const HIGHLIGHT_MAX = 4000;

const dirOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const baseOf = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const langFor = (p: string) => {
  const b = baseOf(p).toLowerCase();
  if (b === 'dockerfile') return 'docker';
  const ext = b.includes('.') ? b.slice(b.lastIndexOf('.') + 1) : '';
  return ext ? langOf(ext) : null;
};

type Kind = DiffLine[0];
type Mark = [number, number];
// One line of one side; mark holds the changed spans inside a paired -/+ line.
type Side = { k: Kind; n: number; t: string; tok: Token[] | null; mark: Mark[] | null };
// from: the gap's first old-side line; up: it sits before the first hunk, so it opens from its bottom.
type Gap = { gap: number; from: number; up: boolean };
type URow = Gap | { a: number | null; b: number | null; s: Side };
type SRow = Gap | { l: Side | null; r: Side | null };
type Layout = 'split' | 'unified';
// The diff in reading order: hunks, collapsed gaps, and gap lines loaded with changes-context.
type Piece = { hunk: number } | { ctx: string[]; a: number; b: number } | Gap;
// Gap lines loaded per click.
const GAP_STEP = 300;
const NO_GAPS: Gaps = [];

function piecesOf(d: FileDiff, gaps: Gaps): Piece[] {
  const out: Piece[] = [];
  let endA = 1;
  let endB = 1;
  // Old-side lines [endA, e) are unchanged; shift maps them to the new side.
  const gapTo = (e: number, shift: number, up: boolean) => {
    let at = endA;
    if (e <= at) return;
    for (const [from, lines] of gaps) {
      const end = from + lines.length;
      if (end <= at || from >= e) continue;
      if (from > at) out.push({ gap: from - at, from: at, up });
      const st = Math.max(from, at);
      const to = Math.min(end, e);
      out.push({ ctx: lines.slice(st - from, to - from), a: st, b: st + shift });
      at = to;
    }
    if (at < e) out.push({ gap: e - at, from: at, up });
  };
  d.hunks.forEach((h, i) => {
    gapTo(h.a, h.b - h.a, i === 0);
    out.push({ hunk: i });
    let a = h.a;
    let b = h.b;
    for (const [k] of h.lines) {
      if (k !== '+') a++;
      if (k !== '-') b++;
    }
    endA = a;
    endB = b;
  });
  if (d.lines !== undefined && !d.truncated && d.hunks.length) gapTo(d.lines + 1, endB - endA, false);
  return out;
}

// Old and new sides are highlighted as two blocks, then each row takes its line back.
function useTokens(d: FileDiff | null | undefined, ps: Piece[]) {
  const [tokens, setTokens] = useState<{ ps: Piece[]; old: Token[][]; now: Token[][] } | null>(null);
  useEffect(() => {
    if (!d || d.note) return;
    const lang = langFor(d.path);
    const old: string[] = [];
    const now: string[] = [];
    for (const p of ps) {
      if ('ctx' in p) (old.push(...p.ctx), now.push(...p.ctx));
      else if ('hunk' in p) for (const [k, t] of d.hunks[p.hunk].lines) {
        if (k !== '+') old.push(t);
        if (k !== '-') now.push(t);
      }
    }
    if (!lang || Math.max(old.length, now.length) > HIGHLIGHT_MAX) return;
    let live = true;
    Promise.all([highlight(old.join('\n'), lang), highlight(now.join('\n'), lang)]).then(([o, n]) => live && o && n && setTokens({ ps, old: o, now: n }), () => {});
    return () => {
      live = false;
    };
  }, [d, ps]);
  return tokens && tokens.ps === ps ? tokens : null;
}

const WORDS = /\w+|\s+|[^\w\s]/g;
const solid = (ts: string[]) => ts.reduce((n, t) => n + (t.trim() ? t.length : 0), 0);

// Changed tokens of each side, merged across spaces, from a word-level LCS; no tint when the lines share too little.
function marksOf(a: Side, b: Side, budget: { cells: number }) {
  if (a.t === b.t || a.t.length > 1000 || b.t.length > 1000) return;
  const x = a.t.match(WORDS) ?? [];
  const y = b.t.match(WORDS) ?? [];
  let p = 0;
  while (p < x.length && p < y.length && x[p] === y[p]) p++;
  let s = 0;
  while (s < x.length - p && s < y.length - p && x[x.length - 1 - s] === y[y.length - 1 - s]) s++;
  const n = x.length - p - s;
  const m = y.length - p - s;
  const kx = new Uint8Array(x.length).fill(1);
  const ky = new Uint8Array(y.length).fill(1);
  for (let i = p; i < p + n; i++) kx[i] = 0;
  for (let j = p; j < p + m; j++) ky[j] = 0;
  // The LCS table is capped per line and per file so a huge rewrite stays fast.
  if (n && m && n * m <= Math.min(40000, budget.cells)) {
    budget.cells -= n * m;
    const L = new Uint16Array((n + 1) * (m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
      L[i * (m + 1) + j] = x[p + i] === y[p + j] ? L[(i + 1) * (m + 1) + j + 1] + 1 : Math.max(L[(i + 1) * (m + 1) + j], L[i * (m + 1) + j + 1]);
    for (let i = 0, j = 0; i < n && j < m;) {
      if (x[p + i] === y[p + j]) (kx[p + i] = ky[p + j] = 1, i++, j++);
      else if (L[(i + 1) * (m + 1) + j] >= L[i * (m + 1) + j + 1]) i++;
      else j++;
    }
  }
  const kept = solid(x.filter((_, i) => kx[i]));
  if (kept * 3 < Math.max(solid(x), solid(y))) return;
  a.mark = rangesOf(x, kx);
  b.mark = rangesOf(y, ky);
}

function rangesOf(ts: string[], keep: Uint8Array) {
  const out: Mark[] = [];
  let at = 0;
  let join = false;
  ts.forEach((t, i) => {
    const end = at + t.length;
    if (keep[i]) join &&= !t.trim();
    else if (join) out[out.length - 1][1] = end;
    else (out.push([at, end]), (join = true));
    at = end;
  });
  return out.length ? out : null;
}

// Both layouts in one pass: removed and added lines of a run pair up by order, so a rewrite sits on the same rows.
function build(d: FileDiff, pieces: Piece[], tk: ReturnType<typeof useTokens>) {
  const uni: URow[] = [];
  const split: SRow[] = [];
  // Row index where each hunk starts, per layout.
  const hu: number[] = [];
  const hs: number[] = [];
  let oi = 0;
  let ni = 0;
  let minus = false;
  let plus = false;
  let ctx = false;
  const budget = { cells: 2_000_000 };
  for (const p of pieces) {
    if ('gap' in p) {
      uni.push(p);
      split.push(p);
      continue;
    }
    if ('ctx' in p) {
      p.ctx.forEach((t, i) => {
        const r: Side = { k: ' ', n: p.b + i, t, tok: tk?.now[ni++] ?? null, mark: null };
        split.push({ l: { ...r, n: p.a + i, tok: tk?.old[oi++] ?? null }, r });
        uni.push({ a: p.a + i, b: p.b + i, s: r });
      });
      continue;
    }
    const h = d.hunks[p.hunk];
    hu.push(uni.length);
    hs.push(split.length);
    let a = h.a;
    let b = h.b;
    let ms: Side[] = [];
    let ps: Side[] = [];
    const flush = () => {
      for (let i = 0; i < Math.max(ms.length, ps.length); i++) {
        if (ms[i] && ps[i]) marksOf(ms[i], ps[i], budget);
        split.push({ l: ms[i] ?? null, r: ps[i] ?? null });
      }
      ms = [];
      ps = [];
    };
    for (const [k, t] of h.lines) {
      if (k === ' ') {
        flush();
        ctx = true;
        const r: Side = { k, n: b, t, tok: tk?.now[ni] ?? null, mark: null };
        split.push({ l: { ...r, n: a, tok: tk?.old[oi] ?? null }, r });
        uni.push({ a, b, s: r });
      } else if (k === '-') {
        minus = true;
        const s: Side = { k, n: a, t, tok: tk?.old[oi] ?? null, mark: null };
        ms.push(s);
        uni.push({ a, b: null, s });
      } else {
        plus = true;
        const s: Side = { k, n: b, t, tok: tk?.now[ni] ?? null, mark: null };
        ps.push(s);
        uni.push({ a: null, b, s });
      }
      if (k !== '+') (a++, oi++);
      if (k !== '-') (b++, ni++);
    }
    flush();
  }
  // A created or fully deleted file has only one side, so it keeps the full width.
  return { uni, split, hu, hs, one: !ctx && !(minus && plus) };
}

// New-side line of a hunk's first change, so the file opens on the edit rather than its leading context.
function lineOf(h: FileDiff['hunks'][number]) {
  let b = h.b;
  for (const [k] of h.lines) {
    if (k !== ' ') return Math.max(1, b);
    b++;
  }
  return Math.max(1, h.b);
}

const headH = (box: HTMLElement) => box.querySelector<HTMLElement>(':scope > .dv-head')?.offsetHeight ?? 0;

type Jump = { i: number; seq: number };

function Code({ s }: { s: Side }): ReactNode {
  const m = s.mark;
  if (!m) return s.tok ? s.tok.map((t, i) => <span key={i} style={t.color ? { color: t.color } : undefined}>{t.content}</span>) : s.t;
  const out: ReactNode[] = [];
  let at = 0;
  let mi = 0;
  for (const t of s.tok ?? [{ content: s.t }]) {
    const end = at + t.content.length;
    const style = t.color ? { color: t.color } : undefined;
    for (let c = at; c < end;) {
      while (mi < m.length && m[mi][1] <= c) mi++;
      const r = m[mi];
      const inside = !!r && r[0] <= c;
      const stop = Math.min(end, r ? (inside ? r[1] : r[0]) : end);
      out.push(<span key={out.length} style={style} className={inside ? 'dv-w' : undefined}>{t.content.slice(c - at, stop - at)}</span>);
      c = stop;
    }
    at = end;
  }
  return out;
}

const tint = (k: Kind) => (k === '+' ? ' dv-p' : k === '-' ? ' dv-m' : '');
const sign = (k: Kind) => (k === ' ' ? '' : k === '-' ? '−' : '+');

const Half = ({ s }: { s: Side | null }) =>
  s ? (
    <div className={`dv-h${tint(s.k)}`}>
      <span className="dv-n">{s.n}</span>
      <span className="dv-s">{sign(s.k)}</span>
      <span className="dv-t"><Code s={s} /></span>
    </div>
  ) : (
    <div className="dv-h dv-x" aria-hidden="true"></div>
  );

// A gap opens on click when the old side is kept (d.lines is set).
function GapRow({ g, onGap }: { g: Gap; onGap: ((g: Gap) => void) | null }) {
  const label = g.gap > 0 ? `⋯ ${g.gap} unchanged line${g.gap === 1 ? '' : 's'}` : '⋯';
  if (!onGap || g.gap <= 0) return <div className="dv-gap">{label}</div>;
  const n = Math.min(g.gap, GAP_STEP);
  return (
    <button type="button" className="dv-gap dv-gapb" onClick={() => onGap(g)} title={n < g.gap ? `Show ${n} more lines` : 'Show these lines'}>
      {label}<span className="dv-gapx">{n < g.gap ? `Show ${n}` : 'Show'}</span>
    </button>
  );
}

// Rows mount in chunks as the reader scrolls, so a huge diff never blocks the page.
const DiffBody = memo(function DiffBody({ d, gaps, layout, jump, onAt, onGap }: {
  d: FileDiff; gaps: Gaps; layout: Layout; jump: Jump | null; onAt: (i: number) => void; onGap: ((g: Gap) => void) | null;
}) {
  const pieces = useMemo(() => piecesOf(d, gaps), [d, gaps]);
  const tk = useTokens(d, pieces);
  const { uni, split, one, hu, hs } = useMemo(() => build(d, pieces, tk), [d, pieces, tk]);
  const rows: (URow | SRow)[] = layout === 'split' ? split : uni;
  const starts = layout === 'split' ? hs : hu;
  const hunkAt = useMemo(() => new Map(starts.map((r, k) => [r, k])), [starts]);
  const [limit, setLimit] = useState(CHUNK);
  const [side, setSide] = useState<'l' | 'r' | undefined>();
  const more = useRef<HTMLDivElement>(null);
  const code = useRef<HTMLDivElement>(null);
  const raf = useRef(0);
  // Set before a jump scrolls, so its own scroll event does not move the counter.
  const skip = useRef(false);
  // A remount (the diff reloaded) must not replay the last jump.
  const done = useRef(jump?.seq ?? 0);
  useEffect(() => {
    const el = more.current;
    if (!el) return;
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && setLimit((l) => l + CHUNK), { rootMargin: '600px' });
    io.observe(el);
    return () => io.disconnect();
  }, [limit, rows.length]);

  // The counter follows the last hunk whose first row sits under the sticky header.
  const track = useEffectEvent((box: HTMLElement) => {
    const heads = box.querySelectorAll<HTMLElement>('[data-h]');
    const line = box.getBoundingClientRect().top + headH(box) + 24;
    let lo = 0;
    let hi = heads.length - 1;
    let at = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (heads[mid].getBoundingClientRect().top <= line) (at = mid, lo = mid + 1);
      else hi = mid - 1;
    }
    onAt(at < 0 ? 0 : Number(heads[at].dataset.h));
  });
  useEffect(() => {
    const box = code.current?.closest<HTMLElement>('.dv-main');
    if (!box) return;
    const onScroll = () => {
      if (skip.current) return void (skip.current = false);
      cancelAnimationFrame(raf.current);
      raf.current = requestAnimationFrame(() => track(box));
    };
    box.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      box.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(raf.current);
    };
  }, [rows.length > 0]);

  // A jump first mounts rows up to its hunk, then scrolls once; later chunk loads leave the scroll alone.
  useEffect(() => {
    if (!jump || jump.seq === done.current) return;
    const row = starts[jump.i];
    if (row === undefined) return;
    if (row >= limit) return setLimit(row + CHUNK);
    done.current = jump.seq;
    const box = code.current?.closest<HTMLElement>('.dv-main');
    const el = code.current?.querySelector(`[data-h="${jump.i}"]`);
    if (!box || !el) return;
    cancelAnimationFrame(raf.current);
    const top = box.scrollTop + el.getBoundingClientRect().top - box.getBoundingClientRect().top - headH(box) - 6;
    const next = Math.max(0, Math.min(top, box.scrollHeight - box.clientHeight));
    if (Math.abs(next - box.scrollTop) < 1) return;
    skip.current = true;
    box.scrollTop = next;
  }, [jump, limit, starts]);

  if (d.note) return <div className="dv-empty">{d.note}</div>;
  if (!rows.length) return <div className="dv-empty">No line changes</div>;
  // A drag that starts on one side selects only that side's code.
  const pickSide = (e: ReactMouseEvent) => {
    const h = (e.target as Element).closest('.dv-sr > .dv-h');
    setSide(h ? (h === h.parentElement!.firstElementChild ? 'l' : 'r') : undefined);
  };
  return (
    <div ref={code} className="dv-code mono" data-sel={layout === 'split' && !one ? side : undefined} onMouseDown={layout === 'split' && !one ? pickSide : undefined}>
      {rows.slice(0, limit).map((r, i) =>
        'gap' in r ? <GapRow key={i} g={r} onGap={onGap} />
          : 's' in r ? (
            <div key={i} className={`dv-r${tint(r.s.k)}`} data-h={hunkAt.get(i)}>
              <span className="dv-n">{r.a ?? ''}</span>
              <span className="dv-n">{r.b ?? ''}</span>
              <span className="dv-s">{sign(r.s.k)}</span>
              <span className="dv-t"><Code s={r.s} /></span>
            </div>
          ) : one ? (
            <div key={i} className="dv-sr one" data-h={hunkAt.get(i)}><Half s={r.l ?? r.r} /></div>
          ) : (
            <div key={i} className="dv-sr" data-h={hunkAt.get(i)}><Half s={r.l} /><Half s={r.r} /></div>
          ),
      )}
      {rows.length > limit && <div ref={more} className="dv-gap">Loading more lines…</div>}
      {d.truncated && <div className="dv-gap">The rest of this diff is too long to show</div>}
    </div>
  );
});

function FileRow({ f, on, pick }: { f: ChangeFile; on: boolean; pick: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (on) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [on]);
  return (
    <button ref={ref} className="dv-f" aria-current={on || undefined} onClick={pick} title={f.path}>
      <span className="dv-fn"><b>{baseOf(f.path)}</b><small>{dirOf(f.path)}</small></span>
      {f.note ? <span className="dv-fnote">{f.note === 'Binary file' ? 'binary' : 'skipped'}</span> : (
        <span className="dv-fc mono"><span className="dv-add">+{f.add}</span> <span className="dv-rm">−{f.rm}</span></span>
      )}
    </button>
  );
}

export function DiffViewer({ source, close }: { source: DiffSource; close: ReactNode }) {
  const card = useStore((s) => {
    const it = s.items[source.item];
    return it?.kind === 'changes' ? it.cards.find((c) => c.id === source.card) ?? null : null;
  });
  const files = card?.files ?? [];
  const [path, setPath] = useState<string | null>(null);
  const idx = Math.max(0, files.findIndex((f) => f.path === path));
  const file = files[idx] ?? null;
  const key = file ? diffKey(source.sessionId, source.card, file.path) : '';
  const diff = useDiffs((s) => (key ? s.byKey[key] : undefined));
  const main = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<Layout>(() => (pref.get<string>('diffLayout', 'split') === 'unified' ? 'unified' : 'split'));
  const pick = (l: Layout) => {
    setLayout(l);
    pref.set('diffLayout', l);
  };

  useEffect(() => {
    if (file && diff === undefined) send({ type: 'changes-load', sessionId: source.sessionId, id: source.card, path: file.path });
  }, [key, diff === undefined]);

  // `at` is the hunk the counter shows; `jump` asks the body to scroll to one.
  const [at, setAt] = useState({ key: '', i: 0 });
  const [jump, setJump] = useState<(Jump & { key: string }) | null>(null);
  const hunks = diff?.hunks ?? [];
  const hunk = at.key === key ? Math.min(at.i, Math.max(0, hunks.length - 1)) : 0;
  // Outside the JSX so the compiler memoizes it on key alone; inline, every counter change re-rendered all rows.
  const onAt = (i: number) => setAt((p) => (p.key === key && p.i === i ? p : { key, i }));
  const toHunk = (i: number) => {
    if (!hunks.length) return;
    const t = Math.max(0, Math.min(hunks.length - 1, i));
    setAt({ key, i: t });
    setJump({ key, i: t, seq: (jump?.seq ?? 0) + 1 });
  };
  // A fully deleted file has nothing left to open.
  const gone = hunks.length > 0 && !hunks.some((h) => h.lines.some(([k]) => k !== '-'));
  const line = hunks.length ? lineOf(hunks[hunk]) : undefined;

  const gaps = useGaps((s) => (key ? s.byKey[key] : undefined)) ?? NO_GAPS;
  const onGap = file && diff?.lines !== undefined ? (g: Gap) => {
    const n = Math.min(g.gap, GAP_STEP);
    send({ type: 'changes-context', sessionId: source.sessionId, id: source.card, path: file.path, from: g.up ? g.from + g.gap - n : g.from, count: n });
  } : null;

  // Reverts are refused mid-turn on the server too; this only greys the buttons out.
  const working = useStore((s) => s.current === source.sessionId && s.status === 'working');
  const last = useRevert((s) => (s.last?.sessionId === source.sessionId ? s.last : null));
  const pending = last?.state === 'pending';
  const canRevert = !!diff?.revertable && !working && !pending;
  useEffect(() => clearRevert, []);
  const revert = (h: number | null) => {
    if (!file || !canRevert) return;
    const req = newReq();
    startRevert(source.sessionId, req, h === null ? file.path : `change ${h + 1} in ${file.path}`, false);
    send({ type: 'changes-revert', sessionId: source.sessionId, id: source.card, path: file.path, ...(h === null ? {} : { hunk: h }), req });
  };
  const undo = () => {
    if (!last?.undo || pending) return;
    const req = newReq();
    startRevert(source.sessionId, req, last.label, true);
    send({ type: 'changes-undo', sessionId: source.sessionId, undo: last.undo, req });
  };
  const waitTitle = 'Wait for the turn to end';

  const choose = (p: string) => {
    setPath(p);
    setAt({ key: '', i: 0 });
    setJump(null);
  };
  const go = (step: number) => {
    if (!files.length) return;
    choose(files[(idx + step + files.length) % files.length].path);
    main.current?.scrollTo({ top: 0 });
  };

  const onKey = useEffectEvent((e: KeyboardEvent) => {
    if (e.defaultPrevented || e.isComposing || e.altKey || e.ctrlKey || e.metaKey || (e.target as Element)?.closest?.('input,textarea,[contenteditable]')) return;
    // Focus inside another overlay (a menu or dialog above the viewer) keeps its own keys.
    const a = document.activeElement;
    const own = root.current?.closest('[popover]') ?? root.current;
    if (a && a !== document.body && !own?.contains(a) && a.closest('[popover], dialog[open], [aria-modal="true"]')) return;
    if (e.key === 'n' || e.key === 'p') {
      e.preventDefault();
      return toHunk(hunk + (e.key === 'n' ? 1 : -1));
    }
    const step = e.key === 'ArrowDown' || e.key === 'j' ? 1 : e.key === 'ArrowUp' || e.key === 'k' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    go(step);
  });
  useEffect(() => {
    const h = (e: KeyboardEvent) => onKey(e);
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, []);

  return (
    <div className="fx-body" ref={root}>
      <div className="fx-top">
        <span className="fx-label"><b className="dv-who">{card?.name ?? 'Changes'}</b> · {files.length} file{files.length === 1 ? '' : 's'}</span>
        {card && <span className="mono dv-tot"><span className="dv-add">+{card.add}</span> <span className="dv-rm">−{card.rm}</span></span>}
        <span className="sp"></span>
        {close}
      </div>
      <div className="fx-stage dv-stage" tabIndex={-1}>
        <div className="dv">
          <nav className="dv-files" aria-label="Changed files">
            {files.map((f, i) => <FileRow key={f.path} f={f} on={i === idx} pick={() => choose(f.path)} />)}
            {card && card.more > 0 && <div className="dv-fmore">{card.more} more files not tracked</div>}
          </nav>
          <section className="dv-main" ref={main}>
            {file ? (
              <>
                <header className={`dv-head${last ? ' has-rev' : ''}`}>
                  <span className="dv-path mono">{file.path}</span>
                  <CopyBtn text={file.path} what="path" label={false} />
                  {file.created && <span className="dv-tag">new</span>}
                  {card?.kind === 'shell' && <span className="dv-tag dv-shell" title="Changed by a command or another program, so it shows against the last commit">no file tool</span>}
                  <span className="mono"><span className="dv-add">+{file.add}</span> <span className="dv-rm">−{file.rm}</span></span>
                  <span className="sp"></span>
                  {hunks.length > 1 && (
                    <span className="dv-nav" role="group" aria-label="Changes in this file">
                      <button onClick={() => toHunk(hunk - 1)} disabled={hunk === 0} aria-label="Previous change" title="Previous change (p)">
                        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M7.5 2.5 4 6l3.5 3.5" /></svg>
                      </button>
                      <span>Change {hunk + 1} / {hunks.length}</span>
                      <button onClick={() => toHunk(hunk + 1)} disabled={hunk === hunks.length - 1} aria-label="Next change" title="Next change (n)">
                        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M4.5 2.5 8 6 4.5 9.5" /></svg>
                      </button>
                    </span>
                  )}
                  {diff?.revertable && hunks.length > 1 && (
                    <button type="button" className="dv-open" disabled={!canRevert} onClick={() => revert(hunk)} title={working ? waitTitle : `Put change ${hunk + 1} back as it was`}>
                      Revert change
                    </button>
                  )}
                  {diff?.revertable && (
                    <button
                      type="button" className="dv-open" disabled={!canRevert} onClick={() => revert(null)}
                      title={working ? waitTitle : card?.kind === 'revert' ? 'Put this file back as it was before the revert' : 'Put this file back as it was before these edits'}
                    >
                      Revert file
                    </button>
                  )}
                  {!gone && (
                    <button type="button" className="dv-open" onClick={(e) => openFile(file.path, line, e.currentTarget)} title={line ? `Open the file at line ${line}` : 'Open the file'}>
                      Open file
                    </button>
                  )}
                  <div className="dv-seg" role="group" aria-label="Diff layout">
                    <button type="button" aria-pressed={layout === 'split'} onClick={() => pick('split')} title="Old and new side by side">Split</button>
                    <button type="button" aria-pressed={layout === 'unified'} onClick={() => pick('unified')} title="One column, removed lines above added ones">Unified</button>
                  </div>
                  {files.length > 1 && (
                    <span className="dv-nav">
                      <button onClick={() => go(-1)} aria-label="Previous file" title="Previous file (↑)">
                        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M2.5 7.5 6 4l3.5 3.5" /></svg>
                      </button>
                      <span>{idx + 1} / {files.length}</span>
                      <button onClick={() => go(1)} aria-label="Next file" title="Next file (↓)">
                        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M2.5 4.5 6 8l3.5-3.5" /></svg>
                      </button>
                    </span>
                  )}
                  {last && (
                    <div className={`dv-rev ${last.state}`} role="status">
                      <span>
                        {last.state === 'pending' ? (last.undoing ? 'Undoing the revert…' : 'Reverting…')
                          : last.state === 'failed' ? last.error
                          : last.undoing ? `Revert undone: ${last.label} is back` : `Reverted ${last.label}`}
                      </span>
                      {last.state === 'done' && last.undo && <button type="button" className="dv-open" onClick={undo}>Undo revert</button>}
                      {last.state !== 'pending' && (
                        <button type="button" className="dv-revx" aria-label="Dismiss" title="Dismiss" onClick={clearRevert}>
                          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M2 2l6 6M8 2 2 8" /></svg>
                        </button>
                      )}
                    </div>
                  )}
                </header>
                {diff === undefined ? <div className="dv-empty"><span className="spin"></span><span className="sr" role="status">Loading…</span></div>
                  : diff === null ? <div className="dv-empty">This diff is no longer available</div>
                  : (
                    <DiffBody
                      key={key} d={diff} gaps={gaps} layout={layout} jump={jump?.key === key ? jump : null} onGap={onGap} onAt={onAt}
                    />
                  )}
              </>
            ) : (
              <div className="dv-empty">No changed files</div>
            )}
          </section>
        </div>
      </div>
      <div className="fx-foot"><kbd>↑</kbd><kbd>↓</kbd>switch files · <kbd>p</kbd><kbd>n</kbd>previous or next change · <kbd>esc</kbd>close</div>
    </div>
  );
}
