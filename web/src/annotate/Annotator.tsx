import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { streamline } from '../board/geom.ts';
import { pushEscape } from '../escape.ts';

type Tool = 'pencil' | 'arrow' | 'rect' | 'text';
// Points are in the image's own pixels, so a resize only changes the scale they are drawn at.
// Pencil: the polyline; arrow and rectangle: [x1, y1, x2, y2]; text: its top-left [x, y].
type Stroke = { tool: 'pencil' | 'arrow' | 'rect'; color: string; w: number; pts: number[] };
type TextMark = { tool: 'text'; color: string; w: number; pts: number[]; text: string; fs: number };
type Mark = Stroke | TextMark;

const COLORS = [
  { name: 'Red', hex: '#e5484d' },
  { name: 'Yellow', hex: '#f5c400' },
  { name: 'Blue', hex: '#2f80ed' },
  { name: 'Green', hex: '#30a46c' },
] as const;
// Long side of the saved picture, as for any attached image.
const MAX_SIDE = 2000;
// Fitted images grow up to this, so a small picture is still big enough to draw on.
const MAX_ZOOM = 2;
const OPEN_MS = 240;
const CLOSE_MS = 180;
const EASE = 'cubic-bezier(.23,1,.32,1)';

const icon = (d: string) => () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);
const PencilIcon = icon('M10.6 2.6l2.8 2.8-7.9 7.9H2.7v-2.8zM9 4.2l2.8 2.8');
const ArrowIcon = icon('M3.5 12.5l8.5-8.5M6.5 3.5H12v5.5');
const RectIcon = icon('M3 4h10v8H3z');
const TextIcon = icon('M3.5 4V3h9v1M8 3v10M6.2 13h3.6');
const UndoIcon = icon('M5.5 3.5 2.5 6.5l3 3M2.5 6.5h7a4 4 0 0 1 0 8H7');
const ClearIcon = icon('M2.5 4.5h11M6 4.5V3h4v1.5M4 4.5l.7 8.3c0 .4.4.7.8.7h5c.4 0 .8-.3.8-.7l.7-8.3');

const TOOLS: { id: Tool; label: string; key: string; Icon: () => React.JSX.Element }[] = [
  { id: 'pencil', label: 'Pencil', key: 'P', Icon: PencilIcon },
  { id: 'arrow', label: 'Arrow', key: 'A', Icon: ArrowIcon },
  { id: 'rect', label: 'Rectangle', key: 'R', Icon: RectIcon },
  { id: 'text', label: 'Text', key: 'T', Icon: TextIcon },
];

// About 8px on a 2000px screenshot: thick enough to read once the model scales the picture down.
const widthFor = (w: number, h: number) => Math.max(3, Math.round(Math.max(w, h) / 250));
const MIN_SCREEN_W = 3;
// Thickness limits and presets in screen px; [ ] and the wheel step by SIZE_STEP like the board's eraser.
const SIZE_MIN = 2;
const SIZE_MAX = 32;
const SIZE_STEP = 1.25;
const SIZES = [
  { px: 2, label: 'Thin', line: 1.2 },
  { px: 4, label: 'Medium', line: 2.4 },
  { px: 8, label: 'Thick', line: 4.5 },
  { px: 16, label: 'Extra thick', line: 7.5 },
];

const TEXT_FONT = '"Lexend", "Atkinson Hyperlegible", system-ui, sans-serif';
const TEXT_WEIGHT = 600;
const LINE_H = 1.25;
// Text size per unit of thickness, its floor in screen px, and the halo width per unit of text size.
const TEXT_K = 4;
const TEXT_MIN = 12;
const HALO = 0.11;
const TEXT_MAX = 500;
// Light ink gets a dark halo and dark ink a white one, so text reads on any screenshot.
const haloFor = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255) > 153 ? 'rgb(0 0 0 / .6)' : 'rgb(255 255 255 / .92)';
};

