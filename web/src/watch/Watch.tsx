import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { currentSummary, useStore } from '../store.ts';
import { usePref } from '../prefs.ts';
import { useEscape } from '../bits.tsx';
import { onTheme, tick } from '../led.tsx';
import { Rig, clamp, type RobotState } from '../robot.tsx';
import { MOVES } from '../robotDirector.ts';
import type { AnyPattern } from '../led.tsx';
import { LAG, WatchModel, type CatchUp, type Station } from './model.ts';
import { camTarget, legAt, loco, processing, stateFor, type Seen } from './director.ts';
import { DH, G, World, checkText, latestChecks, shownAt, visibleRows, type Hit, type Info } from './world.ts';
import { Track, ago } from './timeline.ts';
import { live as laneLive } from './lanes.ts';
import { setWatch, wallNow } from './open.ts';
import type { Pan } from './Side.tsx';

const Overview = lazy(() => import('./Overview.tsx'));
const Side = lazy(() => import('./Side.tsx'));

// A page in a folder: the Files view.
const FilesIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" aria-hidden="true">
    <path d="M2.5 1.5h4.5l2.5 2.5v6.5h-7zM7 1.5V4h2.5" />
  </svg>
);

// When the owner last looked at each session's watch (wall seconds), so a later open can say what changed since.
const SEEN_KEY = 'cw:watchSeen';
const SEEN_MAX = 50;
function readSeen(sid: string): number | null {
  try {
    const v = (JSON.parse(localStorage.getItem(SEEN_KEY) ?? '{}') as Record<string, unknown>)[sid];
    return typeof v === 'number' ? v : null;
  } catch {
    return null;
  }
}
function saveSeen(sid: string, w: number) {
  try {
    const all = JSON.parse(localStorage.getItem(SEEN_KEY) ?? '{}') as Record<string, number>;
    delete all[sid];
    all[sid] = w;
    const keys = Object.keys(all);
    if (keys.length > SEEN_MAX) for (const k of keys.sort((a, b) => all[a] - all[b]).slice(0, keys.length - SEEN_MAX)) delete all[k];
    localStorage.setItem(SEEN_KEY, JSON.stringify(all));
  } catch {
    // Storage full or blocked: the next open just shows no catch-up.
  }
}

// "3 steps done · 2 agents returned, 1 failed · 1 error · 7 files changed · tsc ok"; '' when nothing happened.
function catchText(c: CatchUp) {
  const out: string[] = [];
  const n = (k: number, w: string) => `${k} ${w}${k === 1 ? '' : 's'}`;
  if (c.steps.length) out.push(`${n(c.steps.length, 'step')} done`);
  let ok = 0, bad = 0, stop = 0;
  for (const a of c.agents) a.fin === 'failed' ? bad++ : a.fin === 'stopped' ? stop++ : ok++;
  const ag = [ok && `${n(ok, 'agent')} returned`, bad && (ok ? `${bad} failed` : `${n(bad, 'agent')} failed`), stop && `${stop} stopped`].filter(Boolean);
  if (ag.length) out.push(ag.join(', '));
  if (c.errors.length) out.push(n(c.errors.length, 'error'));
  if (c.files.length) out.push(`${n(c.files.length, 'file')} changed`);
  for (const k of latestChecks(c.checks)) out.push(checkText(k));
  if (!out.length && c.actions) out.push(n(c.actions, 'action'));
  return out.join(' · ');
}

const hhmm = (w: number) => {
  const d = new Date(w * 1000), p = (v: number) => String(v).padStart(2, '0'), t = `${p(d.getHours())}:${p(d.getMinutes())}`;
  return d.toDateString() === new Date().toDateString() ? t : `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${t}`;
};

// Columns over a floor line: the Overview.
const OverviewIcon = () => (
  <svg width="13" height="12" viewBox="0 0 13 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
    <path d="M2.5 8.5v-3M6.5 8.5v-6M10.5 8.5v-4M1 10.5h11" />
  </svg>
);

// Watch mode: the current session as a robot walking a floor of stations, a few seconds behind live.
// One rAF loop (led.tsx's tick) drives the world canvas, the robot's own canvas, the scrubber and the HUD text; it sleeps when nothing moves.

const TOP = 56;
const BOTTOM = 64;
// The robot's canvas reach around its 512 box, in units: room for hops, the flip and the tumble.
const REACH = { l: 200, t: 200, w: 912, h: 912 };
const SPEEDS = [0.5, 1, 2] as const;
const PHASE_WORD: Record<string, string> = { explore: 'Exploring', build: 'Building', check: 'Checking' };
// Pan: px of travel before a press becomes a drag, ms of quiet before the camera goes back to him, rubber reach in view widths.
const DEAD = 6;
const IDLE = 3000;
const BAND = 0.12;
// Furthest the camera zooms out, as a share of the stage's own scale.
const Z_MIN = 0.2;
// The side panel's width and its gap to the right edge, as in .wt-pan; the camera keeps the robot left of it.
const PAN_W = 368;
const PAN_GAP = 12;
// lastSeen is saved this often while watching live.
const SEEN_MS = 30_000;

// live: view = now - LAG. behind: playing from an earlier moment at `speed`. return: gliding back to live. scrub: held on the timeline.
type Mode = 'live' | 'behind' | 'return' | 'scrub';
// follow: the camera frames him. free: the owner is looking around. back: springing back to him.
type Cam = 'follow' | 'free' | 'back';
type Drag = { id: number; x0: number; y0: number; cam0: number; moved: boolean; trail: [number, number][] };
type Hud = {
  prompt: HTMLElement; step: HTMLElement; pill: HTMLElement; now: HTMLElement; card: HTMLElement; sr: HTMLElement;
  when: HTMLElement; follow: HTMLElement; review: HTMLElement; seg: HTMLElement; offL: HTMLElement; offR: HTMLElement;
  agents: HTMLElement; agentsN: HTMLElement; catchT: HTMLElement;
};

// Progressive resistance past an edge: each extra unit of pull moves the view less.
const band = (o: number, c: number) => (o * c) / (o + c);

class Stage {
  m: WatchModel;
  w = new World();
  rig: Rig | null = null;
  // The Overview is open: the stage keeps its place and sleeps; onModel tells the Overview the session moved on.
  paused = false;
  onModel: (() => void) | null = null;
  // The side panel: what it shows (React renders it from onPan), its frame hook, and the px it covers on the right.
  pan: Pan | null = null;
  onPan: (p: Pan | null) => void = () => {};
  side: ((T: number) => void) | null = null;
  private panPx = 0;
  // Catch-up: when the owner last looked (read once at open), whether it was worked out, and the save timer.
  private sid: string;
  private seen0: number | null;
  private caught = false;
  private seenIv = 0;
  private root: HTMLElement;
  private cv: HTMLCanvasElement;
  private fly: HTMLCanvasElement;
  private fg: CanvasRenderingContext2D;
  private flyOn = false;
  private offerKey = '';
  private offAid = { l: '', r: '' };
  private offerFor = -1;
  private dismissed = -1;
  // The Overview is offered only for a turn that ended while watch was open.
  private sawWork = false;
  private sky: HTMLElement;
  private skyX = '';
  private g: CanvasRenderingContext2D;
  private host: HTMLElement;
  private hud: Hud;
  private track: Track;
  private stop: (() => void) | null = null;
  private still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  private mode: Mode = 'live';
  private speed = 1;
  private viewT = 0;
  private scrubGoal = 0;
  private scrubId: number | null = null;
  private cam: Cam = 'follow';
  private camV = 0;
  // Zoom: fitted to the live lanes until the owner zooms; the auto camera's eased shift to keep lanes or the
  // selected lane robot in view; whether lanes were live this frame.
  private zUser = false;
  private zGoal = 1;
  private lastZ = NaN;
  private shift = 0;
  private shiftGoal = 0;
  private lanesOn = false;
  private skyKey = '';
  private goal = 0;
  private resp = 0.5;
  private lim: [number, number] = [-Infinity, Infinity];
  private drag: Drag | null = null;
  private wheelAt = 0;
  private panAt = 0;
  private idleT = 0;
  private bot = { x: -1e4, y0: 0, y1: 0, hw: 0 };
  private ptr: { x: number; y: number } | null = null;
  private px0 = 150;
  private moving = false;
  private state: RobotState | null = null;
  private led: AnyPattern | null = null;
  private seen: Seen = { beats: new WeakSet(), sag: '' };
  private lastWorld = -1e9;
  private lastDrawT = NaN;
  private force = true;
  private lastCam = NaN;
  private lastTf = '';
  private hover: string | null = null;
  private hoverDirty = false;
  private cardOn = false;
  private cardKey = '';
  private srVer = -1;
  private text: Record<string, string> = {};
  private revOn = false;
  private freeOn = false;
  private stillT = 0;
  private stillRaf = 0;
  private offs: (() => void)[] = [];

