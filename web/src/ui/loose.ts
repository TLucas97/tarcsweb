import { z } from 'zod';

// Lenient shapes for the structure blocks: a model writes this JSON, so synonyms and plain strings are accepted.

const STATUS: Record<string, 'done' | 'now' | 'next' | 'blocked'> = {
  done: 'done', complete: 'done', completed: 'done', finished: 'done', shipped: 'done', ok: 'done', yes: 'done', true: 'done', past: 'done',
  now: 'now', current: 'now', active: 'now', doing: 'now', 'in progress': 'now', in_progress: 'now', wip: 'now',
  next: 'next', todo: 'next', planned: 'next', upcoming: 'next', pending: 'next', future: 'next', no: 'next', false: 'next', open: 'next',
  blocked: 'blocked', stuck: 'blocked', waiting: 'blocked', failed: 'blocked',
};
export const status = z.preprocess((v) => {
  const k = String(v).trim().toLowerCase();
  return Object.hasOwn(STATUS, k) ? STATUS[k] : undefined;
}, z.enum(['done', 'now', 'next', 'blocked']).optional());
export type Status = z.output<typeof status>;

// Visually hidden state words, so a screen reader hears what the dot colour shows.
export const SAY = { done: 'done', now: 'current', next: 'upcoming', blocked: 'blocked' } as const;

// Time (0..1) at which a cubic-bezier easing reaches progress `p`, so marks can land when a drawn line passes them.
export function timeAt(p: number, [x1, y1, x2, y2]: readonly [number, number, number, number]) {
  const bz = (a: number, b: number, s: number) => 3 * a * s * (1 - s) ** 2 + 3 * b * s * s * (1 - s) + s ** 3;
  let lo = 0;
  let hi = 1;
  for (let k = 0; k < 24; k++) {
    const m = (lo + hi) / 2;
    if (bz(y1, y2, m) < p) lo = m;
    else hi = m;
  }
  return bz(x1, x2, hi);
}

// Copies the first present alias into the canonical key, and turns a bare string into `{ [bare]: s }`.
export function loose<S extends z.ZodType>(schema: S, aliases: Record<string, string[]>, bare?: string) {
  return z.preprocess((v) => {
    if (bare && (typeof v === 'string' || typeof v === 'number')) return { [bare]: v };
    if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
    const o: Record<string, unknown> = { ...v };
    for (const [k, alts] of Object.entries(aliases)) {
      const a = o[k] === undefined && alts.find((x) => o[x] !== undefined);
      if (a) o[k] = o[a];
    }
    return o;
  }, schema);
}
