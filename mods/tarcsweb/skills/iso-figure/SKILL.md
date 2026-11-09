---
name: iso-figure
description: Draw one small isometric 3D SVG figure inside an explanatory visual (mcp__visual__render_ui, a replay page or an mcp__app__ask_prototype page) - a physical object whose working is the concept, with token-only shading, painter's order, calm motion and a live readout. Load it only when the user chose the figure for this visual (visual_mode's figure option, or a direct ask for an isometric or 3D figure); never on your own.
---

# Iso figure

One small, well-made object, drawn in isometric SVG, that explains a mechanism. It sits in a picture that also has short text. Paste the helper below into the page's inline `<script>`; there is no kit, build step or Node script.

## When to use it

- The idea is spatial, a physical or layered mechanism, or the user asked for 3D or isometric.
- Not for lists, comparisons or plain flows. Those stay text, cards or a ```ui diagram block.
- If the object needs a caption to say what it stands for, draw the flow instead.

## The object is the explanation

Invent a real, recognisable thing whose working *is* the concept. No floating slabs, labelled boxes or arrows: they read as nothing.

| Concept | Object |
|---|---|
| A queue that keeps the newest N | A tray with N slots; a new block pushes in at the front, the oldest drops off the back |
| A cache hit | A cabinet of drawers; the matching drawer slides out, the others stay shut |
| A rate limiter | A hopper that refills one ball per tick; each request takes a ball, an empty hopper refuses |
| Middleware layers | Plates on guide pillars; a token passes down through each plate in order |

- **One object per figure**, scaled to fill its space. Say in one sentence what moves and what that motion means before you draw.
- **Truth first.** Write the model as a few plain values and one function (`stateAt(t)` or `stateOf(input)`). Every number the figure shows and every part that moves comes from it. A readout that disagrees with the drawing is a bug.
- **Parts that teach.** 8-30 parts is typical: a base the thing stands on, the guides or frame, the moving part, stops, a slot or window for the readout. Each part rests on another and has a job.

## The helper

World units: x and y on the floor, z up. The viewer sits toward +x, +y, +z, so `+y` faces show on the screen's left and `+x` faces on its right. Build parts as prisms, call `fit` once with every part, then draw in `paintOrder`.

```js
// Iso camera; keep az between 30 and 60 so the +x/+y faces stay in view.
const CAM = { az: 45, el: 30, s: 1, ox: 0, oy: 0 };
const rad = (d) => d * Math.PI / 180;
const iso = ([x, y, z]) => { const a = rad(CAM.az), e = rad(CAM.el);
  return [CAM.ox + (x * Math.sin(a) - y * Math.cos(a)) * CAM.s,
          CAM.oy + ((x * Math.cos(a) + y * Math.sin(a)) * Math.sin(e) - z * Math.cos(e)) * CAM.s]; };
const depth = ([x, y, z]) => { const a = rad(CAM.az), e = rad(CAM.el); // larger = nearer
  return (x * Math.cos(a) + y * Math.sin(a)) * Math.cos(e) + z * Math.sin(e); };
const pts = (list) => list.map((p) => iso(p).map((v) => +v.toFixed(1)).join(",")).join(" ");
const shift = (v) => { const [a, b] = iso(v), [c, d] = iso([0, 0, 0]); return [a - c, b - d]; };

