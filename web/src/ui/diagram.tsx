import { Card } from './card.tsx';
import { defineUi } from './define.ts';
import { schema, type Data } from './diagram.schema.ts';
import { draw, fade, pop, type Stage } from './motion.ts';
import { clip, textWidth } from './num.ts';
import { useWidth } from './size.ts';

type N = { id: string; label: string; sub?: string; layer: number; ord: number; w: number; h: number; x: number; y: number; acc: boolean; d: number };
type E = { s: N; t: N; label?: string; acc: boolean; back: boolean; path: string; tip: string; lx: number; ly: number; lw: number; d: number; dur: number };

const PAD = 14;
const MAXW = 176;
const MAX_ROOM = 880;
const LBL = 12;

// Ids may repeat or be missing; edges may name nodes never listed. Both resolve to one node per id.
function graphOf(b: Data) {
  const byId = new Map<string, N>();
  const add = (id: string, label = id, sub?: string) => {
    const hit = byId.get(id);
    if (hit) return hit;
    const n: N = { id, label, sub, layer: 0, ord: 0, w: 0, h: 0, x: 0, y: 0, acc: false, d: 0 };
    byId.set(id, n);
    return n;
  };
  for (const n of b.nodes) if (n.id) add(n.id, n.label || n.id, n.sub);
  const acc = new Set<string>();
  b.accent?.forEach((id, i, a) => i && acc.add(`${a[i - 1]}\u0000${id}`));
  const edges: E[] = [];
  for (const e of b.edges) {
    if (!e.from || !e.to || e.from === e.to) continue;
    edges.push({ s: add(e.from), t: add(e.to), label: e.label, acc: e.accent || acc.has(`${e.from}\u0000${e.to}`), back: false, path: '', tip: '', lx: 0, ly: 0, lw: 0, d: 0, dur: 0 });
  }
  for (const e of edges) if (e.acc) e.s.acc = e.t.acc = true;
  return { nodes: [...byId.values()], edges };
}

// Layers by longest path after cutting cycles, then a few barycenter sweeps to untangle crossings.
function layer(nodes: N[], edges: E[]) {
  const outs = new Map<N, E[]>(nodes.map((n) => [n, []]));
  for (const e of edges) outs.get(e.s)!.push(e);
  const seen = new Map<N, 1 | 2>();
  const post: N[] = [];
  const dfs = (u: N) => {
    seen.set(u, 1);
    for (const e of outs.get(u)!) {
      const st = seen.get(e.t);
      if (st === 1) e.back = true;
      else if (!st) dfs(e.t);
    }
    seen.set(u, 2);
    post.push(u);
  };
  nodes.forEach((n) => !seen.has(n) && dfs(n));
  for (const u of post.reverse()) for (const e of outs.get(u)!) if (!e.back) e.t.layer = Math.max(e.t.layer, u.layer + 1);
  const L = Math.max(0, ...nodes.map((n) => n.layer)) + 1;
  const layers = Array.from({ length: L }, (_, l) => nodes.filter((n) => n.layer === l));
  const pos = (n: N) => (n.ord + 0.5) / layers[n.layer].length;
  layers.forEach((ls) => ls.forEach((n, i) => (n.ord = i)));
  const fwd = edges.filter((e) => !e.back);
  for (let pass = 0; pass < 4; pass++) {
    const down = pass % 2 === 0;
    const order = down ? layers.slice(1) : layers.slice(0, -1).reverse();
    for (const ls of order) {
      const bc = new Map(ls.map((n) => {
        const nb = fwd.filter((e) => (down ? e.t === n : e.s === n)).map((e) => pos(down ? e.s : e.t));
        return [n, nb.length ? nb.reduce((a, c) => a + c, 0) / nb.length : pos(n)] as const;
      }));
      ls.sort((a, b) => bc.get(a)! - bc.get(b)! || a.ord - b.ord).forEach((n, i) => (n.ord = i));
    }
  }
  return layers;
}

