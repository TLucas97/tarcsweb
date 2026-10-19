import { recognize } from '../../web/src/board/recognize.ts';
import { generating, type BoardAdapter, type JobInput } from './jobs.ts';

// Stands in for a model so the refine flow can be tried without spending Codex allowance. Deterministic:
// empty prompt snaps shaky strokes, "mockup" (or any empty region) draws a phone header, "dashboard" a dashboard,
// "fail" breaks the JSON, "hang" never answers, "echo-context" also returns the context elements.

type Json = Record<string, unknown>;
type Pair = [number, number];

const STEPS = [
  { ms: 400, text: 'Reading the sketch' },
  { ms: 600, text: 'Cleaning up the lines' },
  { ms: 500, text: 'Fitting to the region' },
];

function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((done, fail) => {
    if (signal.aborted) return fail(new Error('Cancelled'));
    const t = setTimeout(() => {
      signal.removeEventListener('abort', stop);
      done();
    }, ms);
    const stop = () => {
      clearTimeout(t);
      fail(new Error('Cancelled'));
    };
    signal.addEventListener('abort', stop, { once: true });
  });
}

const deg = (rad: number) => Math.round((rad * 180) / Math.PI);
const int = (v: number) => Math.round(v);
const side = (v: number) => Math.max(1, Math.round(v));

// Freehand strokes that are nearly a line, ellipse or (rounded) rect become that shape; pictures go, the rest is kept as is.
function cleanUp(doc: JobInput['elements']) {
  const elements = doc.elements.filter((raw) => (raw as Json)?.kind !== 'image').map((raw) => {
    const el = raw as Json;
    if (el?.kind !== 'stroke' || !Array.isArray(el.pts)) return el;
    const s = recognize((el.pts as Pair[]).flat(), 1).snap;
    if (!s) return el;
    const keep = { ...(el.id !== undefined && { id: el.id }), ...(el.color !== undefined && { color: el.color }), ...(el.strokeWidth !== undefined && { strokeWidth: el.strokeWidth }) };
    if (s.kind === 'line') return { kind: 'line', from: [int(s.x1), int(s.y1)], to: [int(s.x2), int(s.y2)], ...keep };
    if (s.kind === 'poly') {
      const pts: Pair[] = [];
      for (let i = 0; i < s.pts.length; i += 2) pts.push([int(s.pts[i]), int(s.pts[i + 1])]);
      return { kind: 'poly', pts, ...(s.closed && { closed: true }), ...keep };
    }
    const box = { x: int(s.cx - s.w / 2), y: int(s.cy - s.h / 2), w: side(s.w), h: side(s.h), ...(deg(s.rot) && { rot: deg(s.rot) }) };
    if (s.kind === 'ellipse') return { kind: 'ellipse', ...box, ...keep };
    return { kind: 'rect', ...box, ...(int(s.r) > 0 && { r: int(s.r) }), ...keep };
  });
  return { w: doc.w, h: doc.h, elements };
}

// A phone header filling the region: frame, header bar, menu and apple icons, a title.
function mockup({ w, h }: { w: number; h: number }) {
  const pad = Math.max(0, Math.round(Math.min(w, h) * 0.04));
  const fw = side(w - 2 * pad), fh = side(h - 2 * pad);
  const bar = side(Math.min(fh * 0.4, Math.max(24, fh * 0.18)));
  const icon = side(Math.min(bar * 0.55, fw / 8));
  const iy = int(pad + (bar - icon) / 2);
  const size = side(Math.min(icon * 0.8, 64));
  return {
    w,
    h,
    elements: [
      { kind: 'rect', x: pad, y: pad, w: fw, h: fh, r: int(Math.min(fw, fh) * 0.08) },
      { kind: 'line', from: [pad, pad + bar], to: [pad + fw, pad + bar] },
      { kind: 'icon', x: int(pad + icon * 0.6), y: iy, w: icon, h: icon, name: 'menu' },
      { kind: 'icon', x: int(pad + fw - icon * 1.6), y: iy, w: icon, h: icon, name: 'apple' },
      { kind: 'text', x: int(pad + icon * 2.2), y: int(pad + (bar - size * 1.25) / 2), text: 'Title', size },
    ],
  };
}

