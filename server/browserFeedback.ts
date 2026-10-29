import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CACHE_DIR } from './config.ts';
import { localUrl } from './files.ts';
import type { BrowserClientMessage, BrowserFeedback } from './protocol.ts';

type Cdp = { send: (method: string, params?: object, session?: string) => Promise<any> };
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
  const components: object[] = [];
  for (let i = 0; fiber && i < 50 && components.length < 12; i++, child = fiber, fiber = fiber._debugOwner ?? fiber.return) {
    const t = fiber.type;
    if (typeof t !== 'function' && typeof t !== 'object') continue;
    const name = t?.displayName || t?.name || t?.render?.displayName || t?.render?.name;
    if (!name) continue;
    const source = child._debugSource ?? fiber._debugSource;
    const stack = child._debugStack?.stack ?? fiber._debugStack?.stack;
    const frame = typeof stack === 'string' ? stack.split('\n').slice(1).find((s: string) => !/(node_modules|\/deps\/)/.test(s)) : null;
    const location = frame?.trim().replace(/^at (?:.*? \()?/, '').replace(/\)$/, '').match(/^(.*):(\d+):(\d+)$/);
    components.push({ name, ...(source ? { file: source.fileName, line: source.lineNumber, column: source.columnNumber, locationKind: 'React debug source' }
      : location ? { file: location[1], line: Number(location[2]), column: Number(location[3]), locationKind: 'Runtime stack; may refer to transformed source' } : {}),
      ...(typeof stack === 'string' ? { stack: stack.slice(0, 3000) } : {}) });
  }
  return { tag: e.localName, id: e.id, classes: [...e.classList], selector: path.join(' > '), text: (e instanceof HTMLElement ? e.innerText : e.textContent || '').slice(0, 200),
    position: { x: r.x, y: r.y, width: r.width, height: r.height }, computed,
    components, sourceNote: components.length ? 'Source locations are included only when exposed by the React dev build.' : 'React component source metadata unavailable.',
    clip: { x: Math.max(0, r.x + scrollX), y: Math.max(0, r.y + scrollY), width: r.width, height: r.height, scale: 1 } };
}

export async function browserFeedback(cdp: Cdp, session: string, m: Extract<BrowserClientMessage, { type: 'feedback' }>): Promise<BrowserFeedback | null> {
  const send = (method: string, params: object = {}) => cdp.send(method, params, session);
  if (!['hover', 'pick', 'screenshot', 'off'].includes(m.action)) throw new Error('Unknown feedback action');
  await send('DOM.enable');
  await send('Overlay.enable');
  if (m.action === 'off') { await send('Overlay.hideHighlight'); return null; }
  let details: any = null;
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
      details = result.result.value;
    } finally { await send('Runtime.releaseObject', { objectId: object.objectId }); }
  }
  await send('Overlay.hideHighlight');
  const { cssContentSize } = await send('Page.getLayoutMetrics');
  const clip = details?.clip ?? { x: 0, y: 0, width: cssContentSize.width, height: cssContentSize.height, scale: 1 };
  if (!clip.width || !clip.height) throw new Error('This element has no visible area');
  // Bound raster memory even on very long pages; preserve the complete page at reduced resolution.
  clip.scale = Math.min(1, 4096 / Math.max(clip.width, clip.height));
  const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip });
  const id = randomUUID();
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${Date.now()}-${id}.png`);
  await writeFile(path, Buffer.from(data, 'base64'));
  // At most 40 captures survive, including captures from previous server runs.
  const files = (await readdir(dir)).filter((n) => n.endsWith('.png')).sort();
  await Promise.all(files.slice(0, Math.max(0, files.length - 40)).map((n) => rm(join(dir, n), { force: true })));
  if (details) delete details.clip;
  return { id, src: localUrl(path), name: details ? `Element ${details.tag}` : 'Full page', text: details ? JSON.stringify(details, null, 2) : 'Full-page screenshot' };
}