const bez = (p: number[]) => `M${p[0]} ${p[1]}C${p[2]} ${p[3]} ${p[4]} ${p[5]} ${p[6]} ${p[7]}`;
const mid = (p: number[]) => [(p[0] + 3 * p[2] + 3 * p[4] + p[6]) / 8, (p[1] + 3 * p[3] + 3 * p[5] + p[7]) / 8];
// Open chevron at the curve's end, aligned with its last tangent.
function chevron(p: number[]) {
  let dx = p[6] - p[4];
  let dy = p[7] - p[5];
  const len = Math.hypot(dx, dy) || 1;
  dx /= len;
  dy /= len;
  const [x, y] = [p[6], p[7]];
  return `M${x - 6 * dx - 4 * dy} ${y - 6 * dy + 4 * dx}L${x} ${y}L${x - 6 * dx + 4 * dy} ${y - 6 * dy - 4 * dx}`;
}
// Several edges on one side of a node fan out instead of sharing a point.
const spread = (i: number, k: number, room: number) => (k < 2 ? 0 : (i - (k - 1) / 2) * Math.min(9, room / (k - 1)));

function layout(b: Data, room: number) {
  const { nodes, edges } = graphOf(b);
  const layers = layer(nodes, edges);
  const maxW = Math.max(64, Math.min(MAXW, room - 2 * PAD));
  for (const n of nodes) {
    n.w = Math.min(maxW, Math.max(64, Math.ceil(Math.max(textWidth(n.label, 13) * 1.06, n.sub ? textWidth(n.sub, 12) : 0)) + 28));
    n.h = n.sub ? 50 : 36;
  }
  const colW = layers.map((ls) => Math.max(...ls.map((n) => n.w)));
  const gaps = layers.slice(0, -1).map((_, l) => {
    const lw = Math.max(0, ...edges.filter((e) => !e.back && e.s.layer === l && e.label).map((e) => Math.min(120, textWidth(e.label!, LBL)) + 12));
    return Math.min(132, Math.max(44, lw + 20));
  });
  const wide = PAD * 2 + colW.reduce((a, c) => a + c, 0) + gaps.reduce((a, c) => a + c, 0);
  const lr = b.direction === 'LR' || b.direction === 'right' || (b.direction !== 'TB' && b.direction !== 'down' && wide <= room);
  const back = edges.some((e) => e.back);
  let W = 0;
  let H = 0;

  if (lr) {
    const colH = layers.map((ls) => ls.reduce((a, n) => a + n.h, 0) + 16 * (ls.length - 1));
    const inner = Math.max(...colH);
    let x = PAD;
    layers.forEach((ls, l) => {
      let y = 10 + (inner - colH[l]) / 2;
      for (const n of ls) {
        n.x = x + (colW[l] - n.w) / 2;
        n.y = y;
        y += n.h + 16;
      }
      x += colW[l] + (gaps[l] ?? 0);
    });
    W = x + PAD;
    H = inner + 20 + (back ? 34 : 0);
  } else {
    // Top to bottom: each layer is a row, wrapping into more lines when it does not fit.
    let y = 10;
    let gap = 0;
    const usable = room - 2 * PAD;
    for (const ls of layers) {
      const lines: N[][] = [[]];
      let used = 0;
      for (const n of ls) {
        if (lines.at(-1)!.length && used + 14 + n.w > usable) {
          lines.push([]);
          used = 0;
        }
        used += (lines.at(-1)!.length ? 14 : 0) + n.w;
        lines.at(-1)!.push(n);
      }
      for (const line of lines) {
        const lw = line.reduce((a, n) => a + n.w, 0) + 14 * (line.length - 1);
        const lh = Math.max(...line.map((n) => n.h));
        let x = PAD + (usable - lw) / 2;
        for (const n of line) {
          n.x = x;
          n.y = y + (lh - n.h) / 2;
          x += n.w + 14;
        }
        y += lh + 12;
      }
      const labelled = edges.some((e) => !e.back && e.s.layer === ls[0]?.layer && e.label);
      gap = labelled ? 36 : 24;
      y += gap;
    }
    // Shrink to the widest line, keeping room on the right for loops back up.
    const x0 = Math.min(...nodes.map((n) => n.x));
    const x1 = Math.max(...nodes.map((n) => n.x + n.w));
    for (const n of nodes) n.x -= x0 - PAD;
    W = Math.min(room, x1 - x0 + 2 * PAD + (back ? 34 : 0));
    H = y - gap - 12 + 10;
  }

  // Ports: outgoing edges sorted by where their target sits, incoming by their source.
  const cx = (n: N) => n.x + n.w / 2;
  const cy = (n: N) => n.y + n.h / 2;
  const key = (n: N) => (lr ? cy(n) : cx(n));
  const outIdx = new Map<E, [number, number]>();
  const inIdx = new Map<E, [number, number]>();
  for (const n of nodes) {
    const o = edges.filter((e) => !e.back && e.s === n).sort((a, c) => key(a.t) - key(c.t));
    o.forEach((e, i) => outIdx.set(e, [i, o.length]));
    const inc = edges.filter((e) => !e.back && e.t === n).sort((a, c) => key(a.s) - key(c.s));
    inc.forEach((e, i) => inIdx.set(e, [i, inc.length]));
  }
  const bottom = Math.max(...nodes.map((n) => n.y + n.h));
  const right = Math.max(...nodes.map((n) => n.x + n.w));
  for (const e of edges) {
    const { s, t } = e;
    let p: number[];
    if (e.back && lr) {
      const yb = bottom + 26;
      p = [cx(s), s.y + s.h, cx(s), yb, cx(t), yb, cx(t), t.y + t.h + 1];
    } else if (e.back) {
      const xr = Math.min(W - 4, right + 26);
      p = [s.x + s.w, cy(s), xr, cy(s), xr, cy(t), t.x + t.w + 1, cy(t)];
    } else if (lr) {
      const [oi, ok] = outIdx.get(e)!;
      const [ii, ik] = inIdx.get(e)!;
      const sy = cy(s) + spread(oi, ok, s.h - 16);
      const ty = cy(t) + spread(ii, ik, t.h - 16);
      const sx = s.x + s.w;
      const tx = t.x - 1;
      const dx = Math.max(18, (tx - sx) / 2);
      p = [sx, sy, sx + dx, sy, tx - dx, ty, tx, ty];
    } else {
      const [oi, ok] = outIdx.get(e)!;
      const [ii, ik] = inIdx.get(e)!;
      const sx = cx(s) + spread(oi, ok, s.w - 24);
      const tx = cx(t) + spread(ii, ik, t.w - 24);
      const sy = s.y + s.h;
      const ty = t.y - 1;
      const dy = Math.max(14, (ty - sy) / 2);
      p = [sx, sy, sx, sy + dy, tx, ty - dy, tx, ty];
    }
    p = p.map((v) => Math.round(v * 10) / 10);
    e.path = bez(p);
    e.tip = chevron(p);
    [e.lx, e.ly] = mid(p);
    e.lw = e.label ? Math.min(120, textWidth(e.label, LBL)) + 12 : 0;
    e.lx = Math.min(Math.max(e.lx, e.lw / 2 + 2), W - e.lw / 2 - 2);
  }

  // Timing: nodes land layer by layer; each edge draws once its source has landed.
  const ls = Math.min(70, 280 / Math.max(1, layers.length - 1));
  for (const n of nodes) n.d = Math.round(n.layer * ls + Math.min(n.ord, 4) * 24);
  for (const n of nodes) edges.filter((e) => e.s === n && !e.back).forEach((e, i) => ((e.d = n.d + 200 + i * 30), (e.dur = 380)));
  for (const e of edges) if (e.back) ((e.d = Math.max(e.s.d, e.t.d) + 180), (e.dur = 380));
  return { nodes, edges, W: Math.ceil(W), H: Math.ceil(H) };
}