  constructor(sid: string, root: HTMLElement, onExit: () => void) {
    const q = <T extends HTMLElement>(s: string) => root.querySelector<T>(s)!;
    this.root = root;
    this.cv = q<HTMLCanvasElement>('canvas.wt-world');
    this.sky = q('.wt-sky');
    this.g = this.cv.getContext('2d')!;
    this.fly = q<HTMLCanvasElement>('canvas.wt-fly');
    this.fg = this.fly.getContext('2d')!;
    this.host = q('.wt-bot');
    this.hud = {
      prompt: q('.wt-prompt'), step: q('.wt-step'), pill: q('.wt-pill'), now: q('.wt-now'), card: q('.wt-card'), sr: q('ol.sr'),
      when: q('.wt-when'), follow: q('.wt-follow'), review: q('.wt-review'), seg: q('.wt-seg'), offL: q('.wt-off.l'), offR: q('.wt-off.r'),
      agents: q('.wt-agents'), agentsN: q('.wt-agents span'), catchT: q('.wt-catch-t'),
    };
    this.hud.review.inert = this.hud.follow.inert = true;
    this.track = new Track(q('.wt-track'));
    this.sid = sid;
    this.seen0 = readSeen(sid);
    this.seenIv = window.setInterval(() => this.mode === 'live' && !document.hidden && saveSeen(sid, wallNow()), SEEN_MS);
    this.m = new WatchModel(sid);
    this.m.viewNow = () => this.viewT;
    this.m.onChange = () => {
      this.catchUp();
      this.wake();
      this.onModel?.();
    };
    this.m.onAgents = () => {
      this.force = true;
      this.wake();
      this.onModel?.();
    };
    this.m.onClose = onExit;
    this.m.onRebuild = this.rebuilt;
    this.w.theme();
    this.viewT = this.track.t1 = this.liveT();
    this.syncSpeed();
    const ro = new ResizeObserver((es) => {
      const r = es[es.length - 1].contentRect;
      this.layout(r.width, r.height);
    });
    ro.observe(root);
    const tro = new ResizeObserver((es) => {
      const r = es[es.length - 1].contentRect;
      this.track.layout(r.width, r.height, this.track.el.getBoundingClientRect().left, Math.min(2, devicePixelRatio || 1));
      this.force = true;
      this.wake();
    });
    tro.observe(this.track.el);
    this.offs.push(() => (ro.disconnect(), tro.disconnect()));
    this.offs.push(onTheme(() => this.retheme()));
    const on = <K extends keyof HTMLElementEventMap>(el: HTMLElement | Document, type: K, fn: (e: HTMLElementEventMap[K]) => void, o?: AddEventListenerOptions) => {
      el.addEventListener(type, fn as EventListener, o);
      this.offs.push(() => el.removeEventListener(type, fn as EventListener, o));
    };
    on(this.cv, 'pointerdown', this.down);
    on(this.cv, 'pointermove', this.move);
    on(this.cv, 'pointerup', this.up);
    on(this.cv, 'pointercancel', this.up);
    on(this.cv, 'pointerleave', this.leave);
    on(this.cv, 'wheel', this.wheel, { passive: false });
    const tr = this.track.el;
    on(tr, 'pointerdown', this.tdown);
    on(tr, 'pointermove', this.tmove);
    on(tr, 'pointerup', this.tup);
    on(tr, 'pointercancel', this.tup);
    on(tr, 'pointerleave', this.tleave);
    on(document, 'keydown', this.key);
    const mq = matchMedia('(prefers-reduced-motion: reduce)');
    const onMq = () => {
      this.still = mq.matches;
      this.buildRig();
      this.wake();
    };
    mq.addEventListener('change', onMq);
    this.offs.push(() => mq.removeEventListener('change', onMq));
    const onVis = () => {
      if (document.hidden) return;
      // Back from a hidden tab: he skips what he missed instead of replaying it.
      this.rig?.stopMove();
      this.wake();
    };
    document.addEventListener('visibilitychange', onVis);
    this.offs.push(() => document.removeEventListener('visibilitychange', onVis));
  }

  dispose() {
    this.stop?.();
    this.stop = null;
    clearTimeout(this.stillT);
    clearTimeout(this.idleT);
    cancelAnimationFrame(this.stillRaf);
    clearInterval(this.seenIv);
    saveSeen(this.sid, wallNow());
    for (const f of this.offs) f();
    this.m.dispose();
    this.rig?.destroy();
    this.host.replaceChildren();
  }

  private liveT() {
    return this.m.now() - LAG;
  }

  // Real seconds between a view time and live, idle cuts included.
  private behind(T: number) {
    return this.m.wallOf(this.liveT()) - this.m.wallOf(T);
  }

  // The model was rebuilt (the timeline came, or an older page): every time moved, so stay on the same wall moment.
  private rebuilt = (wall: number) => {
    const live = this.mode === 'live' || this.mode === 'return';
    this.viewT = live ? this.liveT() : this.clampT(this.m.modelOf(wall));
    this.scrubGoal = this.viewT;
    if (live) this.mode = 'live';
    // Floor positions changed too, so a panned camera goes back to him.
    if (this.cam !== 'follow') (this.cam = 'follow'), (this.camV = 0);
    this.track.t1 = this.liveT();
    this.track.invalidate();
    this.seen = { beats: new WeakSet(), sag: '' };
    this.w.floorEnd = 0;
    this.lastCam = NaN;
    this.force = true;
    this.rig?.stopMove();
    this.paint();
  };

  retheme() {
    this.w.theme();
    this.track.invalidate();
    this.force = true;
    this.wake();
    this.onModel?.();
  }

  private layout(cw: number, ch: number) {
    const dpr = Math.min(2, devicePixelRatio || 1);
    this.cv.width = this.fly.width = Math.round(cw * dpr);
    this.cv.height = this.fly.height = Math.round(ch * dpr);
    this.flyOn = false;
    this.w.layout({ x: 0, y: TOP, w: cw, h: Math.max(200, ch - TOP - BOTTOM) }, dpr);
    this.w.fitCamY();
    this.panPx = this.panWidth();
    this.skyKey = this.skyX = '';
    if (!this.rig) this.buildRig();
    this.lastCam = NaN;
    this.force = true;
    this.wake();
  }

  private buildRig() {
    this.rig?.destroy();
    this.px0 = 150 * this.w.s;
    this.rig = new Rig(this.host, { level: 'full', px: this.px0, tile: false, still: this.still, reach: REACH, cue: () => {}, driven: true });
    const cv = this.rig.cv!;
    const u = this.px0 / 512;
    cv.style.cssText = `position:absolute;left:0;top:0;width:${REACH.w * u}px;height:${REACH.h * u}px;transform-origin:0 0;will-change:transform;pointer-events:none`;
    this.state = this.led = null;
    this.lastTf = '';
  }

