// Number and text helpers shared by inline ui components.

const fix = (v: number) => Number(v.toPrecision(12));

// Axis ticks: 0, 750, 1.5K, 12K, 3.2M.
export function short(v: number) {
  const a = Math.abs(v);
  for (const [k, s] of [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']] as const) {
    if (a >= k) return `${fix(Number((v / k).toFixed(1)))}${s}`;
  }
  return String(fix(Number(v.toFixed(2))));
}

// Labels next to marks: grouped, at most 2 decimals, compact from a million.
export const plain = (v: number) => (Math.abs(v) >= 1e6 ? short(v) : v.toLocaleString('en-US', { maximumFractionDigits: 2 }));

// Tooltips show the value as written by the model.
export const exact = (v: number) => v.toLocaleString('en-US', { maximumFractionDigits: 6 });

const MONEY = /^(?:[$€£¥₹]|R\$)$/;

// Symbols stick to the number; word units get a space.
export function withUnit(s: string, unit = '') {
  if (!unit) return s;
  if (unit === '%') return `${s}%`;
  if (MONEY.test(unit)) return s.startsWith('-') ? `-${unit}${s.slice(1)}` : `${unit}${s}`;
  return `${s} ${unit}`;
}
// Units short enough to repeat on every label; longer ones live in the header.
export const inline = (unit = '') => unit === '%' || MONEY.test(unit);

const nice = (x: number) => {
  const p = 10 ** Math.floor(Math.log10(x));
  const f = x / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
};

// Round domain and about `count` evenly spaced ticks covering lo..hi.
export function niceScale(lo: number, hi: number, count = 4) {
  if (lo === hi) [lo, hi] = lo === 0 ? [0, 1] : lo > 0 ? [0, hi] : [lo, 0];
  const step = nice((hi - lo) / count);
  const a = Math.floor(lo / step) * step;
  const b = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  for (let t = a; t <= b + step / 2; t += step) ticks.push(fix(t));
  return { lo: fix(a), hi: fix(b), ticks };
}

let ctx: CanvasRenderingContext2D | null = null;
let family = '';
export function textWidth(s: string, size = 12) {
  if (!ctx) {
    ctx = document.createElement('canvas').getContext('2d');
    family = getComputedStyle(document.documentElement).getPropertyValue('--sans').trim() || 'system-ui, sans-serif';
  }
  if (!ctx) return s.length * size * 0.6;
  ctx.font = `${size}px ${family}`;
  return ctx.measureText(s).width;
}

// Cuts a label to fit `max` px, ending in an ellipsis.
export function clip(s: string, max: number, size = 12) {
  if (textWidth(s, size) <= max) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const m = (lo + hi + 1) >> 1;
    if (textWidth(`${s.slice(0, m)}…`, size) <= max) lo = m;
    else hi = m - 1;
  }
  return `${s.slice(0, lo).trimEnd()}…`;
}