function paintText(g: CanvasRenderingContext2D, m: TextMark) {
  const lh = m.fs * LINE_H;
  g.font = `${TEXT_WEIGHT} ${m.fs}px ${TEXT_FONT}`;
  g.textAlign = 'left';
  g.textBaseline = 'alphabetic';
  const { fontBoundingBoxAscent: a, fontBoundingBoxDescent: d } = g.measureText(m.text);
  // CSS centres ascent + descent in each line box; the same baseline keeps the text where it was typed.
  const base = m.pts[1] + (lh - a - d) / 2 + a;
  const lines = m.text.split('\n');
  g.lineJoin = 'round';
  g.lineWidth = m.fs * HALO;
  g.strokeStyle = haloFor(m.color);
  g.fillStyle = m.color;
  lines.forEach((l, i) => g.strokeText(l, m.pts[0], base + i * lh));
  lines.forEach((l, i) => g.fillText(l, m.pts[0], base + i * lh));
}

let meter: CanvasRenderingContext2D | null = null;
const textWidth = (text: string, fs: number) => {
  meter ??= document.createElement('canvas').getContext('2d')!;
  meter.font = `${TEXT_WEIGHT} ${fs}px ${TEXT_FONT}`;
  return Math.max(...text.split('\n').map((l) => meter!.measureText(l).width));
};

function paint(g: CanvasRenderingContext2D, m: Mark) {
  if (m.tool === 'text') return paintText(g, m);
  const p = m.pts;
  g.strokeStyle = g.fillStyle = m.color;
  g.lineWidth = m.w;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.beginPath();
  if (m.tool === 'pencil') {
    if (p.length === 2) {
      g.arc(p[0], p[1], m.w / 2, 0, Math.PI * 2);
      g.fill();
      return;
    }
    // Quadratic curves through the midpoints keep corners round between samples.
    g.moveTo(p[0], p[1]);
    for (let i = 2; i < p.length - 2; i += 2) g.quadraticCurveTo(p[i], p[i + 1], (p[i] + p[i + 2]) / 2, (p[i + 1] + p[i + 3]) / 2);
    g.lineTo(p[p.length - 2], p[p.length - 1]);
    g.stroke();
  } else if (m.tool === 'rect') {
    g.strokeRect(Math.min(p[0], p[2]), Math.min(p[1], p[3]), Math.abs(p[2] - p[0]), Math.abs(p[3] - p[1]));
  } else {
    const [x1, y1, x2, y2] = p;
    const a = Math.atan2(y2 - y1, x2 - x1);
    const head = Math.min(m.w * 4.5, Math.hypot(x2 - x1, y2 - y1) * 0.6);
    // The shaft stops inside the head, so its round cap never shows past the tip.
    g.moveTo(x1, y1);
    g.lineTo(x2 - Math.cos(a) * head * 0.6, y2 - Math.sin(a) * head * 0.6);
    g.stroke();
    g.beginPath();
    g.moveTo(x2, y2);
    g.lineTo(x2 - head * Math.cos(a - 0.45), y2 - head * Math.sin(a - 0.45));
    g.lineTo(x2 - head * Math.cos(a + 0.45), y2 - head * Math.sin(a + 0.45));
    g.closePath();
    g.fill();
    g.stroke();
  }
}

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
// Colour and size controls keep focus in the text box being typed, so the box takes the change.
const keepFocus = (e: React.MouseEvent) => e.preventDefault();

const Line = ({ w }: { w: number }) => (
  <svg width="18" height="16" viewBox="0 0 18 16" aria-hidden="true">
    <path d="M2.5 8h13" stroke="currentColor" strokeWidth={w} strokeLinecap="round" />
  </svg>
);