  // ---- Clock controls ----
  setSpeed(v: number) {
    this.speed = v;
    if (v < 1 && this.mode === 'live') this.mode = 'behind';
    this.syncSpeed();
    this.paint();
  }

  private syncSpeed() {
    for (const b of this.hud.seg.querySelectorAll<HTMLElement>('button')) b.setAttribute('aria-pressed', String(Number(b.dataset.v) === this.speed));
  }

  goLive = () => {
    if (this.mode !== 'live') this.mode = this.still ? 'live' : 'return';
    this.speed = 1;
    this.syncSpeed();
    if (this.cam === 'free') this.recenter();
    this.paint();
  };

  // Review from a moment: playback continues from there at the chosen speed.
  private seek(t: number) {
    const lt = this.liveT();
    if (t >= lt - 0.05) return this.goLive();
    this.viewT = clamp(t, this.m.startT, lt);
    this.mode = 'behind';
    this.force = true;
    if (this.cam === 'free') this.recenter();
    this.paint();
  }

  seekTo = (t: number) => this.seek(t);

  // At or gliding back to the live edge.
  get atLive() {
    return this.mode === 'live' || this.mode === 'return';
  }

  // ←/→: the previous or next station's arrival; past the last one is live.
  private stepStation(dir: number) {
    const m = this.m, T = this.viewT;
    let to = NaN;
    if (dir < 0) {
      for (let i = m.routeLen - 1; i >= 1 && Number.isNaN(to); i--) if (m.stations[i].arr < T - 0.6) to = m.stations[i].arr;
      this.seek(Number.isNaN(to) ? m.startT : to + 0.05);
    } else {
      for (let i = 1; i < m.routeLen && Number.isNaN(to); i++) if (m.stations[i].arr > T + 0.1) to = m.stations[i].arr;
      if (Number.isNaN(to)) this.goLive();
      else this.seek(to + 0.05);
    }
  }

  // Follow (button, F): back to him with the live lanes fitted; an open subagent panel closes with it.
  follow = () => {
    if (this.w.sel) this.setPan(null);
    this.recenter();
  };

  // Back to the auto camera without touching the panel: it frames him, or the subagent whose panel is open.
  private recenter() {
    clearTimeout(this.idleT);
    this.idleT = 0;
    this.zUser = false;
    this.force = true;
    if (this.cam === 'follow') return void this.paint();
    this.cam = this.still ? 'follow' : 'back';
    this.paint();
  }

  // On a narrow window the panel covers most of it; the camera still keeps 40% of the width to frame with.
  private panWidth() {
    const a = this.w.area.w;
    return this.pan ? Math.min(PAN_W + 2 * PAN_GAP, 0.6 * a) : 0;
  }

  // Opens the side panel on an agent or the files view (null closes it); a subagent's panel also points the camera at it.
  setPan = (p: Pan | null) => {
    const w = this.w, sub = p?.k === 'agent' && p.aid !== 'main' ? p.aid : '';
    this.pan = p;
    if (sub !== w.sel) {
      w.sel = sub;
      const q = sub ? w.poses.find((x) => x.lane.row.aid === sub) : undefined;
      // Zoomed in by hand past its lane: zoom out just enough to see it.
      if (q && this.zUser) this.zGoal = Math.min(this.zGoal, Math.max(Z_MIN, w.area.h / w.s / (DH - w.laneY(q.lane.slot) + 160)));
      if (sub && this.cam === 'free') this.cam = this.still ? 'follow' : 'back';
    }
    this.panPx = this.panWidth();
    this.root.toggleAttribute('data-pan', !!p);
    this.hideCard();
    this.onPan(p);
    this.force = true;
    this.paint();
  };

  // A click on a lane robot opens its panel; a second click closes it.
  private select(aid: string) {
    this.setPan(this.w.sel === aid ? null : { k: 'agent', aid });
  }

  // A click on him opens the main agent's panel, or closes it.
  private toMain() {
    const on = this.pan?.k === 'agent' && this.pan.aid === 'main';
    this.setPan(on ? null : { k: 'agent', aid: 'main' });
    if (!on && this.cam !== 'follow') this.recenter();
  }

  toggleFiles = () => this.setPan(this.pan?.k === 'files' ? null : { k: 'files' });

  // The header's running count: each click opens the next running agent's panel.
  nextAgent = () => {
    const run = this.w.poses.filter((p) => p.s === 'running').map((p) => p.lane.row.aid);
    if (!run.length) return;
    const at = this.pan?.k === 'agent' ? run.indexOf(this.pan.aid) : -1;
    this.setPan({ k: 'agent', aid: run[(at + 1) % run.length] });
  };

  // ---- Catch-up: what happened since the owner last looked, once the timeline has loaded. ----
  private catchFrom = 0;
  private catchUp() {
    const m = this.m;
    // The backlog runs on a made-up clock, so a span of real time means nothing there.
    if (this.caught || m.source !== 'timeline') return;
    this.caught = true;
    if (this.seen0 === null) return;
    const text = catchText(m.catchUp(this.seen0, wallNow()));
    if (!text) return;
    this.catchFrom = this.seen0;
    this.hud.catchT.textContent = this.hud.catchT.title = `Since ${hhmm(this.seen0)}: ${text}`;
    this.root.toggleAttribute('data-catch', true);
  }

  dismissCatch = () => this.root.removeAttribute('data-catch');

  replayCatch = () => {
    this.dismissCatch();
    this.seek(this.clampT(this.m.modelOf(this.catchFrom)));
  };

  // ---- Loop ----
  wake = () => {
    if (this.paused) return;
    if (this.still) return this.stillFrame();
    if (this.stop || document.hidden) return;
    this.stop = tick(this.frame);
  };

  // The Overview covers the stage: no frames while it is open, and the same place and view time when it closes.
  setPaused(on: boolean) {
    this.paused = on;
    if (on) {
      this.stop?.();
      this.stop = null;
      this.hover = null;
      this.hideCard();
      return;
    }
    this.force = true;
    this.lastCam = NaN;
    this.paint();
  }

  get T() {
    return this.viewT;
  }

  // The live view time, or the reviewed moment.
  overviewT() {
    return this.mode === 'live' || this.mode === 'return' ? this.liveT() : this.viewT;
  }

  dismissOffer = () => {
    this.dismissed = this.offerFor;
    this.root.removeAttribute('data-offer');
    this.offerKey = '';
  };

  // The edge marker's click: the camera goes to the nearest running agent off that side.
  toOff = (side: 'l' | 'r') => {
    const aid = this.offAid[side];
    if (aid) this.setPan({ k: 'agent', aid });
  };

  // Running agents the camera could not fit: a marker on each edge they are past, with a count.
  private offscreen(T: number) {
    const w = this.w, h = this.hud, a = w.area;
    let nl = 0, nr = 0, dl = Infinity, dr = Infinity, al = '', ar = '';
    for (const p of w.poses) {
      if (p.s !== 'running' || p.body <= 0 || !laneLive(p, T)) continue;
      const sx = (p.x - w.cam) * w.k, right = a.w - this.panPx;
      if (sx < 24) (nl++, -sx < dl && ((dl = -sx), (al = p.lane.row.aid)));
      else if (sx > right - 24) (nr++, sx - right < dr && ((dr = sx - right), (ar = p.lane.row.aid)));
    }
    this.offAid.l = al;
    this.offAid.r = ar;
    const word = (n: number) => (n ? `${n} agent${n > 1 ? 's' : ''}` : '');
    this.set(h.offL, 'offL', word(nl));
    this.set(h.offR, 'offR', word(nr));
    h.offL.toggleAttribute('data-on', nl > 0);
    h.offR.toggleAttribute('data-on', nr > 0);
  }