// Prism from a convex floor polygon (counter-clockwise [x, y] list), base z and height h.
function prism(poly, z, h, cls = "", round = false) {
  const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
  return { poly, cls, round, z0: z, z1: z + h,
    x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
}
const box = (x, y, z, w, d, h, cls) => prism([[x, y], [x + w, y], [x + w, y + d], [x, y + d]], z, h, cls);
const cyl = (cx, cy, r, z, h, cls, n = 32) => prism(Array.from({ length: n }, (_, i) =>
  [cx + r * Math.cos(2 * Math.PI * i / n), cy + r * Math.sin(2 * Math.PI * i / n)]), z, h, cls, true);

// Visible sides shaded by facing (s1 lightest, s3 darkest), then the outline, then the top.
function prismSvg(p) {
  const a = rad(CAM.az), n = p.poly.length, vis = [], out = [];
  const B = (i) => [...p.poly[i % n], p.z0], T = (i) => [...p.poly[i % n], p.z1];
  for (let i = 0; i < n; i++) {
    const [ax, ay] = p.poly[i], [bx, by] = p.poly[(i + 1) % n], len = Math.hypot(bx - ax, by - ay);
    const nx = (by - ay) / len, ny = (ax - bx) / len, lit = (ny * Math.cos(a) - nx * Math.sin(a) + 1) / 2;
    vis[i] = nx * Math.cos(a) + ny * Math.sin(a) > 1e-9;
    if (vis[i]) out.push(`<polygon class="${lit > 2 / 3 ? "s1" : lit > 1 / 3 ? "s2" : "s3"}" points="${pts([B(i), B(i + 1), T(i + 1), T(i)])}"/>`);
  }
  const start = vis.findIndex((v, i) => v && !vis[(i + n - 1) % n]), run = [];
  for (let i = start; vis[i % n] && run.length < n; i++) run.push(i % n);
  const ends = [run[0], (run[run.length - 1] + 1) % n];
  let d = "M" + pts([B(run[0]), ...run.map((i) => B(i + 1))]);
  for (const i of p.round ? ends : [...run, ends[1]]) d += " M" + pts([B(i), T(i)]);
  out.push(`<path class="edge" d="${d}"/>`, `<polygon class="top" points="${pts(p.poly.map((_, i) => T(i)))}"/>`);
  return `<g class="part ${p.cls}">${out.join("")}</g>`;
}

// Scale and centre the camera so every part fills a W x H viewBox with pad px of air.
function fit(parts, W, H, pad = 12) {
  Object.assign(CAM, { s: 1, ox: 0, oy: 0 });
  const q = parts.flatMap((p) => [p.x0, p.x1].flatMap((x) => [p.y0, p.y1].flatMap((y) => [p.z0, p.z1].map((z) => iso([x, y, z])))));
  const xs = q.map((v) => v[0]), ys = q.map((v) => v[1]);
  const [l, r, t, b] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  CAM.s = Math.min((W - 2 * pad) / (r - l), (H - 2 * pad) / (b - t));
  CAM.ox = W / 2 - (l + r) / 2 * CAM.s; CAM.oy = H / 2 - (t + b) / 2 * CAM.s;
}

// A is painted before B when an axis plane puts A on B's far side.
const behind = (A, B) => A.x1 <= B.x0 || A.y1 <= B.y0 || A.z1 <= B.z0;
// Far to near. A cycle (parts that interlock like a pinwheel) has no right order: it warns, and you split a part.
function paintOrder(parts) {
  const c = (p) => depth([(p.x0 + p.x1) / 2, (p.y0 + p.y1) / 2, (p.z0 + p.z1) / 2]);
  const rest = [...parts].sort((a, b) => c(a) - c(b)), out = [];
  while (rest.length) {
    const i = rest.findIndex((p) => rest.every((o) => o === p || !behind(o, p) || behind(p, o)));
    if (i < 0) console.warn("paintOrder: cycle among", rest.map((p) => p.cls));
    out.push(rest.splice(Math.max(i, 0), 1)[0]);
  }
  return out;
}
```

Use it like this:

```js
const W = 420, H = 320, parts = [box(0, 0, -6, 120, 60, 6, "base"), box(10, 20, 0, 24, 20, 16, "key"), cyl(90, 30, 10, 0, 28)];
fit(parts, W, H);
svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
svg.innerHTML = paintOrder(parts).map(prismSvg).join("");
```

- Keep prisms convex. Split an L shape or a frame into boxes.
- If `paintOrder` warns about a cycle, three or more parts interlock and no order is right: split one of them in two.
- Round parts are `cyl`: its facets are drawn without seams and only its silhouette is outlined.
- Grooves, ticks and seams are `<path class="mark">` lines built with `pts` on a face, from edge to edge. A line that stops in mid-face reads as broken.
- Under the base, a floor shadow: a `<polygon class="shadow">` of the base footprint at `z0`, a few units larger.

## Shading with theme tokens only

Never type a color. Pages paint with `--bg --ink --muted --faint --line --tint --accent --bad`, and themed frames set `data-theme="dark"` on `<html>`. Tones come from `color-mix` or relative colors, with the top always the lightest face in both themes. Put `var()` in CSS classes or a `style` attribute, as below, not in hand-written hex.

```css
.fig{--top:var(--bg);--s1:color-mix(in oklab,var(--ink) 5%,var(--bg));
  --s2:color-mix(in oklab,var(--ink) 10%,var(--bg));--s3:color-mix(in oklab,var(--ink) 16%,var(--bg));
  --edge:color-mix(in oklab,var(--ink) 65%,var(--bg));--mix:0%}
:root[data-theme=dark] .fig{--top:color-mix(in oklab,var(--ink) 14%,var(--bg));--s1:color-mix(in oklab,var(--ink) 6%,var(--bg));
  --s2:oklch(from var(--bg) calc(l * .88) c h);--s3:oklch(from var(--bg) calc(l * .76) c h)}
.fig .part.key{--mix:38%;--edge:var(--accent)}
.fig .top{fill:color-mix(in oklab,var(--accent) var(--mix),var(--top))}
.fig .s1{fill:color-mix(in oklab,var(--accent) var(--mix),var(--s1));stroke:color-mix(in oklab,var(--accent) var(--mix),var(--s1))}
.fig .s2{fill:color-mix(in oklab,var(--accent) var(--mix),var(--s2));stroke:color-mix(in oklab,var(--accent) var(--mix),var(--s2))}
.fig .s3{fill:color-mix(in oklab,var(--accent) var(--mix),var(--s3));stroke:color-mix(in oklab,var(--accent) var(--mix),var(--s3))}
.fig polygon{stroke-width:.6;stroke-linejoin:round}
.fig .top,.fig .edge{stroke:var(--edge);stroke-width:1}
.fig .edge,.fig .mark{fill:none;stroke-linecap:round}
.fig .mark{stroke:var(--faint);stroke-width:.8}
.fig .shadow{fill:var(--ink);opacity:.07}
```

- Four tones: top, light side (s1), mid side (s2), shadow side (s3), plus the edge. The sides stroke in their own fill so cylinder facets show no hairline seams.
- The accent goes on exactly one part, the one the reader should watch (`class="key"`). Everything else stays in ink tones. Use `--bad` only when a refusal or failure is the point.

## Painter's order

- Back to front, bottom to top: `paintOrder` does it from the parts' bounds. A part standing on another is drawn after it.
- Inside one part, the sides come before the top face; `prismSvg` already does this.
- A part that wraps another (a frame round a carriage, a ring round a post) is split into a back piece and a front piece, so each sorts on its own.
- Sort once at build time. Re-sort only when a moving part passes in front of or behind a neighbour; a part sliding along a rail beside nothing never needs it.

## Motion

- The still frame must explain on its own; motion only shows the mechanism's change. One moving group, one calm sequence that ends on the outcome. An animated render_ui (`duration_ms`) plays once and finishes at least 200 ms before it. An interactive one (`interactive: true`) may loop while the user plays with it, but stops while the tab is hidden.
- Ease every move (`power2.inOut`-like, 0.6-1.2 s per step). Nothing snaps, bounces or overshoots.
- Move a part that only translates with a transform on its `<g>`: `translate(${shift([dx, dy, dz])})` times the eased progress. Animate only `transform` and `opacity`.
- A part whose shape changes, or that crosses a neighbour, is rebuilt in `requestAnimationFrame` with `prismSvg` and re-sorted. Fine for a few dozen parts.
- Drive time from the rAF timestamp, not a per-frame step. Under `prefers-reduced-motion: reduce`, draw the final state at once and stop.

## Readout and proof

- A live readout beside the figure (a counter, a value, a state word) is written in the same tick that moves the parts, from the same model. When the figure claims "the oldest drops off", the readout shows `kept 4 of 4 · dropped #1` as it happens.
- Show the proof, not only the claim: the refused request eases back to where it started, the drawer that missed stays shut, the counter keeps its value.
- Text is HTML outside the SVG, 16px or larger, in `var(--ink)` and `var(--muted)`. No labels, leader lines or arrows inside the drawing. Name a part in the text by its role or tone ("the highlighted block") instead.

## Fitting the canvases

- **render_ui:** canvas is `width` by rows x 19 px, at most 30 rows, minus 16 px body padding on each side, and nothing scrolls. The figure takes about half the width, the text sits beside it. Example: width 880 and 20 rows give a 400 x 330 viewBox next to a 400 px text column. Give the `<svg>` the same pixel size as its viewBox so text and strokes keep their true size.
- **Replay page (880 x 800):** at most one figure per page, with the page's title and text around it.
- **ask_prototype:** the controls (inputs with a `name`) feed the model, and the figure redraws from it on `input`. The user tunes values, not the drawing.
- Leave air: `fit` keeps `pad` px free on each side (12 by default); raise it when the object should sit smaller in its box. Check the PNG from `check: true` for a clipped corner or a part sunk into another.

## Effort follows intent

- Add detail until the mechanism is clear, then stop. No decorative screws, cables, vents or parts that teach nothing.
- Out of scope here: WebGL shaders, a 3D turning mode, PDF sheets and publishing. If the user wants one of those, say the full `anatomy` skill exists and let them choose it.

Based on ideas from the anatomy skill (MIT, © 2026 Ryan).