// The room the message column offers, capped; the card then shrinks to the drawing.
const hostOf = (el: HTMLDivElement) => el.closest('.frame')?.parentElement;
function useRoom() {
  const [ref, w] = useWidth(hostOf);
  return [ref, w > 0 ? Math.min(MAX_ROOM, w - 2) : 0] as const;
}

const d = (el: Element, k = 'd') => Number((el as SVGElement).dataset[k] ?? 0);

const enter: Stage = (root) => {
  const q = (s: string) => root.querySelectorAll(s);
  return [
    ...pop(q('.ub-dg-n'), { delay: (el) => d(el), duration: 300 }, 0.94),
    ...draw(q('.ub-dg-e'), { delay: (el) => d(el), duration: 380 }),
    ...fade(q('.ub-dg-tip'), { delay: (el) => d(el) + d(el, 'dur') - 90, duration: 140 }),
    ...fade(q('.ub-dg-lb'), { delay: (el) => d(el) + d(el, 'dur') * 0.45, duration: 220 }),
  ];
};

function Drawing({ b, room }: { b: Data; room: number }) {
  const { nodes, edges, W, H } = layout(b, room);
  const inner = (n: N) => n.w - 20;
  return (
    <svg className="ub-dg-svg" width={W} height={H} aria-hidden="true">
      {edges.map((e, i) => (
        <g key={i} className={e.acc ? 'ub-dg-acc' : undefined}>
          <path className="ub-dg-e" d={e.path} pathLength={1} data-d={e.d} />
          <path className="ub-dg-tip" d={e.tip} data-d={e.d} data-dur={e.dur} />
        </g>
      ))}
      {edges.map((e, i) => e.label && (
        <g key={i} className={`ub-dg-lb${e.acc ? ' ub-dg-acc' : ''}`} data-d={e.d} data-dur={e.dur}>
          <rect x={e.lx - e.lw / 2} y={e.ly - 9} width={e.lw} height={18} rx={9} />
          <text x={e.lx} y={e.ly + 4} textAnchor="middle">{clip(e.label, 120, LBL)}</text>
        </g>
      ))}
      {nodes.map((n) => (
        <g key={n.id} className={`ub-dg-n${n.acc ? ' ub-dg-on' : ''}`} data-d={n.d}>
          <rect x={n.x + 0.5} y={n.y + 0.5} width={n.w - 1} height={n.h - 1} rx={8} />
          <text className="ub-dg-l" x={n.x + n.w / 2} y={n.y + (n.sub ? 21 : 22.5)} textAnchor="middle">{clip(n.label, inner(n), 13)}</text>
          {n.sub && <text className="ub-dg-s" x={n.x + n.w / 2} y={n.y + 38} textAnchor="middle">{clip(n.sub, inner(n), 12)}</text>}
        </g>
      ))}
    </svg>
  );
}

// Screen readers get each node with where its arrows go.
function Outline({ b }: { b: Data }) {
  const { nodes, edges } = graphOf(b);
  return (
    <div className="ub-sr">
      <ul>
        {nodes.map((n) => {
          const out = edges.filter((e) => e.s === n);
          return (
            <li key={n.id}>
              {n.label}{n.sub ? ` (${n.sub})` : ''}
              {out.length > 0 && `: leads to ${out.map((e) => `${e.t.label}${e.label ? ` (${e.label})` : ''}`).join(', ')}`}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Diagram({ b }: { b: Data }) {
  const [ref, room] = useRoom();
  return (
    <Card title={b.title} label="Diagram" stage={enter} className="ub-dg">
      <div ref={ref} className="ub-dw">{room > 0 && <Drawing b={b} room={room} />}</div>
      <Outline b={b} />
    </Card>
  );
}

export const diagram = defineUi({ schema, Component: Diagram, label: 'Drawing diagram…' });