  // Input wants a frame now; under reduced motion that is one still frame on the next rAF, not a loop.
  private paint() {
    if (this.paused) return;
    if (!this.still) return this.wake();
    clearTimeout(this.stillT);
    this.stillT = 0;
    if (!this.stillRaf) this.stillRaf = requestAnimationFrame(() => ((this.stillRaf = 0), this.stillPaint()));
  }

  // Reduced motion: no loop; a settled still frame at each change, at most four a second.
  private stillFrame() {
    if (this.stillT || this.stillRaf) return;
    this.stillT = window.setTimeout(() => ((this.stillT = 0), this.stillPaint()), 250);
  }

  private stillPaint() {
    const m = this.m;
    if (this.mode === 'live' || this.mode === 'return') {
      this.mode = 'live';
      let end = this.liveT();
      for (let i = Math.max(0, m.routeLen - 2); i < m.routeLen; i++) end = Math.max(end, m.stations[i].arr + 1, m.stations[i].lastTv + 1);
      this.viewT = end;
    } else if (this.mode === 'scrub') this.viewT = this.scrubGoal;
    this.w.still = true;
    this.force = true;
    this.step(0, this.viewT);
  }

  private frame = (dt: number) => {
    const live = this.liveT();
    if (this.mode === 'live') this.viewT = live;
    else if (this.mode === 'return') {
      const gap = live - this.viewT;
      this.viewT += Math.max(gap * (1 - Math.exp(-dt / 0.22)), Math.min(gap, dt * 12));
      if (live - this.viewT < 0.05) (this.mode = 'live'), (this.viewT = live);
    } else if (this.mode === 'scrub') {
      // Held on the timeline: the view chases the finger closely, so a far click rewinds visibly instead of cutting.
      // Across more than a couple of stations (a long history) the rewind means nothing, so it cuts.
      const gap = this.scrubGoal - this.viewT;
      const far = Math.abs(legAt(this.m, this.scrubGoal) - legAt(this.m, this.viewT)) > 2;
      this.viewT = Math.abs(gap) < 0.01 || far ? this.scrubGoal : this.viewT + gap * (1 - Math.exp(-dt / 0.06));
      // Released (a click lands here too): once the view reaches the spot, playback continues from it.
      if (this.scrubId === null && this.viewT === this.scrubGoal) this.mode = 'behind';
    } else {
      this.viewT = Math.min(live, this.viewT + dt * this.speed);
      if (this.viewT >= live - 0.01 && this.speed >= 1) this.mode = 'live';
    }
    this.w.still = false;
    const busy = this.step(dt, this.viewT);
    if (!busy && this.stop) (this.stop(), (this.stop = null));
  };

  // One view time: pose the robot, move the camera, repaint what changed. Returns whether anything still moves.
  private step(dt: number, T: number) {
    const m = this.m, w = this.w, r = this.rig;
    if (!r || !m.stations.length) {
      this.set(this.hud.now, 'now', m.source === 'wait' ? 'Loading the session…' : '');
      return false;
    }
    const scrub = this.mode === 'scrub';
    // The view reached the oldest loaded moment: the page before it loads and the model rebuilds around the view.
    if (m.before !== null && (T < m.startT + 20 || w.cam < m.stations[0].x)) m.loadOlder();
    // Held on the timeline, text settles instead of scrambling as it passes.
    w.live = !scrub;
    const L = loco(m, T);
    const at = m.stations[L.at];
    const act = m.activityAt(T);
    const sdt = dt * (this.mode === 'behind' ? this.speed : 1);
    const want = stateFor(act, L.moving, at && !Number.isNaN(at.done) ? T - at.done : 99);
    // Leaving a station cuts whatever reaction is still playing; the springs ease it out.
    if (L.moving && !this.moving) r.stopMove();
    if (want.s !== this.state || want.led !== this.led) {
      this.state = want.s;
      this.led = want.led;
      r.set(want.s, want.led, { quiet: true });
    }
    if (!L.moving && this.moving && at?.kind === 'ask' && !this.still && !scrub) r.play('surprised', MOVES.surprised, 'watch');
    this.moving = L.moving;
    const goff = r.goff;
    for (const k in goff) delete goff[k];
    if (L.o) Object.assign(goff, L.o);
    // The wheel fold is a spring in the rig; drive it directly so it follows T exactly.
    const cw = r.C.w;
    if (cw.x !== L.w || cw.t !== L.w) (cw.x = cw.t = L.w), (cw.v = 0), (cw.ok = true);
    const working = m.workingAt(T);
    w.lanes(m, T);
    if (!this.still) {
      const landed: number[] = [];
      w.landings(T, landed);
      processing(m, T, L, r, goff, this.seen, working, landed);
      r.step(sdt);
    } else r.render();
    const fe = w.floorTarget(m, T);
    w.floorEnd = this.still || !w.floorEnd ? fe : w.floorEnd + (fe - w.floorEnd) * (1 - Math.exp(-dt / 0.3));
    const settling = Math.abs(fe - w.floorEnd) > 0.5;
    const fit = w.laneFit(T);
    this.lanesOn = !!fit;
    const zBusy = this.zoom(dt, fit, L.x);
    const tx = this.target(dt, T, L.x, fit);
    const camBusy = this.camera(dt, tx) || zBusy || this.shift !== this.shiftGoal;
    const camMoved = Math.abs(w.cam - this.lastCam) > 0.01 || w.z !== this.lastZ;
    this.lastCam = w.cam;
    this.lastZ = w.z;
    const sk = w.skyBox();
    const skk = `${sk.top.toFixed(1)}|${sk.h.toFixed(1)}|${sk.step.toFixed(2)}`;
    if (skk !== this.skyKey) {
      this.skyKey = skk;
      this.sky.style.cssText = `top:${sk.top.toFixed(1)}px;height:${sk.h.toFixed(1)}px;width:${w.area.w + sk.step}px;background-size:${sk.step}px ${sk.step}px`;
      this.skyX = '';
    }
    const skx = `translate3d(${sk.x.toFixed(1)}px,${sk.dy.toFixed(1)}px,0)`;
    if (skx !== this.skyX) (this.sky.style.transform = skx), (this.skyX = skx);
    const fresh = freshAt(m, T);
    const now = performance.now();
    // The world repaints every frame while the camera or a scrub moves, at 20 fps while something on it animates, else never.
    if (this.force || this.still || camMoved || settling || this.hoverDirty || (scrub && T !== this.lastDrawT) || T >= w.next || ((fresh < 0.9 || w.anim) && now - this.lastWorld >= 48) || (w.faces && now - this.lastWorld >= 98)) {
      w.draw(this.g, m, T, L.x);
      // The camera slid under a resting pointer: what it is over has changed.
      if (camMoved && this.ptr && !this.drag?.moved) this.pointer(this.ptr.x, this.ptr.y);
      this.front();
      this.lastWorld = now;
      this.lastDrawT = T;
      this.force = false;
      this.hoverDirty = false;
    }
    const S = w.k, k = S / (this.px0 / 150);
    const u = (this.px0 / 512) * k;
    const sx = w.area.x + (L.x - w.cam) * S, oy = w.area.y - w.camY * S;
    const x = sx - (REACH.l + 256) * u;
    const y = oy + (400 + 1) * S - (REACH.t + 443) * u;
    const tf = `translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0) scale(${k.toFixed(4)})`;
    if (tf !== this.lastTf) (r.cv!.style.transform = tf), (this.lastTf = tf);
    this.bot = { x: sx, y0: oy + (G - 175) * S, y1: oy + (G + 4) * S, hw: 62 * S };
    // Agent faces in the air sit above him, on their own canvas; it is cleared once when the last one lands.
    const was = this.flyOn;
    if (was) this.fg.setTransform(1, 0, 0, 1, 0, 0), this.fg.clearRect(0, 0, this.fly.width, this.fly.height);
    this.flyOn = w.flights(this.fg, m, T, L.x);
    // An empty full-screen layer still costs compositing, so it is hidden between flights.
    if (this.flyOn !== was) this.fly.style.visibility = this.flyOn ? 'visible' : 'hidden';
    const trackBusy = this.timeline(dt, T, L.moving ? L.at + 1 : L.at);
    this.hudText(T, L.at, L.moving);
    this.flags();
    this.offscreen(T);
    this.offer(working);
    this.side?.(T);
    return working || w.anim || w.faces || this.flyOn || L.moving || r.busy() || camBusy || camMoved || settling || trackBusy || fresh < 1 || T < horizon(m) + 1 || w.next < Infinity || this.mode !== 'live';
  }

