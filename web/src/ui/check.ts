import { schemas, type UiType } from './schemas.ts';

// Shared by the client (UiDraw) and the server (server/uiCheck.ts), so both name a failure the same way.

const WHY_MAX = 500;
const valueAt = (raw: unknown, path: PropertyKey[]) =>
  path.reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Record<PropertyKey, unknown>)[k] : undefined), raw);

// Preprocess steps can throw on odd JSON (e.g. {"toString": null}); that is a failed block, not a crash.
function parse(t: UiType, raw: unknown) {
  try {
    return schemas[t].safeParse(raw);
  } catch {
    return null;
  }
}

export function checkUi(src: string): { ok: true; type: UiType; data: unknown } | { ok: false; why: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(src);
  } catch (e) {
    return { ok: false, why: whyOf(e instanceof Error ? e.message : 'Invalid JSON') };
  }
  const t = raw && typeof raw === 'object' ? (raw as { type?: unknown }).type : undefined;
  if (typeof t !== 'string' || !Object.hasOwn(schemas, t)) return { ok: false, why: whyOf(`Unknown type ${JSON.stringify(t ?? null)}`) };
  const r = parse(t as UiType, raw);
  if (!r) return { ok: false, why: 'Invalid block' };
  if (r.success) return { ok: true, type: t as UiType, data: r.data };
  const i = r.error.issues[0];
  if (!i) return { ok: false, why: 'Invalid block' };
  // An enum issue does not name the value it got, which is what the model needs to fix.
  const got = i.code === 'invalid_value' ? valueAt(raw, i.path) : undefined;
  return { ok: false, why: whyOf(`${i.path.join('.') || 'block'}: ${i.message}${got !== undefined ? `, got ${JSON.stringify(got).slice(0, 60)}` : ''}`) };
}

export const whyOf = (why: string) => why.slice(0, WHY_MAX) || 'Invalid block';
export const blockTypeOf = (src: string) => /"type"\s*:\s*"([^"]{1,40})"/.exec(src)?.[1] ?? 'ui';

// The bodies of a reply's closed top-level ```ui fences, in order. Other fences are skipped whole, so a ```ui
// example inside a ````md fence does not count; as in CommonMark, a fence closes with its char, at least as long.
export function uiFences(text: string) {
  const out: string[] = [];
  let close: RegExp | null = null;
  let ui = false;
  let body: string[] = [];
  for (const line of text.split('\n')) {
    if (close === null) {
      const m = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
      if (!m || (m[1][0] === '`' && m[2].includes('`'))) continue;
      close = new RegExp(`^\\s*${m[1][0] === '`' ? '`' : '~'}{${m[1].length},}\\s*$`);
      ui = m[2].trim() === 'ui';
      body = [];
    } else if (close.test(line)) {
      if (ui) out.push(body.join('\n'));
      close = null;
    } else if (ui) body.push(line);
  }
  return out;
}

export const squash = (s: string) => s.replace(/\s+/g, '');

// The block's order among the reply's ```ui fences; a hash of it when the reply text no longer holds it verbatim.
export function uiIndex(text: string, src: string) {
  const want = squash(src);
  const at = uiFences(text).findIndex((b) => squash(b) === want);
  if (at >= 0) return at;
  let h = 0;
  for (let i = 0; i < want.length; i++) h = (h * 31 + want.charCodeAt(i)) | 0;
  return 100 + (Math.abs(h) % 900);
}
