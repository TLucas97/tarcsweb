import { Component, type ReactNode } from 'react';
import { CodeFrame } from './Code.tsx';
import { Pending } from './bits.tsx';
import { UiKey, UiLive } from './ui/card.tsx';
import type { UiDef } from './ui/define.ts';
import { registry } from './ui/registry.ts';

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
  return { ok: false, why: i ? `${i.path.join('.') || 'block'}: ${i.message}` : 'Invalid block' };
}

function Fallback({ src, why }: { src: string; why: string }) {
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

// A ```ui fence from the model: a JSON spec drawn by the component registered for its type.
export function UiBlock({ src, done, live = false }: { src: string; done: boolean; live?: boolean }) {
  if (!done) {
    const t = /"type"\s*:\s*"(\w+)"/.exec(src)?.[1];
    return (
      <div className="frame ub-wait" aria-busy="true">
        <div className="vmsg"><Pending text={(t && Object.hasOwn(registry, t) && registry[t].label) || 'Building visual…'} /></div>
      </div>
    );
  }
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