  // ---- Zoom: out on its own to fit the live lanes, until the owner zooms; the floor stays at the bottom. ----
  private zoom(dt: number, fit: ReturnType<World['laneFit']>, rx: number) {
    const w = this.w;
    if (!this.zUser) {
      let z = 1;
      if (fit) {
        const zy = w.area.h / w.s / (DH - fit.top + 12);
        const zx = (w.area.w - this.panPx) / w.s / (Math.max(fit.hi, rx + 260) - Math.min(fit.lo, rx - 420));
        // In steps of 1/32, so a lane growing by a step does not keep the whole stage rescaling.
        z = clamp(Math.floor(Math.min(1, zy, w.sel ? 1 : zx) * 32) / 32, Z_MIN, 1);
      }
      this.zGoal = z;
    }
    const g = this.zGoal;
    if (w.z !== g) {
      if (this.still || Number.isNaN(this.lastZ) || Math.abs(g - w.z) < 0.002) w.z = g;
      else w.z += (g - w.z) * (1 - Math.exp(-dt / 0.35));
    }
    w.fitCamY();
    return w.z !== g;
  }

  // Where the auto camera wants to be: framing him, then shifted (eased) to keep the live lanes or the selected
  // lane robot in view, so a new lane never makes the stage jump. An open side panel narrows the view (ve) and the
  // framing moves left of it through the same eased shift.
  private target(dt: number, T: number, rx: number, fit: ReturnType<World['laneFit']>) {
    const w = this.w, vw = w.vw, base = camTarget(this.m, T, vw), ve = vw - this.panPx / w.k;
    let x = base + 0.4 * (vw - ve);
    const sp = w.sel ? w.poses.find((q) => q.lane.row.aid === w.sel) : undefined;
    if (sp) x = sp.x - 0.4 * ve;
    else if (fit && !this.zUser) x = clamp(Math.max(Math.min(x, fit.lo - 40), fit.hi + 40 - ve), rx - 0.88 * ve, rx - 0.08 * ve);
    const want = (this.shiftGoal = x - base);
    this.shift =this.still || Math.abs(want - this.shift) < 0.5 ? want : this.shift + (want - this.shift) * (1 - Math.exp(-dt / 0.3));
    return base + this.shift;
  }

  // A turn that just ended live offers its Overview, until the next turn starts or the owner opens or dismisses it.
  private offer(working: boolean) {
    const m = this.m, key = `${m.version}|${working}|${this.mode === 'live'}`;
    if (key === this.offerKey) return;
    this.offerKey = key;
    let ask = -1, work = false;
    for (let i = m.routeLen - 1; i >= 1; i--) {
      const s = m.stations[i];
      if (s.kind === 'ask') (ask = s.id), (i = 0);
      else if (s.kind === 'step' || s.kind === 'phase') work = true;
    }
    this.offerFor = ask;
    if (working && this.mode === 'live') this.sawWork = true;
    const on = this.sawWork && !working && work && this.mode === 'live' && ask !== this.dismissed;
    this.root.toggleAttribute('data-offer', on);
  }

  // ---- Camera: follows him, or the owner's pan with a spring for flicks, edges and the trip back. ----
  private camera(dt: number, target: number) {
    const w = this.w, vw = w.vw, lo = Math.min(this.m.stations[0].x - 420 - 0.12 * vw, target);
    this.lim = [lo, Math.max(w.floorEnd - 0.88 * vw, target, lo)];
    if (this.cam === 'follow') {
      if (Number.isNaN(this.lastCam) || this.mode === 'live' || this.still || Math.abs(target - w.cam) > vw) w.cam = target;
      else w.cam += (target - w.cam) * (1 - Math.exp(-dt / 0.14));
      return false;
    }
    // Quiet for IDLE ms after the last pan input: back to him. The loop keeps ticking until then, at most IDLE.
    // With lanes live or a zoom of his own, the camera stays the owner's until Follow.
    if (this.cam === 'free' && !this.still && !this.drag?.moved && !this.mine() && now() - this.panAt >= IDLE) this.cam = 'back';
    if (this.cam === 'back') {
      if (this.still) {
        w.cam = target;
        this.cam = 'follow';
        return false;
      }
      // The whole stage moves: heavy and critically damped, starting from whatever velocity the pan left.
      this.spring(target, dt, 0.9);
      if (Math.abs(w.cam - target) < 0.5 && Math.abs(this.camV) < 8) (this.cam = 'follow'), (this.camV = 0), (w.cam = target);
      return true;
    }
    if (this.still) return false;
    if (this.drag?.moved) return true;
    const [a, b] = this.lim;
    // The wheel rested past an edge: settle back inside.
    if (now() - this.wheelAt > 160 && (this.goal < a || this.goal > b)) (this.goal = clamp(this.goal, a, b)), (this.resp = 0.45);
    if (w.cam !== this.goal || this.camV) this.spring(this.goal, dt, this.resp);
    return true;
  }

  // Critically damped spring on the camera, sub-stepped so a stiff wheel spring stays stable at any frame rate.
  private spring(goal: number, dt: number, resp: number) {
    const k = ((2 * Math.PI) / resp) ** 2, c = (4 * Math.PI) / resp;
    let x = this.w.cam, v = this.camV;
    for (let left = Math.min(dt, 0.1); left > 1e-6; left -= 1 / 240) {
      const h = Math.min(1 / 240, left);
      v += (-k * (x - goal) - c * v) * h;
      x += v * h;
    }
    if (Math.abs(x - goal) < 0.05 && Math.abs(v) < 1) (x = goal), (v = 0);
    this.w.cam = x;
    this.camV = v;
  }

  // A pan input restarts the idle wait; reduced motion has no loop, so a timer does the jump cut there.
  private touch() {
    this.panAt = now();
    if (!this.still) return;
    clearTimeout(this.idleT);
    this.idleT = window.setTimeout(this.idle, IDLE);
  }

  private idle = () => {
    this.idleT = 0;
    if (this.cam !== 'free' || this.mine()) return;
    if (this.drag?.moved) return this.touch();
    this.recenter();
  };

  // The camera stays where the owner put it: lanes are live, or he zoomed by hand.
  private mine() {
    return this.zUser || this.lanesOn;
  }

  private rubber(raw: number) {
    const [a, b] = this.lim, c = BAND * this.w.vw;
    if (this.still) return clamp(raw, a, b);
    return raw < a ? a - band(a - raw, c) : raw > b ? b + band(raw - b, c) : raw;
  }

