---
name: visual-explainer
description: House style for explanatory visuals drawn with mcp__visual__render_ui (diagrams, flows, small charts, animated explainers). Read once per session before the first explanatory render_ui call. Not for component prototypes; those follow the design the user gives.
---

# Visual explainer

The picture the user sees is the final frame. The play button replays the motion once.
So the still must explain on its own; motion only shows the order of things.

This is the house style: dark ink, one green accent and calm timing, on white with hairlines
instead of shadows.

## Readability first

The image is drawn 1:1 next to terminal text of about 15px. Anything smaller reads worse than
the chat around it, so the user cannot read it.

- No text under 16px (code 15px). If it does not fit, cut content or split it into two
  visuals; never shrink the type.
- Font: Atkinson Hyperlegible (built for legibility), with the fallbacks below. Body 400, titles 700.
- Fewer things per picture: about 5 nodes per row, two rows at most.

## Tokens

```css
:root{
  --bg:#fff;          /* always white */
  --ink:#1d2520;      /* primary text, main strokes */
  --muted:#5f6561;    /* secondary text, labels on lines */
  --faint:#9aa19c;    /* inactive nodes, back/optional paths */
  --line:#e4e4e0;     /* card borders, dividers, grid */
  --tint:#f4f2ef;     /* rare fill: code chips, a highlighted row */
  --accent:#3b7a57;   /* the ONE color: the path that matters */
  --bad:#9a4b3c;      /* only for a "no / blocked" mark, never decoration */
}
body{font:400 18px/1.4 "Atkinson Hyperlegible",Inter,system-ui,sans-serif;color:var(--ink)}
code{font:15px "Intel One Mono",ui-monospace,monospace}
```

- Type scale: title 26px/700, node label 18px, sub-label and line labels 16px. Title `letter-spacing:-.01em`. Numbers get `font-variant-numeric:tabular-nums`.
- Strokes: borders 1px. Connectors 1.5px, `stroke-linecap:round`. Nothing thicker than 2px.
- Radii: cards 10px, chips 8px, token pill 999px. No other values.
- Spacing: 8px grid. Body padding 24px. Card padding 14px 18px. Gap between nodes 96-120px, so a line label fits.
- Accent use: one path, one border, or one chip. If two things are green, one of them should not be.

## Canvas

- Width = content + 48px padding. Typical 600-1100. Never full width "to fill". Content starts top-left.
- Rows: content height + 48px, divided by 19, rounded up. A one-row flow is 9-11 rows; two tiers 16-20. Max 30.
- Wide and short beats tall. Prefer a left-to-right flow; wrap to a second row before going tall.
- The base style is white, 16px padding, `box-sizing:border-box`, `overflow:hidden`. Set `body{padding:24px}` and the bg yourself anyway.

## Layout

- Reading order: title top-left, then left to right, then top to bottom. Animation follows the same order.
- Title is a plain sentence stating the takeaway ("A cache hit skips the database"), not a topic ("Caching").
- Cards only for things that exist (a service, a table, an account, a step). Labels, values and notes are bare text.
- Connectors: SVG overlay (`position:absolute;inset:0;overflow:visible`) in the same positioned parent as the nodes. Measure endpoints with `getBoundingClientRect()`; never hardcode coordinates. Leave an 8px gap between line and card.
- Arrowheads: an open chevron path `l5 4-5 4` in the line's color. No filled triangles, no `<marker>` defaults.
- Straight lines first. Curves only to route around something: one cubic, horizontal tangents (`C midX y1, midX y2, x2 y2`).
- A path that does not happen: `--faint` color, dashed `2 5`. A blocked path: same, plus a small `--bad` x at its middle.
- Line labels sit centered above the line in `--muted` 16px, 2-3 words.
- Moving data (a request, an amount, a message) is a small dark pill: `--ink` bg, white 16px text, radius 999px. It ends parked where it arrived, so the still shows it.
- Charts: one axis, 2px line or thin bars, gridlines in `--line`, the series that matters in `--accent` and the rest in `--faint`, direct labels instead of a legend, values in ink (never in the series color). If one number is the point, show the number, not a chart.

