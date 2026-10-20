import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type PointerEvent } from 'react';
import type { BrowserButton, BrowserClientMessage, BrowserServerMessage, BrowserState, BrowserTab, BrowserTool, BrowserVideo } from '../../../server/protocol.ts';
import { BROWSER_TEXT_MAX } from '../../../server/protocol.ts';
import { useStore } from '../store.ts';
import { useBrowserActivity } from './activity.ts';
import { browserSocketUrl, onBrowserKey } from './key.ts';
import { ChevLeft, ChevRight, ExpandIcon, FOSI, XIcon, morphBox, reduceMotion, tilde, useEscape } from '../bits.tsx';
import { RecVideo, clock } from './Video.tsx';
import { useLayoutVars } from '../layoutVars.ts';
import { Led } from '../led.tsx';
import { closedBrowser, onCloseRequest } from './open.ts';
import { AgentCursor } from './cursor.ts';
import { ClaudeSetup, dismissStep, dismissedStep, setupStep } from './ClaudeSetup.tsx';
import { QaMenu } from './QaMenu.tsx';

type Meta = { w: number; h: number };
type MouseMsg = Extract<BrowserClientMessage, { type: 'mouse' }>;
type View = { open: boolean; visible: boolean; w: number; h: number; dpr: number };
type Hooks = { state: (s: BrowserState) => void; linked: (on: boolean) => void; frame: () => void };

// The panel's own socket: JSON state and input, binary JPEG frames painted straight onto the canvas.
class Link {
  meta: Meta = { w: 0, h: 0 };
  canvas: HTMLCanvasElement | null = null;
  cursor: AgentCursor | null = null;
  private view: View = { open: true, visible: !document.hidden, w: 0, h: 0, dpr: devicePixelRatio };
  private ws: WebSocket | null = null;
  private hooks: Hooks;
  private retry = 0;
  private timer = 0;
  private closed = false;
  private busy = false;
  private next: Blob | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private ctxOf: HTMLCanvasElement | null = null;

  private offKey: () => void;

  constructor(hooks: Hooks) {
    this.hooks = hooks;
    // A new key means a restarted server, so a pending retry goes now.
    this.offKey = onBrowserKey(() => {
      if (this.closed || this.ws?.readyState === WebSocket.OPEN) return;
      const old = this.ws;
      this.ws = null;
      old?.close();
      this.retry = 0;
      this.connect();
    });
    this.connect();
  }

  private connect() {
    clearTimeout(this.timer);
    const url = browserSocketUrl(false);
    if (!url) return;
    const ws = new WebSocket(url);
    ws.binaryType = 'blob';
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.hooks.linked(true);
      this.send({ type: 'view', ...this.view });
    };
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return this.paint(e.data as Blob);
      const m = JSON.parse(e.data) as BrowserServerMessage;
      if (m.type === 'state') this.hooks.state(m.state);
      else if (m.type === 'meta') {
        this.meta = { w: m.w, h: m.h };
        this.fitCanvas();
      } else if (m.type === 'cursor' && this.canvas?.classList.contains('on')) this.cursor?.point(m.kind, m.x, m.y, this.canvas, this.meta);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.hooks.linked(false);
      if (!this.closed) this.timer = window.setTimeout(() => this.connect(), Math.min(5000, 400 * 2 ** this.retry++));
    };
  }

  send(m: BrowserClientMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  // The canvas takes the page's CSS size, so a frame fitted to the stage maps 1:1 to screen pixels; CSS max sizes
  // scale it down only when the page is wider than the stage (Chrome's minimum window width).
  fitCanvas() {
    const c = this.canvas;
    const { w, h } = this.meta;
    if (!c || !w || !h) return;
    c.style.width = `${w}px`;
    c.style.height = `${h}px`;
  }

  setView(patch: Partial<View>) {
    const next = { ...this.view, ...patch };
    if (next.visible === this.view.visible && next.w === this.view.w && next.h === this.view.h && next.dpr === this.view.dpr) return;
    this.view = next;
    this.send({ type: 'view', ...next });
  }

  // Decoding runs off the main thread; while one frame decodes, only the newest waiting frame is kept.
  private paint(b: Blob) {
    if (this.busy) return void (this.next = b);
    this.busy = true;
    createImageBitmap(b)
      .then((bmp) => {
        const c = this.canvas;
        if (c) {
          if (c.width !== bmp.width || c.height !== bmp.height) Object.assign(c, { width: bmp.width, height: bmp.height });
          if (this.ctxOf !== c) [this.ctx, this.ctxOf] = [c.getContext('2d', { alpha: false }), c];
          this.ctx?.drawImage(bmp, 0, 0);
          this.hooks.frame();
        }
        bmp.close();
      }, () => {})
      .finally(() => {
        this.busy = false;
        const n = this.next;
        this.next = null;
        if (n) this.paint(n);
      });
  }

  close() {
    this.closed = true;
    this.offKey();
    clearTimeout(this.timer);
    this.ws?.close();
    this.ws = null;
  }
}