  private down = (e: PointerEvent) => {
    if (e.button !== 0 || this.drag) return;
    this.cv.setPointerCapture(e.pointerId);
    this.drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, cam0: this.w.cam, moved: false, trail: [] };
  };

  private move = (e: PointerEvent) => {
    this.ptr = { x: e.clientX, y: e.clientY };
    const d = this.drag;
    if (!d || d.id !== e.pointerId) return this.pointer(e.clientX, e.clientY);
    if (!d.moved) {
      if (Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < DEAD) return;
      // Past the dead zone the floor is in his hand: start from here so it never jumps by the dead zone.
      Object.assign(d, { moved: true, x0: e.clientX, cam0: this.w.cam });
      this.cam = 'free';
      this.camV = 0;
      this.root.toggleAttribute('data-drag', true);
      this.hover = null;
      this.hoverDirty = true;
      this.hideCard();
    }
    const raw = d.cam0 - (e.clientX - d.x0) / this.w.k;
    this.w.cam = this.goal = this.rubber(raw);
    d.trail.push([now(), raw]);
    if (d.trail.length > 6) d.trail.shift();
    this.touch();
    this.paint();
  };

  private up = (e: PointerEvent) => {
    const d = this.drag;
    if (!d || d.id !== e.pointerId) return;
    this.drag = null;
    this.root.removeAttribute('data-drag');
    if (!d.moved) {
      if (e.type !== 'pointerup') return;
      const lane = this.laneAt(e.clientX, e.clientY);
      if (lane) return this.select(lane);
      if (this.onBot(e.clientX, e.clientY)) return this.toMain();
      // A click on the bare floor closes the side panel.
      if (this.pan && !this.hitAt(e.clientX, e.clientY)) this.setPan(null);
      return;
    }
    // Throw: keep the release velocity if the pointer was still moving, and project where it would coast to.
    const a = d.trail[0], b = d.trail[d.trail.length - 1], vw = this.w.vw;
    const v = !this.still && b && now() - b[0] < 50 && b[0] > a[0] ? clamp(((b[1] - a[1]) / (b[0] - a[0])) * 1000, -3 * vw, 3 * vw) : 0;
    this.camV = v;
    this.goal = clamp(this.w.cam + v * 0.3, ...this.lim);
    this.resp = 0.5;
    this.touch();
    this.paint();
  };

  private leave = () => {
    this.ptr = null;
    if (!this.drag) this.pointer(-1e4, -1e4);
  };

  // Vertical wheel or a pinch (ctrl+wheel) zooms about the pointer; the zoom is then the owner's until Follow.
  private zoomBy(e: WheelEvent) {
    const w = this.w, dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? w.area.h : 1);
    const z = clamp(w.z * Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0015)), Z_MIN, 1);
    if (z === w.z) return;
    const px = e.clientX - w.area.x, wx = w.cam + px / w.k;
    w.z = this.zGoal = z;
    this.zUser = true;
    w.fitCamY();
    w.cam = this.goal = wx - px / w.k;
    this.cam = 'free';
    this.camV = 0;
    this.touch();
    this.paint();
  }

  private wheel = (e: WheelEvent) => {
    if (this.drag?.moved) return;
    if (e.ctrlKey || (!e.shiftKey && Math.abs(e.deltaY) > Math.abs(e.deltaX))) return void (e.preventDefault(), this.zoomBy(e));
    const raw = e.shiftKey ? e.deltaX || e.deltaY : Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : 0;
    if (!raw) return;
    e.preventDefault();
    const px = raw * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.w.area.w : 1);
    if (this.cam !== 'free') (this.cam = 'free'), (this.goal = this.w.cam);
    const [a, b] = this.lim, c = BAND * this.w.vw, d = px / this.w.k;
    const over = d < 0 ? a - this.goal : this.goal - b;
    this.goal += over > 0 ? d * (c / (c + over)) ** 2 : d;
    if (this.still) this.w.cam = this.goal = clamp(this.goal, a, b);
    // Trackpads send small steady deltas (follow tightly); mouse notches are big steps (smooth them).
    this.resp = Math.abs(px) < 40 ? 0.12 : 0.28;
    this.wheelAt = now();
    this.touch();
    this.paint();
  };

  private onBot(x: number, y: number) {
    const b = this.bot;
    return Math.abs(x - b.x) < b.hw && y > b.y0 && y < b.y1;
  }

  // The agent whose lane robot, label or card is under the pointer.
  private laneAt(x: number, y: number) {
    const h = this.hitAt(x, y);
    return h?.key.startsWith('lane|') ? h.key.slice(5) : null;
  }

  private hitAt(x: number, y: number) {
    const hits = this.w.hits;
    for (let i = hits.length - 1; i >= 0; i--) {
      const h = hits[i];
      if (x >= h.x - 4 && x <= h.x + h.w + 4 && y >= h.y - 3 && y <= h.y + h.h + 3) return h;
    }
    return null;
  }

  // ---- Timeline ----
  private timeline(dt: number, T: number, at: number) {
    const tr = this.track, lt = this.liveT();
    tr.t0 = this.m.startT;
    // After a sleep the span jumps; ease it so the ticks slide over instead of snapping.
    const gap = lt - tr.t1;
    // While chasing, the lag settles near tau (0.15 s) since live keeps moving, so the snap sits above that.
    tr.t1 = this.still || gap < 0.4 ? lt : tr.t1 + gap * (1 - Math.exp(-dt / 0.15));
    tr.draw(this.m, this.w, at);
    tr.place(T);
    return lt - tr.t1 > 0.01;
  }

  private clampT(t: number) {
    return clamp(t, this.m.startT, this.liveT());
  }

  private labelAt(t: number) {
    const m = this.m, s = m.stations[Math.max(0, legAt(m, t))];
    if (m.before !== null && t < m.startT + 20) return m.loadingOlder ? 'Loading earlier work…' : 'Earlier work loads here';
    const when = t < m.openT ? 'Before watch' : ago(this.behind(t));
    const what = !s || s.kind === 'start' ? 'Start' : s.kind === 'ask' ? `You asked: ${s.label}` : s.kind === 'step' ? `Step ${s.num + 1} · ${s.label}` : s.label || 'Working';
    return `${when} · ${what}`;
  }

  private tdown = (e: PointerEvent) => {
    if (e.button !== 0 || this.scrubId !== null) return;
    this.track.el.setPointerCapture(e.pointerId);
    this.scrubId = e.pointerId;
    this.mode = 'scrub';
    this.scrubGoal = this.clampT(this.track.tAt(e.clientX));
    if (this.cam !== 'follow') this.recenter();
    this.track.show(this.scrubGoal, this.labelAt(this.scrubGoal), false);
    this.paint();
  };

  private tmove = (e: PointerEvent) => {
    const t = this.clampT(this.track.tAt(e.clientX));
    if (this.scrubId === e.pointerId) {
      this.scrubGoal = t;
      this.track.show(t, this.labelAt(t), false);
      this.paint();
    } else if (this.scrubId === null) this.track.show(t, this.labelAt(t), true);
  };

  private tup = (e: PointerEvent) => {
    if (this.scrubId !== e.pointerId) return;
    this.scrubId = null;
    // Playback moves on from here, so the readout would go stale; the next hover brings it back.
    this.track.hide();
    // Let go at the live edge and he is live again; anywhere else, playback continues from there.
    if (this.scrubGoal >= this.liveT() - 0.3) return this.goLive();
    if (this.still) (this.viewT = this.scrubGoal), (this.mode = 'behind');
    this.paint();
  };

  private tleave = () => {
    if (this.scrubId === null) this.track.hide();
  };

  private key = (e: KeyboardEvent) => {
    if (this.paused || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    if (t?.closest?.('input,textarea,select,[contenteditable]')) return;
    const k = e.key;
    if (k === 'f' || k === 'F' || (k === ' ' && !t?.closest?.('button'))) return void (e.preventDefault(), this.follow());
    if (k === 'ArrowLeft' || k === 'ArrowRight') return void (e.preventDefault(), this.stepStation(k === 'ArrowLeft' ? -1 : 1));
    if (k === 'Home') return void (e.preventDefault(), this.seek(this.m.startT));
    if (k === 'End') return void (e.preventDefault(), this.goLive());
  };

  // ---- HUD ----
  private set(el: HTMLElement, k: string, v: string) {
    if (this.text[k] === v) return false;
    this.text[k] = v;
    el.textContent = v;
    return true;
  }

  // The review controls and the Follow button exist only while they mean something.
  private flags() {
    const rev = this.mode !== 'live', free = this.cam === 'free' || this.zUser || !!this.w.sel, h = this.hud;
    if (rev !== this.revOn) {
      this.revOn = rev;
      if (!rev && h.review.contains(document.activeElement)) this.track.el.focus({ preventScroll: true });
      this.root.toggleAttribute('data-review', rev);
      h.review.inert = !rev;
    }
    if (free !== this.freeOn) {
      this.freeOn = free;
      if (!free && h.follow.contains(document.activeElement)) this.root.focus({ preventScroll: true });
      this.root.toggleAttribute('data-free', free);
      h.follow.inert = !free;
    }
    if (free) {
      const dir = this.bot.x < 0 ? 'l' : this.bot.x > this.w.area.w ? 'r' : 'c';
      if (h.follow.dataset.dir !== dir) h.follow.dataset.dir = dir;
    }
  }

  private hudText(T: number, at: number, moving: boolean) {
    const m = this.m, h = this.hud;
    let ask: Station | null = null;
    for (let i = Math.min(m.routeLen - 1, legAt(m, T) + 1); i >= 0; i--) {
      const st = m.stations[i];
      if (st.kind === 'ask' && st.arr <= T) (ask = st), (i = 0);
    }
    const st = m.stations[moving ? at + 1 : at];
    // Where we are: the plan he is on, else the objective he wrote for this prompt, else the prompt itself.
    const goal = m.goalAt(T);
    const obj = st?.plan?.title || (goal && (!ask || goal.t >= ask.t0) ? goal.s : '') || (ask ? `“${ask.label}”` : '');
    if (this.set(h.prompt, 'prompt', obj)) h.prompt.title = obj;
    let run = 0;
    for (const p of this.w.poses) if (p.s === 'running') run++;
    if (this.set(h.agentsN, 'agents', run ? `${run} agent${run > 1 ? 's' : ''} running` : '')) h.agents.toggleAttribute('data-on', run > 0);
    this.set(h.step, 'step', !st ? '' : st.kind === 'step' ? `Step ${st.num + 1} of ${st.plan?.texts.length ?? '?'}` : st.kind === 'phase' ? PHASE_WORD[st.phase ?? ''] ?? 'Working' : '');
    const act = m.activityAt(T);
    const rev = this.mode !== 'live';
    const k = rev ? 'behind' : act === 'needs' ? 'needs' : act === 'fault' ? 'fault' : act === 'idle' ? 'idle' : 'working';
    if (h.pill.dataset.k !== k) h.pill.dataset.k = k;
    this.set(h.pill, 'pill', { behind: 'Reviewing', needs: 'Needs you', fault: 'Error', idle: 'Idle', working: 'Working' }[k]);
    const n = st && !moving ? visibleRows(st, T) : 0;
    const row = n ? st.rows[n - 1] : null;
    this.set(h.now, 'now', moving ? `Walking to ${st?.label || 'the next station'}` : row ? `${row.cmd && row.cmd !== row.label ? '' : VERB[row.kind] ?? ''}${row.label}` : st?.kind === 'ask' ? 'Reading your prompt' : '');
    const lt = this.liveT(), behind = ago(this.behind(T));
    this.set(h.when, 'when', rev ? behind : '');
    const vt = rev ? `${behind.slice(1)} behind live` : 'Live';
    if (vt !== this.text.vt) {
      this.text.vt = vt;
      const el = this.track.el;
      el.setAttribute('aria-valuetext', vt);
      el.setAttribute('aria-valuemax', String(Math.round(lt - m.startT)));
      el.setAttribute('aria-valuenow', String(Math.round(T - m.startT)));
    }
    if (m.version !== this.srVer) {
      this.srVer = m.version;
      const items = [];
      for (let i = m.stations.length - 1; i >= 0 && items.length < 12; i--) {
        const s = m.stations[i];
        if (s.kind !== 'step' && s.kind !== 'phase') continue;
        const li = document.createElement('li');
        li.textContent = `${s.label || 'Working'}: ${!Number.isNaN(s.done) && T >= s.done ? 'done' : i < m.routeLen && T >= s.arr ? 'in progress' : 'next'}`;
        items.push(li);
      }
      h.sr.replaceChildren(...items.reverse());
    }
  }

  // ---- Hover: the world registers hit boxes as it draws; the card is plain DOM next to the box. ----
  pointer(x: number, y: number) {
    const over: Hit | null = this.hitAt(x, y);
    const cur = over?.key.startsWith('lane|') || this.onBot(x, y) ? 'pointer' : '';
    if (this.cv.style.cursor !== cur) this.cv.style.cursor = cur;
    const k = over?.key ?? null;
    if (k === this.hover) return;
    this.hover = k;
    this.hoverDirty = true;
    if (!k) this.hideCard();
    this.wake();
    if (this.still) this.front();
  }

  private hideCard() {
    if (!this.cardOn) return;
    this.cardOn = false;
    this.hud.card.classList.remove('on');
  }

  private front() {
    if (!this.hover) return;
    const h = this.w.hits.findLast((x) => x.key === this.hover);
    if (!h || h.quiet) return this.hideCard();
    const g = this.g, dpr = this.w.dpr;
    g.save();
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.strokeStyle = this.w.dark ? 'rgb(232 182 76 / .75)' : 'rgb(183 132 31 / .75)';
    g.lineWidth = 1;
    g.setLineDash([3, 3]);
    g.beginPath();
    g.roundRect(h.x - 5, h.y - 3, h.w + 10, h.h + 6, 7);
    g.stroke();
    g.restore();
    const info = h.info();
    const key = JSON.stringify(info);
    const card = this.hud.card;
    if (key !== this.cardKey) (this.cardKey = key), fillCard(card, info);
    const cw = card.offsetWidth, ch = card.offsetHeight, W = this.w.area.w - this.panPx, H = this.cv.clientHeight;
    let x = h.x + h.w + 14, ox = '0';
    if (x + cw > W - 12) (x = h.x - cw - 14), (ox = '100%');
    if (x < 12) x = Math.min(Math.max(h.x, 12), W - cw - 12);
    const y = Math.min(Math.max(h.y - 4, TOP + 8), H - BOTTOM - 8 - ch);
    card.style.transform = `translate3d(${x.toFixed(0)}px,${y.toFixed(0)}px,0)`;
    card.style.transformOrigin = `${ox} 0`;
    if (!this.cardOn) (this.cardOn = true), card.classList.add('on');
  }
}