// Draw on a composer image with a pencil, arrows, rectangles and text; Save hands back the annotated PNG.
// onSave returns an error to show, or null once the attachment is replaced; onClose unmounts.
export default function Annotator({ src, name, onSave, onClose }: {
  src: string;
  name: string;
  onSave: (png: Blob) => Promise<string | null>;
  onClose: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const baseRef = useRef<HTMLCanvasElement>(null);
  const liveRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const discardRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  const [tool, setTool] = useState<Tool>('pencil');
  const [color, setColor] = useState<string>(COLORS[0].hex);
  const [marks, setMarks] = useState<Mark[]>([]);
  const [past, setPast] = useState<Mark[][]>([]);
  const [confirm, setConfirm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Thickness for new marks in image px; null keeps the default picked from the image size.
  const [size, setSize] = useState<number | null>(null);
  // CSS px per image px, mirrored from fit for render (text box, size preview).
  const [scale, setScale] = useState(1);
  // The text box being typed: its top-left in image px.
  const [draft, setDraft] = useState<{ x: number; y: number } | null>(null);
  const [draftText, setDraftText] = useState('');
  // Brief ring at the pointer showing the new thickness after [ ] or Ctrl+wheel.
  const [ring, setRing] = useState<{ x: number; y: number } | null>(null);
  const [fontReady, setFontReady] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const sizeBtnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  // CSS px per image px and the device ratio, from the stage's ResizeObserver.
  const fit = useRef({ k: 1, dpr: 1 });
  const live = useRef<{ id: number; mark: Stroke; rect: DOMRect } | null>(null);
  const raf = useRef(0);
  const closing = useRef(false);
  // Guards the box against a second commit from the blur its own removal causes.
  const typing = useRef(false);
  // A text click places its box on pointerup, which counts as a user gesture for the phone keyboard.
  const placing = useRef<number | null>(null);
  const hover = useRef<{ x: number; y: number } | null>(null);
  const ringTimer = useRef(0);

  useEffect(() => {
    const im = new Image();
    im.src = src;
    let on = true;
    im.decode().then(() => {
      if (!on) return;
      imgRef.current = im;
      setNat({ w: im.naturalWidth, h: im.naturalHeight });
    }, () => on && onClose());
    // Text marks paint with Lexend; repaint once it is surely loaded.
    document.fonts.load(`${TEXT_WEIGHT} 16px Lexend`).then(() => on && setFontReady(true), () => {});
    return () => {
      on = false;
    };
  }, [src]);

  const k = scale;
  const clampW = (w: number) => Math.min(Math.max(w, SIZE_MIN / k), SIZE_MAX / k);
  // The default is today's: picked from the image size, never under MIN_SCREEN_W on screen.
  const thick = nat ? clampW(size ?? Math.max(widthFor(nat.w, nat.h), MIN_SCREEN_W / k)) : 0;
  const font = Math.max(thick * TEXT_K, TEXT_MIN / k);
  // The box slides left and up as it grows, so text typed near an edge stays inside the picture.
  const at = draft && nat && {
    x: Math.max(0, Math.min(draft.x, nat.w - textWidth(draftText, font))),
    y: Math.max(0, Math.min(draft.y, nat.h - draftText.split('\n').length * font * LINE_H)),
  };

  const redraw = () => {
    const c = baseRef.current;
    if (!c) return;
    const g = c.getContext('2d')!;
    const { k, dpr } = fit.current;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, c.width, c.height);
    g.setTransform(k * dpr, 0, 0, k * dpr, 0, 0);
    for (const m of marks) paint(g, m);
  };
  useLayoutEffect(redraw, [marks, nat, fontReady]);

  const drawLive = () => {
    raf.current = 0;
    const c = liveRef.current;
    if (!c) return;
    const g = c.getContext('2d')!;
    const { k, dpr } = fit.current;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, c.width, c.height);
    if (!live.current) return;
    g.setTransform(k * dpr, 0, 0, k * dpr, 0, 0);
    paint(g, live.current.mark);
  };
  const schedule = () => {
    if (!raf.current) raf.current = requestAnimationFrame(drawLive);
  };
  useEffect(() => () => {
    cancelAnimationFrame(raf.current);
    clearTimeout(ringTimer.current);
  }, []);

  // Fit the image in the stage; canvases follow at device resolution and the marks are redrawn at the new scale.
  const onResize = useEffectEvent((w: number, h: number) => {
    const frame = frameRef.current;
    if (!nat || !frame) return;
    const k = Math.min(w / nat.w, h / nat.h, MAX_ZOOM);
    const dpr = devicePixelRatio || 1;
    fit.current = { k, dpr };
    setScale(k);
    const fw = nat.w * k, fh = nat.h * k;
    frame.style.width = `${fw}px`;
    frame.style.height = `${fh}px`;
    for (const c of [baseRef.current!, liveRef.current!]) {
      c.width = Math.max(1, Math.round(fw * dpr));
      c.height = Math.max(1, Math.round(fh * dpr));
    }
    if (live.current) live.current.rect = frame.getBoundingClientRect();
    redraw();
    drawLive();
  });
  useEffect(() => {
    if (!nat) return;
    const stage = stageRef.current!;
    const ro = new ResizeObserver(([e]) => onResize(e.contentRect.width, e.contentRect.height));
    ro.observe(stage);
    return () => ro.disconnect();
  }, [nat]);

  // Entrance once the picture is decoded; the app underneath stops painting after it, like the drawing board.
  useLayoutEffect(() => {
    if (!nat) return;
    const root = rootRef.current!;
    root.focus({ preventScroll: true });
    const calm = reduced();
    const opts = { duration: calm ? 0 : OPEN_MS, easing: EASE };
    const fade = root.animate([{ opacity: 0 }, { opacity: 1 }], opts);
    if (!calm) {
      frameRef.current!.animate([{ transform: 'scale(.96)', opacity: 0 }, { transform: 'none', opacity: 1 }], opts);
      for (const el of root.querySelectorAll<HTMLElement>('.an-bar,.an-acts')) el.animate([{ transform: 'translateY(-6px)', opacity: 0 }, { transform: 'none', opacity: 1 }], opts);
    }
    fade.finished.then(() => {
      if (!closing.current) document.body.dataset.annot = '';
    }, () => {});
    return () => {
      delete document.body.dataset.annot;
    };
  }, [nat]);

  const close = () => {
    if (closing.current) return;
    closing.current = true;
    cancelAnimationFrame(raf.current);
    live.current = null;
    delete document.body.dataset.annot;
    const root = rootRef.current;
    if (!root || !nat) return onClose();
    const calm = reduced();
    const opts = { duration: calm ? 0 : CLOSE_MS, easing: EASE, fill: 'forwards' as const };
    if (!calm) frameRef.current?.animate([{ transform: 'none' }, { transform: 'scale(.98)' }], opts);
    root.animate([{ opacity: 1 }, { opacity: 0 }], opts).finished.then(onClose, onClose);
  };

  const askClose = () => {
    if (saving) return;
    if (marks.length) setConfirm(true);
    else close();
  };
  // Focus follows the swap: onto Discard when the question shows, back to Cancel when it goes.
  const asked = useRef(false);
  useEffect(() => {
    if (confirm) discardRef.current?.focus();
    else if (asked.current) cancelRef.current?.focus();
    asked.current = confirm;
  }, [confirm]);
  const keepEditing = () => setConfirm(false);

  const commit = (next: Mark[]) => {
    setPast((p) => [...p, marks]);
    setMarks(next);
    setError(null);
  };
  const undo = () => {
    if (!past.length || saving) return;
    setMarks(past[past.length - 1]);
    setPast(past.slice(0, -1));
  };
  const clear = () => {
    if (marks.length && !saving) commit([]);
  };

  // Ends the text box; empty text leaves no mark. Focus goes back to the editor so its keys work again.
  const endDraft = (keep: boolean) => {
    if (!at || !typing.current) return;
    typing.current = false;
    if (document.activeElement === taRef.current) rootRef.current?.focus({ preventScroll: true });
    const text = draftText.replace(/\s+$/, '');
    setDraft(null);
    setDraftText('');
    if (keep && text.trim()) commit([...marks, { tool: 'text', color, w: thick, fs: font, pts: [at.x, at.y], text }]);
  };
  const openDraft = (x: number, y: number) => {
    if (!nat) return;
    typing.current = true;
    // The click lands on the middle of the first line.
    setDraft({ x: Math.min(Math.max(x, 0), nat.w - 1), y: Math.max(0, y - (font * LINE_H) / 2) });
    setDraftText('');
  };
  useLayoutEffect(() => {
    if (draft) taRef.current?.focus({ preventScroll: true });
  }, [draft]);
  // The box hugs its text; it grows as you type and when the size changes.
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.width = ta.style.height = '0';
    ta.style.width = `${ta.scrollWidth + 2}px`;
    ta.style.height = `${ta.scrollHeight}px`;
  }, [draft, draftText, font, scale]);

  const flashRing = (at: { x: number; y: number } | null) => {
    if (!at) return;
    setRing(at);
    clearTimeout(ringTimer.current);
    ringTimer.current = window.setTimeout(() => setRing(null), 700);
  };
  // Thickness steps multiply, like the board's eraser; the result stays within SIZE_MIN..SIZE_MAX on screen.
  const resize = (f: number, at: { x: number; y: number } | null) => {
    if (!nat || saving) return;
    // Functional, so several wheel events before the next render all count.
    setSize((s) => clampW(clampW(s ?? thick) * f));
    flashRing(at);
  };
  const onWheel = useEffectEvent((e: WheelEvent) => {
    if (!nat || confirm) return;
    const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
    // One mouse notch is one step; a trackpad pinch sends small deltas and moves smoothly.
    const f = Math.min(SIZE_STEP, Math.max(1 / SIZE_STEP, SIZE_STEP ** (-dy / 100)));
    const r = frameRef.current?.getBoundingClientRect();
    const inside = r && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    resize(f, inside ? { x: e.clientX - r.left, y: e.clientY - r.top } : null);
  });
  useEffect(() => {
    // Not passive, so Ctrl+wheel never zooms the page while the editor is up.
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      onWheel(e);
    };
    const root = rootRef.current!;
    root.addEventListener('wheel', wheel, { passive: false });
    return () => root.removeEventListener('wheel', wheel);
  }, []);

  // The size popover opens below the button, or above it when the bar sits at the bottom (narrow screens).
  useEffect(() => {
    const pop = popRef.current!;
    const onBefore = (e: Event) => {
      if ((e as ToggleEvent).newState !== 'open') return;
      const b = sizeBtnRef.current!.getBoundingClientRect();
      const up = b.top > innerHeight / 2;
      pop.toggleAttribute('data-up', up);
      pop.style.left = `${b.left + b.width / 2}px`;
      pop.style.top = up ? 'auto' : `${b.bottom + 8}px`;
      pop.style.bottom = up ? `${innerHeight - b.top + 8}px` : 'auto';
    };
    pop.addEventListener('beforetoggle', onBefore);
    return () => pop.removeEventListener('beforetoggle', onBefore);
  }, []);

  const toImage = (e: { clientX: number; clientY: number }, r: DOMRect) => {
    const { k } = fit.current;
    return [(e.clientX - r.left) / k, (e.clientY - r.top) / k] as const;
  };
  const down = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (live.current || !nat || confirm || saving || (e.pointerType === 'mouse' && e.button !== 0)) return;
    // No compat mousedown follows, so focus stays put: in the box this click opens, or on the editor after a commit.
    if (draft || tool === 'text') e.preventDefault();
    // A click while typing only ends the box, like the board.
    if (draft) return endDraft(true);
    if (tool === 'text') {
      placing.current = e.pointerId;
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    const rect = frameRef.current!.getBoundingClientRect();
    const [x, y] = toImage(e, rect);
    const mark: Stroke = { tool, color, w: thick, pts: tool === 'pencil' ? [x, y] : [x, y, x, y] };
    live.current = { id: e.pointerId, mark, rect };
    schedule();
  };
  const move = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (e.pointerType === 'mouse') hover.current = { x: e.nativeEvent.offsetX, y: e.nativeEvent.offsetY };
    const l = live.current;
    if (!l || e.pointerId !== l.id || !nat) return;
    const ev = e.nativeEvent;
    const list = ev.getCoalescedEvents?.() ?? [];
    const pts = l.mark.pts;
    if (l.mark.tool === 'pencil') {
      // Samples closer than half a screen pixel add nothing visible.
      const min = 0.5 / fit.current.k;
      for (const p of list.length ? list : [ev]) {
        const [x, y] = toImage(p, l.rect);
        if (Math.hypot(x - pts[pts.length - 2], y - pts[pts.length - 1]) >= min) pts.push(x, y);
      }
    } else {
      const [x, y] = toImage(ev, l.rect);
      pts[2] = Math.max(0, Math.min(nat.w, x));
      pts[3] = Math.max(0, Math.min(nat.h, y));
    }
    schedule();
  };
  const up = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (placing.current === e.pointerId) {
      placing.current = null;
      const [x, y] = toImage(e, frameRef.current!.getBoundingClientRect());
      return openDraft(x, y);
    }
    const l = live.current;
    if (!l || e.pointerId !== l.id) return;
    live.current = null;
    const m = l.mark;
    const k = fit.current.k;
    let keep = true;
    if (m.tool === 'pencil') m.pts = streamline(m.pts, 0.5, 1 / k);
    // A click with the arrow or rectangle draws nothing.
    else keep = Math.hypot(m.pts[2] - m.pts[0], m.pts[3] - m.pts[1]) * k >= 4;
    if (keep) {
      // Onto the base canvas now, so the stroke never blinks out between this frame and React's redraw.
      const g = baseRef.current!.getContext('2d')!;
      g.setTransform(k * fit.current.dpr, 0, 0, k * fit.current.dpr, 0, 0);
      paint(g, m);
      commit([...marks, m]);
    }
    drawLive();
  };
  // pointercancel and a lost capture drop the stroke in progress instead of committing half of it.
  const cancelStroke = (e?: ReactPointerEvent<HTMLCanvasElement>) => {
    if (e?.pointerId === placing.current) placing.current = null;
    if (!live.current || (e && e.pointerId !== live.current.id)) return;
    live.current = null;
    drawLive();
  };

  const save = async () => {
    if (saving || !nat || !imgRef.current || !marks.length) return;
    setSaving(true);
    setError(null);
    const k = Math.min(1, MAX_SIDE / Math.max(nat.w, nat.h));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(nat.w * k));
    c.height = Math.max(1, Math.round(nat.h * k));
    const g = c.getContext('2d')!;
    g.drawImage(imgRef.current, 0, 0, c.width, c.height);
    g.setTransform(k, 0, 0, k, 0, 0);
    for (const m of marks) paint(g, m);
    const png = await new Promise<Blob | null>((ok) => c.toBlob(ok, 'image/png'));
    const err = png ? await onSave(png).catch(() => "Couldn't save the image") : "Couldn't save the image";
    setSaving(false);
    if (err) setError(err);
    else close();
  };

  // Esc: drop the text box or the stroke in progress, then the confirm, then close; on top of the app's Esc stack.
  const onEsc = useEffectEvent(() => {
    if (draft) endDraft(false);
    else if (live.current) cancelStroke();
    else if (confirm) keepEditing();
    else askClose();
  });
  const onKey = useEffectEvent((e: KeyboardEvent) => {
    if (e.key === 'Escape' || e.isComposing) return;
    // The app's own shortcuts stay off while the editor is up.
    e.stopImmediatePropagation();
    if (confirm || saving || e.altKey) return;
    const mod = e.ctrlKey || e.metaKey;
    // The text box keeps every key for itself; only Enter without Shift ends it.
    if (draft) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        endDraft(true);
      }
      return;
    }
    if (mod && e.code === 'KeyZ' && !e.shiftKey) {
      e.preventDefault();
      undo();
      return;
    }
    if (mod) return;
    if (e.key === '[' || e.key === ']') {
      e.preventDefault();
      resize(e.key === ']' ? SIZE_STEP : 1 / SIZE_STEP, hover.current);
      return;
    }
    if (e.shiftKey) return;
    // Letters as on the board, digits in toolbar order.
    const n = Number(e.key);
    const t = TOOLS.find((x) => x.key === e.key.toUpperCase()) ?? (n >= 1 && n <= TOOLS.length ? TOOLS[n - 1] : undefined);
    if (t) setTool(t.id);
  });
  useEffect(() => {
    const offEsc = pushEscape(() => onEsc());
    const key = (e: KeyboardEvent) => onKey(e);
    addEventListener('keydown', key, true);
    return () => {
      offEsc();
      removeEventListener('keydown', key, true);
    };
  }, []);

  const swatches = COLORS.map((c) => (
    <button key={c.hex} type="button" className="bd-btn an-sw" aria-pressed={color === c.hex} aria-label={c.name} title={c.name} onClick={() => setColor(c.hex)}>
      <span className="an-dot" style={{ background: c.hex }} />
    </button>
  ));
  // The thickness on screen, which is what the preview dot and the presets show.
  const onScreen = Math.round(thick * k);
  const dot = Math.min(Math.max(thick * k, 4), 20);
  const fontScreen = font * k;
  // The box never renders under 16px, so iOS does not zoom into it; a scale brings it to the real size.
  const taPx = Math.max(16, fontScreen);

  return (
    <div className="an-root" ref={rootRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={`Draw on ${name}`} data-ready={nat ? '' : undefined} data-tool={tool}>
      <div className="an-bar" role="toolbar" aria-label="Drawing tools">
        {TOOLS.map(({ id, label, key, Icon }, i) => (
          <button key={id} type="button" className="bd-btn bd-tool" aria-pressed={tool === id} aria-label={label} aria-keyshortcuts={`${i + 1} ${key}`} title={`${label} · ${i + 1} or ${key}`} onClick={() => setTool(id)}>
            <Icon />
            <span className="bd-num" aria-hidden="true">{i + 1}</span>
          </button>
        ))}
        <span className="bd-vr" />
        <div className="an-colors" role="group" aria-label="Colour" onMouseDown={keepFocus}>
          {swatches}
        </div>
        <span className="bd-vr an-vrc" />
        <button
          type="button" className="bd-btn an-size" ref={sizeBtnRef} popoverTarget="an-size-pop" aria-haspopup="dialog" aria-label="Thickness" aria-keyshortcuts="[ ]"
          title="Thickness · [ or ]" onMouseDown={keepFocus}
        >
          <span className="an-trk">
            <span className="an-pv" style={{ width: dot, height: dot, background: color }} />
          </span>
        </button>
        <div className="pop an-pop" id="an-size-pop" popover="auto" ref={popRef} role="dialog" aria-label="Thickness" onMouseDown={keepFocus}>
          <div className="an-pg an-pcol" role="group" aria-label="Colour">{swatches}</div>
          <div className="an-pg" role="group" aria-label="Thickness">
            {SIZES.map(({ px, label, line }) => (
              <button key={px} type="button" className="bd-btn" aria-pressed={onScreen === px} aria-label={label} title={`${label} · ${px} px`} onClick={() => setSize(px / k)}>
                <Line w={line} />
              </button>
            ))}
          </div>
          <p className="an-hint"><span className="an-keys"><kbd>[</kbd> <kbd>]</kbd> or Ctrl+wheel · </span>{onScreen} px</p>
        </div>
        <span className="bd-vr" />
        <button type="button" className="bd-btn" disabled={!past.length || saving} aria-label="Undo" aria-keyshortcuts="Control+Z" title="Undo (Ctrl+Z)" onClick={undo}>
          <UndoIcon />
        </button>
        <button type="button" className="bd-btn" disabled={!marks.length || saving} aria-label="Clear drawing" title="Clear drawing (Undo brings it back)" onClick={clear}>
          <ClearIcon />
        </button>
      </div>
      <div className="an-acts">
        {confirm ? (
          <div className="an-confirm" role="group" aria-labelledby="an-q">
            <span id="an-q">Discard changes?</span>
            <button type="button" className="an-btn" onClick={keepEditing}>Keep editing</button>
            <button type="button" className="an-btn an-discard" ref={discardRef} onClick={close}>Discard</button>
          </div>
        ) : (
          <>
            {error && <span className="an-err" role="status">{error}</span>}
            <button type="button" className="an-btn" ref={cancelRef} title="Cancel (Esc)" disabled={saving} onClick={askClose}>Cancel</button>
            {/* Text being typed counts: pressing Save ends the box (blur) before the click saves. */}
            <button type="button" className="an-btn an-save" disabled={!marks.length && !draftText.trim()} aria-busy={saving} title={marks.length ? 'Replace the attachment with this drawing' : 'Draw something to save'} onClick={save}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </>
        )}
      </div>
      <div className="an-stage" ref={stageRef}>
        {nat && (
          <div className="an-frame" ref={frameRef}>
            <img src={src} alt="" draggable={false} />
            <canvas className="an-cv" ref={baseRef} aria-hidden="true" />
            <canvas
              className="an-cv an-live" ref={liveRef} aria-label="Drawing area"
              onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={cancelStroke} onLostPointerCapture={cancelStroke}
              onPointerLeave={() => (hover.current = null)}
            />
            {at && (
              <textarea
                ref={taRef} className="an-text" aria-label="Text" spellCheck={false} wrap="off" rows={1} maxLength={TEXT_MAX} enterKeyHint="done"
                value={draftText} onChange={(e) => setDraftText(e.currentTarget.value)} onBlur={() => endDraft(true)}
                style={{
                  font: `${TEXT_WEIGHT} ${taPx}px/${LINE_H} ${TEXT_FONT}`, color, '--an-halo': haloFor(color),
                  transform: `translate(${at.x * k}px, ${at.y * k}px) scale(${fontScreen / taPx})`,
                } as CSSProperties}
              />
            )}
            {ring && <span className="an-ring" aria-hidden="true" style={{ width: thick * k, height: thick * k, color, transform: `translate(${ring.x - (thick * k) / 2}px, ${ring.y - (thick * k) / 2}px)` }} />}
          </div>
        )}
      </div>
    </div>
  );
}