// Panel point to page CSS px; the frame is drawn with object-fit: contain, so the letterbox is taken out.
function toPage(c: HTMLCanvasElement | null, m: Meta, cx: number, cy: number) {
  if (!c || !m.w || !m.h) return null;
  const r = c.getBoundingClientRect();
  const k = Math.min(r.width / m.w, r.height / m.h);
  if (!k) return null;
  const x = (cx - r.left - (r.width - m.w * k) / 2) / k;
  const y = (cy - r.top - (r.height - m.h * k) / 2) / k;
  return { x, y, inside: x >= 0 && y >= 0 && x <= m.w && y <= m.h };
}

const mods = (e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) =>
  (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
const BUTTONS: BrowserButton[] = ['left', 'middle', 'right'];

const blank = (url: string) => url === 'about:blank' || url.startsWith('chrome://newtab') || url.startsWith('chrome://new-tab-page');

// Typed text to a URL: schemes and hosts go as they are, anything else is a search.
function toUrl(input: string) {
  const t = input.trim();
  if (!t) return null;
  if (/^(localhost|127\.0\.0\.1|\[[0-9a-f:]+\])(:\d+)?(\/|$)/i.test(t)) return `http://${t}`;
  if (/^[a-z][a-z0-9+.-]*:/i.test(t)) return t;
  if (!/\s/.test(t) && /^[^/]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(t)) return `https://${t}`;
  return `https://www.google.com/search?q=${encodeURIComponent(t)}`;
}

function tabLabel(t: BrowserTab) {
  if (t.title && t.title !== t.url) return t.title;
  if (blank(t.url)) return 'New tab';
  try {
    return new URL(t.url).host || t.url;
  } catch {
    return t.url;
  }
}

const ReloadIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M11.6 6.9A4.6 4.6 0 1 1 10.2 3.6M11.4 1.8v2.4H9" />
  </svg>
);
const PowerIcon = () => (
  <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
    <path d="M7 1.8v4.6M4.2 3.6a4.6 4.6 0 1 0 5.6 0" />
  </svg>
);
const RecIcon = () => (
  <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
    <circle cx="7" cy="7" r="5.4" />
    <circle cx="7" cy="7" r="2.4" style={{ fill: 'currentColor', stroke: 'none' }} />
  </svg>
);

// Ticks once a second, only while a recording runs.
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return <>{clock(now - since)}</>;
}

const PlusIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
    <path d="M6 1.5v9M1.5 6h9" />
  </svg>
);

// The layers that drive this Chrome. Claude in Chrome acts on the browser its session picked, which may be another one.
const TOOLS = [['claude', 'Claude', 'Claude in Chrome'], ['playwright', 'Playwright', 'Playwright (panel)'], ['devtools', 'DevTools', 'Chrome DevTools (panel)']] as const;
const LIT_MS = 1800;
const AGENTS_HINT = 'Use the Browser panel for agents. Off: agents never start or use it, and Claude in Chrome uses the browser you picked.';

const ENTER = [{ opacity: 0, transform: 'translateY(8px) scale(.985)' }, { opacity: 1, transform: 'none' }];