const now = () => performance.now();
const VERB: Record<string, string> = { file: '', search: 'Searching ', run: '$ ', agent: 'Agent: ', needs: 'Asked you: ', fault: 'Error: ' };

// Seconds since the newest thing appeared, arrived, finished or got its outcome on the floor; past ~0.9 s nothing animates.
// Only the stations around view time T are looked at, so it costs the same at any point of a long history.
function freshAt(m: WatchModel, T: number) {
  let last = -Infinity;
  const at = (t: number) => {
    if (t <= T && t > last) last = t;
  };
  const k = Math.max(0, legAt(m, T));
  for (let i = Math.max(0, k - 1); i < Math.min(m.stations.length, k + 3); i++) {
    const s = m.stations[i];
    at(s.arr);
    at(s.done);
    at(shownAt(s));
    const b = s.beats;
    for (let j = b.length - 1; j >= 0 && j >= b.length - 40; j--) if (b[j].tv <= T) (at(b[j].tv), (j = 0));
    for (let j = Math.max(0, s.rows.length - 6); j < s.rows.length; j++) at(s.rows[j].res ?? -Infinity);
    for (const c of s.calls) at(c.res ?? -Infinity);
  }
  return T - last;
}

// The latest scheduled moment: past it, and with the session idle, nothing is left to play.
function horizon(m: WatchModel) {
  let h = -Infinity;
  for (let i = Math.max(0, m.routeLen - 3); i < m.routeLen; i++) {
    const s = m.stations[i];
    h = Math.max(h, s.arr, s.lastTv, Number.isNaN(s.done) ? -Infinity : s.done, shownAt(s));
    for (let j = Math.max(0, s.rows.length - 6); j < s.rows.length; j++) h = Math.max(h, s.rows[j].res ?? -Infinity);
    for (const c of s.calls) h = Math.max(h, c.res ?? -Infinity);
  }
  return h;
}

