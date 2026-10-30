import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { SourceMap } from 'node:module';
import { join } from 'node:path';
import { CACHE_DIR } from './config.ts';
import { localUrl } from './files.ts';
import type { BrowserClientMessage, BrowserFeedback } from './protocol.ts';

type Send = (method: string, params?: object) => Promise<any>;
type Cdp = { send: (method: string, params?: object, session?: string) => Promise<any> };
type Spot = { file: string; line: number; column: number };
// source: a line in the file the user wrote. at: only a frame in the served module, whose lines count transformed code.
type Component = { name: string; source?: Spot; at?: Spot };
type Details = ReturnType<typeof describe>;
const dir = join(CACHE_DIR, 'browser', 'feedback');

// Runs on the resolved node; React metadata is best effort and never inferred from DOM class names.
function describe(this: Element) {
  const e = this;
  const r = e.getBoundingClientRect();
  const path: string[] = [];
  for (let n: Element | null = e; n; n = n.parentElement) {
    if (n.id) { path.unshift(`#${CSS.escape(n.id)}`); break; }
    const siblings = n.parentElement ? [...n.parentElement.children].filter((s) => s.tagName === n!.tagName) : [n];
    path.unshift(n.localName + (siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(n) + 1})` : ''));
  }
  const styles = getComputedStyle(e);
  const computed = Object.fromEntries(['color', 'background-color', 'font-size', 'font-family', 'display', 'position'].map((k) => [k, styles.getPropertyValue(k)]));
  const key = Object.keys(e).find((k) => k.startsWith('__reactFiber$'));
  let fiber = key ? (e as any)[key] : null;
  let child = fiber;
  const components: Component[] = [];
  for (let i = 0; fiber && i < 50 && components.length < 6; i++, child = fiber, fiber = fiber._debugOwner ?? fiber.return) {
    const t = fiber.type;
    if (typeof t !== 'function' && typeof t !== 'object') continue;
    const name = t?.displayName || t?.name || t?.render?.displayName || t?.render?.name;
    if (!name) continue;
    // Where this component renders the previous one: React 18 keeps the JSX source, React 19 only a call stack.
    const source = child._debugSource;
    const stack = child._debugStack?.stack;
    const frame = typeof stack === 'string' ? stack.split('\n').slice(1).find((s: string) => !/(node_modules|\/deps\/)/.test(s)) : null;
    const at = frame?.trim().replace(/^at (?:.*? \()?/, '').replace(/\)$/, '').match(/^(.*):(\d+):(\d+)$/);
    components.push({ name, ...(source ? { source: { file: source.fileName, line: source.lineNumber, column: source.columnNumber } }
      : at ? { at: { file: at[1], line: Number(at[2]), column: Number(at[3]) } } : {}) });
  }
  return { url: location.href, tag: e.localName, id: e.id, classes: [...e.classList], selector: path.join(' > '), text: (e instanceof HTMLElement ? e.innerText : e.textContent || '').slice(0, 200),
    box: { x: r.x, y: r.y, width: r.width, height: r.height }, computed, components,
    clip: { x: Math.max(0, r.x + scrollX), y: Math.max(0, r.y + scrollY), width: r.width, height: r.height, scale: 1 } };
}

// Runs in the page, so the dev server answers these fetches like the module loads it already served.
async function sourceMaps(urls: string[]) {
  return Promise.all(urls.map(async (u) => {
    try {
      const code = await (await fetch(u)).text();
      const ref = /\/\/[#@] ?sourceMappingURL=(\S+)\s*$/.exec(code)?.[1];
      if (!ref) return null;
      const url = new URL(ref, u).href;
      const map = await (await fetch(url)).text();
      return map.length < 5e6 ? { url, map } : null;
    } catch {
      return null;
    }
  }));
}

// A source as the path the user knows: the dev server's path for its own files, else the name the map gives.
function shown(file: string, base: string) {
  try {
    const u = new URL(file, base);
    return ['http:', 'https:', 'file:'].includes(u.protocol) ? decodeURIComponent(u.pathname) : file;
  } catch {
    return file;
  }
}

// React 19 frames point into the served module; its source map gives the line in the original file.
async function locate(send: Send, components: Component[]) {
  const urls = [...new Set(components.flatMap((c) => (c.at && /^https?:/.test(c.at.file) ? [c.at.file] : [])))];
  if (!urls.length) return;
  const { result } = await send('Runtime.evaluate', { expression: `(${sourceMaps})(${JSON.stringify(urls)})`, awaitPromise: true, returnByValue: true });
  const maps = new Map<string, { map: SourceMap; base: string }>();
  (result?.value as ({ url: string; map: string } | null)[] | undefined)?.forEach((m, i) => {
    if (!m) return;
    // A map that does not parse leaves that location marked unavailable.
    try {
      maps.set(urls[i], { map: new SourceMap(JSON.parse(m.map)), base: m.url.startsWith('data:') ? urls[i] : m.url });
    } catch {}
  });
  for (const c of components) {
    const m = c.at && maps.get(c.at.file);
    if (!m) continue;
    const o = m.map.findOrigin(c.at!.line, c.at!.column);
    if ('fileName' in o && o.fileName) c.source = { file: shown(o.fileName, m.base), line: o.lineNumber, column: o.columnNumber };
  }
}

function label(d: Details) {
  const text = d.text.replace(/\s+/g, ' ').trim();
  const what = d.tag + (d.id ? `#${d.id}` : d.classes[0] ? `.${d.classes[0]}` : '');
  const quote = text ? ` "${text.length > 24 ? `${text.slice(0, 24)}…` : text}"` : '';
  return `${d.components[0] ? `${d.components[0].name} › ` : ''}${what}${quote}`;
}

function report(d: Details) {
  const b = d.box;
  const lines = [
    `Page: ${d.url}`,
    `Element: <${d.tag}${d.id ? ` id="${d.id}"` : ''}${d.classes.length ? ` class="${d.classes.join(' ')}"` : ''}>`,
    `Selector: ${d.selector}`,
    ...(d.text.trim() ? [`Text: ${JSON.stringify(d.text.trim())}`] : []),
    `Box: ${Math.round(b.width)}×${Math.round(b.height)} at x ${Math.round(b.x)}, y ${Math.round(b.y)} (CSS px in the viewport)`,
    `Styles: ${Object.entries(d.computed).map(([k, v]) => `${k}: ${v}`).join('; ')}`,
  ];
  if (!d.components.length) lines.push('React: no component found (needs a React dev build)');
  else lines.push('React components, nearest first; each location is the JSX in that component that leads to this element:', ...d.components.map((c) => `  ${c.name}${
    c.source ? ` at ${c.source.file}:${c.source.line}:${c.source.column}` : c.at ? ` in ${shown(c.at.file, c.at.file)} (original line unavailable)` : ' (location unavailable)'}`));
  return lines.join('\n');
}

export async function browserFeedback(cdp: Cdp, session: string, m: Extract<BrowserClientMessage, { type: 'feedback' }>): Promise<BrowserFeedback | null> {
  const send: Send = (method, params = {}) => cdp.send(method, params, session);
  if (!['hover', 'pick', 'screenshot', 'off'].includes(m.action)) throw new Error('Unknown feedback action');
  await send('DOM.enable');
  await send('Overlay.enable');
  if (m.action === 'off') { await send('Overlay.hideHighlight'); return null; }
  let details: Details | null = null;
  if (m.action === 'hover' || m.action === 'pick') {
    if (!Number.isFinite(m.x) || !Number.isFinite(m.y)) throw new Error('Invalid pick coordinates');
    const { backendNodeId } = await send('DOM.getNodeForLocation', { x: Math.round(m.x!), y: Math.round(m.y!), includeUserAgentShadowDOM: false });
    if (m.action === 'hover') {
      await send('Overlay.highlightNode', { backendNodeId, highlightConfig: { showInfo: true, contentColor: { r: 65, g: 135, b: 240, a: 0.25 }, borderColor: { r: 65, g: 135, b: 240, a: 1 } } });
      return null;
    }
    const { object } = await send('DOM.resolveNode', { backendNodeId });
    try {
      const result = await send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: describe.toString(), returnByValue: true });
      if (result.exceptionDetails) throw new Error('Could not inspect this element');
      details = result.result.value as Details;
    } finally { await send('Runtime.releaseObject', { objectId: object.objectId }); }
    // A page that blocks the fetches keeps its runtime locations, marked unavailable.
    await locate(send, details.components).catch(() => {});
  }
  await send('Overlay.hideHighlight');
  const { cssContentSize, cssLayoutViewport: view } = await send('Page.getLayoutMetrics');
  const clip = details?.clip ?? { x: 0, y: 0, width: cssContentSize.width, height: cssContentSize.height, scale: 1 };
  if (!clip.width || !clip.height) throw new Error('This element has no visible area');
  // Bound raster memory even on very long pages; preserve the complete page at reduced resolution.
  clip.scale = Math.min(1, 4096 / Math.max(clip.width, clip.height));
  // Capturing beyond the viewport resizes it, which the page sees; an element on screen does not need that.
  const b = details?.box;
  const onScreen = !!b && b.x >= 0 && b.y >= 0 && b.x + b.width <= view.clientWidth && b.y + b.height <= view.clientHeight;
  const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: !onScreen, clip });
  const id = randomUUID();
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${Date.now()}-${id}.png`);
  await writeFile(path, Buffer.from(data, 'base64'));
  // At most 40 captures survive, including captures from previous server runs.
  const files = (await readdir(dir)).filter((n) => n.endsWith('.png')).sort();
  await Promise.all(files.slice(0, Math.max(0, files.length - 40)).map((n) => rm(join(dir, n), { force: true })));
  if (details) return { id, src: localUrl(path), name: label(details), text: report(details) };
  const { result } = await send('Runtime.evaluate', { expression: 'location.href', returnByValue: true });
  return { id, src: localUrl(path), name: 'Full page', text: `Page: ${result?.value ?? 'unknown'}\nFull-page screenshot` };
}