// A dashboard filling the region: left sidebar with nav rows, top bar with a title, four stat cards.
function dashboard({ w, h }: { w: number; h: number }) {
  const pad = Math.max(2, Math.round(Math.min(w, h) * 0.03));
  const sw = side(w * 0.22), top = side(h * 0.14), gap = pad;
  const x0 = pad + sw + gap, cw = side((w - x0 - pad - gap * 3) / 4), ch = side(h * 0.22);
  const size = side(Math.min(top * 0.45, 24));
  const els: Json[] = [
    { kind: 'rect', x: pad, y: pad, w: side(w - 2 * pad), h: side(h - 2 * pad), r: int(pad) },
    { kind: 'line', from: [pad + sw, pad], to: [pad + sw, h - pad] },
    { kind: 'line', from: [pad + sw, pad + top], to: [w - pad, pad + top] },
    { kind: 'text', x: x0, y: int(pad + (top - size * 1.25) / 2), text: 'Dashboard', size },
  ];
  for (let i = 0; i < 4; i++) els.push({ kind: 'rect', x: int(pad + gap), y: int(pad + top + gap + i * (size + gap)), w: side(sw - 2 * gap), h: side(size), r: 4 });
  for (let i = 0; i < 4; i++) els.push({ kind: 'rect', x: int(x0 + i * (cw + gap)), y: int(pad + top + gap), w: cw, h: ch, r: 6 });
  return { w, h, elements: els };
}

export const fakeAdapter: BoardAdapter = {
  id: 'fake',
  label: 'Fake (no model)',
  capabilities: { elements: true },
  async submit(input, emit, signal) {
    const p = input.prompt.toLowerCase();
    const fresh = generating(input);
    for (let i = 0; i < STEPS.length; i++) {
      // The first step echoes the job's model pick, so checks can see it reached the adapter.
      const ctx = input.context.length || input.overview ? ` context ${input.context.length}${input.overview ? ` overview ${input.overview.w}x${input.overview.h}` : ''}` : '';
      const text = i === 0 ? `${fresh ? 'Reading the request' : STEPS[0].text} (${input.model ?? '-'}/${input.effort ?? '-'}${input.fast ? '/fast' : ''})${ctx}` :i === 1 && (fresh || p.includes('mockup')) ? 'Drafting the mockup' : STEPS[i].text;
      emit({ step: i + 1, of: STEPS.length, text });
      await wait(STEPS[i].ms, signal);
    }
    // Never settles until cancelled or the job deadline aborts it.
    if (p.includes('hang')) await new Promise((_, fail) => signal.addEventListener('abort', () => fail(new Error('Cancelled')), { once: true }));
    if (p.includes('fail')) return { json: '{"w": 10, "h": 10, "elements": [{"kind": "rect", ' };
    const doc = p.includes('dashboard') ? dashboard(input.target) : fresh || p.includes('mockup') ? mockup(input.target) : cleanUp(input.elements);
    // A model that wrongly hands the context back, so checks can see the client drop it.
    if (p.includes('echo-context')) (doc.elements as Json[]).push(...(input.context as Json[]));
    const json = JSON.stringify(doc);
    // Answers wrapped the way chat models often wrap them, for the server's JSON extraction.
    if (p.includes('fenced')) return { json: `Here is the cleaned region:\n\n\`\`\`json\n${json}\n\`\`\`\n\nLet me know if you want changes.` };
    if (p.includes('prose')) return { json: `Sure {not this}. The result is ${json} and that is all {"x": 1}.` };
    return { json };
  },
};