## Motion

- Every scene ends in a meaningful final frame. No exits, no loops, no fade-outs. Total animation ends at least 200ms before `duration_ms`.
- Typical total 2-4s. Stay under 6s unless it is a multi-step story. `duration_ms` = last end + 300ms.
- Order: title, then nodes in reading order, then connectors draw, then labels, then the moving token, then the end-state change. One thing starts while the previous settles (overlap ~0.1-0.3s); never all at once, never strictly one after another.
- Values:

| What | From | Duration | Ease (GSAP / cubic-bezier) |
|---|---|---|---|
| Title | opacity 0, y 8 | 0.6s | `power3.out` / `.16,1,.3,1` |
| Card | opacity 0, y 12, scale .97 | 0.8s, stagger 0.12s | `expo.out` / `.16,1,.3,1` |
| Connector draw | dashoffset L+4 | 0.7s, stagger 0.1-0.3s | `power2.inOut` / `.65,0,.35,1` |
| Arrowhead | opacity 0 | 0.2s, when line ends | linear |
| Line label | opacity 0, y 4 | 0.5s | `power3.out` |
| Token travel | along the line | 1.0s | `power2.inOut` |
| Value swap | old: y -8, blur 3px, out 0.35s; new: y 8, blur 3px, in 0.5s | | `power2.in` / `power3.out` |

- Animate only `transform`, `opacity`, `filter: blur` and SVG `stroke-dashoffset`.
- Never from `scale(0)`; start at .97. No bounce, no overshoot, no elastic. The one exception: a small `back.out(1.6)` pop for a "no" mark.
- Never animate text the reader must read while it moves; let it land, then move the next thing.
- Physical metaphor when it fits: if the thing is a letter, an invoice or a card, move it like the real object.

## Libraries

Pick the library by what the picture is, before writing any HTML. Hand-rolling what a library
already does (a force layout, a math formula, code highlighting) looks worse and breaks more.

| The picture is | Use | Why |
|---|---|---|
| Cards and arrows, a flow, a sequence of steps | HTML cards + SVG overlay + GSAP timeline | Full control of the style; GSAP orders the steps |
| A short entrance, a list appearing | Motion `animate` + `stagger`, or CSS `@keyframes` | Less code than a timeline |
| A graph with many nodes whose positions you cannot pick by hand | elkjs (layered layout) or d3-force, then draw in our style | Layout math is hard to get right by hand |
| A real chart (axes, many points, a scale) | d3 (scales, axes, shapes) styled by hand | Chart.js only for a quick bar/line; restyle its defaults |
| Math, formulas | KaTeX | Real math typesetting |
| Code | highlight.js with the `github` theme, font 15px | Readable colors on white |
| Many particles, a simulation, physics | `<canvas>` on rAF, driven by `performance.now()` | DOM is too slow for hundreds of items |
| Something 3D | three.js (ES module + importmap) | Only when depth is the point |
| A "rough idea / sketch" feel | rough.js | Hand-drawn lines on purpose |

Never Mermaid for explainers: its default look fights this style. Use elkjs for layout instead.

Pinned, all checked on cdn.jsdelivr.net (prefix `https://cdn.jsdelivr.net/npm/`):

- GSAP `gsap@3.14.2/dist/gsap.min.js` (global `gsap`). Do not `paused:true`; let it play on load.
- Motion `motion@12.23.12/dist/motion.js` (global `Motion`; `const {animate, stagger} = Motion`).
- d3 `d3@7.9.0/dist/d3.min.js` (global `d3`).
- elkjs `elkjs@0.12.0/lib/elk.bundled.js` (global `ELK`; `new ELK().layout(graph)` returns a Promise).
- Chart.js `chart.js@4.5.1/dist/chart.umd.min.js` (global `Chart`). Set `animation:false` or its own duration under `duration_ms`.
- KaTeX `katex@0.19.0/dist/katex.min.js` + `katex@0.19.0/dist/katex.min.css`.
- highlight.js `@highlightjs/cdn-assets@11.12.0/highlight.min.js` + `.../styles/github.min.css`.
- rough.js `roughjs@4.6.6/bundled/rough.js` (global `rough`).
- three.js `three@0.186.1/build/three.module.min.js` via `<script type="importmap">`.

