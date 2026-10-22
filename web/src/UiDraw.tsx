import { Component, useContext, useEffect, type ReactNode } from 'react';
import { CodeFrame } from './Code.tsx';
import { UiKey, UiLive } from './ui/card.tsx';
import type { UiDef } from './ui/define.ts';
import { registry } from './ui/registry.ts';
import { setUiLabels, UiReport } from './UiBlock.tsx';
import { useStore } from './store.ts';
import { send } from './socket.ts';

// The streaming placeholder names the block once this chunk is in.
setUiLabels(Object.fromEntries(Object.entries(registry).map(([k, d]) => [k, d.label])));

const valueAt = (raw: unknown, path: PropertyKey[]) =>
  path.reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Record<PropertyKey, unknown>)[k] : undefined), raw);

function parse(src: string): { ok: true; def: UiDef; data: unknown } | { ok: false; why: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(src);
  } catch (e) {
    return { ok: false, why: e instanceof Error ? e.message : 'Invalid JSON' };
  }
  const t = raw && typeof raw === 'object' ? (raw as { type?: unknown }).type : undefined;
  const def = typeof t === 'string' && Object.hasOwn(registry, t) ? registry[t] : undefined;
  if (!def) return { ok: false, why: `Unknown type ${JSON.stringify(t ?? null)}` };
  const r = def.schema.safeParse(raw);
  if (r.success) return { ok: true, def, data: r.data };
  const i = r.error.issues[0];
  if (!i) return { ok: false, why: 'Invalid block' };
  // An enum issue does not name the value it got, which is what the model needs to fix.
  const got = i.code === 'invalid_value' ? valueAt(raw, i.path) : undefined;
  return { ok: false, why: `${i.path.join('.') || 'block'}: ${i.message}${got !== undefined ? `, got ${JSON.stringify(got).slice(0, 60)}` : ''}` };
}

const squash = (s: string) => s.replace(/\s+/g, '');

// The block's order among the reply's ```ui fences; a hash of it when the reply text no longer holds it verbatim.
function uiIndex(text: string, src: string) {
  const want = squash(src);
  let n = 0;
  let fence: string | null = null;
  let body: string[] = [];
  for (const line of text.split('\n')) {
    if (fence === null) {
      const m = /^\s*(`{3,}|~{3,})\s*ui\s*$/.exec(line);
      if (m) {
        fence = m[1];
        body = [];
      }
    } else if (new RegExp(`^\\s*${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`).test(line)) {
      if (squash(body.join('\n')) === want) return n;
      n++;
      fence = null;
    } else body.push(line);
  }
  let h = 0;
  for (let i = 0; i < want.length; i++) h = (h * 31 + want.charCodeAt(i)) | 0;
  return 100 + (Math.abs(h) % 900);
}

const REPORTED_MAX = 200;
const reported = new Set<string>();

// Only a reply of the turn on screen is worth a note: older ones were already followed by a new prompt.
function reportFail(sessionId: string, itemId: string, src: string, why: string) {
  const s = useStore.getState();
  const it = s.items[itemId];
  if (s.current !== sessionId || it?.kind !== 'agent') return;
  const at = s.order.lastIndexOf(itemId);
  if (at < 0) return;
  for (let i = s.order.length - 1; i > at; i--) {
    const later = s.items[s.order[i]];
    if (later?.kind === 'user' && !later.queued) return;
  }
  const index = uiIndex(it.text, src);
  const key = `${sessionId}:${itemId}#${index}`;
  if (reported.has(key)) return;
  const blockType = /"type"\s*:\s*"([^"]{1,40})"/.exec(src)?.[1] ?? 'ui';
  if (!send({ type: 'ui-block-failed', sessionId, itemId, index, blockType, why: why.slice(0, 500) || 'Invalid block' })) {
    unsent.set(key, [sessionId, itemId, src, why]);
    if (unsent.size > UNSENT_MAX) unsent.delete(unsent.keys().next().value!);
    return;
  }
  unsent.delete(key);
  reported.add(key);
  if (reported.size > REPORTED_MAX) reported.delete(reported.values().next().value!);
}

// Reports that met a closed socket, by the same key; they go once the next hello lands, checked again like a fresh one.
const UNSENT_MAX = 20;
const unsent = new Map<string, Parameters<typeof reportFail>>();
useStore.subscribe((s, prev) => {
  if (!s.connected || prev.connected || !unsent.size) return;
  const list = [...unsent.values()];
  unsent.clear();
  for (const args of list) reportFail(...args);
});

function Fallback({ src, why }: { src: string; why: string }) {
  const ctx = useContext(UiReport);
  useEffect(() => {
    if (ctx) reportFail(ctx.sessionId, ctx.itemId, src, why);
  }, [ctx, src, why]);
  return (
    <div className="ub-bad">
      <CodeFrame code={src} lang="json" done />
      <p className="ub-note">This visual could not be drawn<span>{why}</span></p>
    </div>
  );
}

class Guard extends Component<{ src: string; children: ReactNode }, { err: string | null }> {
  state = { err: null as string | null };
  static getDerivedStateFromError(e: unknown) {
    return { err: e instanceof Error ? e.message : 'Render error' };
  }
  render() {
    return this.state.err ? <Fallback src={this.props.src} why={this.state.err} /> : this.props.children;
  }
}

// A finished ```ui block: the registry and zod live in this chunk, loaded with the first block.
export default function UiDraw({ src, live }: { src: string; live: boolean }) {
  const r = parse(src);
  if (!r.ok) return <Fallback src={src} why={r.why} />;
  const { Component: Drawn } = r.def;
  return (
    <Guard key={src} src={src}>
      <UiKey.Provider value={src}>
        <UiLive.Provider value={live}>
          <Drawn b={r.data} />
        </UiLive.Provider>
      </UiKey.Provider>
    </Guard>
  );
}