export default function BrowserPanel() {
  const boxRef = useRef<HTMLElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const keysRef = useRef<HTMLTextAreaElement>(null);
  const cursorRef = useRef<HTMLDivElement>(null);
  const linkRef = useRef<Link | null>(null);
  const fromRef = useRef<DOMRect | null>(null);
  const closing = useRef(false);
  const framedRef = useRef(false);
  const last = useRef({ t: 0, x: 0, y: 0, b: -1, n: 1 });
  const move = useRef<MouseMsg | null>(null);
  const raf = useRef(0);
  const [st, setSt] = useState<BrowserState | null>(null);
  const [linked, setLinked] = useState(false);
  const [framed, setFramed] = useState(false);
  const [full, setFull] = useState(false);
  const [focus, setFocus] = useState<'keys' | 'url' | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [lit, setLit] = useState<BrowserTool | null>(null);
  // The recording open in the stage, and the saved one or error the owner dismissed.
  const [playing, setPlaying] = useState<BrowserVideo | null>(null);
  const [dismissed, setDismissed] = useState('');
  const [setupOff, setSetupOff] = useState(dismissedStep);
  const home = useStore((s) => s.home);
  const acted = useBrowserActivity();
  const boxEl = useLayoutVars(boxRef);

  // The last layer that acted stays lit briefly, then fades.
  useEffect(() => {
    const left = acted ? acted.at + LIT_MS - Date.now() : 0;
    if (!acted || left <= 0) return;
    setLit(acted.tool);
    const t = setTimeout(() => setLit(null), left);
    return () => clearTimeout(t);
  }, [acted]);

  const status = linked ? st?.status ?? 'stopped' : 'link';
  const live = status === 'live';
  const active = st?.tabs.find((t) => t.id === st.active) ?? null;
  const send = (m: BrowserClientMessage) => linkRef.current?.send(m);

  useEffect(() => {
    const link = new Link({
      state: setSt,
      linked: setLinked,
      frame: () => {
        if (framedRef.current) return;
        framedRef.current = true;
        setFramed(true);
      },
    });
    link.canvas = canvasRef.current;
    link.cursor = cursorRef.current && new AgentCursor(cursorRef.current);
    link.fitCanvas();
    linkRef.current = link;
    const onVis = () => link.setView({ visible: !document.hidden });
    document.addEventListener('visibilitychange', onVis);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      link.cursor?.hide();
      link.close();
      linkRef.current = null;
    };
  }, []);

  // A stopped or restarted Chrome has no picture until its first new frame.
  useEffect(() => {
    if (live) return;
    framedRef.current = false;
    setFramed(false);
  }, [live]);

  // The agent cursor belongs to the tab it acted in.
  const tabId = st?.active;
  useEffect(() => linkRef.current?.cursor?.hide(), [live, tabId]);

  // Frames are sized to the stage in device px, so a docked panel does not pull full-size JPEGs.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    let t = 0;
    const ro = new ResizeObserver(([e]) => {
      const { width, height } = e.contentRect;
      clearTimeout(t);
      t = window.setTimeout(() => linkRef.current?.setView({ w: Math.round(width * devicePixelRatio), h: Math.round(height * devicePixelRatio), dpr: devicePixelRatio }), 150);
    });
    ro.observe(el);
    return () => {
      clearTimeout(t);
      ro.disconnect();
    };
  }, []);

  // Docked, the panel shares the side column: under the Agents panel and above the Work card or sheet, following both.
  useEffect(() => {
    const els = ['aside.panel', 'aside.smap', 'section.smx'].map((s) => document.querySelector(s)).filter((el) => el !== null);
    if (!els.length) return;
    const ro = new ResizeObserver(() => {
      const box = boxRef.current;
      if (!box) return;
      const panel = document.querySelector('aside.panel');
      if (panel && !panel.classList.contains('full')) box.style.setProperty('--at', `${Math.round(panel.getBoundingClientRect().bottom)}px`);
      // The open sheet hides its card; a hidden card has no box.
      const sheet = document.querySelector('section.smx.open:not(.full)');
      const card = document.querySelector('aside.smap:not([hidden]):not(.open)');
      const h = (sheet ?? card)?.getBoundingClientRect().height ?? 0;
      box.style.setProperty('--wh', `${Math.round(h)}px`);
      box.style.setProperty('--wg', h ? '1' : '0');
    });
    for (const el of els) ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Starting the entrance reads no layout, so it can run before the first paint.
  useLayoutEffect(() => {
    boxRef.current?.animate(reduceMotion() ? [{ opacity: 0 }, { opacity: 1 }] : ENTER, { duration: reduceMotion() ? 120 : 240, easing: 'cubic-bezier(.23,1,.32,1)' });
  }, []);

  const close = () => {
    if (closing.current) return;
    closing.current = true;
    const el = boxRef.current;
    if (!el) return closedBrowser();
    el.getAnimations().forEach((a) => a.cancel());
    el.animate([...ENTER].reverse(), { duration: 160, easing: FOSI, fill: 'forwards' }).finished.then(closedBrowser, closedBrowser);
  };
  const onClose = useEffectEvent(close);
  useEffect(() => {
    onCloseRequest(() => onClose());
    return () => onCloseRequest(null);
  }, []);

  const fullscreen = (v: boolean) => {
    fromRef.current = boxRef.current!.getBoundingClientRect();
    setFull(v);
  };
  useLayoutEffect(() => {
    const from = fromRef.current;
    fromRef.current = null;
    if (from) morphBox(boxRef.current!, from, full);
  }, [full]);
  // While typing into the page or the address bar, Esc belongs to them.
  useEscape(full && !focus, () => fullscreen(false));
  useEscape(!full && !focus, close);
  useEscape(!!playing && !focus, () => setPlaying(null));

  // Wheel needs a non-passive listener to keep the app from scrolling; deltas add up to one event per frame.
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    let dx = 0;
    let dy = 0;
    let at: { x: number; y: number; mods: number } | null = null;
    let f = 0;
    const flush = () => {
      f = 0;
      if (at) linkRef.current?.send({ type: 'mouse', kind: 'wheel', x: at.x, y: at.y, button: 'none', buttons: 0, clicks: 0, mods: at.mods, dx, dy });
      dx = dy = 0;
    };
    const onWheel = (e: WheelEvent) => {
      const link = linkRef.current;
      const p = link && toPage(link.canvas, link.meta, e.clientX, e.clientY);
      if (!link || !p?.inside) return;
      e.preventDefault();
      const k = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? link.meta.h : 1;
      dx += e.deltaX * k;
      dy += e.deltaY * k;
      at = { x: p.x, y: p.y, mods: mods(e) };
      f ||= requestAnimationFrame(flush);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('wheel', onWheel);
      cancelAnimationFrame(f);
    };
  }, []);

  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  const flushMove = () => {
    raf.current = 0;
    const m = move.current;
    move.current = null;
    if (m) send(m);
  };

  const mouse = (e: PointerEvent, kind: 'move' | 'down' | 'up', clicks: number) => {
    const link = linkRef.current;
    const p = link && toPage(link.canvas, link.meta, e.clientX, e.clientY);
    if (!p) return null;
    const button: BrowserButton = kind === 'move' ? (e.buttons & 1 ? 'left' : e.buttons & 4 ? 'middle' : e.buttons & 2 ? 'right' : 'none') : BUTTONS[e.button] ?? 'left';
    const msg: MouseMsg = { type: 'mouse', kind, x: p.x, y: p.y, button, buttons: e.buttons, clicks, mods: mods(e), dx: 0, dy: 0 };
    return { msg, inside: p.inside };
  };

  const onPointerDown = (e: PointerEvent<HTMLCanvasElement>) => {
    keysRef.current?.focus({ preventScroll: true });
    const now = performance.now();
    const r = mouse(e, 'down', 1);
    if (!live || !r?.inside) return;
    const l = last.current;
    const n = l.b === e.button && now - l.t < 500 && Math.hypot(r.msg.x - l.x, r.msg.y - l.y) < 5 ? Math.min(l.n + 1, 3) : 1;
    last.current = { t: now, x: r.msg.x, y: r.msg.y, b: e.button, n };
    e.currentTarget.setPointerCapture(e.pointerId);
    flushMove();
    send({ ...r.msg, clicks: n });
  };
  const onPointerUp = (e: PointerEvent<HTMLCanvasElement>) => {
    if (!live || !e.currentTarget.hasPointerCapture(e.pointerId)) return;
    const r = mouse(e, 'up', last.current.n);
    flushMove();
    if (r) send(r.msg);
  };
  const onPointerMove = (e: PointerEvent<HTMLCanvasElement>) => {
    if (!live) return;
    const r = mouse(e, 'move', 0);
    if (!r || (!r.inside && !e.buttons)) return;
    move.current = r.msg;
    raf.current ||= requestAnimationFrame(flushMove);
  };

  // Keys go to the page; stopping propagation keeps the app's shortcuts (Esc stops a turn) out of it.
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>, kind: 'down' | 'up') => {
    e.stopPropagation();
    if (e.nativeEvent.isComposing || e.key === 'Process' || e.key === 'Dead' || e.key === 'Unidentified') return;
    // Paste goes through the paste event, which carries the local clipboard.
    if (kind === 'down' && (e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'v') return;
    e.preventDefault();
    const printable = [...e.key].length === 1 && !e.ctrlKey && !e.metaKey;
    const text = kind === 'up' ? '' : e.key === 'Enter' ? '\r' : printable ? e.key : '';
    send({ type: 'key', kind, key: e.key, code: e.code, keyCode: e.keyCode, text, mods: mods(e), location: e.location, repeat: e.repeat });
  };

  const go = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const url = toUrl(draft ?? '');
    if (url) send({ type: 'navigate', url });
    setDraft(null);
    e.currentTarget.querySelector('input')?.blur();
  };

  const start = () => send({ type: 'start' });
  const stop = () => send({ type: 'stop' });
  const running = status === 'live' || status === 'starting';
  // Stopped and not held means the server is about to start it for this open panel.
  const shown = status === 'stopped' && !st?.held ? 'starting' : status;
  // The profile is open as a window on the desktop (ClaudeSetup), so the panel has no Chrome of its own meanwhile.
  const desk = status !== 'link' && !!st?.setupWindow;
  const sub = desk ? 'Setup window open' : shown === 'link' ? 'Connecting…' : shown === 'starting' ? 'Starting…' : shown === 'stopped' ? 'Stopped' : shown === 'error' ? 'Could not start' : st?.engine ?? '';
  const rec = st?.rec ?? null;
  const saved = st?.saved && st.saved.path !== dismissed ? st.saved : null;
  const recError = st?.recError && st.recError !== dismissed ? st.recError : null;
  // The setup card needs the agents switch on and a panel that can host Claude in Chrome here.
  const step = st?.agents && !st.unavailable?.claude && st.claude ? setupStep(st.claude) : null;
  const setup = step && setupOff !== step ? step : null;
  const showSetup = (on: boolean) => {
    dismissStep(on ? null : step);
    setSetupOff(on ? null : step);
  };

  return (
    <>
      <section
        ref={boxEl} className={`brw${full ? ' full' : ''}`} aria-label="Browser"
        onFocus={(e) => setFocus(e.target === keysRef.current ? 'keys' : e.target instanceof HTMLInputElement ? 'url' : null)}
        onBlur={() => setFocus(null)}
      >
        <div className="brw-top">
          <b>Browser</b><small title={sub}>{sub}</small>
          <span className="brw-tools" aria-label="Tools on this browser">
            {TOOLS.map(([key, short, name]) => {
              const on = !!st?.tools.includes(key);
              const na = st?.unavailable?.[key];
              const unset = key === 'claude' && !!step;
              const note = na ?? (lit === key ? 'acting now' : on ? 'on in a running session' : unset ? 'not set up in this browser' : 'off');
              const cls = `brw-tool${on ? ' on' : ''}${lit === key ? ' lit' : ''}${na ? ' na' : ''}`;
              // With the setup card dismissed, the badge brings it back.
              if (unset && !setup) {
                return <button key={key} type="button" className={`${cls} unset`} title={`${name} · ${note} · show setup`} onClick={() => showSetup(true)}><i aria-hidden="true"></i>{short}</button>;
              }
              return <span key={key} className={`${cls}${unset ? ' unset' : ''}`} title={`${name} · ${note}`}><i aria-hidden="true"></i>{short}</span>;
            })}
          </span>
          <label className="brw-agents" title={AGENTS_HINT}>
            <span>Agents</span>
            <button
              type="button" role="switch" className="mcp-sw" aria-checked={!!st?.agents} aria-label="Use the Browser panel for agents" disabled={!st}
              onClick={() => send({ type: 'agents', on: !st?.agents })}
            >
              <i></i>
            </button>
          </label>
          {rec ? (
            <button
              type="button" className={`brw-rec${rec.saving ? ' saving' : ''}`} disabled={rec.saving}
              aria-label={rec.saving ? 'Saving the recording' : 'Stop recording'} title={rec.saving ? 'Saving the recording…' : `Stop recording${rec.title ? ` · ${rec.title}` : ''}`}
              onClick={() => send({ type: 'record', on: false })}
            >
              <i aria-hidden="true"></i>{rec.saving ? 'Saving…' : <Elapsed since={rec.since} />}
            </button>
          ) : (
            <button className="min" aria-label="Record a video of this tab" title={st?.recWhy ?? 'Record a video of this tab'} disabled={!live} onClick={() => send({ type: 'record', on: true })}>
              <RecIcon />
            </button>
          )}
          <button className="min" aria-label={running ? 'Stop the browser' : 'Start the browser'} title={running ? 'Stop the browser' : 'Start the browser'} onClick={running ? stop : start}>
            <PowerIcon />
          </button>
          <button className="min expand" aria-pressed={full} aria-label={full ? 'Exit full screen' : 'Full screen'} title={full ? 'Exit full screen (esc)' : 'Full screen'} onClick={() => fullscreen(!full)}>
            <ExpandIcon out={full} />
          </button>
          <button className="min" aria-label="Collapse the browser" title="Collapse" onClick={close}>
            <svg width="10" height="10" viewBox="0 0 10 10"><path d="M1 5h8" /></svg>
          </button>
        </div>
        <div className="brw-bar">
          <button type="button" className="brw-nav" aria-label="Back" title="Back" disabled={!live || !st?.canBack} onClick={() => send({ type: 'back' })}><ChevLeft /></button>
          <button type="button" className="brw-nav" aria-label="Forward" title="Forward" disabled={!live || !st?.canForward} onClick={() => send({ type: 'forward' })}><ChevRight /></button>
          <button type="button" className={`brw-nav${st?.loading ? ' busy' : ''}`} aria-busy={!!st?.loading} aria-label="Reload" title="Reload" disabled={!live} onClick={() => send({ type: 'reload' })}><ReloadIcon /></button>
          <form className="brw-url" onSubmit={go}>
            <input
              value={draft ?? (active && !blank(active.url) ? active.url : '')} placeholder="Search or enter address" aria-label="Address"
              spellCheck={false} autoComplete="off" disabled={!live}
              onChange={(e) => setDraft(e.target.value)}
              onFocus={(e) => {
                setDraft(e.currentTarget.value);
                e.currentTarget.select();
              }}
              onBlur={() => setDraft(null)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key !== 'Escape') return;
                setDraft(null);
                e.currentTarget.blur();
              }}
            />
          </form>
          {/* Full screen covers the composer the pick fills in. */}
          <QaMenu onPick={() => full && fullscreen(false)} />
        </div>
        {st?.unavailable?.claude && <p className="brw-note" title={st.unavailable.claude}>{st.unavailable.claude}</p>}
        {setup && st?.claude && <ClaudeSetup c={st.claude} step={setup} live={live} windowOpen={st.setupWindow} windowError={st.setupError} send={send} onDismiss={() => showSetup(false)} />}
        {(saved || recError) && !rec && (
          <div className={`brw-saved${recError ? ' bad' : ''}`}>
            {recError ? (
              <span title={recError}>Recording failed: {recError}</span>
            ) : saved && (
              <>
                <button type="button" className="brw-link" title="Play the recording" onClick={() => setPlaying(saved)}>Recording saved</button>
                <span className="mono" title={saved.path}>{tilde(saved.path, home)} · {clock(saved.ms)}</span>
              </>
            )}
            <button type="button" className="brw-x" aria-label="Dismiss" title="Dismiss" onClick={() => setDismissed(recError ?? saved?.path ?? '')}><XIcon /></button>
          </div>
        )}
        {live && (
          <div className="brw-tabs" role="tablist" aria-label="Tabs">
            {st!.tabs.map((t) => (
              <div key={t.id} className={`brw-tab${t.id === st!.active ? ' on' : ''}`} title={t.url}>
                <button type="button" role="tab" aria-selected={t.id === st!.active} onClick={() => send({ type: 'tab-select', id: t.id })}>{tabLabel(t)}</button>
                <button type="button" className="brw-x" aria-label={`Close ${tabLabel(t)}`} title="Close tab" onClick={() => send({ type: 'tab-close', id: t.id })}><XIcon /></button>
              </div>
            ))}
            <button type="button" className="brw-new" aria-label="New tab" title="New tab" onClick={() => send({ type: 'tab-new' })}><PlusIcon /></button>
          </div>
        )}
        <div ref={stageRef} className={`brw-stage${focus === 'keys' ? ' typing' : ''}`}>
          <canvas
            ref={canvasRef} className={live && framed ? 'on' : ''}
            onPointerDown={onPointerDown} onPointerUp={onPointerUp} onPointerMove={onPointerMove}
            onMouseDown={(e) => e.preventDefault()} onContextMenu={(e) => e.preventDefault()}
          />
          <div ref={cursorRef} className="brw-cursor" aria-hidden="true">
            <i />
            <svg width="14" height="20" viewBox="0 0 14 20"><path d="M1 1v14.6l3.7-3.5 2.5 5.8 2.6-1.1-2.5-5.7h5.2z" /></svg>
            <b />
          </div>
          <textarea
            ref={keysRef} className="brw-keys" aria-label="Type into the page" tabIndex={-1} autoCapitalize="off" autoCorrect="off" spellCheck={false}
            onKeyDown={(e) => onKey(e, 'down')} onKeyUp={(e) => onKey(e, 'up')}
            onPaste={(e) => {
              e.preventDefault();
              e.stopPropagation();
              const text = e.clipboardData.getData('text/plain');
              if (text.length > BROWSER_TEXT_MAX) {
                useStore.setState({ notice: `That text is too long to paste into the browser (${text.length.toLocaleString()} characters; the limit is ${BROWSER_TEXT_MAX.toLocaleString()}).`, noticeInfo: false });
                return;
              }
              if (text) send({ type: 'text', text });
            }}
            onCompositionEnd={(e) => {
              if (e.data) send({ type: 'text', text: e.data });
              e.currentTarget.value = '';
            }}
            onInput={(e) => {
              if (!(e.nativeEvent as InputEvent).isComposing) e.currentTarget.value = '';
            }}
          />
          {playing && (
            <div className="brw-play" role="dialog" aria-label="Recording">
              <div className="brw-play-bar">
                <b title={playing.title ?? undefined}>{playing.title || 'Recording'}</b>
                <button
                  type="button" className="brw-link" title="Delete this recording from disk"
                  onClick={() => {
                    send({ type: 'record-delete', path: playing.path });
                    setPlaying(null);
                  }}
                >
                  Delete
                </button>
                <button type="button" className="brw-x" aria-label="Close the recording" title="Close (esc)" onClick={() => setPlaying(null)}><XIcon /></button>
              </div>
              <RecVideo key={playing.path} v={playing} autoPlay fill />
            </div>
          )}
          {!(live && framed) && (
            <div className="brw-state" role="status">
              {desk ? (
                <>
                  <b>Finish setup in the Chrome window, then close it</b>
                  <p>The browser comes back here once that window is closed.</p>
                  <button type="button" className="brw-link" onClick={() => send({ type: 'setup-window', open: false })}>Close the window</button>
                </>
              ) : shown === 'error' ? (
                <>
                  <b>Chrome could not start</b>
                  {st?.error && <p>{st.error}</p>}
                  <button type="button" className="set-btn" onClick={start}>Try again</button>
                </>
              ) : shown === 'stopped' ? (
                <>
                  <b>The browser is stopped</b>
                  <button type="button" className="set-btn" onClick={start}>Start</button>
                </>
              ) : (
                <>
                  <Led size="sm" pattern="calm" />
                  <span>{shown === 'link' ? 'Connecting…' : shown === 'starting' ? 'Starting Chrome…' : 'Loading…'}</span>
                </>
              )}
            </div>
          )}
        </div>
      </section>
      <div className={`scrim${full ? ' on' : ''}`} aria-hidden="true" onClick={() => fullscreen(false)} />
    </>
  );
}