function fillCard(card: HTMLElement, info: Info) {
  const el = (tag: string, cls: string, text = '') => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  };
  const out: HTMLElement[] = [el('div', `k ${info.tone ?? ''}`, info.k), el('div', 't', info.title)];
  if (info.path) out.push(el('div', 'p', info.path));
  if (info.rows.length) {
    const dl = el('dl', '');
    for (const [k, v, c] of info.rows) {
      const dd = el('dd', '');
      dd.append(el('span', c ?? '', v));
      dl.append(el('dt', '', k), dd);
    }
    out.push(dl);
  }
  card.replaceChildren(...out);
}

export default function Watch() {
  const root = useRef<HTMLDivElement>(null);
  const stage = useRef<Stage | null>(null);
  const [ov, setOv] = useState<Stage | null>(null);
  // The side panel: the stage it reads, what it shows now (null: closed), and what it showed last, kept while it exits.
  const [host, setHost] = useState<Stage | null>(null);
  const [pan, setPan] = useState<Pan | null>(null);
  const [lastPan, setLastPan] = useState<Pan | null>(null);
  const sid = useStore((s) => s.current);
  const name = useStore((s) => currentSummary(s)?.name ?? '');
  const textScale = usePref('textScale');
  const font = usePref('font');

  const openOv = (on: boolean) => {
    const s = stage.current;
    if (!s) return;
    if (on) s.dismissOffer();
    s.setPaused(on);
    setOv(on ? s : null);
  };

  useEffect(() => {
    if (!sid) return;
    const close = () => setWatch(false);
    const s = new Stage(sid, root.current!, close);
    stage.current = s;
    s.onPan = (p) => {
      setPan(p);
      if (p) setLastPan(p);
    };
    setHost(s);
    document.body.dataset.watch = '';
    // Focus the stage, not a button: Space then means "follow", never "exit".
    root.current!.focus({ preventScroll: true });
    return () => {
      delete document.body.dataset.watch;
      s.dispose();
      stage.current = null;
      setHost(null);
      setPan(null);
      setLastPan(null);
    };
  }, [sid]);

  useEffect(() => {
    stage.current?.retheme();
  }, [textScale, font]);

  // Esc leaves watch before anything else sees it (it would stop the turn otherwise).
  useEscape(true, () => setWatch(false));

  return (
    <div ref={root} className="wt" role="dialog" aria-modal="true" aria-label="Watch mode" tabIndex={-1} data-ov={ov ? '' : undefined}>
      <div className="wt-sky" aria-hidden="true" />
      <canvas className="wt-world" aria-hidden="true" />
      <div className="wt-bot" aria-hidden="true" />
      <canvas className="wt-fly" aria-hidden="true" />
      <i className="wt-edge l" aria-hidden="true" />
      <i className="wt-edge r" aria-hidden="true" />
      <button type="button" className="wt-btn wt-off l" title="Go to this agent" onClick={() => stage.current?.toOff('l')} />
      <button type="button" className="wt-btn wt-off r" title="Go to this agent" onClick={() => stage.current?.toOff('r')} />
      <header className="wt-top">
        <div className="wt-brand"><b>Watch</b><span title={name}>{name}</span></div>
        <div className="wt-prompt" />
        <div className="wt-state">
          <span className="wt-step" />
          <span className="wt-pill" data-k="working" />
          <span className="wt-now mono" />
        </div>
        <button type="button" className="wt-btn wt-agents" title="Open the next running agent" onClick={() => stage.current?.nextAgent()}>
          <i aria-hidden="true" />
          <span />
        </button>
        <button type="button" className="wt-btn wt-filesbtn" title="Files each agent read or edited, up to the playhead" aria-pressed={pan?.k === 'files'} onClick={() => stage.current?.toggleFiles()}>
          <FilesIcon />
          Files
        </button>
        <button type="button" className="wt-btn wt-ovbtn" title="Every step of this turn on one screen" aria-pressed={!!ov} onClick={() => openOv(!ov)}>
          <OverviewIcon />
          Overview
        </button>
        <button type="button" className="wt-btn" title="Exit watch (esc)" onClick={() => setWatch(false)}>Exit watch</button>
      </header>
      {ov && (
        <Suspense fallback={null}>
          <Overview host={ov} onClose={() => openOv(false)} />
        </Suspense>
      )}
      {host && lastPan && (
        <Suspense fallback={null}>
          <Side host={host} pan={lastPan} open={!!pan} />
        </Suspense>
      )}
      <div className="wt-catch" role="status">
        <span className="wt-catch-t" />
        <button type="button" className="wt-btn wt-catch-go" onClick={() => stage.current?.replayCatch()}>Replay from there</button>
        <button type="button" className="wt-btn wt-offer-x" title="Dismiss" aria-label="Dismiss" onClick={() => stage.current?.dismissCatch()}>
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M2 2l6 6M8 2 2 8" /></svg>
        </button>
      </div>
      <div className="wt-offer">
        <button type="button" className="wt-btn" onClick={() => openOv(true)}>
          <OverviewIcon />
          Turn finished · See the overview
        </button>
        <button type="button" className="wt-btn wt-offer-x" title="Dismiss" aria-label="Dismiss" onClick={() => stage.current?.dismissOffer()}>
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M2 2l6 6M8 2 2 8" /></svg>
        </button>
      </div>
      <button type="button" className="wt-btn wt-follow" data-dir="c" title="Follow the robot (F)" onClick={() => stage.current?.follow()}>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path className="wt-follow-c" d="M6 1.5v2M6 8.5v2M1.5 6h2M8.5 6h2" /><circle className="wt-follow-c" cx="6" cy="6" r="1.3" />
          <path className="wt-follow-a" d="M4.5 2.5 8 6l-3.5 3.5" />
        </svg>
        Follow
      </button>
      <footer className="wt-foot">
        <span className="wt-when mono" aria-hidden="true" />
        <div className="wt-track" role="slider" tabIndex={0} aria-label="Session timeline" aria-valuemin={0} aria-valuetext="Live">
          <canvas aria-hidden="true" />
          <i className="wt-ahead" aria-hidden="true" />
          <i className="wt-hov" aria-hidden="true" />
          <i className="wt-head" aria-hidden="true" />
          <div className="wt-tip mono" aria-hidden="true" />
        </div>
        <div className="wt-side">
          <span className="wt-calm" aria-hidden="true"><i />Live</span>
          <div className="wt-review">
            <div className="wt-seg" role="group" aria-label="Speed">
              {SPEEDS.map((v) => (
                <button key={v} type="button" data-v={v} onClick={() => stage.current?.setSpeed(v)}>{v}×</button>
              ))}
            </div>
            <button type="button" className="wt-btn wt-live" title="Back to live (end)" onClick={() => stage.current?.goLive()}>
              <i aria-hidden="true" />Live
            </button>
          </div>
        </div>
      </footer>
      <div className="wt-card" role="tooltip" />
      <ol className="sr" aria-label="Stations" />
    </div>
  );
}