Async layout (elkjs, fonts, KaTeX): build the scene, then start the timeline. The final frame
is taken at `duration_ms`, so the whole thing must still finish in time.

Gotchas:

- Motion: the end keyframe must use the same transform functions as the start. `['translateY(12px) scale(.97)','none']` renders `scale(0)`, so the element vanishes. Write `'translateY(0px) scale(1)'`.
- Line draw: never `pathLength="1"`; GSAP's offset tween ignores it and the line pops in whole. Measure `L=p.getTotalLength()`, set `strokeDasharray:`${L} ${L+4}``, `strokeDashoffset:L+4` (the +4 hides the round-cap dot), tween the offset to 0. A dashed path cannot be drawn this way; fade it in.
- Insert measured SVG and labels before starting the animation, and measure before any transform is applied.
- Scripts at the end of `<body>`; load the CDN tag before the inline script.

## Never

- Gradients, glow, neon, glassmorphism, heavy or colored shadows.
- Purple, or more than one accent hue. Colored backgrounds on large areas.
- Emoji or icon-font decoration. A small inline SVG at 1.5px stroke if an icon is truly needed.
- Everything boxed. Centered hero card. A card inside a card.
- A canvas stretched to full width with the content floating in the middle.
- Arrows that cross each other, lines that touch cards, labels that overlap lines.
- Captions that restate the title. More than ~12 words of prose inside the picture.
- Text under 16px, or a font other than the one above, in an explainer.

After rendering, Read the PNG and check: gaps, overlaps, clipped text, empty right side.

## Skeleton

```html
<style>/* tokens above */ h2{font-size:26px;font-weight:700;letter-spacing:-.01em;margin:0 0 32px}
.row{position:relative;display:flex;gap:112px;width:max-content}
.node{padding:14px 18px;border:1px solid var(--line);border-radius:10px}
.node small{display:block;color:var(--muted);font-size:16px}
.hot{border-color:var(--accent)} svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible}
path{fill:none;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}</style>
<h2>A cache hit skips the database</h2>
<div class="row" id="row">
  <div class="node" id="a">Request<small>GET /user/42</small></div>
  <div class="node hot" id="b">Cache<small>Redis, 5 min TTL</small></div>
  <svg id="s"></svg>
</div>
<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
<script>
const R=row.getBoundingClientRect();
function link(p,q,color){ const a=p.getBoundingClientRect(),b=q.getBoundingClientRect();
  const y=a.top+a.height/2-R.top, x1=a.right-R.left+8, x2=b.left-R.left-8;
  s.insertAdjacentHTML('beforeend',`<path class="l" stroke="${color}" d="M${x1} ${y}H${x2}"/><path class="h" opacity="0" stroke="${color}" d="M${x2-5} ${y-4}l5 4-5 4"/>`); }
link(a,b,'#3b7a57');
s.querySelectorAll('.l').forEach(p=>{const L=p.getTotalLength();gsap.set(p,{strokeDasharray:`${L} ${L+4}`,strokeDashoffset:L+4})});
gsap.timeline()
  .from('h2',{opacity:0,y:8,duration:.6,ease:'power3.out'})
  .from('.node',{opacity:0,y:12,scale:.97,duration:.8,ease:'expo.out',stagger:.12},.2)
  .to('.l',{strokeDashoffset:0,duration:.7,ease:'power2.inOut'},1)
  .to('.h',{opacity:1,duration:.2},1.6);
</script>
```

Call with `width` ≈ 560, `rows: 10`, `duration_ms: 2200`.
